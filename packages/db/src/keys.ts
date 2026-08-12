export const K = {
  user: (id: string) => `wa:user:${id}`,
  usersAll: "wa:users:all",
  adminIds: "wa:admins",
  session: (sid: string) => `wa:session:${sid}`,
  /** SET of session ids for a user (ban/kick all sessions) */
  sessionsByUser: (userId: string) => `wa:sessions:by:${userId}`,
  oauthState: (state: string) => `wa:oauth:state:${state}`,

  // ── Invites (local password registration) ─────────────
  /** Pending invite code JSON (TTL) */
  invite: (code: string) => `wa:invite:${code}`,
  /** SET of pending invite codes created by user */
  invitesByUser: (userId: string) => `wa:invites:by:${userId}`,
  /** ZSET score=ms of generation events for sliding-window quota */
  inviteGenLog: (userId: string) => `wa:invite:genlog:${userId}`,
  /** Global invite policy overrides (JSON) */
  inviteSettings: "wa:settings:invites",
  /** Admin-editable runtime config overrides on top of env (JSON) */
  runtimeSettings: "wa:settings:runtime",
  /** Short lock serializing the read-modify-write of runtimeSettings */
  runtimeSettingsLock: "wa:settings:runtime:lock",

  bot: (id: string) => `wa:bot:${id}`,
  /** Sensitive iLink bot_token — never expose via list/admin JSON without care */
  botCreds: (id: string) => `wa:bot:${id}:creds`,
  botsAll: "wa:bots:all",
  botsByOwner: (userId: string) => `wa:bots:owner:${userId}`,

  persona: (id: string) => `wa:persona:${id}`,
  personaSlug: (slug: string) => `wa:persona:slug:${slug}`,
  personasAll: "wa:personas:all",
  personasPublic: "wa:personas:public",
  /** Single-key pointer to current default persona id (avoids full list scan) */
  personaDefault: "wa:persona:default",
  personasByOwner: (userId: string) => `wa:personas:owner:${userId}`,
  personaLib: (userId: string) => `wa:user:${userId}:persona_lib`,
  personaVersion: (id: string) => `wa:pver:${id}`,
  personaVersions: (personaId: string) => `wa:persona:${personaId}:versions`,

  peer: (botId: string, peerId: string) => `wa:peer:${botId}:${peerId}`,
  peersByBot: (botId: string) => `wa:peers:bot:${botId}`,
  peersAll: "wa:peers:all",

  assignment: (botId: string, peerId: string) =>
    `wa:asg:${botId}:${peerId}`,

  messages: (botId: string, peerId: string) =>
    `wa:msgs:${botId}:${peerId}`,
  msgCountUser: (botId: string, peerId: string) =>
    `wa:msgcount:${botId}:${peerId}`,

  memories: (botId: string, peerId: string, personaId: string) =>
    `wa:mem:${botId}:${peerId}:${personaId}`,

  contextToken: (botId: string, peerId: string) =>
    `wa:ctx:${botId}:${peerId}`,

  /** Peers with proactive outreach enabled for a bot (SET of peerId) */
  proactivePeersByBot: (botId: string) => `wa:proactive:peers:${botId}`,
  /** Distributed lock while generating/sending a proactive message */
  proactiveLock: (botId: string, peerId: string) =>
    `wa:proactive:lock:${botId}:${peerId}`,
  /** Daily proactive send counter per peer (YYYY-MM-DD) */
  proactiveDayCount: (botId: string, peerId: string, day: string) =>
    `wa:proactive:day:${botId}:${peerId}:${day}`,

  // ── Scheduled services (kept separate from proactive) ─────────────
  scheduledService: (id: string) => `wa:schedule:service:${id}`,
  scheduledServices: "wa:schedule:services",
  scheduledServicePersonas: (id: string) => `wa:schedule:service:${id}:personas`,
  scheduledSubscription: (id: string) => `wa:schedule:subscription:${id}`,
  scheduledSubscriptions: "wa:schedule:subscriptions",
  scheduledSubscriptionsByUser: (userId: string) => `wa:schedule:subscriptions:user:${userId}`,
  scheduledSubscriptionsByPeer: (botId: string, peerId: string) => `wa:schedule:subscriptions:peer:${botId}:${peerId}`,
  scheduledTask: (id: string) => `wa:schedule:task:${id}`,
  scheduledTasks: "wa:schedule:tasks",
  scheduledTasksByUser: (userId: string) => `wa:schedule:tasks:user:${userId}`,
  scheduledTasksByPeer: (botId: string, peerId: string) => `wa:schedule:tasks:peer:${botId}:${peerId}`,
  /** Chat-originated plans only; TTL protects against stale confirmation. */
  scheduledPending: (botId: string, peerId: string) => `wa:schedule:pending:${botId}:${peerId}`,
  /** NX execution gate: source id + scheduled UTC minute. */
  scheduledExecutionLock: (source: string, id: string, minute: string) => `wa:schedule:lock:${source}:${id}:${minute}`,

  audit: "wa:audit",
  usageDay: (day: string) => `wa:usage:day:${day}`,
  usageDayUser: (day: string, userId: string) =>
    `wa:usage:day:${day}:user:${userId}`,
  usageDayBot: (day: string, botId: string) =>
    `wa:usage:day:${day}:bot:${botId}`,
  /** SET index of user ids that spent tokens on `day` (TTL like the hashes) */
  usageDayUsers: (day: string) => `wa:usage:day:${day}:users`,
  /** SET index of bot ids that spent tokens on `day` */
  usageDayBots: (day: string) => `wa:usage:day:${day}:bots`,

  /**
   * Fleet / scale-out keys (single host multi-worker or multi-host).
   * - pollable: bots that should be long-polled (active + token + not paused)
   * - lease: which worker currently owns getUpdates for a bot
   * - inbox: inbound message jobs for reply consumers
   */
  botsPollable: "wa:bots:pollable",
  botLease: (botId: string) => `wa:bot:${botId}:lease`,
  botPaused: (botId: string) => `wa:bot:${botId}:paused`,
  workersReg: "wa:workers:reg",
  workerMeta: (workerId: string) => `wa:worker:${workerId}`,
  workerBots: (workerId: string) => `wa:worker:${workerId}:bots`,
  /**
   * Admin force-offline fence. While present, that worker must not
   * re-register, renew, or claim leases (until cleared).
   */
  workerFence: (workerId: string) => `wa:worker:${workerId}:fence`,
  /** SET of currently fenced worker ids (admin list) */
  workersFenced: "wa:workers:fenced",
  /**
   * HASH workerId → WorkerWeight JSON. Admin load weight in percent
   * (100 = default share). Only nodes with an override have a field.
   * Written by admin actions only.
   */
  workerWeights: "wa:workers:weights",
  /**
   * HASH workerId → ISO timestamp of the last heartbeat the fleet saw for a
   * weighted node. Deliberately separate from `workerWeights`: the GC stamps
   * this on its own cadence, and must never read-modify-write a weight record
   * an admin may be editing at the same moment.
   */
  workerWeightsSeen: "wa:workers:weights:seen",
  /** LIST of JSON InboundJob — RPUSH / BLPOP */
  inbox: "wa:inbox",
  /**
   * Idempotency gate for one inbound WeChat message (SET NX EX).
   * iLink delivers no stable msg_id, so the worker synthesizes a key from
   * bot/peer/create_time_ms/text/media and uses this to stop a re-delivered
   * long-poll batch from spawning a second LLM generation.
   */
  inboundSeen: (dedupKey: string) => `wa:inbound:seen:${dedupKey}`,
  /** Pub/Sub channel — workers re-run claim on "wake" */
  workerWake: "wa:worker:wake",

  /**
   * WeChat QR bot login session (view JSON, TTL).
   * Poll loop stays on the node that started login; any node can read status.
   */
  botLogin: (sessionId: string) => `wa:botlogin:${sessionId}`,
  /** SET of active login session ids for a user (optional cleanup index) */
  botLoginsByOwner: (userId: string) => `wa:botlogin:owner:${userId}`,

  /** Sticker square (blob in Redis; admin review for public) */
  sticker: (id: string) => `wa:sticker:${id}`,
  /** Raw image bytes (binary value) */
  stickerBlob: (id: string) => `wa:sticker:${id}:blob`,
  stickersAll: "wa:stickers:all",
  /** approved + public + enabled — square listing */
  stickersPublic: "wa:stickers:public",
  /** pending review */
  stickersPending: "wa:stickers:pending",
  stickersByOwner: (userId: string) => `wa:stickers:owner:${userId}`,
  stickerSlug: (slug: string) => `wa:sticker:slug:${slug}`,
  stickerLib: (userId: string) => `wa:user:${userId}:sticker_lib`,

  // ── User custom LLM providers (secrets encrypted; egress via HF tools) ──
  llmProvider: (id: string) => `wa:llmp:${id}`,
  llmProvidersByOwner: (userId: string) => `wa:llmp:owner:${userId}`,

  // ── P2P / WeChat ↔ LINUX DO bind ─────────────────────
  /** O(1) username → userId (lowercase) */
  userByName: (lowerUsername: string) => `wa:user:name:${lowerUsername}`,
  /** Primary WeChat bind for a LINUX DO user (JSON UserWechatBind) */
  bindUser: (userId: string) => `wa:bind:user:${userId}`,
  /** Reverse: peer endpoint → userId */
  bindPeer: (botId: string, peerId: string) => `wa:bind:peer:${botId}:${peerId}`,
  /** Single-use bind code (TTL) */
  bindCode: (code: string) => `wa:bind:code:${code}`,
  /** Connect request JSON (TTL) */
  connectReq: (requestId: string) => `wa:connect:req:${requestId}`,
  connectFrom: (botId: string, peerId: string) =>
    `wa:connect:from:${botId}:${peerId}`,
  connectTo: (botId: string, peerId: string) =>
    `wa:connect:to:${botId}:${peerId}`,
  /** Active P2P session JSON (idle TTL, refreshed on activity) */
  p2pSession: (sessionId: string) => `wa:p2p:${sessionId}`,
  p2pPeer: (botId: string, peerId: string) => `wa:p2p:peer:${botId}:${peerId}`,
  /** Daily @ request counter per peer endpoint */
  p2pRequestDay: (botId: string, peerId: string, day: string) =>
    `wa:p2p:reqday:${botId}:${peerId}:${day}`,
  /**
   * SET of blocked LINUX DO userIds for a user.
   * A blocks B → B cannot @ A (and A cannot @ B) for P2P.
   */
  blockSet: (userId: string) => `wa:block:${userId}`,

  // ── Admin broadcast (text push jobs) ───────────────────
  /** Broadcast job JSON */
  broadcast: (id: string) => `wa:broadcast:${id}`,
  /** LIST of recent broadcast job ids (newest first) */
  broadcastsAll: "wa:broadcasts:all",
  /** Distributed lock while a worker processes a job */
  broadcastLock: (id: string) => `wa:broadcast:${id}:lock`,
  /** Optional pointer to currently running job id */
  broadcastActive: "wa:broadcast:active",

  // ── Web try-chat (ephemeral, no WeChat) ───────────────
  /** Try-chat session meta JSON { userId, personaId, botName, createdAt, msgCount } */
  trySession: (sessionId: string) => `wa:try:${sessionId}`,
  /** Try-chat message list (JSON {role,content}) */
  trySessionMsgs: (sessionId: string) => `wa:try:${sessionId}:msgs`,
  /** Daily try-chat user-message counter (YYYY-MM-DD) */
  tryDayCount: (userId: string, day: string) => `wa:try:day:${userId}:${day}`,

  // ── OTA releases (file-level fleet update packs) ───────
  /** Current channel release meta (ReleaseMeta JSON, no blobs) */
  releaseCurrent: "wa:release:current",
  /** Release meta by version string */
  releaseMeta: (version: string) => `wa:release:meta:${version}`,
  /** ZSET score=ms createdAt, member=version — recent versions */
  releaseVersions: "wa:release:versions",
  /** Content-addressed blob index { chunks, size, sha256 } */
  releaseBlobMeta: (sha256: string) => `wa:release:blob:${sha256}`,
  /** Binary chunk n for content hash */
  releaseBlobChunk: (sha256: string, n: number) =>
    `wa:release:blob:${sha256}:${n}`,
  /** Per-worker update job (NodeUpdateJob JSON, TTL) */
  workerUpdate: (workerId: string) => `wa:worker:${workerId}:update`,
  /** Per-worker update progress/status (NodeUpdateStatus JSON, TTL) */
  workerUpdateStatus: (workerId: string) =>
    `wa:worker:${workerId}:update:status`,

  // ── Admin live activity stream (fleet fan-in) ──────────
  /** Pub/Sub channel for important stream events (not redis.cmd samples) */
  streamChannel: "wa:stream:events",
  /** LIST of recent stream events JSON (newest first, LTRIM) */
  streamRecent: "wa:stream:recent",
};
