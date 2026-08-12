import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildScheduledMessages,
  buildScheduledRepairUserMessage,
  extractScheduledOutputSkeleton,
  normalizeScheduledLayout,
  scheduledOutputIssues,
  splitScheduledBulletin,
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
    assert.match(String(messages[0]?.content), /按该时刻自然问候/);
    assert.match(String(messages[0]?.content), /27~34℃/);
    assert.match(String(messages[0]?.content), /上海今日天气/);
    assert.equal(messages[1]?.role, "user");
    assert.match(String(messages[1]?.content), /硬性检查清单/);
    assert.match(String(messages[1]?.content), /🌡️ 温度/);
    assert.match(String(messages[1]?.content), /今日寄语/);
  });

  it("accepts compact emoji labels and builds a skeleton repair prompt", () => {
    const loosePrompt = `🌤️ 今日天气
🌡️ 温度
☁️ 天气
🌧️ 降雨
💨 风力
👕 穿衣
☂️ 出行
今日寄语
保留换行`;
    const output = `夜里好。

🌤️ 深圳今日天气｜8月12日
🌡温度：26℃ ～ 31℃
☁天气：多云
🌧降雨：阵雨
💨风力：东南风 2～3 级

👕穿衣：短袖
☂出行：带伞

「今日寄语：热气退一点也挺好。」

先歇着吧。`;
    assert.deepEqual(scheduledOutputIssues(loosePrompt, output), []);

    const richPrompt = `${loosePrompt}

【正确示例】
早呀。

🌤️ 深圳今日天气｜8月13日 周四
🌡️ 温度：27℃ ～ 34℃
☁️ 天气：多云
🌧️ 降雨：午后可能有阵雨
💨 风力：东南风 2～3 级

👕 穿衣：短袖即可。
☂️ 出行：记得带伞。

「今日寄语：慢慢把今天过好就行。」

好啦，先吃点东西。
`;
    const skeleton = extractScheduledOutputSkeleton(richPrompt);
    assert.ok(skeleton);
    assert.match(skeleton!, /🌤️/);
    const repair = buildScheduledRepairUserMessage(
      ["缺少栏目：☁️ 天气"],
      richPrompt,
    );
    assert.match(repair, /整份重写/);
    assert.match(repair, /🌤️ 深圳今日天气/);
    assert.match(repair, /☁️ 天气/);
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

  it("flags section markers smashed into one line", () => {
    const smashed =
      "早上好老板🌤️ 深圳今日天气｜8月13日🌡️ 温度：26℃ ~ 31℃今日寄语：八月的雨";
    const issues = scheduledOutputIssues(taskPrompt, smashed);
    assert.ok(issues.some((x) => x.includes("🌤️") && x.includes("换行")));
    assert.ok(issues.some((x) => x.includes("🌡️") && x.includes("换行")));
  });

  it("repairs smashed weather layout before send", () => {
    const smashed =
      "早上好，老板。🌤️ 深圳今日天气｜8月13日🌡️ 温度：26℃ ~ 31℃☁️ 天气：晴间多云今日寄语：八月的雨，下完就晴。";
    const fixed = normalizeScheduledLayout(smashed);
    assert.match(fixed, /\n\n🌤️/);
    assert.match(fixed, /\n🌡️/);
    assert.match(fixed, /\n☁️/);
    assert.match(fixed, /\n\n今日寄语/);
    assert.doesNotMatch(fixed, /「\n\n今日寄语/);
    assert.deepEqual(scheduledOutputIssues(taskPrompt, fixed).filter((x) => x.includes("换行")), []);
  });

  it("keeps 「今日寄语 together and splits bulletin into WeChat bubbles", () => {
    const smashed =
      "夜里好呀～快12点了。🌤️ 深圳今日天气｜8月12日 周三🌡️ 温度：26℃ ～ 31℃☁️ 天气：多云转阴🌧️ 降雨：有阵雨概率💨 风力：东南风 2～3 级👕 穿衣：短袖就行☂️ 出行：伞带好「今日寄语：热气退一点，人也轻松一点。」这么晚了还没睡呀？";
    const fixed = normalizeScheduledLayout(smashed);
    assert.match(fixed, /\n\n「今日寄语：/);
    assert.doesNotMatch(fixed, /「\n+今日寄语/);
    const chunks = splitScheduledBulletin(fixed);
    assert.equal(chunks.length, 5, JSON.stringify(chunks));
    assert.match(chunks[0]!, /夜里好/);
    assert.match(chunks[1]!, /^🌤️/);
    assert.match(chunks[1]!, /\n🌡️/);
    const wear = chunks.find((c) => c.startsWith("👕"));
    assert.ok(wear);
    assert.match(wear!, /☂️/);
    assert.equal(chunks[3], "「今日寄语：热气退一点，人也轻松一点。」");
    assert.match(chunks[4]!, /还没睡/);
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
