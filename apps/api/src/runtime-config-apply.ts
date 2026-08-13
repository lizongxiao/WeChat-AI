import type { ChatService, TryChatService } from "@wechat-ai/core";
import type { ActivityBus } from "./activity-stream.js";
import type { AppConfig } from "./config.js";
import type { RuntimeSettingKey } from "./runtime-settings-spec.js";
import type { BotWorkerManager } from "./worker.js";

export interface RuntimeConfigTargets {
  chat: ChatService;
  tryChat: TryChatService;
  worker: BotWorkerManager;
  activityBus: ActivityBus;
}

/**
 * Keys whose change requires re-pushing a subsystem's options.
 *
 * Deliberately coarse: when any key in a set changes we re-push that whole
 * subsystem from the current `cfg`. The push is idempotent and cheap, and it
 * keeps this file from drifting into a per-key dispatch table that silently
 * misses a field when someone adds one.
 */
const CHAT_KEYS: RuntimeSettingKey[] = [
  "shortHistoryLimit",
  "memoryExtractEveryN",
  "allowUnapproved",
  "multiBubbleJson",
  "replyFilterEnabled",
  "maxReplyChunks",
  "maxChunkChars",
  "maxStickersPerReply",
  "stickerSendEnabled",
  "memoryTopK",
  "memoryFullInjectMax",
  "memoryMaxItems",
  "timeToolEnabled",
  "timeToolTimeZone",
  "webSearchEnabled",
  "webSearchMaxResults",
  "toolsBaseUrl",
  "toolsApiKey",
  "toolsTimeoutMs",
  "chatflowHttpAllowlist",
  "chatflowMaxSteps",
  "chatflowMaxNodes",
  "visionMode",
  "visionModel",
  "visionCaptionMaxTokens",
];

const TRYCHAT_KEYS: RuntimeSettingKey[] = [
  "tryChatSessionTtlSec",
  "tryChatMaxHistory",
  "tryChatMaxUserMsgsPerDay",
  "tryChatMaxUserMsgsPerSession",
  "multiBubbleJson",
  "replyFilterEnabled",
  "maxReplyChunks",
  "maxChunkChars",
  "timeToolEnabled",
  "timeToolTimeZone",
  "toolsBaseUrl",
  "toolsApiKey",
  "toolsTimeoutMs",
  "webSearchEnabled",
  "webSearchMaxResults",
  "chatflowHttpAllowlist",
  "chatflowMaxSteps",
  "chatflowMaxNodes",
];

const WORKER_KEYS: RuntimeSettingKey[] = [
  "stickerSendEnabled",
  "maxStickersPerReply",
  "visionEnabled",
  "visionMaxImages",
  "voiceTranscriptEnabled",
  "inboundMediaMaxBytes",
  "splitReply",
  "replyDelayMsPerChar",
  "replyDelayMinMs",
  "replyDelayMaxMs",
  "replyDelayFirstMinMs",
  "replyDelayFirstMaxMs",
  "replyDelayThinkExtraMs",
  "peerRatePerMinute",
  "maxBotsPerWorker",
  "leaseTtlSec",
  "leaseRenewSec",
  "rebalanceEnabled",
  "rebalanceIntervalSec",
  "rebalanceSlack",
  "rebalanceMaxPerTick",
  "workerWeightTtlSec",
  "inboxMaxLen",
  "proactiveEnabled",
  "proactiveIdleHours",
  "proactiveMinIntervalHours",
  "proactiveMaxPerDay",
  "proactiveQuietHours",
  "proactiveScanIntervalSec",
  "proactiveMaxPerScan",
  "proactiveLockTtlSec",
  "proactiveAttemptCooldownHours",
  "keepAliveEnabled",
  "keepAliveAfterHours",
  "keepAliveMaxHours",
  "keepAliveMinIntervalHours",
  "keepAliveQuietHours",
  "keepAliveMaxPerScan",
  "keepAliveDueSoonHours",
  "broadcastIntervalMs",
  "p2pEnabled",
  "p2pBindCodeTtlSec",
  "p2pRequestTtlSec",
  "p2pSessionIdleSec",
  "p2pRelayMaxChars",
  "p2pMaxRequestsPerDay",
  "nodeLabel",
  "nodeRegion",
  "otaEnabled",
  "otaAllowInstall",
  "otaStagingDir",
];

