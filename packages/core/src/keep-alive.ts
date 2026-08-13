/**
 * Keep-alive pings for scheduled subscribers whose iLink context_token
 * is aging. Outbound bot messages do not refresh the token — only inbound
 * does — so this decides whether we may still ask the user to reply.
 */
import type { MemoryRow } from "@wechat-ai/db";
import type { ChatMessage } from "@wechat-ai/llm";
import { applyPromptTemplate, buildBotIdentityBlock } from "./prompt.js";
import { hourInTimeZone, isInQuietHours, parseQuietHours } from "./proactive.js";

export interface KeepAlivePolicy {
  enabled: boolean;
  /** Hours since last inbound before a ping is allowed. */
  afterHours: number;
  /** Hours since last inbound after which we stop trying. */
  maxHours: number;
  /** Minimum hours between two keep-alive pings. */
  minIntervalHours: number;
  /** Quiet window "H-H"; empty disables. */
  quietHours: string;
  quietTimeZone: string;
  /** Skip a dedicated ping if a scheduled send is due within this many hours. */
  dueSoonHours: number;
}

export const DEFAULT_KEEP_ALIVE_POLICY: KeepAlivePolicy = {
  enabled: true,
  afterHours: 18,
  maxHours: 40,
  minIntervalHours: 20,
  quietHours: "22-8",
  quietTimeZone: "Asia/Shanghai",
  dueSoonHours: 2,
};

export type KeepAliveSkipReason =
  | "disabled"
  | "no_token"
  | "no_inbound_clock"
  | "too_fresh"
  | "too_stale"
  | "quiet_hours"
  | "already_pinged"
  | "scheduled_due_soon"
  | "stale_session";

export interface KeepAliveInput {
  hasToken: boolean;
  inboundAt?: string | null;
  lastKeepAliveAt?: string | null;
  lastKeepAliveError?: string | null;
  nextScheduledAt?: string | null;
  now?: Date;
  policy: KeepAlivePolicy;
}

export interface KeepAliveResult {
  ok: boolean;
  reason?: KeepAliveSkipReason;
  inboundHours?: number;
}

export function hoursSince(
  iso: string | null | undefined,
  now = new Date(),
): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (now.getTime() - t) / 3_600_000);
}

export function isStaleKeepAliveError(error: string | null | undefined): boolean {
  const raw = (error || "").toLowerCase();
  if (!raw) return false;
  if (/frequen|too many|rate limit/.test(raw)) return false;
  return /ret=-2|prepare failed|ret=-14|errcode=-14|no_context_token/.test(raw);
}

export function isKeepAliveEligible(input: KeepAliveInput): KeepAliveResult {
  const policy = input.policy;
  const now = input.now ?? new Date();
  if (!policy.enabled) return { ok: false, reason: "disabled" };
  if (!input.hasToken) return { ok: false, reason: "no_token" };

  const inboundHours = hoursSince(input.inboundAt, now);
  if (inboundHours == null) return { ok: false, reason: "no_inbound_clock" };
  if (inboundHours < policy.afterHours) {
    return { ok: false, reason: "too_fresh", inboundHours };
  }
  if (inboundHours >= policy.maxHours) {
    return { ok: false, reason: "too_stale", inboundHours };
  }

  const inboundMs = Date.parse(input.inboundAt!);
  const pingMs = input.lastKeepAliveAt
    ? Date.parse(input.lastKeepAliveAt)
    : NaN;
  if (
    Number.isFinite(pingMs) &&
    Number.isFinite(inboundMs) &&
    pingMs >= inboundMs &&
    isStaleKeepAliveError(input.lastKeepAliveError)
  ) {
    return { ok: false, reason: "stale_session", inboundHours };
  }

  const sincePing = hoursSince(input.lastKeepAliveAt, now);
  if (sincePing != null && sincePing < policy.minIntervalHours) {
    return { ok: false, reason: "already_pinged", inboundHours };
  }

  const quiet = parseQuietHours(policy.quietHours);
  if (quiet) {
    const hour = hourInTimeZone(now, policy.quietTimeZone);
    if (isInQuietHours(hour, quiet)) {
      return { ok: false, reason: "quiet_hours", inboundHours };
    }
  }

  if (policy.dueSoonHours > 0 && input.nextScheduledAt) {
    const due = Date.parse(input.nextScheduledAt);
    if (Number.isFinite(due)) {
      const hoursUntil = (due - now.getTime()) / 3_600_000;
      if (hoursUntil >= 0 && hoursUntil <= policy.dueSoonHours) {
        return { ok: false, reason: "scheduled_due_soon", inboundHours };
      }
    }
  }

  return { ok: true, inboundHours };
}

/** True when a scheduled bulletin should ask the user to reply in its closing. */
export function shouldPiggybackKeepAlive(
  inboundAt: string | null | undefined,
  policy: KeepAlivePolicy,
  now = new Date(),
): boolean {
  if (!policy.enabled) return false;
  const hours = hoursSince(inboundAt, now);
  if (hours == null) return false;
  return hours >= policy.afterHours && hours < policy.maxHours;
}

export function firstKeepAliveSentence(
  text: string,
  maxChars = 80,
): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const m = t.match(/^(.+?[。！？!?～~])/u);
  const sentence = (m?.[1] || t).trim();
  if ([...sentence].length <= maxChars) return sentence;
  return [...sentence].slice(0, maxChars).join("").trim();
}

export const MISSED_SCHEDULED_NOTICE = "早上那条刚才没送到。";

/** Prefix the first bubble so a missed bulletin stays within 3 sends. */
export function attachMissedDeliveryNotice(texts: string[]): string[] {
  const out = texts.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (!out.length) return out;
  if (out[0]!.startsWith(MISSED_SCHEDULED_NOTICE)) return out;
  out[0] = `${MISSED_SCHEDULED_NOTICE}${out[0]}`;
  return out;
}

export function buildKeepAliveMessages(params: {
  systemPrompt: string;
  memories: MemoryRow[];
  botName?: string;
  personaName?: string;
  inboundHours?: number;
}): ChatMessage[] {
  const botName = params.botName?.trim() || "助手";
  const identity = buildBotIdentityBlock(
    params.personaName?.trim() || botName,
  );
  const personaBody = applyPromptTemplate(params.systemPrompt, { botName });
  const facts = params.memories
    .map((m) => m.content?.trim())
    .filter((x): x is string => Boolean(x));
  const memoryBlock = facts.length
    ? [
        "## 关于该用户的长期记忆（仅限此用户，勿与他人混淆）",
        ...facts.map((f) => `- ${f}`),
      ].join("\n")
    : "";
  const hours =
    params.inboundHours != null && Number.isFinite(params.inboundHours)
      ? Math.max(0.1, Math.round(params.inboundHours * 10) / 10)
      : null;
  const keepAliveBlock = [
    "## 会话保活",
    hours != null
      ? `对方大约 ${hours} 小时没给你发消息了。这是保活提醒，不是闲聊，也不是定时推送。`
      : "这是保活提醒，不是闲聊，也不是定时推送。",
    "只输出一句很短的话（约 40 字内），用人设口吻自然请对方回一句，好让对话继续。",
    "禁止提 token、系统、会话、过期、微信。禁止输出多气泡 JSON、表情或跳过指令。不要编造天气或新闻。",
  ].join("\n");
  const system = [identity, personaBody, memoryBlock, keepAliveBlock]
    .filter(Boolean)
    .join("\n\n");
  return [
    { role: "system", content: system },
    { role: "user", content: "请现在只说一句，请对方回我。" },
  ];
}
