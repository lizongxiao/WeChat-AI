import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseScheduledTask, scheduledChatTools } from "./scheduled-chat-tools.js";

describe("scheduled chat tool contract", () => {
  it("exposes only confirmation-gated mutation tools", () => {
    assert.deepEqual(scheduledChatTools.map(x => x.name), ["prepare_scheduled_task", "confirm_scheduled_task", "list_my_scheduled_tasks", "update_scheduled_task", "cancel_scheduled_task"]);
  });

  it("parses recurring, weekday, and one-time Chinese schedules", () => {
    const daily=parseScheduledTask("每天晚上10点提醒我睡觉",new Date("2026-08-12T01:00:00Z"));
    assert.ok(daily && !("question" in daily));
    if(!daily || "question" in daily) return;
    assert.equal(daily.schedule,"0 22 * * *");
    const weekdays=parseScheduledTask("每周一、三、五下午6点提醒我写周报",new Date("2026-08-12T01:00:00Z"));
    assert.ok(weekdays && !("question" in weekdays));
    if(!weekdays || "question" in weekdays) return;
    assert.equal(weekdays.schedule,"0 18 * * 1,3,5");
    const once=parseScheduledTask("明天早上8点提醒我带伞",new Date("2026-08-12T01:00:00Z"));
    assert.ok(once && !("question" in once));
    if(!once || "question" in once) return;
    assert.equal(once.schedule_type,"one_time");
    assert.equal(once.execute_at,"2026-08-13T00:00:00.000Z");
  });

  it("does not infer missing times or create tasks from ordinary conversation", () => {
    assert.deepEqual(parseScheduledTask("每天提醒我喝水"),{question:"几点提醒你？"});
    assert.equal(parseScheduledTask("我每天晚上都睡很晚"),null);
  });
});
