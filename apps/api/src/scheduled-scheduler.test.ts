import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cronMatches,
  decideScheduledDue,
  DEFAULT_MISSED_GRACE_MS,
  DEFAULT_ONE_TIME_RETRY_BACKOFF_MS,
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

describe("decideScheduledDue (expiry-driven scheduling)", () => {
  const now = new Date("2026-08-12T01:00:30.000Z"); // 09:00:30 Shanghai
  const graceMs = DEFAULT_MISSED_GRACE_MS;
  const backoffMs = DEFAULT_ONE_TIME_RETRY_BACKOFF_MS;
  const cronInput = (extra: Record<string, unknown>) => ({
    enabled: true,
    scheduleType: "cron" as const,
    schedule: "0 9 * * *",
    timezone: "Asia/Shanghai",
    now,
    graceMs,
    retryBackoffMs: backoffMs,
    ...extra,
  });

  it("cron: future next_run_at is not due", () => {
    const d = decideScheduledDue(
      cronInput({ nextRunAt: "2026-08-13T01:00:00.000Z" }),
    );
    assert.equal(d.due, false);
    assert.equal(d.skipReason, "future");
  });

  it("cron: expired next_run_at inside grace is due and advances", () => {
    // next_run_at 09:00:00, now 09:00:30 → 30s late, execute (catch-up)
    const d = decideScheduledDue(
      cronInput({ nextRunAt: "2026-08-12T01:00:00.000Z" }),
    );
    assert.equal(d.due, true);
    assert.equal(d.setNextRunAt, "2026-08-13T01:00:00.000Z");
  });

  it("cron: expired beyond grace is skipped and advanced (no stale delivery)", () => {
    // next_run_at 20 minutes ago > 10 min grace
    const d = decideScheduledDue(
      cronInput({ nextRunAt: "2026-08-12T00:40:00.000Z" }),
    );
    assert.equal(d.due, false);
    assert.equal(d.skipReason, "missed_window");
    assert.equal(d.setNextRunAt, "2026-08-13T01:00:00.000Z");
  });

  it("cron: missing next_run_at initializes the schedule", () => {
    const d = decideScheduledDue(cronInput({ nextRunAt: null }));
    assert.equal(d.due, false);
    assert.equal(d.skipReason, "initialized");
    assert.equal(d.setNextRunAt, "2026-08-13T01:00:00.000Z");
  });

  it("cron: disabled items are never due", () => {
    const d = decideScheduledDue(
      cronInput({ enabled: false, nextRunAt: "2026-08-12T01:00:00.000Z" }),
    );
    assert.equal(d.due, false);
    assert.equal(d.skipReason, "disabled");
  });

  it("one_time: future execute_at is not due", () => {
    const d = decideScheduledDue({
      ...cronInput({}),
      scheduleType: "one_time",
      executeAt: "2026-08-12T02:00:00.000Z",
    });
    assert.equal(d.due, false);
    assert.equal(d.skipReason, "future");
  });

  it("one_time: due at/after execute_at", () => {
    const d = decideScheduledDue({
      ...cronInput({}),
      scheduleType: "one_time",
      executeAt: "2026-08-12T01:00:00.000Z",
    });
    assert.equal(d.due, true);
  });

  it("one_time: failed attempt backs off, then retries inside grace", () => {
    const base = {
      ...cronInput({}),
      scheduleType: "one_time" as const,
      executeAt: "2026-08-12T01:00:00.000Z",
    };
    // attempt just failed 10s ago → backoff
    const backoff = decideScheduledDue({
      ...base,
      lastRunAt: "2026-08-12T01:00:20.000Z",
      lastStatus: "error",
    });
    assert.equal(backoff.due, false);
    assert.equal(backoff.skipReason, "backoff");
    // attempt failed 5 minutes ago → retry (grace is 10 min)
    const retry = decideScheduledDue({
      ...base,
      lastRunAt: "2026-08-11T23:55:00.000Z",
      lastStatus: "error",
    });
    assert.equal(retry.due, true);
  });

  it("one_time: never retries after a successful send", () => {
    const d = decideScheduledDue({
      ...cronInput({}),
      scheduleType: "one_time",
      executeAt: "2026-08-12T01:00:00.000Z",
      lastRunAt: "2026-08-12T01:00:10.000Z",
      lastStatus: "sent",
    });
    assert.equal(d.due, false);
  });

  it("one_time: beyond grace without success is disabled", () => {
    const d = decideScheduledDue({
      ...cronInput({}),
      scheduleType: "one_time",
      executeAt: "2026-08-12T00:30:00.000Z", // 30 min ago
    });
    assert.equal(d.due, false);
    assert.equal(d.disable, true);
    assert.equal(d.skipReason, "missed_window");
  });
});
