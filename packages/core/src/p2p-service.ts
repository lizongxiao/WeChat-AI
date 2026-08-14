import {
  type Db,
  acceptConnectRequest,
  blockUser,
  clearPrimaryBind,
  consumeBindCode,
  createConnectRequest,
  deleteConnectRequest,
  deleteP2PSession,
  getBindByPeer,
  getBindByUser,
  getInboundRequest,
  getOutboundRequest,
  getP2PRequestDayCount,
  getP2PSessionForPeer,
  type P2PSession,
  getUser,
  getUserByUsername,
  getUsersByIds,
  incrP2PRequestDay,
  isBlockedEitherWay,
  isPeerReachable,
  listBlockedUserIds,
  otherParty,
  selfParty,
  setPrimaryBind,
  touchP2PSession,
  unblockUser,
  type PeerEndpoint,
  type PeerIdentity,
  type UserWechatBind,
  nowIso,
} from "@wechat-ai/db";
import {
  CommandRegistry,
  type CommandContext,
  type CommandResult,
  type P2PRemoteSend,
} from "./commands/index.js";

export interface P2PServiceOptions {
  bindCodeTtlSec: number;
  requestTtlSec: number;
  sessionIdleSec: number;
  relayMaxChars: number;
  maxRequestsPerDay: number;
}

export interface P2PInboundRequest {
  botId: string;
  peerId: string;
  text: string;
  mediaOnly?: boolean;
}

export interface P2PHandleResult {
  /** true = worker must NOT call ChatService / LLM */
  handled: boolean;
  localReplies: string[];
  remoteSends: P2PRemoteSend[];
}

const DEFAULTS: P2PServiceOptions = {
  bindCodeTtlSec: 600,
  requestTtlSec: 300,
  sessionIdleSec: 1800,
  relayMaxChars: 500,
  maxRequestsPerDay: 20,
};

/** Whole-message @username (optional leading/trailing whitespace). */
const AT_USER_RE = /^\s*@([A-Za-z0-9_.\-]{1,64})\s*$/;

const BIND_RE = /^\s*\/绑定\s+([A-Za-z0-9]{4,12})\s*$/i;
const UNBIND_RE = /^\s*\/解绑\s*$/;
const WHOAMI_RE = /^\s*\/我的身份\s*$/;
const ACCEPT_RE = /^\s*\/同意\s*$/;
const REJECT_RE = /^\s*\/拒绝\s*$/;
const DISCONNECT_RE = /^\s*\/断开\s*$/;
const CANCEL_RE = /^\s*\/取消请求\s*$/;
const BLOCK_RE = /^\s*\/拉黑\s+@?([A-Za-z0-9_.\-]{1,64})\s*$/;
const UNBLOCK_RE = /^\s*\/取消拉黑\s+@?([A-Za-z0-9_.\-]{1,64})\s*$/;
const BLOCKLIST_RE = /^\s*\/黑名单\s*$/;

function localOnly(text: string): P2PHandleResult {
  return { handled: true, localReplies: [text], remoteSends: [] };
}

function fallthrough(): P2PHandleResult {
  return { handled: false, localReplies: [], remoteSends: [] };
}

function fmtMin(sec: number): number {
  return Math.max(1, Math.round(sec / 60));
}

export class P2PService {
  private opts: P2PServiceOptions;

