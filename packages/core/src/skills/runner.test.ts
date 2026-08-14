import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SkillRunner } from "./runner.js";
import type { ChatSkill, SkillContext } from "./types.js";

function ctx(overrides: Partial<SkillContext> = {}): SkillContext {
  return {
    db: null as never,
    botId: "bot1",
    peerId: "peer1",
    text: "",
    ...overrides,
  };
}

function skill(
  id: string,
  opts: Partial<ChatSkill> = {},
): ChatSkill {
  return {
    id,
    name: id,
    description: `技能 ${id}`,
    handle: async () => `reply:${id}`,
    ...opts,
  };
}

describe("SkillRunner.run", () => {
  it("returns the first non-null reply in registration order", async () => {
    const runner = new SkillRunner([
      skill("a"),
      skill("b", { handle: async () => null }),
      skill("c"),
    ]);
    assert.equal(await runner.run(ctx({ text: "hi" })), "reply:a");
  });

  it("falls through when every skill returns null", async () => {
    const runner = new SkillRunner([
      skill("a", { handle: async () => null }),
      skill("b", { handle: async () => null }),
    ]);
    assert.equal(await runner.run(ctx({ text: "hi" })), null);
  });

  it("respects detect() before invoking handle", async () => {
    let called = false;
    const runner = new SkillRunner([
      skill("a", {
        detect: (t) => t.includes("定时"),
        handle: async () => {
          called = true;
          return "scheduled";
        },
      }),
    ]);
    assert.equal(await runner.run(ctx({ text: "早上好" })), null);
    assert.equal(called, false);
    assert.equal(await runner.run(ctx({ text: "设置定时任务" })), "scheduled");
    assert.equal(called, true);
  });

  it("skips disabled skills via filter", async () => {
    const disabled = new Set(["scheduled"]);
    const runner = new SkillRunner(
      [
        skill("scheduled"),
        skill("weather", { handle: async () => "weather" }),
      ],
      {
        isEnabled: async (id) => !disabled.has(id),
      },
    );
    assert.equal(await runner.run(ctx({ text: "hi" })), "weather");
  });

  it("handle can decide not to handle even without detect", async () => {
    const runner = new SkillRunner([
      skill("a", {
        handle: async () => null,
      }),
      skill("b"),
    ]);
    assert.equal(await runner.run(ctx({ text: "hi" })), "reply:b");
  });
});

describe("SkillRunner.describe", () => {
  it("lists only enabled skills", async () => {
    const disabled = new Set(["off"]);
    const runner = new SkillRunner(
      [skill("on"), skill("off")],
      { isEnabled: async (id) => !disabled.has(id) },
    );
    const list = await runner.describe(ctx({ text: "hi" }));
    assert.deepEqual(list.map((s) => s.id), ["on"]);
  });

  it("lists all skills when no filter is set", async () => {
    const runner = new SkillRunner([skill("a"), skill("b")]);
    const list = await runner.describe(ctx({ text: "hi" }));
    assert.deepEqual(list.map((s) => s.id), ["a", "b"]);
  });
});
