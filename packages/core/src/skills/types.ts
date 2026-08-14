/**
 * Skill system types.
 *
 * A skill is a deterministic, server-side capability that intercepts chat
 * text before the LLM turn (mirroring the scheduled-task boundary: text the
 * model generates can never directly create/modify Redis records). Skills are
 * pluggable: enabling/disabling is stored per-global and per-persona.
 */
import type { Db } from "@wechat-ai/db";

export interface SkillContext {
  db: Db;
  botId: string;
  peerId: string;
  text: string;
  mediaOnly?: boolean;
}

export interface ChatSkill {
  /** Stable id used by skill toggles, e.g. "scheduled". */
  id: string;
  /** Display name, e.g. "定时任务". */
  name: string;
  /** One-line description shown in `/帮助` and the admin panel. */
  description: string;
  /**
   * Optional natural-language trigger test. When omitted the runner always
   * calls `handle` and relies on its null return to fall through.
   */
  detect?(text: string): boolean;
  /**
   * Handle one inbound message. Return a non-null string to take over the
   * turn; return null to fall through to the next skill / LLM.
   */
  handle(ctx: SkillContext): Promise<string | null>;
}
