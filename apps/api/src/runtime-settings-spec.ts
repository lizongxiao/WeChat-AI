import { LOG_LEVELS, VISION_MODES, type AppConfig } from "./config.js";

/**
 * Declarative registry of every runtime-editable config field.
 *
 * Scope rule (see docs/runtime-settings.md): bootstrap-critical config stays
 * env-only — REDIS_URL, LLM_* (platform model creds), LLM_PROVIDER_SECRET,
 * SESSION_COOKIE_NAME / COOKIE_SECURE, PUBLIC_BASE_URL / CORS_ORIGINS,
 * WECHAT_AI_HOST / PORT / TOKEN, LINUXDO_ADMIN_IDS, APP_VERSION.
 * Everything else is editable from the admin panel; env supplies the default.
 */

/** AppConfig fields the admin panel may override. */
export type RuntimeSettingKey =
  // chat
  | "splitReply"
  | "multiBubbleJson"
  | "replyFilterEnabled"
  | "maxReplyChunks"
  | "maxChunkChars"
  | "shortHistoryLimit"
  | "replyDelayMsPerChar"
  | "replyDelayMinMs"
  | "replyDelayMaxMs"
  | "replyDelayFirstMinMs"
  | "replyDelayFirstMaxMs"
  | "replyDelayThinkExtraMs"
  | "allowUnapproved"
  | "peerRatePerMinute"
  // memory
  | "memoryExtractEveryN"
  | "memoryTopK"
  | "memoryFullInjectMax"
  | "memoryMaxItems"
  // sticker
  | "stickerSendEnabled"
  | "maxStickersPerReply"
  | "stickerMaxBytes"
  // search / tools gateway
  | "webSearchEnabled"
  | "webSearchMaxResults"
  | "toolsBaseUrl"
  | "toolsApiKey"
  | "toolsTimeoutMs"
  | "timeToolEnabled"
  | "timeToolTimeZone"
  // chatflow
  | "chatflowMaxSteps"
  | "chatflowMaxNodes"
  | "chatflowHttpAllowlist"
  // proactive
  | "proactiveEnabled"
  | "proactiveIdleHours"
  | "proactiveMinIntervalHours"
  | "proactiveMaxPerDay"
  | "proactiveQuietHours"
  | "proactiveScanIntervalSec"
  | "proactiveMaxPerScan"
  | "proactiveLockTtlSec"
  | "proactiveAttemptCooldownHours"
  // keepalive
  | "keepAliveEnabled"
  | "keepAliveAfterHours"
  | "keepAliveMaxHours"
  | "keepAliveMinIntervalHours"
  | "keepAliveQuietHours"
  | "keepAliveMaxPerScan"
  | "keepAliveDueSoonHours"
  // p2p
  | "p2pEnabled"
  | "p2pBindCodeTtlSec"
  | "p2pRequestTtlSec"
  | "p2pSessionIdleSec"
  | "p2pRelayMaxChars"
  | "p2pMaxRequestsPerDay"
  // try chat
  | "tryChatEnabled"
  | "tryChatMaxUserMsgsPerDay"
  | "tryChatMaxUserMsgsPerSession"
  | "tryChatSessionTtlSec"
  | "tryChatMaxHistory"
  | "personaForkEnabled"
  // auth / invites
  | "linuxdoAuthEnabled"
  | "localAuthEnabled"
  | "passwordMinLength"
  | "inviteRequiredForLocal"
  | "firstUserIsAdmin"
  | "inviteCodeTtlSec"
  | "inviteCodeLength"
  | "inviteMaxPendingPerUser"
  | "inviteQuotaWindowHours"
  | "inviteQuotaMax"
  // inbound media / vision
  | "visionEnabled"
  | "visionMode"
  | "visionModel"
  | "visionCaptionMaxTokens"
  | "visionMaxImages"
  | "inboundMediaMaxBytes"
  | "voiceTranscriptEnabled"
  // worker / scheduling
  | "workerEnabled"
  | "maxBotsPerWorker"
  | "leaseTtlSec"
  | "leaseRenewSec"
  | "rebalanceEnabled"
  | "rebalanceIntervalSec"
  | "rebalanceSlack"
  | "rebalanceMaxPerTick"
  | "workerWeightTtlSec"
  | "replyConcurrency"
  | "inboxMaxLen"
  | "logLevel"
  | "logSlowRequestMs"
  // broadcast
  | "broadcastIntervalMs"
  | "broadcastMaxText"
  | "broadcastHistory"
  // ota / node labels
  | "otaEnabled"
  | "otaAllowInstall"
  | "otaStagingDir"
  | "nodeLabel"
  | "nodeRegion"
  // admin activity stream
  | "dataStreamEnabled"
  | "dataStreamMaxEps"
  | "dataStreamRedisSample";

