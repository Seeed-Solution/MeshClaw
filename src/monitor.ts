import { randomUUID } from "node:crypto";
import { createLoggerBackedRuntime, type RuntimeEnv } from "openclaw/plugin-sdk";
import { resolveMeshtasticAccount } from "./accounts.js";
import { connectMeshtasticClient, DeviceStatus, SetOwnerRebootError, type MeshtasticClient } from "./client.js";
import { handleMeshtasticInbound } from "./inbound.js";
import { connectMeshtasticMqtt, type MeshtasticMqttClient } from "./mqtt-client.js";
import { nodeNumToHex } from "./normalize.js";
import { getMeshtasticRuntime } from "./runtime.js";
import { setActiveSerialSend, setActiveMqttSend } from "./send.js";
import type { CoreConfig, MeshtasticInboundMessage } from "./types.js";

/** Inject a mention pattern (e.g. "@bard2") into the config so group messages
 *  containing the pattern are recognized as mentions. */
function injectMentionPattern(cfg: CoreConfig, name: string | undefined): CoreConfig {
  if (!name) return cfg;
  const mentionPattern = `@${name}`;
  const existingPatterns =
    (cfg as Record<string, unknown> & { messages?: { groupChat?: { mentionPatterns?: string[] } } })
      .messages?.groupChat?.mentionPatterns ?? [];
  if (existingPatterns.includes(mentionPattern)) return cfg;
  return {
    ...cfg,
    messages: {
      ...(cfg as Record<string, unknown>).messages as Record<string, unknown> | undefined,
      groupChat: {
        ...((cfg as Record<string, unknown>).messages as Record<string, unknown> | undefined)
          ?.groupChat as Record<string, unknown> | undefined,
        mentionPatterns: [...existingPatterns, mentionPattern],
      },
    },
  };
}

