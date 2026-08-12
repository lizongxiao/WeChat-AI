import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildScheduledMessages,
  scheduledOutputIssues,
} from "./prompt.js";
import {
  extractWeatherLocation,
  scheduledSearchQuery,
} from "./chat-service.js";

const taskPrompt = `这是每天早晨主动发送给用户的天气与晨间问候。
🌤️ {{location}}今日天气｜{日期}
🌡️ 温度：最低温 ~ 最高温
☁️ 天气：天气状况
🌧️ 降雨：降雨情况
💨 风力：风向和风力
今日寄语：15~40 字
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
      webSearchContext: "上海 2026-08-13：多云，27~34℃，东南风。",
    });

    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.role, "system");
    assert.match(String(messages[0]?.content), /任务内容与格式要求优先于 Persona/);
    assert.match(String(messages[0]?.content), /2026-08-13 09:00/);
    assert.match(String(messages[0]?.content), /服务端已完成联网查询/);
    assert.match(String(messages[0]?.content), /27~34℃/);
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

  it("uses the overall length bound, not the 寄语 subsection bound", () => {
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
    const tooLong = scheduledOutputIssues(
      taskPrompt,
      `${output}\n${"啦".repeat(200)}`,
    );
    assert.ok(tooLong.some((x) => /字数为 \d+，要求 150~300 字/.test(x)));
    assert.ok(!tooLong.some((x) => /15~40/.test(x)));
  });

  it("prefers 整体控制在 over bare 控制在 under 今日寄语", () => {
    const realPrompt = `这是每天早晨主动发送给用户的天气与晨间问候。

请先联网查询今天 {{location}} 的最新天气，再以当前 Persona 的身份主动向用户发送消息。

第三部分：每日一句
每天必须生成一句简短的「今日寄语」。
要求：
- 控制在 15~40 字
格式：
「今日寄语：xxx」

【全局要求】
- 保留换行
- 整体控制在 300～500 字`;
    const output = `早上好呀。

🌤️ 深圳今日天气｜8月13日
🌡️ 温度：27℃ ~ 34℃
☁️ 天气：多云
🌧️ 降雨：午后有短时阵雨
💨 风力：东南风 2～3 级

👕 穿衣：轻薄透气。
☂️ 出行：带伞防晒。

今日寄语：云会路过，舒服的节奏可以自己留下。

今天也慢慢来。`;
    // ~120 chars — below 300 overall, but far above 寄语 15~40
    const issues = scheduledOutputIssues(realPrompt, output);
    assert.ok(
      issues.some((x) => /要求 300~500 字/.test(x)),
      JSON.stringify(issues),
    );
    assert.ok(!issues.some((x) => /15~40/.test(x)), JSON.stringify(issues));

    const longEnough = `${output}\n${"今天也一起慢慢走。".repeat(20)}`;
    assert.deepEqual(scheduledOutputIssues(realPrompt, longEnough), []);
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

  it("extracts a city and never treats 的/给用户 as the location", () => {
    assert.equal(extractWeatherLocation("播报今天上海的天气"), "上海");
    assert.equal(
      extractWeatherLocation(taskPrompt.replace("{{location}}", "杭州")),
      "杭州",
    );
    assert.equal(extractWeatherLocation("今天的天气怎么样"), "");
    assert.equal(
      extractWeatherLocation(
        "这是每天早晨主动发送给用户的天气与晨间问候。\n🌤️ 今日天气｜{日期}",
      ),
      "",
    );
    assert.equal(
      extractWeatherLocation(
        "这是每天早晨主动发送给用户的天气与晨间问候。",
        "成都",
      ),
      "成都",
    );
    const planned = scheduledSearchQuery(
      "今天的天气",
      "2026-08-13T01:00:00.000Z",
      "Asia/Shanghai",
    );
    assert.equal(planned.usedDefaultLocation, true);
    assert.equal(planned.location, "深圳");
    assert.match(planned.query, /深圳.*天气/);
    assert.doesNotMatch(planned.query, /\s的\s/);
    const hinted = scheduledSearchQuery(
      "这是每天早晨主动发送给用户的天气与晨间问候。",
      "2026-08-13T01:00:00.000Z",
      "Asia/Shanghai",
      "南京",
    );
    assert.equal(hinted.location, "南京");
    assert.equal(hinted.usedDefaultLocation, undefined);
    assert.match(hinted.query, /南京.*天气/);
    const shanghai = scheduledSearchQuery(
      "🌤️ 上海今日天气｜{日期}",
      "2026-08-13T01:00:00.000Z",
      "Asia/Shanghai",
    );
    assert.equal(shanghai.location, "上海");
    assert.match(shanghai.query, /上海.*天气/);
  });
});
