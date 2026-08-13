import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_KEEP_ALIVE_POLICY,
  attachMissedDeliveryNotice,
  firstKeepAliveSentence,
  isKeepAliveEligible,
  isStaleKeepAliveError,
  shouldPiggybackKeepAlive,
  type KeepAlivePolicy,
} from "./keep-alive.js";

const policy: KeepAlivePolicy = { ...DEFAULT_KEEP_ALIVE_POLICY };

/** 2026-08-13 12:00 Shanghai — outside 22-8 quiet hours. */
const noon = new Date("2026-08-13T04:00:00.000Z");
/** 2026-08-13 22:30 Shanghai. */
const late = new Date("2026-08-13T14:30:00.000Z");

function hoursAgo(hours: number, now = noon): string {
  return new Date(now.getTime() - hours * 3_600_000).toISOString();
}

describe("isKeepAliveEligible", () => {
  const base = {
    hasToken: true,
    inboundAt: hoursAgo(20),
    policy,
    now: noon,
  };

  it("skips when disabled", () => {
    const r = isKeepAliveEligible({
      ...base,
      policy: { ...policy, enabled: false },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "disabled");
  });

  it("skips without a token", () => {
    const r = isKeepAliveEligible({ ...base, hasToken: false });
    assert.equal(r.reason, "no_token");
  });

  it("skips old peers that have no inbound clock", () => {
    const r = isKeepAliveEligible({ ...base, inboundAt: null });
    assert.equal(r.reason, "no_inbound_clock");
  });

  it("skips when inbound is still fresh", () => {
    const r = isKeepAliveEligible({ ...base, inboundAt: hoursAgo(5) });
    assert.equal(r.reason, "too_fresh");
    assert.ok((r.inboundHours ?? 0) < 18);
  });

  it("skips when inbound is too stale to reach", () => {
    const r = isKeepAliveEligible({ ...base, inboundAt: hoursAgo(41) });
    assert.equal(r.reason, "too_stale");
  });

  it("skips overnight quiet hours", () => {
    const r = isKeepAliveEligible({
      ...base,
      inboundAt: hoursAgo(20, late),
      now: late,
    });
    assert.equal(r.reason, "quiet_hours");
  });

  it("skips when already pinged within min interval", () => {
    const r = isKeepAliveEligible({
      ...base,
      lastKeepAliveAt: hoursAgo(5),
    });
    assert.equal(r.reason, "already_pinged");
  });

  it("skips when a scheduled send is due soon", () => {
    const r = isKeepAliveEligible({
      ...base,
      nextScheduledAt: new Date(noon.getTime() + 90 * 60_000).toISOString(),
    });
    assert.equal(r.reason, "scheduled_due_soon");
  });

  it("does not treat a past due time as due soon", () => {
    const r = isKeepAliveEligible({
      ...base,
      nextScheduledAt: new Date(noon.getTime() - 60_000).toISOString(),
    });
    assert.equal(r.ok, true);
  });

  it("stops nagging after a stale-session error until the next inbound", () => {
    const inboundAt = hoursAgo(22);
    const r = isKeepAliveEligible({
      ...base,
      inboundAt,
      lastKeepAliveAt: hoursAgo(21),
      lastKeepAliveError: "ilink_error: prepare failed ret=-2",
    });
    assert.equal(r.reason, "stale_session");
  });

  it("allows a ping after inbound refreshes past a stale error", () => {
    const r = isKeepAliveEligible({
      ...base,
      inboundAt: hoursAgo(19),
      lastKeepAliveAt: hoursAgo(30),
      lastKeepAliveError: "prepare failed ret=-2",
    });
    assert.equal(r.ok, true);
  });

  it("is eligible in the 18–40h window outside quiet hours", () => {
    const r = isKeepAliveEligible(base);
    assert.equal(r.ok, true);
    assert.ok((r.inboundHours ?? 0) >= 18);
  });
});

describe("shouldPiggybackKeepAlive", () => {
  it("asks for a reply only inside the keep-alive window", () => {
    assert.equal(shouldPiggybackKeepAlive(hoursAgo(5), policy, noon), false);
    assert.equal(shouldPiggybackKeepAlive(hoursAgo(20), policy, noon), true);
    assert.equal(shouldPiggybackKeepAlive(hoursAgo(41), policy, noon), false);
    assert.equal(shouldPiggybackKeepAlive(null, policy, noon), false);
    assert.equal(
      shouldPiggybackKeepAlive(hoursAgo(20), { ...policy, enabled: false }, noon),
      false,
    );
  });
});

describe("keep-alive helpers", () => {
  it("detects stale session errors but not rate limits", () => {
    assert.equal(isStaleKeepAliveError("prepare failed ret=-2"), true);
    assert.equal(isStaleKeepAliveError("no_context_token"), true);
    assert.equal(isStaleKeepAliveError("too many requests / frequen"), false);
  });

  it("keeps the first short sentence", () => {
    assert.equal(firstKeepAliveSentence("在吗？顺便问一句今天好不好。后面的丢掉"), "在吗？");
    assert.equal(firstKeepAliveSentence(""), "");
  });

  it("prefixes a missed bulletin onto the first bubble", () => {
    const texts = attachMissedDeliveryNotice(["早上好呀", "深圳多云"]);
    assert.equal(texts[0], "早上那条刚才没送到。早上好呀");
    assert.equal(texts[1], "深圳多云");
    assert.equal(texts.length, 2);
    assert.deepEqual(attachMissedDeliveryNotice(texts), texts);
  });
});