  constructor(
    private db: Db,
    opts: Partial<P2PServiceOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Apply admin-editable settings in place (runtime settings reload). */
  applyRuntimeOptions(patch: Partial<P2PServiceOptions>): void {
    Object.assign(this.opts, patch);
  }

  async handleInbound(req: P2PInboundRequest): Promise<P2PHandleResult> {
    const text = (req.text ?? "").trim();
    const mediaOnly = Boolean(req.mediaOnly) || !text;

    // Commands (/绑定 /同意 …) are registered in the unified command system
    // via registerCommands() and dispatched before this method — see
    // BotWorkerManager. Here we only handle @username requests, active-session
    // relay, and media-only guards. This keeps every ordinary roleplay message
    // from paying a Redis GET just to find no session.
    if (!mediaOnly) {
      const atMatch = text.match(AT_USER_RE);
      if (atMatch) return this.handleAt(req, atMatch[1]!);
    }

    const session = await getP2PSessionForPeer(
      this.db,
      req.botId,
      req.peerId,
    );
    if (session && mediaOnly) {
      return localOnly("会话中暂不支持图片/语音，请发送文字，或发送 /断开 结束对话。");
    }

    // Active session → relay (pass the row we just loaded; microseconds old)
    if (session && !mediaOnly) {
      return this.handleRelay(req, session);
    }

    return fallthrough();
  }

  /**
   * Register every P2P command into the unified command registry. The worker
   * runs the registry before this service's relay logic, so commands keep
   * taking precedence over relay exactly as before.
   */
  registerCommands(registry: CommandRegistry): void {
    const cmd = (
      name: string,
      description: string,
      usage: string | undefined,
      run: (ctx: CommandContext) => Promise<P2PHandleResult>,
    ) =>
      registry.register({
        name,
        description,
        usage,
        handler: async (ctx) => this.toCommandResult(await run(ctx)),
      });

    cmd("绑定", "绑定 LINUX DO 账号", "/绑定 <验证码>", (ctx) =>
      this.handleBind(this.toReq(ctx), ctx.args),
    );
    cmd("解绑", "解除 LINUX DO 账号绑定", "/解绑", (ctx) =>
      this.handleUnbind(this.toReq(ctx)),
    );
    cmd("我的身份", "查看绑定账号与对话状态", "/我的身份", (ctx) =>
      this.handleWhoami(this.toReq(ctx)),
    );
    cmd("同意", "同意对方的对话请求", "/同意", (ctx) =>
      this.handleAccept(this.toReq(ctx)),
    );
    cmd("拒绝", "拒绝对方的对话请求", "/拒绝", (ctx) =>
      this.handleReject(this.toReq(ctx)),
    );
    cmd("断开", "结束当前对话", "/断开", (ctx) =>
      this.handleDisconnect(this.toReq(ctx)),
    );
    cmd("取消请求", "取消发出的对话请求", "/取消请求", (ctx) =>
      this.handleCancel(this.toReq(ctx)),
    );
    cmd("拉黑", "拉黑用户", "/拉黑 <@用户名>", (ctx) =>
      this.handleBlock(this.toReq(ctx), ctx.args.replace(/^@/, "")),
    );
    cmd("取消拉黑", "移出黑名单", "/取消拉黑 <@用户名>", (ctx) =>
      this.handleUnblock(this.toReq(ctx), ctx.args.replace(/^@/, "")),
    );
    cmd("黑名单", "查看黑名单", "/黑名单", (ctx) =>
      this.handleBlockList(this.toReq(ctx)),
    );
  }

  private toReq(ctx: CommandContext): P2PInboundRequest {
    return {
      botId: ctx.botId,
      peerId: ctx.peerId,
      text: ctx.text,
      mediaOnly: ctx.mediaOnly,
    };
  }

  private toCommandResult(r: P2PHandleResult): CommandResult {
    return {
      handled: r.handled,
      reply: r.localReplies.length ? r.localReplies.join("\n") : undefined,
      remoteSends: r.remoteSends,
    };
  }

  // ── Bind ─────────────────────────────────────────────

  private async handleBind(
    req: P2PInboundRequest,
    code: string,
  ): Promise<P2PHandleResult> {
    const rec = await consumeBindCode(this.db, code);
    if (!rec) {
      return localOnly("绑定码无效或已过期。请到用户中心重新生成绑定码后再试。");
    }

    const user = await getUser(this.db, rec.userId);
    if (!user) {
      return localOnly("绑定失败：平台账号不存在。请重新登录用户中心后再生成绑定码。");
    }

    const bind: UserWechatBind = {
      userId: user.id,
      username: user.username,
      botId: req.botId,
      peerId: req.peerId,
      boundAt: nowIso(),
    };
    await setPrimaryBind(this.db, bind);

    return localOnly(
      `已绑定 LINUX DO 账号 @${user.username}。现在可以发送 @对方用户名 发起对话。`,
    );
  }

  private async handleUnbind(
    req: P2PInboundRequest,
  ): Promise<P2PHandleResult> {
    const bind = await getBindByPeer(this.db, req.botId, req.peerId);
    if (!bind) {
      return localOnly("当前微信尚未绑定 LINUX DO 账号。");
    }
    await clearPrimaryBind(this.db, bind.userId);
    return localOnly(`已解除与 @${bind.username} 的绑定。`);
  }

  private async handleWhoami(
    req: P2PInboundRequest,
  ): Promise<P2PHandleResult> {
    const bind = await getBindByPeer(this.db, req.botId, req.peerId);
    if (!bind) {
      return localOnly(
        "当前微信尚未绑定。请到用户中心生成绑定码，然后发送 /绑定 验证码。",
      );
    }
    const session = await getP2PSessionForPeer(
      this.db,
      req.botId,
      req.peerId,
    );
    const out = await getOutboundRequest(this.db, req.botId, req.peerId);
    const inn = await getInboundRequest(this.db, req.botId, req.peerId);
    let state = "空闲";
    if (session) {
      const other = otherParty(session, req.botId, req.peerId);
      state = other ? `对话中（与 @${other.username}）` : "对话中";
    } else if (out) {
      state = `等待 @${out.to.username} 同意对话请求`;
    } else if (inn) {
      state = `收到 @${inn.from.username} 的对话请求（/同意 或 /拒绝）`;
    }
    return localOnly(
      `身份：@${bind.username}\n状态：${state}\n命令：@用户名 /同意 /拒绝 /断开 /取消请求 /拉黑 用户名 /解绑`,
    );
  }

  private async handleBlock(
    req: P2PInboundRequest,
    rawUsername: string,
  ): Promise<P2PHandleResult> {
    const selfBind = await getBindByPeer(this.db, req.botId, req.peerId);
    if (!selfBind) {
      return localOnly("请先绑定 LINUX DO 账号后再使用拉黑。");
    }
    const target = await getUserByUsername(this.db, rawUsername);
    if (!target) {
      return localOnly(`找不到用户 @${rawUsername}。`);
    }
    if (target.id === selfBind.userId) {
      return localOnly("不能拉黑自己。");
    }
    const r = await blockUser(this.db, selfBind.userId, target.id);
    if (!r.ok && r.reason === "already") {
      return localOnly(`@${target.username} 已在你的黑名单中。`);
    }
    return localOnly(
      `已拉黑 @${target.username}。对方无法再向你发起对话；进行中的会话已结束。可在用户中心管理黑名单，或发送 /取消拉黑 ${target.username}。`,
    );
  }

  private async handleUnblock(
    req: P2PInboundRequest,
    rawUsername: string,
  ): Promise<P2PHandleResult> {
    const selfBind = await getBindByPeer(this.db, req.botId, req.peerId);
    if (!selfBind) {
      return localOnly("请先绑定 LINUX DO 账号。");
    }
    const target = await getUserByUsername(this.db, rawUsername);
    if (!target) {
      return localOnly(`找不到用户 @${rawUsername}。`);
    }
    const ok = await unblockUser(this.db, selfBind.userId, target.id);
    if (!ok) {
      return localOnly(`@${target.username} 不在你的黑名单中。`);
    }
    return localOnly(`已将 @${target.username} 移出黑名单。`);
  }

  private async handleBlockList(
    req: P2PInboundRequest,
  ): Promise<P2PHandleResult> {
    const selfBind = await getBindByPeer(this.db, req.botId, req.peerId);
    if (!selfBind) {
      return localOnly("请先绑定 LINUX DO 账号。");
    }
    const ids = await listBlockedUserIds(this.db, selfBind.userId);
    if (!ids.length) {
      return localOnly("黑名单为空。可发送 /拉黑 用户名 或在用户中心管理。");
    }
    const map = await getUsersByIds(this.db, ids);
    const lines = ids.map((id) => {
      const u = map.get(id);
      return u ? `· @${u.username}` : `· (id:${id})`;
    });
    return localOnly(`黑名单（${ids.length}）：\n${lines.join("\n")}`);
  }

  // ── Connect ──────────────────────────────────────────

  private async handleAt(
    req: P2PInboundRequest,
    rawUsername: string,
  ): Promise<P2PHandleResult> {
    const selfBind = await getBindByPeer(this.db, req.botId, req.peerId);
    if (!selfBind) {
      return localOnly(
        "请先绑定 LINUX DO 账号后再使用 @。打开用户中心生成绑定码，然后发送 /绑定 验证码。",
      );
    }

    // Busy checks
    const existingSess = await getP2PSessionForPeer(
      this.db,
      req.botId,
      req.peerId,
    );
    if (existingSess) {
      const other = otherParty(existingSess, req.botId, req.peerId);
      return localOnly(
        `你正在与 @${other?.username ?? "对方"} 对话中。请先发送 /断开 再发起新请求。`,
      );
    }
    const existingOut = await getOutboundRequest(
      this.db,
      req.botId,
      req.peerId,
    );
    if (existingOut) {
      return localOnly(
        `已有等待中的请求（@${existingOut.to.username}）。发送 /取消请求 可取消。`,
      );
    }
    const existingIn = await getInboundRequest(
      this.db,
      req.botId,
      req.peerId,
    );
    if (existingIn) {
      return localOnly(
        `你有来自 @${existingIn.from.username} 的待处理请求。请先 /同意 或 /拒绝。`,
      );
    }

    const targetUser = await getUserByUsername(this.db, rawUsername);
    if (!targetUser) {
      return localOnly(`找不到用户 @${rawUsername}。请确认对方已用 LINUX DO 登录过本平台。`);
    }
    if (targetUser.id === selfBind.userId) {
      return localOnly("不能与自己建立对话。");
    }

    if (await isBlockedEitherWay(this.db, selfBind.userId, targetUser.id)) {
      return localOnly(
        `无法与 @${targetUser.username} 建立对话（黑名单限制）。可在用户中心查看/管理黑名单。`,
      );
    }

    const targetBind = await getBindByUser(this.db, targetUser.id);
    if (!targetBind) {
      return localOnly(
        `@${targetUser.username} 尚未绑定微信，暂时无法联系。请对方先在用户中心完成绑定。`,
      );
    }

    const reachable = await isPeerReachable(
      this.db,
      targetBind.botId,
      targetBind.peerId,
    );
    if (!reachable) {
      return localOnly(
        `@${targetUser.username} 当前不可达（对方需先与机器人聊过至少一次）。`,
      );
    }

    // Daily rate
    const dayCount = await getP2PRequestDayCount(
      this.db,
      req.botId,
      req.peerId,
    );
    if (dayCount >= this.opts.maxRequestsPerDay) {
      return localOnly(
        `今日发起对话请求次数已达上限（${this.opts.maxRequestsPerDay}）。请明天再试。`,
      );
    }

    const from: PeerIdentity = {
      botId: selfBind.botId,
      peerId: selfBind.peerId,
      userId: selfBind.userId,
      username: selfBind.username,
    };
    // Prefer live username
    const liveSelf = await getUser(this.db, selfBind.userId);
    if (liveSelf?.username) from.username = liveSelf.username;

    const to: PeerIdentity = {
      botId: targetBind.botId,
      peerId: targetBind.peerId,
      userId: targetBind.userId,
      username: targetUser.username,
    };

    const created = await createConnectRequest(
      this.db,
      from,
      to,
      this.opts.requestTtlSec,
    );
    if (!created.ok) {
      if (created.reason === "to_busy") {
        return localOnly(`@${targetUser.username} 正忙（已有请求或对话），请稍后再试。`);
      }
      if (created.reason === "from_busy") {
        return localOnly("你当前有进行中的请求或对话，请先处理后再发起。");
      }
      return localOnly("发起请求失败，请稍后再试。");
    }

    await incrP2PRequestDay(this.db, req.botId, req.peerId);

    const mins = fmtMin(this.opts.requestTtlSec);
    return {
      handled: true,
      localReplies: [
        `已向 @${to.username} 发送对话请求，等待对方同意…（${mins}分钟内有效）`,
      ],
      remoteSends: [
        {
          botId: to.botId,
          peerId: to.peerId,
          text: `【对话请求】@${from.username} 想通过机器人与你对话。回复 /同意 开始，/拒绝 忽略。（${mins}分钟内有效）`,
        },
      ],
    };
  }

  private async handleAccept(
    req: P2PInboundRequest,
  ): Promise<P2PHandleResult> {
    const inbound = await getInboundRequest(this.db, req.botId, req.peerId);
    if (inbound) {
      const selfBind = await getBindByPeer(this.db, req.botId, req.peerId);
      if (
        selfBind &&
        (await isBlockedEitherWay(
          this.db,
          selfBind.userId,
          inbound.from.userId,
        ))
      ) {
        await deleteConnectRequest(this.db, inbound);
        return localOnly(
          `无法同意：与 @${inbound.from.username} 存在黑名单限制，请求已关闭。`,
        );
      }
    }

    const result = await acceptConnectRequest(
      this.db,
      req.botId,
      req.peerId,
      this.opts.sessionIdleSec,
    );
    if (!result.ok) {
      return localOnly("没有待处理的对话请求。");
    }
    const { request } = result;
    const idleMin = fmtMin(this.opts.sessionIdleSec);
    return {
      handled: true,
      localReplies: [
        `已与 @${request.from.username} 建立对话。直接发文字即可，发送 /断开 结束。（空闲 ${idleMin} 分钟自动结束）`,
      ],
      remoteSends: [
        {
          botId: request.from.botId,
          peerId: request.from.peerId,
          text: `@${request.to.username} 已同意对话。现在可以直接发消息了。发送 /断开 结束。`,
        },
      ],
    };
  }

  private async handleReject(
    req: P2PInboundRequest,
  ): Promise<P2PHandleResult> {
    const request = await getInboundRequest(this.db, req.botId, req.peerId);
    if (!request) {
      return localOnly("没有待处理的对话请求。");
    }
    await deleteConnectRequest(this.db, request);
    return {
      handled: true,
      localReplies: [`已拒绝 @${request.from.username} 的对话请求。`],
      remoteSends: [
        {
          botId: request.from.botId,
          peerId: request.from.peerId,
          text: `@${request.to.username} 拒绝了你的对话请求。`,
        },
      ],
    };
  }

  private async handleCancel(
    req: P2PInboundRequest,
  ): Promise<P2PHandleResult> {
    const request = await getOutboundRequest(this.db, req.botId, req.peerId);
    if (!request) {
      return localOnly("没有可取消的对话请求。");
    }
    await deleteConnectRequest(this.db, request);
    return {
      handled: true,
      localReplies: [`已取消向 @${request.to.username} 的对话请求。`],
      remoteSends: [
        {
          botId: request.to.botId,
          peerId: request.to.peerId,
          text: `@${request.from.username} 取消了对话请求。`,
        },
      ],
    };
  }

  private async handleDisconnect(
    req: P2PInboundRequest,
  ): Promise<P2PHandleResult> {
    const session = await getP2PSessionForPeer(
      this.db,
      req.botId,
      req.peerId,
    );
    if (!session) {
      return localOnly("当前没有进行中的对话。");
    }
    const me = selfParty(session, req.botId, req.peerId);
    const other = otherParty(session, req.botId, req.peerId);
    await deleteP2PSession(this.db, session);
    const local = "已断开对话，恢复与机器人的角色扮演。";
    if (!other || !me) {
      return localOnly(local);
    }
    return {
      handled: true,
      localReplies: [local],
      remoteSends: [
        {
          botId: other.botId,
          peerId: other.peerId,
          text: `@${me.username} 已断开对话。`,
        },
      ],
    };
  }

  // ── Relay ────────────────────────────────────────────

  private async handleRelay(
    req: P2PInboundRequest,
    session: P2PSession,
  ): Promise<P2PHandleResult> {
    // Session was loaded by the caller microseconds ago — re-reading it here
    // was a second GET on every relayed message for no added safety.
    const me = selfParty(session, req.botId, req.peerId);
    const other = otherParty(session, req.botId, req.peerId);
    if (!me || !other) {
      await deleteP2PSession(this.db, session);
      return localOnly("会话状态异常，已清理。请重新 @用户名 发起。");
    }

    let body = (req.text ?? "").trim();
    if (body.length > this.opts.relayMaxChars) {
      body = body.slice(0, this.opts.relayMaxChars);
    }
    if (!body) {
      return localOnly("消息为空，未发送。");
    }

    await touchP2PSession(this.db, session, this.opts.sessionIdleSec);

    return {
      handled: true,
      localReplies: [], // silent ack on sender side
      remoteSends: [
        {
          botId: other.botId,
          peerId: other.peerId,
          text: `[${me.username}] ${body}`,
        },
      ],
    };
  }
}

/** Pure helpers exported for tests */
export function parseAtUsername(text: string): string | null {
  const m = text.match(AT_USER_RE);
  return m?.[1] ?? null;
}

export function isP2PCommand(text: string): boolean {
  const t = text.trim();
  return (
    BIND_RE.test(t) ||
    UNBIND_RE.test(t) ||
    WHOAMI_RE.test(t) ||
    ACCEPT_RE.test(t) ||
    REJECT_RE.test(t) ||
    DISCONNECT_RE.test(t) ||
    CANCEL_RE.test(t) ||
    BLOCK_RE.test(t) ||
    UNBLOCK_RE.test(t) ||
    BLOCKLIST_RE.test(t) ||
    AT_USER_RE.test(t)
  );
}

export type { PeerEndpoint, PeerIdentity, P2PRemoteSend };
