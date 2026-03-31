import {
  addWildcardAllowFrom,
  DEFAULT_ACCOUNT_ID,
  type DmPolicy,
  type WizardPrompter,
} from "openclaw/plugin-sdk/irc";
import {
  promptAccountId,
  promptChannelAccessConfig,
} from "openclaw/plugin-sdk/matrix";
import type {
  ChannelSetupDmPolicy,
} from "openclaw/plugin-sdk/setup";
import type { ChannelSetupWizard } from "openclaw/plugin-sdk";
import { readdir } from "node:fs/promises";
import {
  listMeshtasticAccountIds,
  resolveDefaultMeshtasticAccountId,
  resolveMeshtasticAccount,
} from "./accounts.js";
import { normalizeMeshtasticAllowEntry } from "./normalize.js";
import type {
  CoreConfig,
  MeshtasticAccountConfig,
  MeshtasticRegion,
  MeshtasticTransport,
} from "./types.js";

const channel = "meshtastic" as const;

// ── Helpers ──────────────────────────────────────────────────────

function parseListInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function updateMeshtasticAccountConfig(
  cfg: CoreConfig,
  accountId: string,
  patch: Partial<MeshtasticAccountConfig>,
): CoreConfig {
  const current = cfg.channels?.meshtastic ?? {};
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        meshtastic: { ...current, ...patch },
      },
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      meshtastic: {
        ...current,
        accounts: {
          ...current.accounts,
          [accountId]: { ...current.accounts?.[accountId], ...patch },
        },
      },
    },
  };
}

async function detectSerialPortCandidates(): Promise<string[]> {
  const candidates = new Set<string>();
  try {
    const devEntries = await readdir("/dev");
    for (const entry of devEntries) {
      if (
        entry.startsWith("cu.usb")
        || entry.startsWith("tty.usb")
        || entry.startsWith("ttyUSB")
        || entry.startsWith("ttyACM")
      ) {
        candidates.add(`/dev/${entry}`);
      }
    }
  } catch {}
  try {
    const byIdEntries = await readdir("/dev/serial/by-id");
    for (const entry of byIdEntries) {
      candidates.add(`/dev/serial/by-id/${entry}`);
    }
  } catch {}
  return [...candidates].sort((a, b) => a.localeCompare(b));
}

const REGION_OPTIONS: { value: string; label: string }[] = [
  { value: "US", label: "US (902-928 MHz)" },
  { value: "EU_433", label: "EU_433 (433 MHz)" },
  { value: "EU_868", label: "EU_868 (869 MHz)" },
  { value: "CN", label: "CN (470-510 MHz)" },
  { value: "JP", label: "JP (920 MHz)" },
  { value: "ANZ", label: "ANZ (915-928 MHz)" },
  { value: "KR", label: "KR (920-923 MHz)" },
  { value: "TW", label: "TW (920-925 MHz)" },
  { value: "RU", label: "RU (868 MHz)" },
  { value: "IN", label: "IN (865-867 MHz)" },
  { value: "TH", label: "TH (920-925 MHz)" },
  { value: "LORA_24", label: "LORA_24 (2.4 GHz)" },
];

function regionToMqttTopic(region: string): string {
  return `msh/${region}/2/json/#`;
}

