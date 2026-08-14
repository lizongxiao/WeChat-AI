/**
 * Command registry: single place to register, match and run `/commands`.
 *
 * Matching is exact on the command token (after the leading `/`), with
 * explicit aliases for synonyms/case variants. Unknown `/foo` returns null
 * so the caller can fall through to other handling (e.g. LLM roleplay).
 */
import type { ChatCommand, CommandContext, CommandResult } from "./types.js";

export class CommandRegistry {
  private byName = new Map<string, ChatCommand>();
  private byAlias = new Map<string, string>();

  register(cmd: ChatCommand): void {
    this.byName.set(cmd.name, cmd);
    for (const alias of cmd.aliases ?? []) {
      this.byAlias.set(alias, cmd.name);
    }
  }

  /** Resolve `/name args` → command + args. Returns null for non-command text. */
  match(text: string): { cmd: ChatCommand; args: string } | null {
    const t = text.trim();
    if (!t.startsWith("/")) return null;
    const space = t.indexOf(" ");
    const token = space === -1 ? t.slice(1) : t.slice(1, space);
    if (!token) return null;
    const name = this.byAlias.get(token) ?? (this.byName.has(token) ? token : null);
    if (!name) return null;
    return {
      cmd: this.byName.get(name)!,
      args: space === -1 ? "" : t.slice(space + 1).trim(),
    };
  }

  list(): ChatCommand[] {
    return [...this.byName.values()];
  }

  get(name: string): ChatCommand | undefined {
    return this.byName.get(name);
  }

  /** Run the command if `text` matches; otherwise null. Args are parsed here. */
  async run(
    ctx: Omit<CommandContext, "args">,
  ): Promise<CommandResult | null> {
    const m = this.match(ctx.text);
    if (!m) return null;
    return m.cmd.handler({ ...ctx, args: m.args });
  }
}
