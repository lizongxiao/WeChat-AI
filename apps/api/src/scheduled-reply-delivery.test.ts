import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scheduledReplyParts } from "./scheduled-reply-delivery.js";

describe("scheduled reply delivery", () => {
  it("splits blank-line paragraphs into separate WeChat bubbles", () => {
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
    assert.equal(parts.length, 5);
    assert.equal(parts[0]?.text, "夜里好呀～快12点了。");
    assert.match(parts[1]!.text, /^🌤️[\s\S]*💨/);
    assert.match(parts[2]!.text, /^👕[\s\S]*☂️/);
    assert.equal(parts[3]?.text, "「今日寄语：热气退一点，人也轻松一点。」");
    assert.equal(parts[4]?.text, "这么晚了还没睡呀？");
  });

  it("prefers ChatService multi-part payload when present", () => {
    const parts = scheduledReplyParts({
      kind: "reply",
      text: "full\n\ntext",
      parts: [
        { kind: "text", text: "问候" },
        { kind: "text", text: "天气块" },
      ],
    });
    assert.deepEqual(parts, [
      { kind: "text", text: "问候" },
      { kind: "text", text: "天气块" },
    ]);
  });
});
