import path from "node:path";
import { constants as zlibConstants } from "node:zlib";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import compress from "@fastify/compress";
import { ChatService, TryChatService } from "@wechat-ai/core";
import { openDatabase, seedPersonas, setRedisCommandHook } from "@wechat-ai/db";
import { LlmClient } from "@wechat-ai/llm";
import { BotLoginSessionManager } from "./bot-login-sessions.js";
import {
  CC_HTML_APP,
  CC_HTML_MARKETING,
  CC_OG,
  CDN_HTML_APP,
  CDN_HTML_MARKETING,
  CDN_OG,
  ifNoneMatchHits,
  setPublicCache,
} from "./cache-headers.js";
import { initActivityBus } from "./activity-stream.js";
import { LOG_LEVELS, loadConfig } from "./config.js";
import { registerRoutes } from "./routes.js";
import {
  buildFastifyOptions,
  registerRequestLogging,
} from "./server-options.js";
import { RuntimeConfigManager } from "./runtime-config.js";
import {
  applyRuntimeConfigToServices,
  type RuntimeConfigTargets,
} from "./runtime-config-apply.js";
import {
  loadStaticAssets,
  pickEncoded,
  upgradeStaticCompression,
} from "./static-pages.js";
import { BotWorkerManager } from "./worker.js";
import { loadLinuxDoConfig } from "./oauth-linuxdo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The bot worker runs in this same process/event loop. A stray rejection from
// any of its detached loops must not take the HTTP server down with it.
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandled rejection (kept alive):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaught exception (kept alive):", err);
});

