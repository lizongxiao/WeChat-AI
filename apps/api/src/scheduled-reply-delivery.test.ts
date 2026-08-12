import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scheduledReplyParts } from "./scheduled-reply-delivery.js";

describe("scheduled reply delivery", () => {
  it("keeps multi-line text and intentional blank lines in one final message", () => {
    const text = "🌤️ 今日天气：晴\n🌡️ 温度：28℃\n\n☁️ 出行建议：注意防晒";
    assert.deepEqual(scheduledReplyParts({ kind: "reply", text, parts: [{ kind: "text", text: "ignored second bubble" }] }), [
      { kind: "text", text },
    ]);
  });
});