export type SettingType =
  | "bool"
  | "int"
  | "float"
  | "string"
  | "csv"
  | "secret";

export type SettingGroupId =
  | "chat"
  | "memory"
  | "sticker"
  | "vision"
  | "search"
  | "chatflow"
  | "proactive"
  | "keepalive"
  | "p2p"
  | "trychat"
  | "auth"
  | "worker"
  | "broadcast"
  | "ota"
  | "stream";

export interface SettingGroup {
  id: SettingGroupId;
  label: string;
  desc: string;
}

export const SETTING_GROUPS: SettingGroup[] = [
  { id: "chat", label: "对话与回复", desc: "分条、节奏、历史长度与限流" },
  { id: "memory", label: "长期记忆", desc: "抽取频率与注入条数" },
  { id: "sticker", label: "表情包", desc: "是否允许发送与单条上限" },
  {
    id: "vision",
    label: "入站图片与语音",
    desc: "识别用户发来的图片（默认关）+ 是否采用微信自带的语音转文字（默认开）",
  },
  {
    id: "search",
    label: "联网搜索与工具网关",
    desc: "全局联网开关 + HF tools 出站（人设仍需各自开启联网）",
  },
  { id: "chatflow", label: "Chatflow", desc: "图执行上限与 HTTP 节点白名单" },
  { id: "proactive", label: "主动联系", desc: "闲置唤醒的频率与静默时段" },
  {
    id: "keepalive",
    label: "会话保活",
    desc: "定时订阅用户到期前的短提醒，请对方回一句以续期会话令牌",
  },
  { id: "p2p", label: "用户互聊", desc: "@用户名 转发的时效与配额" },
  { id: "trychat", label: "网页试聊", desc: "试聊开关与每日/每会话配额" },
  { id: "auth", label: "注册与邀请", desc: "本地注册、密码强度与邀请码策略" },
  { id: "worker", label: "Worker 与调度", desc: "租约、再平衡与队列容量" },
  { id: "broadcast", label: "广播", desc: "发送间隔、文本上限与历史保留" },
  { id: "ota", label: "OTA 与节点标签", desc: "在线更新与多节点展示信息" },
  { id: "stream", label: "数据流", desc: "管理端实时活动流（SSE）" },
];

export interface SettingSpec {
  key: RuntimeSettingKey;
  /** Env var supplying the default (shown in the panel) */
  env: string;
  group: SettingGroupId;
  label: string;
  type: SettingType;
  min?: number;
  max?: number;
  step?: number;
  /**
   * Closed set of allowed values for a string setting. Anything else is
   * rejected outright — a free-form string that reaches a strict consumer
   * (pino's log level, say) turns a typo into a boot crash on every node.
   * Rendered as a <select> in the admin panel.
   */
  options?: readonly string[];
  /**
   * Value is baked into Fastify / a worker pool / a boot branch and cannot be
   * hot-applied. Saved to Redis and shown with a「需重启」badge.
   */
  restart?: boolean;
  hint?: string;
}

/**
 * Ordered registry. Order drives the admin panel layout within each group.
 */