async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log(`[config] repoRoot=${cfg.repoRoot}`);
  console.log(`[config] redis=${cfg.redisUrl}`);
  console.log(
    `[config] stickers=redis blob (max ${cfg.stickerMaxBytes} bytes)`,
  );

  const db = openDatabase(cfg.redisUrl);
  try {
    await db.ping();
    console.log("[redis] PONG");
  } catch (err) {
    console.error(
      "[redis] 无法连接 REDIS_URL，请检查远端 Redis：",
      cfg.redisUrl,
      err,
    );
    process.exit(1);
  }

  await seedPersonas(db);

  // Redis-stored admin overrides on top of env. Loaded BEFORE any service is
  // constructed so boot already uses the effective values; the fan-out target
  // is filled in once the services exist, and the 5s poll starts after that.
  let runtimeTargets: RuntimeConfigTargets | null = null;
  const settings = new RuntimeConfigManager(db, cfg, (changed, live) => {
    if (runtimeTargets) {
      applyRuntimeConfigToServices(changed, live, runtimeTargets);
    }
  });
  await settings.init();
  {
    const v = settings.view();
    console.log(
      `[settings] runtime overrides=${v.overriddenCount}/${v.items.length}` +
        (v.updatedAt ? ` updatedAt=${v.updatedAt} by=${v.updatedBy}` : ""),
    );
    for (const w of settings.currentWarnings()) console.warn(`[settings] ${w}`);
  }

  const activityBus = initActivityBus({
    db,
    source: process.env.WORKER_ID?.trim() || "api",
    enabled: cfg.dataStreamEnabled,
    maxEps: cfg.dataStreamMaxEps,
    redisSample: cfg.dataStreamRedisSample,
  });
  // Installed unconditionally: noteRedisCmd() no-ops while the bus is
  // disabled, and the admin panel can turn DATA_STREAM_ENABLED on at runtime —
  // a boot-time branch here would leave that switch permanently dead.
  setRedisCommandHook((info) => activityBus.noteRedisCmd(info));
  if (cfg.dataStreamEnabled) {
    void activityBus.start().then(() => {
      console.log(
        `[stream] activity bus on sample=${cfg.dataStreamRedisSample} maxEps=${cfg.dataStreamMaxEps}`,
      );
    });
  }

  // Platform (admin) LLM: direct. User custom APIs + search: TOOLS gateway only.
  const llm = LlmClient.forPlatform({
    baseURL: cfg.llmBaseUrl,
    apiKey: cfg.llmApiKey || "missing",
    model: cfg.llmModel,
    toolsBaseUrl: cfg.toolsBaseUrl || undefined,
    toolsApiKey: cfg.toolsApiKey || undefined,
  });
  if (!cfg.llmApiKey) {
    console.warn("[warn] LLM_API_KEY not set (platform / admin LLM)");
  }
  if (cfg.webSearchEnabled && !cfg.toolsBaseUrl) {
    console.warn(
      "[warn] WEB_SEARCH_ENABLED but TOOLS_BASE_URL empty — search will fail until HF tools is configured",
    );
  }
  if (cfg.toolsBaseUrl) {
    console.log(`[config] tools gateway=${cfg.toolsBaseUrl} (user custom LLM + search)`);
  } else {
    console.log(
      "[config] TOOLS_BASE_URL not set — user custom LLM APIs and web search unavailable",
    );
  }

  /**
   * Vision endpoint for reading inbound images.
   *
   * Separate from the platform LLM on purpose: the roleplay model is usually
   * text-only (deepseek et al), so caption mode sends the image to a
   * vision-capable endpoint and passes only its text description onward.
   * Base/key default to the platform LLM's, which covers providers that host a
   * vision model alongside the chat model.
   */
  const visionLlm = cfg.visionEnabled
    ? LlmClient.forPlatform({
        baseURL: cfg.visionBaseUrl || cfg.llmBaseUrl,
        apiKey: cfg.visionApiKey || cfg.llmApiKey || "missing",
        model: cfg.visionModel || cfg.llmModel,
        maxTokens: cfg.visionCaptionMaxTokens,
      })
    : null;
  if (cfg.visionEnabled) {
    if (!cfg.visionModel) {
      console.warn(
        "[warn] VISION_ENABLED=true but VISION_MODEL is empty — images will be reported as unreadable. Set VISION_MODEL to a vision-capable model id.",
      );
    } else {
      console.log(
        `[config] vision mode=${cfg.visionMode} model=${cfg.visionModel} base=${
          cfg.visionBaseUrl || cfg.llmBaseUrl
        }`,
      );
    }
  }

  const publicBase = cfg.publicBaseUrl.replace(/\/$/, "");
  const chat = new ChatService(
    db,
    llm,
    {
      shortHistoryLimit: cfg.shortHistoryLimit,
      memoryExtractEveryN: cfg.memoryExtractEveryN,
      allowUnapproved: cfg.allowUnapproved,
      unapprovedReply:
        `账号尚未开通对话权限。请前往网页端批准对话权限！\n（此项目为公益免费项目！使用文档：${publicBase}/docs）`,
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
      toolsBaseUrl: cfg.toolsBaseUrl || undefined,
      toolsApiKey: cfg.toolsApiKey || undefined,
      llmProviderSecret: cfg.llmProviderSecret || undefined,
      chatflowHttpAllowHosts: cfg.chatflowHttpAllowlist,
      chatflowMaxSteps: cfg.chatflowMaxSteps,
      chatflowMaxNodes: cfg.chatflowMaxNodes,
      visionMode: cfg.visionMode,
      visionModel: cfg.visionModel || undefined,
      visionCaptionMaxTokens: cfg.visionCaptionMaxTokens,
    },
    visionLlm,
  );

  const tryChat = new TryChatService(db, llm, {
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
    webSearchEnabled: cfg.webSearchEnabled,
    chatflowHttpAllowHosts: cfg.chatflowHttpAllowlist,
    chatflowMaxSteps: cfg.chatflowMaxSteps,
    chatflowMaxNodes: cfg.chatflowMaxNodes,
  });

  const worker = new BotWorkerManager({
    db,
    chat,
    stickerSendEnabled: cfg.stickerSendEnabled,
    maxStickersPerReply: cfg.maxStickersPerReply,
    visionEnabled: cfg.visionEnabled,
    visionMaxImages: cfg.visionMaxImages,
    inboundMediaMaxBytes: cfg.inboundMediaMaxBytes,
    voiceTranscriptEnabled: cfg.voiceTranscriptEnabled,
    peerRatePerMinute: cfg.peerRatePerMinute,
    maxBotsPerWorker: cfg.maxBotsPerWorker,
    leaseTtlSec: cfg.leaseTtlSec,
    leaseRenewSec: cfg.leaseRenewSec,
    rebalanceEnabled: cfg.rebalanceEnabled,
    rebalanceIntervalSec: cfg.rebalanceIntervalSec,
    rebalanceSlack: cfg.rebalanceSlack,
    rebalanceMaxPerTick: cfg.rebalanceMaxPerTick,
    workerWeightTtlSec: cfg.workerWeightTtlSec,
    replyConcurrency: cfg.replyConcurrency,
    inboxMaxLen: cfg.inboxMaxLen,
    splitReply: cfg.splitReply,
    maxReplyChunks: cfg.maxReplyChunks,
    maxChunkChars: cfg.maxChunkChars,
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
    appVersion: cfg.appVersion,
    repoRoot: cfg.repoRoot,
    otaEnabled: cfg.otaEnabled,
    otaAllowInstall: cfg.otaAllowInstall,
    otaStagingDir: cfg.otaStagingDir,
    log: (msg, extra) => {
      if (extra) console.log(msg, extra);
      else console.log(msg);
    },
  });

  runtimeTargets = { chat, tryChat, worker, activityBus };
  settings.start();

  const loginSessions = new BotLoginSessionManager(db, worker);
  // Stickers / OTA blob upload as JSON base64 (~4/3 raw); allow up to ~12MB payload
  // 12MB is only needed by the upload routes; as a global default it let any
  // unauthenticated POST make the process buffer 12MB before a handler ran.
  // Those routes set `bodyLimit: cfg.uploadBodyLimit` per route instead.
  const app = Fastify(buildFastifyOptions(cfg));

  const rawLogLevel = (process.env.LOG_LEVEL ?? "").trim();
  if (rawLogLevel && rawLogLevel.toLowerCase() !== cfg.logLevel) {
    app.log.warn(
      { requested: rawLogLevel, using: cfg.logLevel, valid: LOG_LEVELS },
      "LOG_LEVEL is not a pino level — falling back",
    );
  }

  registerRequestLogging(app, cfg);

  await app.register(compress, {
    global: true,
    threshold: 4096,
    encodings: ["br", "gzip", "deflate"],
    // Dynamic JSON gets compressed synchronously on the event loop. Default
    // brotli quality is far too slow for 30-60KB admin listings; q4 lands
    // near gzip speed at better ratio. Static shells bypass this middleware
    // entirely (static-pages.ts sets Content-Encoding itself).
    brotliOptions: {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
    },
  });

  await registerRoutes(app, {
    db,
    chat,
    tryChat,
    worker,
    loginSessions,
    cfg,
    activityBus,
    settings,
  });

  const publicDir = path.join(__dirname, "../public");
  const staticAssets = loadStaticAssets(publicDir, publicBase);
  console.log(
    `[static] pages=${[...staticAssets.pages.keys()].join(",") || "(none)"} og=${staticAssets.og ? "yes" : "no"}`,
  );

  const sendCachedPage = (
    route: string,
    browserCc: string,
    edgeCc: string,
    req: import("fastify").FastifyRequest,
    reply: import("fastify").FastifyReply,
  ) => {
    const page = staticAssets.pages.get(route);
    if (!page) return null;
    // Serve the boot-time brotli/gzip buffer when the client accepts it.
    // Setting Content-Encoding also tells @fastify/compress to stand down.
    const variant = pickEncoded(page, req.headers["accept-encoding"]);
    const etag = variant?.etag ?? page.etag;
    setPublicCache(reply, browserCc, edgeCc, {
      etag,
      cacheTag: "html-shell",
    });
    reply.header("Vary", "Accept-Encoding");
    if (ifNoneMatchHits(req.headers["if-none-match"], etag)) {
      return reply.code(304).send();
    }
    reply.type(page.contentType);
    if (variant) {
      reply.header("Content-Encoding", variant.encoding);
      return reply.send(variant.body);
    }
    return reply.send(page.body);
  };

  // Landing (feature intro + OG for link previews). App console stays at /app.
  app.get("/", async (req, reply) => {
    const sent = sendCachedPage(
      "/",
      CC_HTML_MARKETING,
      CDN_HTML_MARKETING,
      req,
      reply,
    );
    if (sent) return sent;
    return reply.redirect("/app");
  });
  app.get("/app", async (req, reply) => {
    const sent = sendCachedPage(
      "/app",
      CC_HTML_APP,
      CDN_HTML_APP,
      req,
      reply,
    );
    if (sent) return sent;
    return reply.code(404).send("app.html missing");
  });
  app.get("/docs", async (req, reply) => {
    const sent = sendCachedPage(
      "/docs",
      CC_HTML_MARKETING,
      CDN_HTML_MARKETING,
      req,
      reply,
    );
    if (sent) return sent;
    return reply.code(404).send("docs.html missing");
  });
  app.get("/admin", async (req, reply) => {
    const sent = sendCachedPage(
      "/admin",
      CC_HTML_APP,
      CDN_HTML_APP,
      req,
      reply,
    );
    if (sent) return sent;
    return reply.code(404).send("admin.html missing");
  });
  app.get("/chatflow", async (req, reply) => {
    const sent = sendCachedPage(
      "/chatflow",
      CC_HTML_APP,
      CDN_HTML_APP,
      req,
      reply,
    );
    if (sent) return sent;
    return reply.code(404).send("chatflow.html missing");
  });
  app.get("/og.jpg", async (req, reply) => {
    const og = staticAssets.og;
    if (!og) return reply.code(404).send("og image missing");
    setPublicCache(reply, CC_OG, CDN_OG, {
      etag: og.etag,
      cacheTag: "og-image",
    });
    if (ifNoneMatchHits(req.headers["if-none-match"], og.etag)) {
      return reply.code(304).send();
    }
    return reply.type(og.contentType).send(og.body);
  });

  await app.listen({ host: cfg.host, port: cfg.port });
  // Max-quality shell compression, off the boot path
  void upgradeStaticCompression(staticAssets).then(
    () => console.log("[static] shells recompressed (brotli q11)"),
    (err) => console.warn("[static] recompress failed (serving q5):", err),
  );
  const oauth = loadLinuxDoConfig();
  console.log(`Landing   http://${cfg.host}:${cfg.port}/`);
  console.log(`App UI    http://${cfg.host}:${cfg.port}/app`);
  console.log(`Docs      http://${cfg.host}:${cfg.port}/docs`);
  console.log(`Admin UI  http://${cfg.host}:${cfg.port}/admin`);
  console.log(`Chatflow  http://${cfg.host}:${cfg.port}/chatflow`);
  console.log(
    `[version] ${cfg.appVersion} ota=${cfg.otaEnabled ? "on" : "off"}`,
  );
  console.log(
    oauth
      ? `[oauth] LINUX DO enabled → ${oauth.redirectUri}${
          cfg.linuxdoAuthEnabled ? "" : " (登录已关闭 LINUXDO_AUTH_ENABLED=false)"
        }`
      : "[oauth] LINUX DO 未配置（设置 LINUXDO_CLIENT_ID/SECRET/REDIRECT_URI）",
  );

  if (cfg.workerEnabled) {
    // Do not block process forever if Redis is slow; start() is still awaited
    // but bootstrap is now batched. Log clearly on failure.
    try {
      await worker.start();
    } catch (err) {
      console.error(
        "[worker] start failed (API stays up; check Redis / logs):",
        err,
      );
    }
  } else {
    console.log("WORKER_ENABLED=false");
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    settings.stop();
    // Await the fleet deregistration so peers re-claim this node's bots
    // immediately instead of waiting out the lease TTL.
    await worker.stopAsync().catch(() => undefined);
    await app.close().catch(() => undefined);
    await db.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