export type MeshtasticMonitorOptions = {
  accountId?: string;
  config?: CoreConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export async function monitorMeshtasticProvider(
  opts: MeshtasticMonitorOptions,
): Promise<{ stop: () => void }> {
  const core = getMeshtasticRuntime();
  const cfg = opts.config ?? (core.config.loadConfig() as CoreConfig);
  const account = resolveMeshtasticAccount({
    cfg,
    accountId: opts.accountId,
  });

  const runtime: RuntimeEnv =
    opts.runtime ??
    createLoggerBackedRuntime({
      logger: core.logging.getChildLogger(),
      exitError: () => new Error("Runtime exit not available"),
    });

  if (!account.configured) {
    throw new Error(
      `Meshtastic is not configured for account "${account.accountId}". ` +
        `Run 'openclaw onboard' or set channels.meshtastic.transport and connection details in config.`,
    );
  }

  const logger = core.logging.getChildLogger({
    channel: "meshtastic",
    accountId: account.accountId,
  });

  const transport = account.transport;

  if (transport === "mqtt") {
    // MQTT: use config nodeName for mention pattern (no device to read from).
    const effectiveCfg = injectMentionPattern(cfg, account.config.nodeName?.trim());
    return monitorMqtt({ account, cfg: effectiveCfg, runtime, logger, opts });
  }
  // Serial/HTTP: mention pattern is injected after connection so the device's
  // actual name can be used as fallback when nodeName is not configured.
  return monitorDevice({ account, cfg, runtime, logger, opts, transport });
}

async function monitorDevice(params: {
  account: ReturnType<typeof resolveMeshtasticAccount>;
  cfg: CoreConfig;
  runtime: RuntimeEnv;
  logger: ReturnType<ReturnType<typeof getMeshtasticRuntime>["logging"]["getChildLogger"]>;
  opts: MeshtasticMonitorOptions;
  transport: "serial" | "http";
}): Promise<{ stop: () => void }> {
  const { account, runtime, logger, opts, transport } = params;
  let cfg = params.cfg;
  const core = getMeshtasticRuntime();

  let client: MeshtasticClient | null = null;

  try {
    client = await connectMeshtasticClient({
      transport,
      serialPort: account.serialPort,
      httpAddress: account.httpAddress,
      httpTls: account.httpTls,
      region: account.config.region,
      nodeName: account.config.nodeName,
      abortSignal: opts.abortSignal,
      onStatus: (status) => {
        logger.info(`[${account.accountId}] device ${status}`);
      },
      onError: (error) => {
        logger.error(`[${account.accountId}] error: ${error.message}`);
      },
      onText: async (event) => {
        if (!client) {
          return;
        }

        const channelName =
          client.getChannelName(event.channelIndex) ?? `channel-${event.channelIndex}`;

        const message: MeshtasticInboundMessage = {
          messageId: randomUUID(),
          senderNodeId: event.senderNodeId,
          senderName: event.senderName ?? client.getNodeName(event.senderNodeNum),
          channelIndex: event.channelIndex,
          channelName,
          text: event.text,
          timestamp: event.rxTime,
          isGroup: !event.isDirect,
        };

        core.channel.activity.record({
          channel: "meshtastic",
          accountId: account.accountId,
          direction: "inbound",
          at: message.timestamp,
        });

        await handleMeshtasticInbound({
          message,
          account,
          config: cfg,
          runtime,
          sendReply: async (target, text) => {
            if (!client) {
              return;
            }
            // For DM replies, resolve node number from hex ID.
            // For group replies, broadcast to the same channel.
            if (message.isGroup) {
              // Broadcast: fire-and-forget.  The SDK's sendText promise waits
              // for internal queue confirmation which may time out for broadcasts.
              // The radio sends the packet regardless, so we don't await.
              client.sendText(text, undefined, false, message.channelIndex).catch((err) => {
                logger.warn(`[${account.accountId}] broadcast send failed: ${err instanceof Error ? err.message : String(err)}`);
              });
            } else {
              // DM: fire-and-forget.  The SDK's sendText awaits ACK from the
              // target node; if ACK times out the promise rejects, but the radio
              // has already transmitted the packet.  Awaiting would block
              // subsequent reply chunks.
              const { hexToNodeNum } = await import("./normalize.js");
              const destNum = hexToNodeNum(target);
              client.sendText(text, destNum, true).catch((err) => {
                logger.warn(`[${account.accountId}] DM send failed to ${target}: ${err instanceof Error ? err.message : String(err)}`);
              });
            }
            opts.statusSink?.({ lastOutboundAt: Date.now() });
            core.channel.activity.record({
              channel: "meshtastic",
              accountId: account.accountId,
              direction: "outbound",
            });
          },
          statusSink: opts.statusSink,
        });
      },
    });
  } catch (err) {
    if (err instanceof SetOwnerRebootError) {
      logger.info(`[${account.accountId}] ${err.message}`);
      // Wait for the device to finish rebooting before the framework retries.
      logger.info(`[${account.accountId}] waiting 30s for device reboot...`);
      await new Promise((r) => setTimeout(r, 30_000));
    }
    throw err;
  }

  // Determine the effective device name for @mention matching.
  // If nodeName is configured, use it.  Otherwise read the device's actual name.
  const effectiveName = account.config.nodeName?.trim() || client.getMyNodeName();
  cfg = injectMentionPattern(cfg, effectiveName);
  if (effectiveName) {
    logger.info(`[${account.accountId}] mention trigger: @${effectiveName}`);
  }

  // Register active send function for `openclaw message send`.
  setActiveSerialSend((text, destination, channelIndex) =>
    client ? client.sendText(text, destination, true, channelIndex) : Promise.resolve(0),
  );

  const address =
    transport === "serial"
      ? account.serialPort
      : `${account.httpAddress}${account.httpTls ? " (tls)" : ""}`;
  logger.info(
    `[${account.accountId}] connected via ${transport} (${address}), node ${nodeNumToHex(client.myNodeNum)}`,
  );

  // Block until the gateway aborts or the device disconnects.
  // Returning from startAccount signals "channel exited" to the framework,
  // which triggers auto-restart.  We must stay alive so the serial port
  // remains open and isn't double-locked on reconnect.
  await new Promise<void>((resolve) => {
    if (opts.abortSignal) {
      opts.abortSignal.addEventListener("abort", () => resolve(), { once: true });
    }
    client!.device.events.onDeviceStatus.subscribe((status: number) => {
      if (status === DeviceStatus.Disconnected) {
        logger.info(`[${account.accountId}] device disconnected, exiting monitor`);
        resolve();
      }
    });
  });

  // Cleanup: release the serial port so the next start can open it.
  setActiveSerialSend(null);
  client?.close();
  client = null;

  // Give the OS time to release the serial port lock before the framework
  // restarts the channel (which would immediately try to reopen it).
  logger.info(`[${account.accountId}] releasing serial port (3s delay)...`);
  await new Promise<void>((r) => setTimeout(r, 3_000));

  return { stop: () => {} };
}

async function monitorMqtt(params: {
  account: ReturnType<typeof resolveMeshtasticAccount>;
  cfg: CoreConfig;
  runtime: RuntimeEnv;
  logger: ReturnType<ReturnType<typeof getMeshtasticRuntime>["logging"]["getChildLogger"]>;
  opts: MeshtasticMonitorOptions;
}): Promise<{ stop: () => void }> {
  const { account, cfg, runtime, logger, opts } = params;
  const core = getMeshtasticRuntime();
  const mqttConfig = account.config.mqtt;

  if (!mqttConfig?.broker) {
    throw new Error("MQTT broker not configured. Set channels.meshtastic.mqtt.broker or run 'openclaw onboard'.");
  }

  let mqttClient: MeshtasticMqttClient | null = null;

  mqttClient = await connectMeshtasticMqtt({
    mqtt: mqttConfig,
    abortSignal: opts.abortSignal,
    onStatus: (status) => {
      logger.info(`[${account.accountId}] mqtt: ${status}`);
    },
    onError: (error) => {
      logger.error(`[${account.accountId}] mqtt error: ${error.message}`);
    },
    onText: async (event) => {
      const message: MeshtasticInboundMessage = {
        messageId: randomUUID(),
        senderNodeId: event.senderNodeId,
        senderName: event.senderName,
        channelIndex: event.channelIndex,
        channelName: event.channelName ?? `channel-${event.channelIndex}`,
        text: event.text,
        timestamp: event.rxTime,
        isGroup: !event.isDirect,
      };

      core.channel.activity.record({
        channel: "meshtastic",
        accountId: account.accountId,
        direction: "inbound",
        at: message.timestamp,
      });

      await handleMeshtasticInbound({
        message,
        account,
        config: cfg,
        runtime,
        sendReply: async (target, text) => {
          if (!mqttClient) {
            return;
          }
          const channelName = message.isGroup ? message.channelName : undefined;
          await mqttClient.sendText(text, message.isGroup ? undefined : target, channelName);
          opts.statusSink?.({ lastOutboundAt: Date.now() });
          core.channel.activity.record({
            channel: "meshtastic",
            accountId: account.accountId,
            direction: "outbound",
          });
        },
        statusSink: opts.statusSink,
      });
    },
  });

  // Register active send function for `openclaw message send`.
  setActiveMqttSend((text, destination, channelName) =>
    mqttClient ? mqttClient.sendText(text, destination, channelName) : Promise.resolve(),
  );

  logger.info(
    `[${account.accountId}] connected via mqtt (${mqttConfig.broker}:${mqttConfig.port ?? 1883})`,
  );

  // Block until the gateway aborts.  Same pattern as monitorDevice.
  await new Promise<void>((resolve) => {
    if (opts.abortSignal) {
      opts.abortSignal.addEventListener("abort", () => resolve(), { once: true });
    }
  });

  setActiveMqttSend(null);
  mqttClient?.close();
  mqttClient = null;

  return { stop: () => {} };
}
