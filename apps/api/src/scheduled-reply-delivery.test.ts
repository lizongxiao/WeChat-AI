import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scheduledReplyParts } from "./scheduled-reply-delivery.js";

const bulletin = `夜里好呀～快12点了。

🌤️ 深圳今日天气｜8月12日 周三
🌡️ 温度：26℃ ～ 31℃
☁️ 天气：多云转阴
🌧️ 降雨：有阵雨概率
💨 风力：东南风 2～3 级

👕 穿衣：短袖就行
☂️ 出行：伞带好

「今日寄语：热气退一点，人也轻松一点。」

这么晚了还没睡呀？`;

describe("scheduled reply delivery", () => {
  it("packs a weather bulletin into 3 newline-free WeChat bubbles", () => {
    const parts = scheduledReplyParts({ kind: "reply", text: bulletin });
    assert.equal(parts.length, 3);
    assert.ok(parts.every((p) => p.kind === "text" && !p.text.includes("\n")));
    assert.equal(parts[0]?.text, "夜里好呀～快12点了。");
    assert.match(String(parts[1]?.text), /^🌤️ 深圳今日天气/);
    assert.match(String(parts[1]?.text), /🌡️ 温度：26℃ ～ 31℃/);
    assert.match(String(parts[1]?.text), /👕 穿衣：短袖就行/);
    assert.match(String(parts[1]?.text), /☂️ 出行：伞带好/);
    assert.match(String(parts[2]?.text), /今日寄语：热气退一点/);
    assert.match(String(parts[2]?.text), /还没睡呀/);
  });

  it("re-packs a ChatService multi-part payload instead of exploding every line", () => {
    const parts = scheduledReplyParts({
      kind: "reply",
      text: bulletin,
      parts: [
        { kind: "text", text: "问候" },
        { kind: "text", text: "🌤️ 天气\n🌡️ 温度：28℃" },
      ],
    });
    assert.equal(parts.length, 3);
    assert.equal(parts[0]?.text, "夜里好呀～快12点了。");
    assert.match(String(parts[1]?.text), /🌤️ 深圳今日天气/);
  });

  it("still packs when only parts are present", () => {
    const parts = scheduledReplyParts({
      kind: "reply",
      text: "",
      parts: [
        { kind: "text", text: "早呀" },
        { kind: "text", text: "🌤️ 深圳今日天气｜8月13日\n🌡️ 温度：28℃" },
        { kind: "text", text: "「今日寄语：慢慢来。」\n先吃早餐。" },
      ],
    });
    assert.equal(parts.length, 3);
    assert.equal(parts[0]?.text, "早呀");
    assert.match(String(parts[1]?.text), /🌤️ 深圳今日天气/);
    assert.match(String(parts[1]?.text), /🌡️ 温度：28℃/);
    assert.match(String(parts[2]?.text), /今日寄语/);
    assert.match(String(parts[2]?.text), /先吃早餐/);
  });
});
