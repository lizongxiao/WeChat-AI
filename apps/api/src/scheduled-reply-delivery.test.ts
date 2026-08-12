import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scheduledReplyParts } from "./scheduled-reply-delivery.js";

describe("scheduled reply delivery", () => {
  it("sends each weather field as its own WeChat bubble without newlines", () => {
    const text = `夜里好呀～快12点了。

🌤️ 深圳今日天气｜8月12日 周三
🌡️ 温度：26℃ ～ 31℃
☁️ 天气：多云转阴
🌧️ 降雨：有阵雨概率
💨 风力：东南风 2～3 级

👕 穿衣：短袖就行
☂️ 出行：伞带好

「今日寄语：热气退一点，人也轻松一点。」

这么晚了还没睡呀？`;
    const parts = scheduledReplyParts({ kind: "reply", text });
    assert.equal(parts.length, 10);
    assert.ok(parts.every((p) => p.kind === "text" && !p.text.includes("\n")));
    assert.equal(parts[0]?.text, "夜里好呀～快12点了。");
    assert.equal(parts[1]?.text, "🌤️ 深圳今日天气｜8月12日 周三");
    assert.equal(parts[2]?.text, "🌡️ 温度：26℃ ～ 31℃");
    assert.equal(parts[8]?.text, "「今日寄语：热气退一点，人也轻松一点。」");
    assert.equal(parts[9]?.text, "这么晚了还没睡呀？");
  });

  it("flattens ChatService multi-part payload that still contains newlines", () => {
    const parts = scheduledReplyParts({
      kind: "reply",
      text: "full\n\ntext",
      parts: [
        { kind: "text", text: "问候" },
        { kind: "text", text: "🌤️ 天气\n🌡️ 温度：28℃" },
      ],
    });
    assert.deepEqual(parts, [
      { kind: "text", text: "问候" },
      { kind: "text", text: "🌤️ 天气" },
      { kind: "text", text: "🌡️ 温度：28℃" },
    ]);
  });
});
