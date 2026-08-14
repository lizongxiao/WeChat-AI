/**
 * Skill runner: iterates registered skills in order, skipping disabled ones,
 * and returns the first non-null reply (or null to fall through to the LLM).
 */
import type { ChatSkill, SkillContext } from "./types.js";

export interface SkillFilter {
  /** Decide whether a skill is enabled for this turn. Default: all enabled. */
  isEnabled?(
    skillId: string,
    ctx: SkillContext,
  ): Promise<boolean> | boolean;
}

export class SkillRunner {
  constructor(
    private skills: ChatSkill[],
    private filter: SkillFilter = {},
  ) {}

  list(): ChatSkill[] {
    return [...this.skills];
  }

  get(id: string): ChatSkill | undefined {
    return this.skills.find((s) => s.id === id);
  }

  /** Run enabled skills in order; first non-null reply wins. */
  async run(ctx: SkillContext): Promise<string | null> {
    for (const skill of this.skills) {
      if (await this.isEnabled(skill.id, ctx)) {
        if (skill.detect && !skill.detect(ctx.text)) continue;
        const reply = await skill.handle(ctx);
        if (reply !== null) return reply;
      }
    }
    return null;
  }

  /** Enabled skills for the current peer/persona (for `/帮助` / admin). */
  async describe(ctx: SkillContext): Promise<ChatSkill[]> {
    const enabled: ChatSkill[] = [];
    for (const skill of this.skills) {
      if (await this.isEnabled(skill.id, ctx)) enabled.push(skill);
    }
    return enabled;
  }

  private async isEnabled(id: string, ctx: SkillContext): Promise<boolean> {
    if (!this.filter.isEnabled) return true;
    return Boolean(await this.filter.isEnabled(id, ctx));
  }
}
