import {
  GROUP_POLICY_BLOCKED_LABEL,
  createNormalizedOutboundDeliverer,
  createReplyPrefixOptions,
  formatTextWithAttachmentLinks,
  logInboundDrop,
  resolveControlCommandGate,
  resolveOutboundMediaUrls,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
  type OutboundReplyPayload,
  type OpenClawConfig,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import type { ResolvedMeshtasticAccount } from "./accounts.js";
import {
  normalizeMeshtasticAllowlist,
  normalizeMeshtasticNodeId,
  resolveMeshtasticAllowlistMatch,
} from "./normalize.js";
import {
  resolveMeshtasticMentionGate,
  resolveMeshtasticGroupAccessGate,
  resolveMeshtasticGroupMatch,
  resolveMeshtasticGroupSenderAllowed,
  resolveMeshtasticRequireMention,
} from "./policy.js";
import { getMeshtasticRuntime } from "./runtime.js";
import { sendMessageMeshtastic } from "./send.js";
import type { CoreConfig, MeshtasticInboundMessage } from "./types.js";

const CHANNEL_ID = "meshtastic" as const;

const escapeRegexLiteral = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function resolveMeshtasticEffectiveAllowlists(params: {
  configAllowFrom: string[];
  configGroupAllowFrom: string[];
  storeAllowList: string[];
}): {
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
} {
  const effectiveAllowFrom = [...params.configAllowFrom, ...params.storeAllowList].filter(Boolean);
  const effectiveGroupAllowFrom = [...params.configGroupAllowFrom].filter(Boolean);
  return { effectiveAllowFrom, effectiveGroupAllowFrom };
}

// LoRa payload limit is ~230 bytes.  Split longer replies into chunks
// so the firmware doesn't silently truncate them.
const MESHTASTIC_CHUNK_LIMIT = 200;

/** Channel-level system prompt hint for LoRa-constrained responses. */
const LORA_SYSTEM_HINT =
  "You are responding over a LoRa mesh radio (Meshtastic). " +
  "Each message is limited to ~200 bytes. " +
  "Keep responses extremely concise — plain text only, no markdown, no emoji, no bullet lists. " +
  "Use short sentences. Omit filler words. Prioritize the most important information first.";


function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    // Try to break at a space near the limit.
    let breakAt = remaining.lastIndexOf(" ", limit);
    if (breakAt <= limit * 0.4) breakAt = limit; // no good break point
    chunks.push(remaining.slice(0, breakAt).trimEnd());
    remaining = remaining.slice(breakAt).trimStart();
  }
  return chunks;
}

async function deliverMeshtasticReply(params: {
  payload: OutboundReplyPayload;
  target: string;
  accountId: string;
  channelIndex?: number;
  channelName?: string;
  chunkLimit?: number;
  sendReply?: (target: string, text: string) => Promise<void>;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}) {
  const combined = formatTextWithAttachmentLinks(
    params.payload.text,
    resolveOutboundMediaUrls(params.payload),
  );
  if (!combined) {
    return;
  }

  const chunks = chunkText(combined, params.chunkLimit ?? MESHTASTIC_CHUNK_LIMIT);

  for (const chunk of chunks) {
    if (params.sendReply) {
      await params.sendReply(params.target, chunk);
    } else {
      await sendMessageMeshtastic(params.target, chunk, {
        accountId: params.accountId,
        channelIndex: params.channelIndex,
        channelName: params.channelName,
      });
    }
    // Small delay between chunks to avoid overwhelming the radio queue.
    if (chunks.length > 1) {
      await new Promise<void>((r) => setTimeout(r, 1_500));
    }
  }
  params.statusSink?.({ lastOutboundAt: Date.now() });
}

