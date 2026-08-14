/**
 * Unified WeChat command system.
 *
 * Every `/command` in the chat (system help, skill commands, P2P commands)
 * registers here so the worker dispatches from one place and `/帮助` can
 * list everything the current user may type.
 */
import type { Db } from "@wechat-ai/db";

/** Remote delivery target used by P2P relay commands. */
export interface P2PRemoteSend {
  botId: string;
  peerId: string;
  text: string;
}

export interface CommandContext {
  db: Db;
  botId: string;
  peerId: string;
  /** Whole trimmed input text (including the leading `/`). */
  text: string;
  /** Argument text after the command token (trimmed, may be ""). */
  args: string;
  mediaOnly?: boolean;
}

export interface CommandResult {
  /** true = fully handled; worker must not fall through to relay/skills/LLM. */
  handled: boolean;
  /** Local reply text sent back to the peer. */
  reply?: string;
  /** Optional remote sends (P2P relay side effects). */
  remoteSends?: P2PRemoteSend[];
}

export interface ChatCommand {
  /** Canonical name, e.g. "帮助" or "同意". */
  name: string;
  aliases?: string[];
  /** One-line description shown by `/帮助`. */
  description: string;
  /** Full usage string, e.g. "/绑定 <验证码>". Falls back to "/name". */
  usage?: string;
  /** Invoked after `/name [args]` matches. */
  handler(ctx: CommandContext): Promise<CommandResult>;
}

export function commandReply(text: string): CommandResult {
  return { handled: true, reply: text };
}
