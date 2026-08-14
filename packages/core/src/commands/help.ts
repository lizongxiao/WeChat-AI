/**
 * `/帮助` command: lists every registered command plus (optionally) the
 * skills enabled for the current peer, injected by the caller so this module
 * stays free of Redis/skill-runner dependencies.
 */
import type { CommandRegistry } from "./registry.js";
import type { ChatCommand, CommandContext, CommandResult } from "./types.js";

export interface HelpCommandOptions {
  /**
   * Extra section appended after the command list, e.g. the skill summary
   * for the current persona. Return "" / null to omit.
   */
  extraSection?: (ctx: CommandContext) => Promise<string | null> | string | null;
  /** Optional header line(s) shown above the command list. */
  header?: string;
}

export function buildHelpCommand(
  registry: CommandRegistry,
  opts: HelpCommandOptions = {},
): ChatCommand {
  return {
    name: "帮助",
    aliases: ["help", "菜单", "命令", "commands"],
    description: "查看可用命令与当前技能",
    async handler(ctx): Promise<CommandResult> {
      const lines: string[] = [];
      if (opts.header) lines.push(opts.header);
      lines.push("可用命令：");
      for (const cmd of registry.list()) {
        const usage = cmd.usage ?? `/${cmd.name}`;
        lines.push(`· ${usage} — ${cmd.description}`);
      }
      if (opts.extraSection) {
        const extra = await opts.extraSection(ctx);
        if (extra) lines.push("", extra);
      }
      return { handled: true, reply: lines.join("\n") };
    },
  };
}