export async function handleMeshtasticInbound(params: {
  message: MeshtasticInboundMessage;
  account: ResolvedMeshtasticAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  sendReply?: (target: string, text: string) => Promise<void>;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { message, account, config, runtime, statusSink } = params;
  const core = getMeshtasticRuntime();

  const rawBody = message.text?.trim() ?? "";
  if (!rawBody) {
    return;
  }

  statusSink?.({ lastInboundAt: message.timestamp });

  const senderDisplay = message.senderName
    ? `${message.senderName} (${message.senderNodeId})`
    : message.senderNodeId;

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const defaultGroupPolicy = resolveDefaultGroupPolicy(config);
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: config.channels?.meshtastic !== undefined,
      groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "meshtastic",
    accountId: account.accountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.channel,
    log: (message) => runtime.log?.(message),
  });

  const configAllowFrom = normalizeMeshtasticAllowlist(account.config.allowFrom);
  const configGroupAllowFrom = normalizeMeshtasticAllowlist(account.config.groupAllowFrom);
  const storeAllowFrom =
    dmPolicy === "allowlist"
      ? []
      : await core.channel.pairing.readAllowFromStore({
          channel: CHANNEL_ID,
          accountId: account.accountId,
        }).catch((err: unknown) => {
          runtime.log?.(`meshtastic: pairing allowFrom read failed: ${String(err)}`);
          return [] as string[];
        });
  const storeAllowList = normalizeMeshtasticAllowlist(storeAllowFrom);

  const channelLabel = message.channelName ?? `channel-${message.channelIndex}`;
  const groupMatch = resolveMeshtasticGroupMatch({
    groups: account.config.channels,
    target: channelLabel,
  });

  if (message.isGroup) {
    const groupAccess = resolveMeshtasticGroupAccessGate({ groupPolicy, groupMatch });
    if (!groupAccess.allowed) {
      runtime.log?.(`meshtastic: drop channel ${channelLabel} (${groupAccess.reason})`);
      return;
    }
  }

  const directGroupAllowFrom = normalizeMeshtasticAllowlist(groupMatch.groupConfig?.allowFrom);
  const wildcardGroupAllowFrom = normalizeMeshtasticAllowlist(groupMatch.wildcardConfig?.allowFrom);
  const groupAllowFrom =
    directGroupAllowFrom.length > 0 ? directGroupAllowFrom : wildcardGroupAllowFrom;

  const { effectiveAllowFrom, effectiveGroupAllowFrom } = resolveMeshtasticEffectiveAllowlists({
    configAllowFrom,
    configGroupAllowFrom,
    storeAllowList,
  });

  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: config as OpenClawConfig,
    surface: CHANNEL_ID,
  });
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const senderAllowedForCommands = resolveMeshtasticAllowlistMatch({
    allowFrom: message.isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom,
    message,
  }).allowed;
  const hasControlCommand = core.channel.text.hasControlCommand(rawBody, config as OpenClawConfig);
  const commandGate = resolveControlCommandGate({
    useAccessGroups,
    authorizers: [
      {
        configured: (message.isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom).length > 0,
        allowed: senderAllowedForCommands,
      },
    ],
    allowTextCommands,
    hasControlCommand,
  });
  const commandAuthorized = commandGate.commandAuthorized;

  if (message.isGroup) {
    const senderAllowed = resolveMeshtasticGroupSenderAllowed({
      groupPolicy,
      message,
      outerAllowFrom: effectiveGroupAllowFrom,
      innerAllowFrom: groupAllowFrom,
    });
    if (!senderAllowed) {
      runtime.log?.(`meshtastic: drop group sender ${senderDisplay} (policy=${groupPolicy})`);
      return;
    }
  } else {
    if (dmPolicy === "disabled") {
      runtime.log?.(`meshtastic: drop DM sender=${senderDisplay} (dmPolicy=disabled)`);
      return;
    }
    if (dmPolicy !== "open") {
      const dmAllowed = resolveMeshtasticAllowlistMatch({
        allowFrom: effectiveAllowFrom,
        message,
      }).allowed;
      if (!dmAllowed) {
        if (dmPolicy === "pairing") {
          const normalizedId = normalizeMeshtasticNodeId(message.senderNodeId);
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: CHANNEL_ID,
            accountId: account.accountId,
            id: normalizedId,
            meta: { name: message.senderName || undefined },
          });
          if (created) {
            try {
              const reply = core.channel.pairing.buildPairingReply({
                channel: CHANNEL_ID,
                idLine: `Your node ID: ${normalizedId}`,
                code,
              });
              await deliverMeshtasticReply({
                payload: { text: reply },
                target: message.senderNodeId,
                accountId: account.accountId,
                sendReply: params.sendReply,
                statusSink,
              });
            } catch (err) {
              runtime.error?.(
                `meshtastic: pairing reply failed for ${senderDisplay}: ${String(err)}`,
              );
            }
          }
        }
        runtime.log?.(`meshtastic: drop DM sender ${senderDisplay} (dmPolicy=${dmPolicy})`);
        return;
      }
    }
  }

  if (message.isGroup && commandGate.shouldBlock) {
    logInboundDrop({
      log: (line) => runtime.log?.(line),
      channel: CHANNEL_ID,
      reason: "control command (unauthorized)",
      target: senderDisplay,
    });
    return;
  }

  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config as OpenClawConfig);
  const wasMentioned = core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes);

  const requireMention = message.isGroup
    ? resolveMeshtasticRequireMention({
        groupConfig: groupMatch.groupConfig,
        wildcardConfig: groupMatch.wildcardConfig,
      })
    : false;

  const mentionGate = resolveMeshtasticMentionGate({
    isGroup: message.isGroup,
    requireMention,
    wasMentioned,
    hasControlCommand,
    allowTextCommands,
    commandAuthorized,
  });
  if (mentionGate.shouldSkip) {
    runtime.log?.(`meshtastic: drop channel ${channelLabel} (${mentionGate.reason})`);
    return;
  }

  const peerId = message.isGroup ? channelLabel : message.senderNodeId;
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: message.isGroup ? "group" : "direct",
      id: peerId,
    },
  });

  const fromLabel = message.isGroup ? channelLabel : senderDisplay;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config as OpenClawConfig);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Meshtastic",
    from: fromLabel,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const groupSystemPrompt = groupMatch.groupConfig?.systemPrompt?.trim() || undefined;

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: message.isGroup
      ? `meshtastic:channel:${channelLabel}`
      : `meshtastic:${message.senderNodeId}`,
    To: `meshtastic:${peerId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: message.isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: message.senderName || undefined,
    SenderId: message.senderNodeId,
    GroupSubject: message.isGroup ? channelLabel : undefined,
    GroupSystemPrompt: [LORA_SYSTEM_HINT, groupSystemPrompt].filter(Boolean).join("\n\n"),
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    WasMentioned: message.isGroup ? wasMentioned : undefined,
    MessageSid: message.messageId,
    Timestamp: message.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `meshtastic:${peerId}`,
    CommandAuthorized: commandAuthorized,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`meshtastic: failed updating session meta: ${String(err)}`);
    },
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config as OpenClawConfig,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });
  const deliverReply = createNormalizedOutboundDeliverer(async (payload) => {
    await deliverMeshtasticReply({
      payload,
      target: peerId,
      accountId: account.accountId,
      channelIndex: message.isGroup ? message.channelIndex : undefined,
      channelName: message.isGroup ? message.channelName : undefined,
      chunkLimit: account.config.textChunkLimit,
      sendReply: params.sendReply,
      statusSink,
    });
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config as OpenClawConfig,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: deliverReply,
      onError: (err, info) => {
        runtime.error?.(`meshtastic ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      skillFilter: groupMatch.groupConfig?.skills,
      onModelSelected,
      disableBlockStreaming:
        typeof account.config.blockStreaming === "boolean"
          ? !account.config.blockStreaming
          : undefined,
    },
  });
}
