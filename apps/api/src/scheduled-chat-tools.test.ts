import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  approvePeer,
  deleteSystemSubscriptionService,
  getPersonaBySlug,
  listPeerScheduledTasks,
  openDatabase,
  saveSystemSubscriptionService,
  seedPersonas,
  setAssignment,
  setServicePersonas,
  upsertBotAccount,
} from "@wechat-ai/db";
import {
  handleScheduledChatTool,
  isScheduledCancelIntent,
  isScheduledOverviewIntent,
  parseScheduledTask,
  scheduledChatTools,
} from "./scheduled-chat-tools.js";

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

describe("scheduled chat tool contract", () => {
  it("exposes only confirmation-gated mutation tools", () => {
    assert.deepEqual(scheduledChatTools.map(x => x.name), ["prepare_scheduled_task", "confirm_scheduled_task", "list_my_scheduled_tasks", "update_scheduled_task", "cancel_scheduled_task"]);
  });

  it("parses recurring, weekday, and one-time Chinese schedules", () => {
    const daily=parseScheduledTask("每天晚上10点提醒我睡觉",new Date("2026-08-12T01:00:00Z"));
    assert.ok(daily && !("question" in daily));
    if(!daily || "question" in daily) return;
    assert.equal(daily.schedule,"0 22 * * *");
    const weekdays=parseScheduledTask("每周一、三、五下午6点提醒我写周报",new Date("2026-08-12T01:00:00Z"));
    assert.ok(weekdays && !("question" in weekdays));
    if(!weekdays || "question" in weekdays) return;
    assert.equal(weekdays.schedule,"0 18 * * 1,3,5");
    const once=parseScheduledTask("明天早上8点提醒我带伞",new Date("2026-08-12T01:00:00Z"));
    assert.ok(once && !("question" in once));
    if(!once || "question" in once) return;
    assert.equal(once.schedule_type,"one_time");
    assert.equal(once.execute_at,"2026-08-13T00:00:00.000Z");
  });

  it("does not infer missing times or create tasks from ordinary conversation", () => {
    assert.deepEqual(parseScheduledTask("每天提醒我喝水"),{question:"几点提醒你？"});
    assert.equal(parseScheduledTask("我每天晚上都睡很晚"),null);
  });

  it("understands common conversational creation requests and Chinese clocks", () => {
    const wakeUp = parseScheduledTask(
      "帮我设置一个每天早上八点半的定时任务，叫我起床",
    );
    assert.ok(wakeUp && !("question" in wakeUp));
    if (!wakeUp || "question" in wakeUp) return;
    assert.equal(wakeUp.schedule, "30 8 * * *");
    assert.match(wakeUp.name, /起床/);

    const weather = parseScheduledTask("每天早上7点给我播报上海天气");
    assert.ok(weather && !("question" in weather));
    if (!weather || "question" in weather) return;
    assert.equal(weather.web_search_enabled, 1);
  });

  it("asks for recurrence instead of silently turning a time into a daily task", () => {
    assert.deepEqual(parseScheduledTask("晚上8点提醒我吃药"), {
      question: "你希望今天、明天，还是每天 20:00 提醒？",
    });
  });

  it("uses an explicit appointment date for a one-time reminder", () => {
    const appointment = parseScheduledTask(
      "已预约2026年09月01日16:00口腔牙周科门诊，当天上午8点提醒我",
      new Date("2026-08-25T14:10:00Z"),
    );
    assert.ok(appointment && !("question" in appointment));
    if (!appointment || "question" in appointment) return;
    assert.equal(appointment.schedule_type, "one_time");
    assert.equal(appointment.execute_at, "2026-09-01T00:00:00.000Z");
    assert.equal(appointment.display, "2026年09月01日 08:00");
  });

  it("recognizes natural ways to abandon a pending reminder", () => {
    for (const text of ["这个需要去掉提醒了", "关闭", "不是", "取消"]) {
      assert.equal(isScheduledCancelIntent(text), true, text);
    }
    assert.equal(isScheduledCancelIntent("不是每天，是明天"), false);
  });

  it("recognizes natural questions about the current persona's schedules", () => {
    for (const text of [
      "你有什么定时任务",
      "你被分配了什么定时任务",
      "这个人设有哪些提醒",
      "我现在订阅了什么",
      "看看我的推送列表",
    ]) {
      assert.equal(isScheduledOverviewIntent(text), true, text);
    }
    assert.equal(isScheduledOverviewIntent("今天有什么安排"), false);
  });

  it("creates a task through confirmation and reports all schedules for the current persona", async (t) => {
    let db;
    try {
      db = openDatabase(redisUrl);
      await Promise.race([
        db.ping(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 2500),
        ),
      ]);
    } catch {
      try { await db?.close(); } catch {}
      t.skip("Redis not available");
      return;
    }
    await seedPersonas(db);
    const persona = await getPersonaBySlug(db, "catgirl");
    assert.ok(persona);
    const suffix = Date.now().toString(36);
    const botId = `bot_schedule_chat_${suffix}`;
    const peerId = `peer_${suffix}@im.wechat`;
    await upsertBotAccount(db, {
      id: botId,
      ownerUserId: `owner_${suffix}`,
      displayName: "测试机器人",
      botToken: "test-token",
    });
    await approvePeer(db, botId, peerId);
    await setAssignment(db, botId, peerId, persona!.id);
    const service = await saveSystemSubscriptionService(db, {
      name: `晨间天气${suffix}`,
      description: "每天发送天气",
      prompt_template: "查询 {{location}} 天气",
      params_schema: {
        type: "object",
        required: ["location"],
        properties: { location: { type: "string" } },
      },
      schedule: "30 7 * * *",
      timezone: "Asia/Shanghai",
      web_search_enabled: 1,
      enabled: 1,
    });
    await setServicePersonas(db, service.id, [persona!.id]);

    const ask = (text:string) =>
      handleScheduledChatTool(db!, { botId, peerId, text });
    assert.equal(await ask("已预约2026年09月01日16:00口腔牙周科门诊"), null);
    const appointmentPlan = await ask("当天上午8点提醒我");
    assert.match(appointmentPlan ?? "", /准备创建定时任务/);
    assert.match(appointmentPlan ?? "", /2026年09月01日 08:00/);
    assert.match((await ask("取消")) ?? "", /已取消/);
    const prepared = await ask("帮我设置每天早上八点半叫我起床");
    assert.match(prepared ?? "", /准备创建定时任务/);
    assert.match((await ask("好的，创建吧")) ?? "", /已创建/);
    assert.match((await ask("每天提醒我喝水")) ?? "", /几点/);
    assert.match((await ask("上午九点")) ?? "", /准备创建定时任务/);
    assert.match((await ask("确认")) ?? "", /已创建/);

    // A user can abandon a clarification in ordinary language. The pending
    // draft must be cleared instead of trapping every later message in the
    // same "today/tomorrow/daily" question.
    assert.match((await ask("晚上8点提醒我吃药")) ?? "", /今天、明天/);
    assert.match((await ask("这个需要去掉提醒了")) ?? "", /已取消/);
    assert.equal(await ask("不是"), null);

    assert.match((await ask("晚上8点提醒我吃药")) ?? "", /今天、明天/);
    assert.match((await ask("关闭")) ?? "", /已取消/);
    assert.equal(await ask("不是"), null);
    // Regression for the conversational completion shown in production: a
    // spaced clock must advance the pending draft instead of asking again.
    assert.match((await ask("每天开盘前给你返回黄金实时价格，创建定时任务")) ?? "", /几点/);
    const goldPlan = await ask("每天 8 点");
    assert.match(goldPlan ?? "", /准备创建定时任务/);
    assert.match(goldPlan ?? "", /每天 08:00/);
    assert.match((await ask("确认")) ?? "", /已创建/);
    const tasks = await listPeerScheduledTasks(db, botId, peerId);
    assert.equal(tasks.length, 3);
    assert.ok(tasks.some(task=>task.schedule==="30 8 * * *"));
    assert.ok(tasks.some(task=>task.schedule==="0 9 * * *"));
    assert.ok(tasks.some(task=>task.schedule==="0 8 * * *"));

    const beforeSubscription = await ask("这个人设有哪些定时任务");
    assert.match(beforeSubscription ?? "", /晨间天气/);
    assert.match(beforeSubscription ?? "", /\[自建任务\].*起床/);
    assert.match(beforeSubscription ?? "", /当前人设还可以订阅/);

    assert.match((await ask(`订阅${service.name}`)) ?? "", /location/);
    assert.match((await ask("上海")) ?? "", /准备订阅/);
    assert.match((await ask("嗯，确认")) ?? "", /已订阅/);
    const overview = await ask("我现在订阅了什么");
    assert.match(overview ?? "", /\[系统订阅\].*晨间天气.*上海/);
    assert.ok(tasks.some(task=>task.name.includes("黄金实时价格")));

    await deleteSystemSubscriptionService(db, service.id);
    await db.close();
  });
});
