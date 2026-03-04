import {
  buildBaseAccountStatusSnapshot,
  buildBaseChannelStatusSummary,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  PAIRING_APPROVED_MESSAGE,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import {
  listMeshtasticAccountIds,
  resolveDefaultMeshtasticAccountId,
  resolveMeshtasticAccount,
  type ResolvedMeshtasticAccount,
} from "./accounts.js";
import { MeshtasticConfigSchema } from "./config-schema.js";
import { monitorMeshtasticProvider } from "./monitor.js";
import {
  normalizeMeshtasticMessagingTarget,
  looksLikeMeshtasticNodeId,
  normalizeMeshtasticAllowEntry,
  normalizeMeshtasticNodeId,
} from "./normalize.js";
import { meshtasticOnboardingAdapter } from "./onboarding.js";
import { resolveMeshtasticGroupMatch, resolveMeshtasticRequireMention } from "./policy.js";
import { getMeshtasticRuntime } from "./runtime.js";
import { sendMessageMeshtastic } from "./send.js";
import type { CoreConfig, MeshtasticProbe } from "./types.js";

const meta = {
  id: "meshtastic",
  label: "Meshtastic",
  selectionLabel: "Meshtastic (plugin)",
  docsPath: "/channels/meshtastic",
  docsLabel: "meshtastic",
  blurb: "LoRa mesh network; configure serial, HTTP, or MQTT transport.",
  order: 80,
  quickstartAllowFrom: true,
};

export const meshtasticPlugin: ChannelPlugin<ResolvedMeshtasticAccount, MeshtasticProbe> = {
  id: "meshtastic",
  meta: {
    ...meta,
    quickstartAllowFrom: true,
  },
  onboarding: meshtasticOnboardingAdapter,
  pairing: {
    idLabel: "meshtasticNode",
    normalizeAllowEntry: (entry) => normalizeMeshtasticAllowEntry(entry),
    notifyApproval: async ({ id }) => {
      const normalized = normalizeMeshtasticNodeId(id);
      if (!normalized) {
        throw new Error(`invalid Meshtastic pairing id: ${id}`);
      }
      await sendMessageMeshtastic(normalized, PAIRING_APPROVED_MESSAGE);
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.meshtastic"] },
  configSchema: buildChannelConfigSchema(MeshtasticConfigSchema),
  config: {
    listAccountIds: (cfg) => listMeshtasticAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) =>
      resolveMeshtasticAccount({ cfg: cfg as CoreConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultMeshtasticAccountId(cfg as CoreConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg as CoreConfig,
        sectionKey: "meshtastic",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg as CoreConfig,
        sectionKey: "meshtastic",
        accountId,
        clearBaseFields: ["name", "transport", "serialPort", "httpAddress", "httpTls", "mqtt"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      transport: account.transport,
      serialPort: account.serialPort || undefined,
      httpAddress: account.httpAddress || undefined,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveMeshtasticAccount({ cfg: cfg as CoreConfig, accountId }).config.allowFrom ?? []).map(
        (entry) => String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => normalizeMeshtasticAllowEntry(String(entry))).filter(Boolean),
    resolveDefaultTo: ({ cfg, accountId }) =>
      resolveMeshtasticAccount({ cfg: cfg as CoreConfig, accountId }).config.defaultTo?.trim() ||
      undefined,
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.meshtastic?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.meshtastic.accounts.${resolvedAccountId}.`
        : "channels.meshtastic.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: `${basePath}allowFrom`,
        approveHint: formatPairingApproveHint("meshtastic"),
        normalizeEntry: (raw) => normalizeMeshtasticAllowEntry(raw),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const warnings: string[] = [];
      const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
      const { groupPolicy } = resolveAllowlistProviderRuntimeGroupPolicy({
        providerConfigPresent: cfg.channels?.meshtastic !== undefined,
        groupPolicy: account.config.groupPolicy,
        defaultGroupPolicy,
      });
      if (groupPolicy === "open") {
        warnings.push(
          '- Meshtastic channels: groupPolicy="open" allows all channels and senders (mention-gated). Prefer channels.meshtastic.groupPolicy="allowlist" with channels.meshtastic.channels.',
        );
      }
      if (account.transport === "mqtt" && !account.config.mqtt?.tls) {
        warnings.push("- Meshtastic MQTT TLS is disabled; credentials are sent in plaintext.");
      }
      return warnings;
    },
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId, groupId }) => {
      const account = resolveMeshtasticAccount({ cfg: cfg as CoreConfig, accountId });
      if (!groupId) {
        return true;
      }
      const match = resolveMeshtasticGroupMatch({
        groups: account.config.channels,
        target: groupId,
      });
      return resolveMeshtasticRequireMention({
        groupConfig: match.groupConfig,
        wildcardConfig: match.wildcardConfig,
      });
    },
    resolveToolPolicy: ({ cfg, accountId, groupId }) => {
      const account = resolveMeshtasticAccount({ cfg: cfg as CoreConfig, accountId });
      if (!groupId) {
        return undefined;
      }
      const match = resolveMeshtasticGroupMatch({
        groups: account.config.channels,
        target: groupId,
      });
      return match.groupConfig?.tools ?? match.wildcardConfig?.tools;
    },
  },
  messaging: {
    normalizeTarget: normalizeMeshtasticMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeMeshtasticNodeId,
      hint: "<!nodeId>",
    },
  },
  resolver: {
    resolveTargets: async ({ inputs, kind }) => {
      return inputs.map((input) => {
        const normalized = normalizeMeshtasticMessagingTarget(input);
        if (!normalized) {
          return {
            input,
            resolved: false,
            note: "invalid Meshtastic target",
          };
        }
        if (kind === "group") {
          return {
            input,
            resolved: true,
            id: normalized,
            name: normalized,
          };
        }
        if (!looksLikeMeshtasticNodeId(normalized)) {
          return {
            input,
            resolved: false,
            note: "expected node ID target",
          };
        }
        return {
          input,
          resolved: true,
          id: normalized,
          name: normalized,
        };
      });
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveMeshtasticAccount({ cfg: cfg as CoreConfig, accountId });
      const q = query?.trim().toLowerCase() ?? "";
      const ids = new Set<string>();

      for (const entry of account.config.allowFrom ?? []) {
        const normalized = normalizeMeshtasticAllowEntry(entry);
        if (normalized && normalized !== "*") {
          ids.add(normalized);
        }
      }
      for (const entry of account.config.groupAllowFrom ?? []) {
        const normalized = normalizeMeshtasticAllowEntry(entry);
        if (normalized && normalized !== "*") {
          ids.add(normalized);
        }
      }
      for (const ch of Object.values(account.config.channels ?? {})) {
        for (const entry of ch.allowFrom ?? []) {
          const normalized = normalizeMeshtasticAllowEntry(entry);
          if (normalized && normalized !== "*") {
            ids.add(normalized);
          }
        }
      }

      return Array.from(ids)
        .filter((id) => (q ? id.includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "user", id }));
    },
    listGroups: async ({ cfg, accountId, query, limit }) => {
      const account = resolveMeshtasticAccount({ cfg: cfg as CoreConfig, accountId });
      const q = query?.trim().toLowerCase() ?? "";
      const groupIds = new Set<string>();

      for (const group of Object.keys(account.config.channels ?? {})) {
        if (group === "*") {
          continue;
        }
        groupIds.add(group);
      }

      return Array.from(groupIds)
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "group", id, name: id }));
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getMeshtasticRuntime().channel.text.chunkText(text, limit),
    chunkerMode: "text",
    textChunkLimit: 200,
    sendText: async ({ to, text, accountId }) => {
      const result = await sendMessageMeshtastic(to, text, {
        accountId: accountId ?? undefined,
      });
      return { channel: "meshtastic", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ account, snapshot }) => ({
      ...buildBaseChannelStatusSummary(snapshot),
      transport: account.transport,
      serialPort: account.serialPort || undefined,
      httpAddress: account.httpAddress || undefined,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account }) => {
      if (!account.configured) {
        return {
          ok: false,
          error: "Not configured. Run 'openclaw onboard' to configure.",
          transport: account.transport,
        } as MeshtasticProbe;
      }

      const address =
        account.transport === "serial"
          ? account.serialPort
          : account.transport === "http"
            ? account.httpAddress
            : account.config.mqtt?.broker;

      // Lightweight transport-specific reachability check.
      try {
        if (account.transport === "serial") {
          const { access } = await import("node:fs/promises");
          await access(account.serialPort);
        } else if (account.transport === "http") {
          const prefix = account.httpTls ? "https" : "http";
          const url = `${prefix}://${account.httpAddress}/api/v1/fromradio`;
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5_000);
          try {
            await fetch(url, { signal: controller.signal });
          } finally {
            clearTimeout(timeout);
          }
        } else if (account.transport === "mqtt") {
          const mqtt = await import("mqtt");
          const mqttConfig = account.config.mqtt;
          const protocol = mqttConfig?.tls ? "mqtts" : "mqtt";
          const broker = mqttConfig?.broker ?? "mqtt.meshtastic.org";
          const port = mqttConfig?.port ?? 1883;
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
              client.end(true);
              reject(new Error("MQTT connection timed out (5s)"));
            }, 5_000);
            const client = mqtt.default.connect(`${protocol}://${broker}:${port}`, {
              username: mqttConfig?.username ?? "meshdev",
              password: mqttConfig?.password ?? "large4cats",
              clean: true,
              connectTimeout: 5_000,
            });
            client.on("connect", () => {
              clearTimeout(timeout);
              client.end(true);
              resolve();
            });
            client.on("error", (err) => {
              clearTimeout(timeout);
              client.end(true);
              reject(err);
            });
          });
        }
        return {
          ok: true,
          transport: account.transport,
          address,
        } as MeshtasticProbe;
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          transport: account.transport,
          address,
        } as MeshtasticProbe;
      }
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      ...buildBaseAccountStatusSnapshot({ account, runtime, probe }),
      transport: account.transport,
      serialPort: account.serialPort || undefined,
      httpAddress: account.httpAddress || undefined,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      if (!account.configured) {
        throw new Error(
          `Meshtastic is not configured for account "${account.accountId}". ` +
            `Run 'openclaw onboard' or set channels.meshtastic.transport and connection details in config.`,
        );
      }
      const transportDesc =
        account.transport === "serial"
          ? `serial (${account.serialPort})`
          : account.transport === "http"
            ? `http (${account.httpAddress}${account.httpTls ? " tls" : ""})`
            : `mqtt (${account.config.mqtt?.broker ?? "?"})`;
      ctx.log?.info(`[${account.accountId}] starting Meshtastic provider (${transportDesc})`);
      const { stop } = await monitorMeshtasticProvider({
        accountId: account.accountId,
        config: ctx.cfg as CoreConfig,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
      return { stop };
    },
  },
};
