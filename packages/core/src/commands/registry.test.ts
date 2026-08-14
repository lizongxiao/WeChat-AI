import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CommandRegistry } from "./registry.js";
import { buildHelpCommand } from "./help.js";
import type { CommandContext, ChatCommand, CommandResult } from "./types.js";

function ctx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    db: null as never,
    botId: "bot1",
    peerId: "peer1",
    text: "",
    args: "",
    ...overrides,
  };
}

function stubCommand(name: string, opts: Partial<ChatCommand> = {}): ChatCommand {
  return {
    name,
    description: `命令 ${name}`,
    handler: async () => ({ handled: true, reply: `ok:${name}` }),
    ...opts,
  };
}

describe("CommandRegistry.match", () => {
  const reg = new CommandRegistry();
  reg.register(stubCommand("绑定", { usage: "/绑定 <验证码>" }));
  reg.register(stubCommand("帮助", { aliases: ["help"] }));

  it("matches /name with args", () => {
    const m = reg.match("/绑定 ABC123");
    assert.ok(m);
    assert.equal(m!.cmd.name, "绑定");
    assert.equal(m!.args, "ABC123");
  });

  it("matches /name without args", () => {
    const m = reg.match("/帮助");
    assert.ok(m);
    assert.equal(m!.args, "");
  });

  it("resolves aliases", () => {
    const m = reg.match("/help");
    assert.ok(m);
    assert.equal(m!.cmd.name, "帮助");
  });

  it("returns null for non-command text and unknown commands", () => {
    assert.equal(reg.match("早上好"), null);
    assert.equal(reg.match("/不存在的命令"), null);
    assert.equal(reg.match(""), null);
    assert.equal(reg.match("/"), null);
  });

  it("trims whitespace and keeps multi-word args", () => {
    const m = reg.match("  /绑定   ABC123  ");
    assert.ok(m);
    assert.equal(m!.args, "ABC123");
  });
});

describe("CommandRegistry.run", () => {
  it("returns result when matched, null otherwise", async () => {
    const reg = new CommandRegistry();
    reg.register(stubCommand("同意"));
    assert.deepEqual(await reg.run(ctx({ text: "/同意" })), {
      handled: true,
      reply: "ok:同意",
    });
    assert.equal(await reg.run(ctx({ text: "普通消息" })), null);
  });
});

describe("buildHelpCommand", () => {
  it("lists all commands with usage and appends extra section", async () => {
    const reg = new CommandRegistry();
    reg.register(stubCommand("绑定", { usage: "/绑定 <验证码>" }));
    reg.register(stubCommand("同意"));
    const help = buildHelpCommand(reg, {
      header: "机器人菜单",
      extraSection: async () => "当前技能：\n· 定时任务",
    });
    reg.register(help);

    const res = (await help.handler(
      ctx({ text: "/帮助" }),
    )) as CommandResult;
    assert.ok(res.handled);
    assert.ok(res.reply!.includes("机器人菜单"));
    assert.ok(res.reply!.includes("· /绑定 <验证码> — 命令 绑定"));
    assert.ok(res.reply!.includes("· /同意 — 命令 同意"));
    assert.ok(res.reply!.includes("当前技能：\n· 定时任务"));
    // help lists itself
    assert.ok(res.reply!.includes("· /帮助 — 查看可用命令与当前技能"));
  });

  it("omits extra section when it returns null", async () => {
    const reg = new CommandRegistry();
    reg.register(stubCommand("同意"));
    const help = buildHelpCommand(reg, { extraSection: async () => null });
    reg.register(help);
    const res = (await help.handler(ctx({ text: "/帮助" }))) as CommandResult;
    // extra section is absent — its injected content must not appear
    assert.ok(!res.reply!.includes("· 定时任务"));
  });
});
