import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cronMatches,
  nextCronRun,
  resolveScheduledParams,
  scheduledPreviewTime,
  scheduledTestLockSource,
} from "./scheduled-scheduler.js";

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
    assert.notEqual(
      scheduledTestLockSource("subscription", "run-a"),
      scheduledTestLockSource("subscription", "run-b"),
    );
  });

  it("previews a service at its next planned execution time", () => {
    assert.equal(
      scheduledPreviewTime(
        "0 9 * * *",
        "Asia/Shanghai",
        new Date("2026-08-12T09:28:00.000Z"),
      ),
      "2026-08-13T01:00:00.000Z",
    );
  });

  it("fills blank subscription params with schema and built-in defaults", () => {
    const empty = resolveScheduledParams(
      {},
      {
        required: ["location"],
        properties: { location: { type: "string" } },
      },
    );
    assert.equal(empty.params.location, "深圳");
    assert.deepEqual(empty.defaultsApplied, ["location"]);

    const schemaDefault = resolveScheduledParams(
      { location: "  " },
      {
        required: ["location"],
        properties: { location: { type: "string", default: "广州" } },
      },
    );
    assert.equal(schemaDefault.params.location, "广州");

    const kept = resolveScheduledParams({ location: "上海" }, {
      required: ["location"],
      properties: { location: { type: "string", default: "广州" } },
    });
    assert.equal(kept.params.location, "上海");
    assert.deepEqual(kept.defaultsApplied, []);
  });

  it("keeps cron preview helper for admin UI, separate from smoke-test wall clock", () => {
    // Manual tests now use Date.now(); this helper remains for “下次执行” display.
    const preview = scheduledPreviewTime(
      "30 7 * * *",
      "Asia/Shanghai",
      new Date("2026-08-12T15:30:00.000Z"),
    );
    assert.equal(preview, "2026-08-12T23:30:00.000Z");
  });
});
