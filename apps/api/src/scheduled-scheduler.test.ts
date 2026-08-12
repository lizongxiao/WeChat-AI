import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cronMatches, nextCronRun, scheduledTestLockSource } from "./scheduled-scheduler.js";

describe("scheduled cron matching", () => {
  it("uses the task timezone, not the worker timezone", () => {
    // 09:00 in Shanghai, 01:00 UTC.
    const at = new Date("2026-08-12T01:00:00.000Z");
    assert.equal(cronMatches("0 9 * * *", at, "Asia/Shanghai"), true);
    assert.equal(cronMatches("0 9 * * *", at, "UTC"), false);
  });

  it("supports weekday and step schedules", () => {
    // 2026-08-10 was Monday; 09:10 Shanghai.
    const at = new Date("2026-08-10T01:10:00.000Z");
    assert.equal(cronMatches("*/5 9 * * 1", at, "Asia/Shanghai"), true);
    assert.equal(cronMatches("*/5 9 * * 2", at, "Asia/Shanghai"), false);
  });

  it("computes the next run in the configured timezone", () => {
    const next = nextCronRun("0 9 * * *", "Asia/Shanghai", new Date("2026-08-12T01:01:00.000Z"));
    assert.equal(next, "2026-08-13T01:00:00.000Z");
  });

  it("keeps a manual service test out of the production dedupe lock", () => {
    // A click on “测试” can happen in the same minute as the normal schedule.
    // It must still send rather than being reported as a duplicate execution.
    assert.notEqual(scheduledTestLockSource("subscription"), "subscription");
    assert.equal(scheduledTestLockSource("subscription"), "subscription:test");
  });
});
