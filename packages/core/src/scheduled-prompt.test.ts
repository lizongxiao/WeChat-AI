import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildScheduledMessages,
  scheduledOutputIssues,
} from "./prompt.js";

const taskPrompt = `这是每天早晨主动发送给用户的天气与晨间问候。
🌤️ {{location}}今日天气｜{日期}
🌡️ 温度：最低温 ~ 最高温
☁️ 天气：天气状况
🌧️ 降雨：降雨情况
💨 风力：风向和风力
今日寄语：xxx
保留换行
整体控制在 150~300 字`;

describe("scheduled prompt contract", () => {
  it("gives the scheduled instruction priority without replaying chat history", () => {
    const messages = buildScheduledMessages({
      systemPrompt: "你是一只喜欢短句闲聊的猫娘。",
      memories: [],
      scheduledPrompt: taskPrompt.replace("{{location}}", "上海"),
      botName: "小铃",
      personaName: "猫娘",
      executionTime: "2026-08-13T01:00:00.000Z",
      timeZone: "Asia/Shanghai",
      webSearchRequired: true,
      trustedInstruction: true,
    });

    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.role, "system");
    assert.match(String(messages[0]?.content), /任务内容与格式要求优先于 Persona/);
    assert.match(String(messages[0]?.content), /2026-08-13 09:00/);
    assert.match(String(messages[0]?.content), /必须先调用 web_search/);
    assert.match(String(messages[0]?.content), /上海今日天气/);
    assert.equal(messages[1]?.role, "user");
  });

  it("detects a weather greeting that ignored the requested structure", () => {
    const issues = scheduledOutputIssues(
      taskPrompt,
      "早啊——虽然现在说早有点心虚，傍晚的天还挂着太阳。",
    );

    assert.ok(issues.some((x) => x.includes("🌡️ 温度")));
    assert.ok(issues.some((x) => x.includes("今日寄语")));
    assert.ok(issues.some((x) => x.includes("换行")));
  });

  it("accepts a structured weather greeting", () => {
    const output = `早上好呀，今天也慢慢醒来吧。

🌤️ 上海今日天气｜8月13日
🌡️ 温度：27℃ ~ 34℃
☁️ 天气：多云
🌧️ 降雨：午后有短时阵雨
💨 风力：东南风 2～3 级

👕 穿衣：轻薄透气，室内备件薄外套。
☂️ 出行：带伞也记得做好防晒。

今日寄语：云会路过，舒服的节奏可以自己留下。

早餐别忘啦，今天也陪你稳稳往前走。`;
    assert.deepEqual(scheduledOutputIssues(taskPrompt, output), []);
  });
});