export const SETTING_SPECS: SettingSpec[] = [
  // ── 对话与回复 ──
  {
    key: "splitReply",
    env: "SPLIT_REPLY",
    group: "chat",
    label: "多气泡分条发送",
    type: "bool",
    hint: "关闭后一次性发送整段回复",
  },
  {
    key: "multiBubbleJson",
    env: "MULTI_BUBBLE_JSON",
    group: "chat",
    label: "模型直出气泡 JSON",
    type: "bool",
    hint: '要求模型返回 {"messages":[...]}；与二次过滤互斥',
  },
  {
    key: "replyFilterEnabled",
    env: "REPLY_FILTER_ENABLED",
    group: "chat",
    label: "二次 AI 排版过滤",
    type: "bool",
    hint: "额外一次 LLM 调用，成本与延迟翻倍；开启后主模型不再直出 JSON",
  },
  {
    key: "maxReplyChunks",
    env: "MAX_REPLY_CHUNKS",
    group: "chat",
    label: "单次回复最多气泡数",
    type: "int",
    min: 1,
    max: 20,
  },
  {
    key: "maxChunkChars",
    env: "MAX_CHUNK_CHARS",
    group: "chat",
    label: "单个气泡最多字符",
    type: "int",
    min: 16,
    max: 500,
  },
  {
    key: "shortHistoryLimit",
    env: "SHORT_HISTORY_LIMIT",
    group: "chat",
    label: "短期上下文条数",
    type: "int",
    min: 2,
    max: 100,
  },
  {
    key: "replyDelayMsPerChar",
    env: "REPLY_DELAY_MS_PER_CHAR",
    group: "chat",
    label: "每字符打字延迟(ms)",
    type: "int",
    min: 0,
    max: 1000,
  },
  {
    key: "replyDelayMinMs",
    env: "REPLY_DELAY_MIN_MS",
    group: "chat",
    label: "气泡间隔下限(ms)",
    type: "int",
    min: 0,
    max: 60000,
  },
  {
    key: "replyDelayMaxMs",
    env: "REPLY_DELAY_MAX_MS",
    group: "chat",
    label: "气泡间隔上限(ms)",
    type: "int",
    min: 0,
    max: 120000,
  },
  {
    key: "replyDelayFirstMinMs",
    env: "REPLY_DELAY_FIRST_MIN_MS",
    group: "chat",
    label: "首条延迟下限(ms)",
    type: "int",
    min: 0,
    max: 60000,
  },
  {
    key: "replyDelayFirstMaxMs",
    env: "REPLY_DELAY_FIRST_MAX_MS",
    group: "chat",
    label: "首条延迟上限(ms)",
    type: "int",
    min: 0,
    max: 120000,
  },
  {
    key: "replyDelayThinkExtraMs",
    env: "REPLY_DELAY_THINK_EXTRA_MS",
    group: "chat",
    label: "思考额外延迟(ms)",
    type: "int",
    min: 0,
    max: 60000,
  },
  // NOTE: DEFAULT_PERSONA_SLUG is deliberately absent. cfg.defaultPersonaSlug
  // has no consumer — the default persona is resolved from the DB is_default
  // flag (管理台「人设」→ 设默认), so exposing it here would be a control that
  // reports success and does nothing.
  {
    key: "allowUnapproved",
    env: "ALLOW_UNAPPROVED_USERS",
    group: "chat",
    label: "允许未批准用户对话",
    type: "bool",
  },
  {
    key: "peerRatePerMinute",
    env: "PEER_RATE_PER_MINUTE",
    group: "chat",
    label: "单联系人每分钟消息上限",
    type: "int",
    min: 1,
    max: 600,
  },

  // ── 长期记忆 ──
  {
    key: "memoryExtractEveryN",
    env: "MEMORY_EXTRACT_EVERY_N",
    group: "memory",
    label: "每 N 轮抽取一次记忆",
    type: "int",
    min: 1,
    max: 100,
  },
  {
    key: "memoryTopK",
    env: "MEMORY_TOP_K",
    group: "memory",
    label: "超量时注入 Top-K 条",
    type: "int",
    min: 1,
    max: 100,
  },
  {
    key: "memoryFullInjectMax",
    env: "MEMORY_FULL_INJECT_MAX",
    group: "memory",
    label: "全量注入阈值",
    type: "int",
    min: 1,
    max: 200,
    hint: "总条数 ≤ 该值时全部注入，否则走 Top-K",
  },
  {
    key: "memoryMaxItems",
    env: "MEMORY_MAX_ITEMS",
    group: "memory",
    label: "每人设每联系人存储上限",
    type: "int",
    min: 10,
    max: 1000,
  },

  // ── 表情包 ──
  {
    key: "stickerSendEnabled",
    env: "STICKER_SEND_ENABLED",
    group: "sticker",
    label: "允许发送表情包",
    type: "bool",
  },
  {
    key: "maxStickersPerReply",
    env: "MAX_STICKERS_PER_REPLY",
    group: "sticker",
    label: "单次回复最多表情数",
    type: "int",
    min: 0,
    max: 10,
  },
  {
    key: "stickerMaxBytes",
    env: "STICKER_MAX_BYTES",
    group: "sticker",
    label: "上传单图上限(字节)",
    type: "int",
    min: 65536,
    max: 33554432,
    restart: true,
    hint: "Fastify 在注册路由时固化 bodyLimit，需重启后生效",
  },

  // ── 入站图片与语音 ──
  {
    key: "voiceTranscriptEnabled",
    env: "VOICE_TRANSCRIPT_ENABLED",
    group: "vision",
    label: "采用微信的语音转文字",
    type: "bool",
    hint:
      "默认开。转写文字随入站消息一起送达，用它不额外花钱、也不需要任何模型，" +
      "所以与「识别图片」无关。关闭后语音一律回「没听清，麻烦打字」",
  },
  {
    key: "visionEnabled",
    env: "VISION_ENABLED",
    group: "vision",
    label: "识别用户发来的图片",
    type: "bool",
    hint: "关闭时收到图片只回一句「看不了图」，不下载、不调模型",
  },
  {
    key: "visionMode",
    env: "VISION_MODE",
    group: "vision",
    label: "识图方式",
    type: "string",
    options: VISION_MODES,
    hint:
      "caption：先让识图模型把图片转成文字描述，再交给人设模型——**人设模型不需要支持视觉**，" +
      "推荐。direct：把图片原样交给人设模型，要求该模型本身支持视觉",
  },
  {
    key: "visionModel",
    env: "VISION_MODEL",
    group: "vision",
    label: "识图模型",
    type: "string",
    hint:
      "必填，否则图片一律按「看不了」处理。端点用 VISION_BASE_URL / VISION_API_KEY（env-only，" +
      "留空则复用平台 LLM 的）。自定义模型连接始终用连接里的模型，此项对其无效",
  },
  {
    key: "visionCaptionMaxTokens",
    env: "VISION_CAPTION_MAX_TOKENS",
    group: "vision",
    label: "图片描述长度上限(token)",
    type: "int",
    min: 32,
    max: 4000,
    hint: "只在 caption 模式下生效：要的是一句描述，不是一篇作文",
  },
  {
    key: "visionMaxImages",
    env: "VISION_MAX_IMAGES",
    group: "vision",
    label: "单条消息最多识别几张",
    type: "int",
    min: 1,
    max: 8,
  },
  {
    key: "inboundMediaMaxBytes",
    env: "INBOUND_MEDIA_MAX_BYTES",
    group: "vision",
    label: "单个附件下载上限(字节)",
    type: "int",
    min: 65536,
    max: 33554432,
    hint: "解密后的原始大小；转成 base64 会再涨约 1/3",
  },

  // ── 联网搜索与工具网关 ──
  {
    key: "webSearchEnabled",
    env: "WEB_SEARCH_ENABLED",
    group: "search",
    label: "全局联网搜索开关",
    type: "bool",
    hint: "总闸；人设还需各自开启「联网」才会真正检索",
  },
  {
    key: "webSearchMaxResults",
    env: "WEB_SEARCH_MAX_RESULTS",
    group: "search",
    label: "默认搜索结果条数",
    type: "int",
    min: 1,
    max: 10,
    hint: "Chatflow search 节点可用 max_results 覆盖；工具服务硬上限 10",
  },
  {
    key: "toolsBaseUrl",
    env: "TOOLS_BASE_URL",
    group: "search",
    label: "工具网关地址",
    type: "string",
    hint: "HF tools 服务；用户自定义模型与联网搜索的唯一出站口，留空即关闭这两项能力",
  },
  {
    key: "toolsApiKey",
    env: "TOOLS_API_KEY",
    group: "search",
    label: "工具网关密钥",
    type: "secret",
    hint: "留空表示不修改；输入 - 可清空",
  },
  {
    key: "toolsTimeoutMs",
    env: "TOOLS_TIMEOUT_MS",
    group: "search",
    label: "搜索请求超时(ms)",
    type: "int",
    min: 1000,
    max: 120000,
  },
  {
    key: "timeToolEnabled",
    env: "TIME_TOOL_ENABLED",
    group: "search",
    label: "启用 get_current_time 工具",
    type: "bool",
  },
  {
    key: "timeToolTimeZone",
    env: "TIME_TOOL_TIMEZONE",
    group: "search",
    label: "默认时区",
    type: "string",
    hint: "IANA 名称，如 Asia/Shanghai",
  },

  // ── Chatflow ──
  {
    key: "chatflowMaxSteps",
    env: "CHATFLOW_MAX_STEPS",
    group: "chatflow",
    label: "单次执行最多步数",
    type: "int",
    min: 1,
    max: 200,
  },
  {
    key: "chatflowMaxNodes",
    env: "CHATFLOW_MAX_NODES",
    group: "chatflow",
    label: "单图最多节点数",
    type: "int",
    min: 1,
    max: 200,
  },
  {
    key: "chatflowHttpAllowlist",
    env: "CHATFLOW_HTTP_ALLOWLIST",
    group: "chatflow",
    label: "HTTP 节点额外白名单",
    type: "csv",
    hint:
      "逗号分隔的精确 host（不支持通配）；工具网关 host:port 始终允许。" +
      "填单个 * = 放开任意公网地址；内网、回环与云元数据（169.254.169.254 / " +
      "100.100.100.200）始终拦截，重定向逐跳复检。注意白名单全站共享，" +
      "所有人的人设都能请求列表里的地址。",
  },

  // ── 主动联系 ──
  {
    key: "proactiveEnabled",
    env: "PROACTIVE_ENABLED",
    group: "proactive",
    label: "启用主动联系",
    type: "bool",
    hint: "Chatflow 模式人设不参与主动联系",
  },
  {
    key: "proactiveIdleHours",
    env: "PROACTIVE_IDLE_HOURS",
    group: "proactive",
    label: "闲置多少小时后可唤醒",
    type: "int",
    min: 1,
    max: 720,
  },
  {
    key: "proactiveMinIntervalHours",
    env: "PROACTIVE_MIN_INTERVAL_HOURS",
    group: "proactive",
    label: "两次主动最小间隔(小时)",
    type: "int",
    min: 1,
    max: 720,
  },
  {
    key: "proactiveMaxPerDay",
    env: "PROACTIVE_MAX_PER_DAY",
    group: "proactive",
    label: "每人每天最多主动次数",
    type: "int",
    min: 0,
    max: 24,
  },
  {
    key: "proactiveQuietHours",
    env: "PROACTIVE_QUIET_HOURS",
    group: "proactive",
    label: "静默时段",
    type: "string",
    hint: '如 0-8 表示 0 点到 8 点不打扰；留空关闭',
  },
  {
    key: "proactiveScanIntervalSec",
    env: "PROACTIVE_SCAN_INTERVAL_SEC",
    group: "proactive",
    label: "扫描间隔(秒)",
    type: "int",
    min: 30,
    max: 86400,
    hint: "改小后需等当前定时器走完一轮才生效",
  },
  {
    key: "proactiveMaxPerScan",
    env: "PROACTIVE_MAX_PER_SCAN",
    group: "proactive",
    label: "单轮最多发送数",
    type: "int",
    min: 1,
    max: 1000,
  },
  {
    key: "proactiveLockTtlSec",
    env: "PROACTIVE_LOCK_TTL_SEC",
    group: "proactive",
    label: "分布式锁 TTL(秒)",
    type: "int",
    min: 30,
    max: 3600,
  },
  {
    key: "proactiveAttemptCooldownHours",
    env: "PROACTIVE_ATTEMPT_COOLDOWN_HOURS",
    group: "proactive",
    label: "失败重试冷却(小时)",
    type: "int",
    min: 0,
    max: 168,
  },

  // ── 会话保活 ──
  {
    key: "keepAliveEnabled",
    env: "KEEP_ALIVE_ENABLED",
    group: "keepalive",
    label: "启用会话保活",
    type: "bool",
    hint: "只针对有启用订阅或定时任务的用户；与「主动联系」无关",
  },
  {
    key: "keepAliveAfterHours",
    env: "KEEP_ALIVE_AFTER_HOURS",
    group: "keepalive",
    label: "距上次入站多少小时后开始提醒",
    type: "int",
    min: 1,
    max: 72,
  },
  {
    key: "keepAliveMaxHours",
    env: "KEEP_ALIVE_MAX_HOURS",
    group: "keepalive",
    label: "距上次入站超过多少小时停止尝试",
    type: "int",
    min: 2,
    max: 168,
    hint: "超过后会话令牌多半已失效，继续发等于骚扰失败",
  },
  {
    key: "keepAliveMinIntervalHours",
    env: "KEEP_ALIVE_MIN_INTERVAL_HOURS",
    group: "keepalive",
    label: "两次保活最小间隔(小时)",
    type: "int",
    min: 1,
    max: 168,
  },
  {
    key: "keepAliveQuietHours",
    env: "KEEP_ALIVE_QUIET_HOURS",
    group: "keepalive",
    label: "独立提醒静默时段",
    type: "string",
    hint: "如 22-8；留空关闭。定时天气仍按原计划发送",
  },
  {
    key: "keepAliveMaxPerScan",
    env: "KEEP_ALIVE_MAX_PER_SCAN",
    group: "keepalive",
    label: "每轮最多提醒人数",
    type: "int",
    min: 1,
    max: 100,
  },
  {
    key: "keepAliveDueSoonHours",
    env: "KEEP_ALIVE_DUE_SOON_HOURS",
    group: "keepalive",
    label: "定时即将发送则跳过独立提醒(小时)",
    type: "int",
    min: 0,
    max: 24,
    hint: "避免早上天气和保活连发",
  },

  // ── 用户互聊 ──
  { key: "p2pEnabled", env: "P2P_ENABLED", group: "p2p", label: "启用用户互聊", type: "bool" },
  {
    key: "p2pBindCodeTtlSec",
    env: "P2P_BIND_CODE_TTL_SEC",
    group: "p2p",
    label: "绑定码有效期(秒)",
    type: "int",
    min: 60,
    max: 86400,
  },
  {
    key: "p2pRequestTtlSec",
    env: "P2P_REQUEST_TTL_SEC",
    group: "p2p",
    label: "会话请求有效期(秒)",
    type: "int",
    min: 30,
    max: 86400,
  },
  {
    key: "p2pSessionIdleSec",
    env: "P2P_SESSION_IDLE_SEC",
    group: "p2p",
    label: "会话闲置超时(秒)",
    type: "int",
    min: 60,
    max: 86400,
  },
  {
    key: "p2pRelayMaxChars",
    env: "P2P_RELAY_MAX_CHARS",
    group: "p2p",
    label: "单条转发字数上限",
    type: "int",
    min: 10,
    max: 5000,
  },
  {
    key: "p2pMaxRequestsPerDay",
    env: "P2P_MAX_REQUESTS_PER_DAY",
    group: "p2p",
    label: "每人每天发起上限",
    type: "int",
    min: 0,
    max: 1000,
  },

  // ── 网页试聊 ──
  {
    key: "tryChatEnabled",
    env: "TRY_CHAT_ENABLED",
    group: "trychat",
    label: "启用网页试聊",
    type: "bool",
  },
  {
    key: "tryChatMaxUserMsgsPerDay",
    env: "TRY_CHAT_MAX_USER_MSGS_PER_DAY",
    group: "trychat",
    label: "每人每天消息上限",
    type: "int",
    min: 1,
    max: 10000,
  },
  {
    key: "tryChatMaxUserMsgsPerSession",
    env: "TRY_CHAT_MAX_USER_MSGS_PER_SESSION",
    group: "trychat",
    label: "每会话消息上限",
    type: "int",
    min: 1,
    max: 1000,
  },
  {
    key: "tryChatSessionTtlSec",
    env: "TRY_CHAT_SESSION_TTL_SEC",
    group: "trychat",
    label: "会话有效期(秒)",
    type: "int",
    min: 60,
    max: 86400,
  },
  {
    key: "tryChatMaxHistory",
    env: "TRY_CHAT_MAX_HISTORY",
    group: "trychat",
    label: "保留历史条数",
    type: "int",
    min: 2,
    max: 200,
  },
  {
    key: "personaForkEnabled",
    env: "PERSONA_FORK_ENABLED",
    group: "trychat",
    label: "允许复制他人人设",
    type: "bool",
  },

  // ── 注册与邀请 ──
  {
    key: "linuxdoAuthEnabled",
    env: "LINUXDO_AUTH_ENABLED",
    group: "auth",
    label: "启用 LINUX DO 登录",
    type: "bool",
    hint: "关闭后「使用 LINUX DO 登录」按钮隐藏，login/callback 一律拒绝（需已配置 LINUXDO_CLIENT_*）",
  },
  {
    key: "localAuthEnabled",
    env: "LOCAL_AUTH_ENABLED",
    group: "auth",
    label: "启用用户名密码登录",
    type: "bool",
  },
  {
    key: "passwordMinLength",
    env: "PASSWORD_MIN_LENGTH",
    group: "auth",
    label: "密码最短长度",
    type: "int",
    min: 4,
    max: 128,
  },
  {
    key: "inviteRequiredForLocal",
    env: "INVITE_REQUIRED_FOR_LOCAL",
    group: "auth",
    label: "本地注册需要邀请码",
    type: "bool",
    hint: "OAuth 登录不受此限制",
  },
  {
    key: "firstUserIsAdmin",
    env: "FIRST_USER_IS_ADMIN",
    group: "auth",
    label: "首位注册用户成为超管",
    type: "bool",
  },
  {
    key: "inviteCodeTtlSec",
    env: "INVITE_CODE_TTL_SEC",
    group: "auth",
    label: "邀请码有效期(秒)",
    type: "int",
    min: 60,
    max: 31536000,
    hint: "「系统」页的邀请注册策略会覆盖此默认值",
  },
  {
    key: "inviteCodeLength",
    env: "INVITE_CODE_LENGTH",
    group: "auth",
    label: "邀请码长度",
    type: "int",
    min: 6,
    max: 32,
  },
  {
    key: "inviteMaxPendingPerUser",
    env: "INVITE_MAX_PENDING_PER_USER",
    group: "auth",
    label: "每人未使用邀请码上限",
    type: "int",
    min: 1,
    max: 1000,
  },
  {
    key: "inviteQuotaWindowHours",
    env: "INVITE_QUOTA_WINDOW_HOURS",
    group: "auth",
    label: "邀请配额窗口(小时)",
    type: "int",
    min: 0,
    max: 8760,
  },
  {
    key: "inviteQuotaMax",
    env: "INVITE_QUOTA_MAX",
    group: "auth",
    label: "每窗口最多生成数",
    type: "int",
    min: 0,
    max: 1000,
  },

  // ── Worker 与调度 ──
  {
    key: "workerEnabled",
    env: "WORKER_ENABLED",
    group: "worker",
    label: "本进程运行 Worker",
    type: "bool",
    restart: true,
    hint: "worker.start() 只在启动时执行一次",
  },
  {
    key: "maxBotsPerWorker",
    env: "MAX_BOTS_PER_WORKER",
    group: "worker",
    label: "单节点最多轮询机器人",
    type: "int",
    min: 1,
    max: 100000,
  },
  {
    key: "leaseTtlSec",
    env: "LEASE_TTL_SEC",
    group: "worker",
    label: "租约 TTL(秒)",
    type: "int",
    min: 15,
    max: 3600,
    hint: "必须大于续约间隔，否则节点会在续约前丢失租约",
  },
  {
    key: "leaseRenewSec",
    env: "LEASE_RENEW_SEC",
    group: "worker",
    label: "租约续约间隔(秒)",
    type: "int",
    min: 5,
    max: 600,
  },
  {
    key: "rebalanceEnabled",
    env: "REBALANCE_ENABLED",
    group: "worker",
    label: "启用多节点再平衡",
    type: "bool",
  },
  {
    key: "rebalanceIntervalSec",
    env: "REBALANCE_INTERVAL_SEC",
    group: "worker",
    label: "再平衡最小间隔(秒)",
    type: "int",
    min: 15,
    max: 3600,
  },
  {
    key: "rebalanceSlack",
    env: "REBALANCE_SLACK",
    group: "worker",
    label: "超出公平份额容忍量",
    type: "int",
    min: 0,
    max: 1000,
  },
  {
    key: "rebalanceMaxPerTick",
    env: "REBALANCE_MAX_PER_TICK",
    group: "worker",
    label: "单轮最多释放租约数",
    type: "int",
    min: 1,
    max: 10000,
  },
  {
    key: "workerWeightTtlSec",
    env: "WORKER_WEIGHT_TTL_SEC",
    group: "worker",
    label: "节点负载权重保留时长(秒)",
    hint: "节点心跳消失多久后自动删除其负载权重。需长于一次重启 / OTA 应用，否则每次发版都会重置调节。",
    type: "int",
    min: 60,
    max: 2592000,
  },
  {
    key: "replyConcurrency",
    env: "REPLY_CONCURRENCY",
    group: "worker",
    label: "回复消费者并发数",
    type: "int",
    min: 1,
    max: 512,
    restart: true,
    hint: "消费者池在 start() 时一次性拉起，缩容需重启",
  },
  {
    key: "inboxMaxLen",
    env: "INBOX_MAX_LEN",
    group: "worker",
    label: "进程内队列深度上限",
    type: "int",
    min: 100,
    max: 1000000,
  },
  {
    key: "logLevel",
    env: "LOG_LEVEL",
    group: "worker",
    label: "日志级别",
    type: "string",
    // Closed set on purpose: pino throws on an unknown level at Fastify
    // construction, so a free-form typo here would crash-loop every node on
    // its next restart with no way in through the admin API to undo it.
    options: LOG_LEVELS,
    restart: true,
    hint: "Fastify 在创建实例时固化 logger，需重启后生效",
  },
  {
    key: "logSlowRequestMs",
    env: "LOG_SLOW_REQUEST_MS",
    group: "worker",
    label: "慢请求告警阈值(ms)",
    type: "int",
    min: 50,
    max: 60000,
    hint: "超过此耗时的成功请求按 warn 记录；读取时取当前值，无需重启",
  },

  // ── 广播 ──
  {
    key: "broadcastIntervalMs",
    env: "BROADCAST_INTERVAL_MS",
    group: "broadcast",
    label: "消息间隔(ms)",
    type: "int",
    min: 50,
    max: 60000,
  },
  {
    key: "broadcastMaxText",
    env: "BROADCAST_MAX_TEXT",
    group: "broadcast",
    label: "文本长度上限",
    type: "int",
    min: 1,
    max: 20000,
  },
  {
    key: "broadcastHistory",
    env: "BROADCAST_HISTORY",
    group: "broadcast",
    label: "保留历史任务数",
    type: "int",
    min: 1,
    max: 10000,
  },

  // ── OTA 与节点标签 ──
  { key: "otaEnabled", env: "OTA_ENABLED", group: "ota", label: "启用 OTA 更新", type: "bool" },
  {
    key: "otaAllowInstall",
    env: "OTA_ALLOW_INSTALL",
    group: "ota",
    label: "OTA 允许执行安装",
    type: "bool",
    hint: "锁文件/package.json 变化时才会触发 pnpm install",
  },
  {
    key: "otaStagingDir",
    env: "OTA_STAGING_DIR",
    group: "ota",
    label: "OTA 暂存目录",
    type: "string",
  },
  { key: "nodeLabel", env: "NODE_LABEL", group: "ota", label: "节点标签", type: "string" },
  { key: "nodeRegion", env: "NODE_REGION", group: "ota", label: "节点区域", type: "string" },

  // ── 数据流 ──
  {
    key: "dataStreamEnabled",
    env: "DATA_STREAM_ENABLED",
    group: "stream",
    label: "启用实时活动流",
    type: "bool",
  },
  {
    key: "dataStreamMaxEps",
    env: "DATA_STREAM_MAX_EPS",
    group: "stream",
    label: "每秒事件上限",
    type: "int",
    min: 5,
    max: 10000,
  },
  {
    key: "dataStreamRedisSample",
    env: "DATA_STREAM_REDIS_SAMPLE",
    group: "stream",
    label: "Redis 命令采样率",
    type: "float",
    min: 0,
    max: 1,
    step: 0.01,
  },
];