const STREAM_KEYS: RuntimeSettingKey[] = [
  "dataStreamEnabled",
  "dataStreamMaxEps",
  "dataStreamRedisSample",
];

function touched(
  changed: Set<RuntimeSettingKey>,
  keys: RuntimeSettingKey[],
): boolean {
  return keys.some((k) => changed.has(k));
}

/**
 * Push the current effective config into services that snapshot their options
 * at construction. Route handlers need nothing here — they read `ctx.cfg.*`
 * per request and `cfg` is mutated in place by the settings manager.
 */
export function applyRuntimeConfigToServices(
  changed: Set<RuntimeSettingKey>,
  cfg: AppConfig,
  targets: RuntimeConfigTargets,
): void {
  if (touched(changed, CHAT_KEYS)) {
    targets.chat.applyRuntimeOptions({
      shortHistoryLimit: cfg.shortHistoryLimit,
      memoryExtractEveryN: cfg.memoryExtractEveryN,
      allowUnapproved: cfg.allowUnapproved,
      multiBubbleJson: cfg.multiBubbleJson,
      replyFilterEnabled: cfg.replyFilterEnabled,
      maxReplyBubbles: cfg.maxReplyChunks,
      maxChunkChars: cfg.maxChunkChars,
      maxStickersPerReply: cfg.maxStickersPerReply,
      stickersEnabled: cfg.stickerSendEnabled,
      memoryTopK: cfg.memoryTopK,
      memoryFullInjectMax: cfg.memoryFullInjectMax,
      memoryMaxItems: cfg.memoryMaxItems,
      timeToolEnabled: cfg.timeToolEnabled,
      timeToolTimeZone: cfg.timeToolTimeZone,
      webSearchEnabled: cfg.webSearchEnabled,
      webSearchMaxResults: cfg.webSearchMaxResults,
      toolsBaseUrl: cfg.toolsBaseUrl || undefined,
      toolsApiKey: cfg.toolsApiKey || undefined,
      toolsTimeoutMs: cfg.toolsTimeoutMs,
      chatflowHttpAllowHosts: cfg.chatflowHttpAllowlist,
      chatflowMaxSteps: cfg.chatflowMaxSteps,
      chatflowMaxNodes: cfg.chatflowMaxNodes,
      visionMode: cfg.visionMode,
      visionModel: cfg.visionModel || undefined,
      visionCaptionMaxTokens: cfg.visionCaptionMaxTokens,
    });
  }

  if (touched(changed, TRYCHAT_KEYS)) {
    targets.tryChat.applyRuntimeOptions({
      sessionTtlSec: cfg.tryChatSessionTtlSec,
      maxHistory: cfg.tryChatMaxHistory,
      maxUserMsgsPerDay: cfg.tryChatMaxUserMsgsPerDay,
      maxUserMsgsPerSession: cfg.tryChatMaxUserMsgsPerSession,
      multiBubbleJson: cfg.multiBubbleJson,
      replyFilterEnabled: cfg.replyFilterEnabled,
      maxReplyBubbles: cfg.maxReplyChunks,
      maxChunkChars: cfg.maxChunkChars,
      timeToolEnabled: cfg.timeToolEnabled,
      timeToolTimeZone: cfg.timeToolTimeZone,
      toolsBaseUrl: cfg.toolsBaseUrl || undefined,
      toolsApiKey: cfg.toolsApiKey || undefined,
      toolsTimeoutMs: cfg.toolsTimeoutMs,
      webSearchEnabled: cfg.webSearchEnabled,
      webSearchMaxResults: cfg.webSearchMaxResults,
      chatflowHttpAllowHosts: cfg.chatflowHttpAllowlist,
      chatflowMaxSteps: cfg.chatflowMaxSteps,
      chatflowMaxNodes: cfg.chatflowMaxNodes,
    });
  }

  if (touched(changed, WORKER_KEYS)) {
    targets.worker.applyRuntimeConfig({
      stickerSendEnabled: cfg.stickerSendEnabled,
      maxStickersPerReply: cfg.maxStickersPerReply,
      visionEnabled: cfg.visionEnabled,
      visionMaxImages: cfg.visionMaxImages,
      voiceTranscriptEnabled: cfg.voiceTranscriptEnabled,
      inboundMediaMaxBytes: cfg.inboundMediaMaxBytes,
      splitReply: cfg.splitReply,
      peerRatePerMinute: cfg.peerRatePerMinute,
      maxBotsPerWorker: cfg.maxBotsPerWorker,
      leaseTtlSec: cfg.leaseTtlSec,
      leaseRenewSec: cfg.leaseRenewSec,
      rebalanceEnabled: cfg.rebalanceEnabled,
      rebalanceIntervalSec: cfg.rebalanceIntervalSec,
      rebalanceSlack: cfg.rebalanceSlack,
      rebalanceMaxPerTick: cfg.rebalanceMaxPerTick,
      workerWeightTtlSec: cfg.workerWeightTtlSec,
      inboxMaxLen: cfg.inboxMaxLen,
      replyDelay: {
        msPerChar: cfg.replyDelayMsPerChar,
        minMs: cfg.replyDelayMinMs,
        maxMs: cfg.replyDelayMaxMs,
        firstMinMs: cfg.replyDelayFirstMinMs,
        firstMaxMs: cfg.replyDelayFirstMaxMs,
        thinkExtraMs: cfg.replyDelayThinkExtraMs,
      },
      proactive: {
        globalEnabled: cfg.proactiveEnabled,
        defaultIdleHours: cfg.proactiveIdleHours,
        defaultMinIntervalHours: cfg.proactiveMinIntervalHours,
        defaultMaxPerDay: cfg.proactiveMaxPerDay,
        defaultQuietHours: cfg.proactiveQuietHours,
        scanIntervalSec: cfg.proactiveScanIntervalSec,
        maxPerScan: cfg.proactiveMaxPerScan,
        lockTtlSec: cfg.proactiveLockTtlSec,
        attemptCooldownHours: cfg.proactiveAttemptCooldownHours,
      },
      keepAlive: {
        enabled: cfg.keepAliveEnabled,
        afterHours: cfg.keepAliveAfterHours,
        maxHours: cfg.keepAliveMaxHours,
        minIntervalHours: cfg.keepAliveMinIntervalHours,
        quietHours: cfg.keepAliveQuietHours,
        quietTimeZone: cfg.timeToolTimeZone || "Asia/Shanghai",
        dueSoonHours: cfg.keepAliveDueSoonHours,
        maxPerScan: cfg.keepAliveMaxPerScan,
        lockTtlSec: 180,
      },
      broadcast: {
        intervalMs: cfg.broadcastIntervalMs,
        pollIntervalMs: 2_000,
        lockTtlSec: 60,
      },
      p2pEnabled: cfg.p2pEnabled,
      p2p: {
        bindCodeTtlSec: cfg.p2pBindCodeTtlSec,
        requestTtlSec: cfg.p2pRequestTtlSec,
        sessionIdleSec: cfg.p2pSessionIdleSec,
        relayMaxChars: cfg.p2pRelayMaxChars,
        maxRequestsPerDay: cfg.p2pMaxRequestsPerDay,
      },
      nodeLabel: cfg.nodeLabel,
      nodeRegion: cfg.nodeRegion,
      otaEnabled: cfg.otaEnabled,
      otaAllowInstall: cfg.otaAllowInstall,
      otaStagingDir: cfg.otaStagingDir,
    });
  }

  if (touched(changed, STREAM_KEYS)) {
    targets.activityBus.applyRuntimeOptions({
      enabled: cfg.dataStreamEnabled,
      maxEps: cfg.dataStreamMaxEps,
      redisSample: cfg.dataStreamRedisSample,
    });
  }
}