function parseRegionFromTopic(topic: string): string | undefined {
  return topic.match(/^msh\/([^/]+)\//)?.[1];
}

function setGroupAccess(
  cfg: CoreConfig,
  accountId: string,
  policy: "open" | "allowlist" | "disabled",
  entries: string[],
): CoreConfig {
  if (policy !== "allowlist") {
    return updateMeshtasticAccountConfig(cfg, accountId, {
      enabled: true,
      groupPolicy: policy,
    });
  }
  const channels = Object.fromEntries(
    [...new Set(entries.map((e) => e.trim()).filter(Boolean))].map((e) => [e, {}]),
  );
  return updateMeshtasticAccountConfig(cfg, accountId, {
    enabled: true,
    groupPolicy: "allowlist",
    channels,
  });
}

// ── Transport-specific configure flows ───────────────────────────

async function configureSerial(params: {
  cfg: CoreConfig;
  accountId: string;
  prompter: WizardPrompter;
  currentPort: string;
}): Promise<CoreConfig> {
  const { prompter, accountId } = params;
  const serialCandidates = await detectSerialPortCandidates();
  let serialPort = params.currentPort;
  let needsManual = true;

  if (serialCandidates.length > 0) {
    const initial = serialCandidates.includes(serialPort) ? serialPort : serialCandidates[0];
    const choice = await prompter.select({
      message: "Detected serial port",
      options: [
        ...serialCandidates.map((value) => ({ value, label: value })),
        { value: "__manual__", label: "Manual input" },
      ],
      initialValue: initial,
    });
    if (String(choice) !== "__manual__") {
      serialPort = String(choice);
      needsManual = false;
    }
  }

  if (needsManual) {
    serialPort = String(
      await prompter.text({
        message: "Serial port path",
        placeholder: "/dev/ttyUSB0 or /dev/tty.usbmodem*",
        initialValue: serialPort || undefined,
        validate: (v) => (String(v ?? "").trim() ? undefined : "Required"),
      }),
    ).trim();
  }

  return updateMeshtasticAccountConfig(params.cfg, accountId, {
    enabled: true,
    transport: "serial",
    serialPort,
  });
}

async function configureHttp(params: {
  cfg: CoreConfig;
  accountId: string;
  prompter: WizardPrompter;
  currentAddress: string;
  currentTls: boolean;
}): Promise<CoreConfig> {
  const { prompter, accountId } = params;

  const httpAddress = String(
    await prompter.text({
      message: "Device IP or hostname",
      placeholder: "meshtastic.local or 192.168.1.100",
      initialValue: params.currentAddress || undefined,
      validate: (v) => (String(v ?? "").trim() ? undefined : "Required"),
    }),
  ).trim();

  const httpTls = await prompter.confirm({
    message: "Use HTTPS?",
    initialValue: params.currentTls,
  });

  return updateMeshtasticAccountConfig(params.cfg, accountId, {
    enabled: true,
    transport: "http",
    httpAddress,
    httpTls,
  });
}

async function configureMqtt(params: {
  cfg: CoreConfig;
  accountId: string;
  prompter: WizardPrompter;
  resolved: ReturnType<typeof resolveMeshtasticAccount>;
}): Promise<CoreConfig> {
  const { prompter, accountId, resolved } = params;
  const mqtt = resolved.config.mqtt;

  const broker = String(
    await prompter.text({
      message: "MQTT broker hostname",
      initialValue: mqtt?.broker || "mqtt.meshtastic.org",
      validate: (v) => (String(v ?? "").trim() ? undefined : "Required"),
    }),
  ).trim();

  const port = Number.parseInt(
    String(await prompter.text({ message: "MQTT broker port", initialValue: String(mqtt?.port ?? 1883) })),
    10,
  );

  const username = String(
    await prompter.text({ message: "MQTT username", initialValue: mqtt?.username || "meshdev" }),
  ).trim();

  const password = String(
    await prompter.text({ message: "MQTT password", initialValue: mqtt?.password || "large4cats" }),
  ).trim();

  const existingTopic = mqtt?.topic || "msh/US/2/json/#";
  const currentRegion = parseRegionFromTopic(existingTopic) ?? "US";
  const regionChoice = await prompter.select({
    message: "LoRa region (determines which mesh traffic to receive)",
    options: REGION_OPTIONS,
    initialValue: currentRegion,
  });

  const topic = String(
    await prompter.text({
      message: "MQTT subscribe topic",
      initialValue: regionToMqttTopic(String(regionChoice)),
      validate: (v) => (String(v ?? "").trim() ? undefined : "Required"),
    }),
  ).trim();

  const mqttTls = await prompter.confirm({
    message: "Use TLS for MQTT?",
    initialValue: mqtt?.tls ?? false,
  });

  return updateMeshtasticAccountConfig(params.cfg, accountId, {
    enabled: true,
    transport: "mqtt",
    mqtt: {
      broker,
      port: Number.isFinite(port) ? port : 1883,
      username: username || undefined,
      password: password || undefined,
      topic,
      tls: mqttTls,
    },
  });
}

// ── DM Policy ────────────────────────────────────────────────────

const dmPolicy: ChannelSetupDmPolicy = {
  label: "Meshtastic",
  channel,
  policyKey: "channels.meshtastic.dmPolicy",
  allowFromKey: "channels.meshtastic.allowFrom",
  getCurrent: (cfg) => ((cfg as CoreConfig).channels?.meshtastic?.dmPolicy as DmPolicy) ?? "pairing",
  setPolicy: (cfg, policy) => {
    const allowFrom =
      policy === "open"
        ? addWildcardAllowFrom((cfg as CoreConfig).channels?.meshtastic?.allowFrom)
        : undefined;
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        meshtastic: {
          ...(cfg as CoreConfig).channels?.meshtastic,
          dmPolicy: policy,
          ...(allowFrom ? { allowFrom } : {}),
        },
      },
    } as typeof cfg;
  },
  promptAllowFrom: async ({ cfg, prompter }) => {
    const existing = (cfg as CoreConfig).channels?.meshtastic?.allowFrom ?? [];
    await prompter.note(
      ["Allowlist Meshtastic DMs by node ID.", "Format: !aabbccdd (hex)", "Comma-separated."].join(
        "\n",
      ),
      "Meshtastic allowlist",
    );
    const raw = await prompter.text({
      message: "Meshtastic allowFrom (node IDs)",
      placeholder: "!aabbccdd, !11223344",
      initialValue: existing[0] ? String(existing[0]) : undefined,
      validate: (v) => (String(v ?? "").trim() ? undefined : "Required"),
    });
    const normalized = [
      ...new Set(parseListInput(String(raw)).map((e) => normalizeMeshtasticAllowEntry(e)).filter(Boolean)),
    ];
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        meshtastic: { ...(cfg as CoreConfig).channels?.meshtastic, allowFrom: normalized },
      },
    } as typeof cfg;
  },
};