export const SETTING_SPEC_BY_KEY = new Map<RuntimeSettingKey, SettingSpec>(
  SETTING_SPECS.map((s) => [s.key, s]),
);

export function isRuntimeSettingKey(k: string): k is RuntimeSettingKey {
  return SETTING_SPEC_BY_KEY.has(k as RuntimeSettingKey);
}

/** Stored/serialized form of a setting value (JSON-safe). */
export type SettingValue = string | number | boolean;

/**
 * Coerce + clamp one raw input into the spec's type.
 * Returns null when the value is unusable (caller keeps the previous value).
 */
export function coerceSetting(
  spec: SettingSpec,
  raw: unknown,
): SettingValue | null {
  switch (spec.type) {
    case "bool": {
      if (typeof raw === "boolean") return raw;
      if (typeof raw === "string") {
        const s = raw.trim().toLowerCase();
        if (s === "true" || s === "1") return true;
        if (s === "false" || s === "0") return false;
      }
      if (typeof raw === "number") return raw !== 0;
      return null;
    }
    case "int":
    case "float": {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) return null;
      let v = spec.type === "int" ? Math.round(n) : n;
      if (spec.min !== undefined) v = Math.max(spec.min, v);
      if (spec.max !== undefined) v = Math.min(spec.max, v);
      return v;
    }
    case "csv": {
      const s = Array.isArray(raw)
        ? raw.join(",")
        : typeof raw === "string"
          ? raw
          : String(raw ?? "");
      return s
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
        .join(",");
    }
    case "string":
    case "secret": {
      let s: string;
      if (typeof raw !== "string") {
        if (raw === null || raw === undefined) return null;
        s = String(raw).trim();
      } else {
        s = raw.trim();
      }
      // Reject rather than clamp: silently substituting a value for a closed
      // set would hide the typo instead of surfacing it.
      if (spec.options && !spec.options.includes(s)) return null;
      return s;
    }
  }
}

/** AppConfig value → JSON-safe stored form. */
export function configToSettingValue(
  spec: SettingSpec,
  cfg: AppConfig,
): SettingValue {
  const v = (cfg as unknown as Record<string, unknown>)[spec.key];
  if (spec.type === "csv") {
    return Array.isArray(v) ? v.join(",") : String(v ?? "");
  }
  if (spec.type === "bool") return Boolean(v);
  if (spec.type === "int" || spec.type === "float") return Number(v ?? 0);
  return String(v ?? "");
}

/** Stored form → the shape AppConfig expects for that field. */
export function settingValueToConfig(
  spec: SettingSpec,
  value: SettingValue,
): unknown {
  if (spec.type === "csv") {
    return String(value)
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
  }
  return value;
}