// ── Setup Wizard (declarative + finalize) ────────────────────────

export const meshtasticSetupWizard: ChannelSetupWizard = {
  channel,

  resolveAccountIdForConfigure: async (params) => {
    const coreCfg = params.cfg as CoreConfig;
    const defaultId = resolveDefaultMeshtasticAccountId(coreCfg);
    if (params.shouldPromptAccountIds && !params.accountOverride) {
      return promptAccountId({
        cfg: coreCfg,
        prompter: params.prompter,
        label: "Meshtastic",
        currentId: defaultId,
        listAccountIds: listMeshtasticAccountIds,
        defaultAccountId: defaultId,
      });
    }
    return params.accountOverride?.trim() || defaultId;
  },

  status: {
    configuredLabel: "configured",
    unconfiguredLabel: "needs transport config",
    configuredHint: "configured",
    unconfiguredHint: "needs transport config",
    configuredScore: 1,
    unconfiguredScore: 0,
    resolveConfigured: ({ cfg }) => {
      const coreCfg = cfg as CoreConfig;
      return listMeshtasticAccountIds(coreCfg).some(
        (id) => resolveMeshtasticAccount({ cfg: coreCfg, accountId: id }).configured,
      );
    },
    resolveStatusLines: ({ cfg, configured }) => {
      if (!configured) return ["Meshtastic: needs transport config"];
      const coreCfg = cfg as CoreConfig;
      const id = listMeshtasticAccountIds(coreCfg).find(
        (aid) => resolveMeshtasticAccount({ cfg: coreCfg, accountId: aid }).configured,
      );
      if (!id) return ["Meshtastic: needs transport config"];
      const resolved = resolveMeshtasticAccount({ cfg: coreCfg, accountId: id });
      return [`Meshtastic: ${resolved.transport} transport`];
    },
  },

  introNote: {
    title: "Meshtastic setup",
    lines: [
      "Meshtastic connects to LoRa mesh devices.",
      "Transport options: serial (USB), http (WiFi), mqtt (broker).",
      "Serial needs a device port (e.g. /dev/ttyUSB0).",
      "HTTP needs a device IP/hostname (e.g. meshtastic.local).",
      "MQTT needs a broker address (default: mqtt.meshtastic.org).",
      "Env vars: MESHTASTIC_TRANSPORT, MESHTASTIC_SERIAL_PORT, MESHTASTIC_HTTP_ADDRESS, MESHTASTIC_MQTT_BROKER.",
    ],
  },

  // No standard credentials — transport config is too branching for the
  // declarative credential flow. All interactive setup runs in finalize.
  credentials: [],

  finalize: async ({ cfg, accountId, prompter, forceAllowFrom }) => {
    let next = cfg as CoreConfig;
    const resolved = resolveMeshtasticAccount({ cfg: next, accountId });

    // ── Transport selection ──
    const transportChoice = await prompter.select({
      message: "Meshtastic transport",
      options: [
        { value: "serial", label: "Serial (USB device)" },
        { value: "http", label: "HTTP (WiFi device)" },
        { value: "mqtt", label: "MQTT (broker, no local hardware)" },
      ],
      initialValue: resolved.transport || "serial",
    });
    const transport = String(transportChoice) as MeshtasticTransport;

    // ── Transport-specific configuration ──
    if (transport === "serial") {
      next = await configureSerial({
        cfg: next,
        accountId,
        prompter,
        currentPort: resolved.serialPort || "",
      });
    } else if (transport === "http") {
      next = await configureHttp({
        cfg: next,
        accountId,
        prompter,
        currentAddress: resolved.httpAddress || "",
        currentTls: resolved.httpTls ?? false,
      });
    } else {
      next = await configureMqtt({ cfg: next, accountId, prompter, resolved });
    }

    // ── LoRa region (serial/HTTP only) ──
    if (transport !== "mqtt") {
      const regionChoice = await prompter.select({
        message: "LoRa region",
        options: [
          { value: "UNSET", label: "UNSET (keep device default)" },
          ...REGION_OPTIONS,
        ],
        initialValue: resolved.config.region ?? "UNSET",
      });
      const region = String(regionChoice) as MeshtasticRegion;
      if (region !== "UNSET") {
        next = updateMeshtasticAccountConfig(next, accountId, { region });
      }
    }

    // ── Device display name ──
    const currentNodeName = resolveMeshtasticAccount({ cfg: next, accountId }).config.nodeName;
    const isMqtt = transport === "mqtt";
    const nodeNameInput = String(
      await prompter.text({
        message: isMqtt
          ? "Device display name (required for MQTT — used as @mention trigger)"
          : "Device display name (leave empty to auto-detect from device)",
        placeholder: isMqtt ? "e.g. OpenClaw" : "e.g. OpenClaw (empty = use device's current name)",
        initialValue: currentNodeName || undefined,
        validate: isMqtt
          ? (v) => (String(v ?? "").trim() ? undefined : "Required for MQTT (no device to auto-detect from)")
          : undefined,
      }),
    ).trim();
    if (nodeNameInput) {
      next = updateMeshtasticAccountConfig(next, accountId, { nodeName: nodeNameInput });
    }

    // ── Channel access config ──
    const afterConfig = resolveMeshtasticAccount({ cfg: next, accountId });
    const accessConfig = await promptChannelAccessConfig({
      prompter,
      label: "Meshtastic channels",
      currentPolicy: afterConfig.config.groupPolicy ?? "disabled",
      currentEntries: Object.keys(afterConfig.config.channels ?? {}),
      placeholder: "LongFast, Emergency, *",
      updatePrompt: Boolean(afterConfig.config.channels),
    });
    if (accessConfig) {
      next = setGroupAccess(next, accountId, accessConfig.policy, accessConfig.entries);
      const wantsMentions = await prompter.confirm({
        message: "Require mention to reply in Meshtastic channels?",
        initialValue: true,
      });
      if (!wantsMentions) {
        const resolvedAfter = resolveMeshtasticAccount({ cfg: next, accountId });
        const channels = resolvedAfter.config.channels ?? {};
        const patched = Object.fromEntries(
          Object.entries(channels).map(([key, value]) => [key, { ...value, requireMention: false }]),
        );
        next = updateMeshtasticAccountConfig(next, accountId, { channels: patched });
      }
    }

    // ── Allowlist ──
    if (forceAllowFrom) {
      const existing = next.channels?.meshtastic?.allowFrom ?? [];
      await prompter.note(
        ["Allowlist Meshtastic DMs by node ID.", "Format: !aabbccdd (hex)", "Comma-separated."].join("\n"),
        "Meshtastic allowlist",
      );
      const raw = await prompter.text({
        message: "Meshtastic allowFrom (node IDs)",
        placeholder: "!aabbccdd, !11223344",
        initialValue: existing[0] ? String(existing[0]) : undefined,
        validate: (v) => (String(v ?? "").trim() ? undefined : "Required"),
      });
      const normalized = [
        ...new Set(parseListInput(String(raw)).map((e) => normalizeMeshtasticAllowEntry(e)).filter(Boolean)),
      ];
      next = {
        ...next,
        channels: {
          ...next.channels,
          meshtastic: { ...next.channels?.meshtastic, allowFrom: normalized },
        },
      };
    }

    return { cfg: next };
  },

  completionNote: {
    title: "Meshtastic next steps",
    lines: [
      "Next: restart gateway and verify status.",
      "Command: openclaw channels status --probe",
    ],
  },

  dmPolicy,

  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      meshtastic: {
        ...(cfg as CoreConfig).channels?.meshtastic,
        enabled: false,
      },
    },
  }),
};
