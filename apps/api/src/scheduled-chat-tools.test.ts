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
  parseAppointmentReminder,
  resolveScheduledTaskReference,
  scheduledChatTools,
} from "./scheduled-chat-tools.js";
import type { ScheduledTask } from "@wechat-ai/db";

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

  it("derives reminder times relative to an appointment", () => {
    const message="【深圳市第三人民医院】已预约2026年09月01日16:00-16:30口腔牙周科门诊，请提前30分钟取号";
    const oneDay=parseAppointmentReminder(message,"提前一天提醒我");
    assert.ok(oneDay);
    assert.equal(oneDay?.execute_at,"2026-08-31T08:00:00.000Z");
    assert.equal(oneDay?.display,"2026年08月31日 16:00（提前1天）");
    const oneHour=parseAppointmentReminder(message,"提前一个小时提醒");
    assert.equal(oneHour?.execute_at,"2026-09-01T07:00:00.000Z");
    const custom=parseAppointmentReminder(message,"提前90分钟");
    assert.equal(custom?.execute_at,"2026-09-01T06:30:00.000Z");
    assert.equal(parseAppointmentReminder(message,"前一天上午8点")?.execute_at,"2026-08-31T00:00:00.000Z");
    assert.equal(parseAppointmentReminder(message,"8月31日上午9点")?.execute_at,"2026-08-31T01:00:00.000Z");
    assert.equal(parseAppointmentReminder(message,"9月2日上午9点"),null);
  });

  it("recognizes natural ways to abandon a pending reminder", () => {
    for (const text of ["这个需要去掉提醒了", "关闭", "不是", "取消"]) {
      assert.equal(isScheduledCancelIntent(text), true, text);
    }
    assert.equal(isScheduledCancelIntent("不是每天，是明天"), false);
  });

  it("resolves conversational and quoted references to scheduled tasks", () => {
    const task = (id:string,name:string,prompt:string,created_at:string):ScheduledTask => ({
      id,user_id:"user",bot_id:"bot",peer_id:"peer",persona_id:"persona",name,prompt,
      schedule:"0 8 * * *",timezone:"Asia/Shanghai",web_search_enabled:0,enabled:1,
      created_via:"chat",created_at,updated_at:created_at,
    });
    const tasks=[
      task("a","喝水","每天早上8点提醒我喝水","2026-08-01T00:00:00Z"),
      task("b","黄金实时价格","每天开盘前返回黄金实时价格","2026-08-02T00:00:00Z"),
    ];
    assert.equal(resolveScheduledTaskReference(tasks,"关闭黄金实时价格提醒").task?.id,"b");
    assert.equal(resolveScheduledTaskReference(tasks,"引用：每天开盘前返回黄金实时价格\n取消这个任务").task?.id,"b");
    assert.equal(resolveScheduledTaskReference(tasks,"取消第二个定时任务").task?.id,"b");
    assert.equal(resolveScheduledTaskReference(tasks,"把提醒关掉").task,null);
    assert.equal(resolveScheduledTaskReference([tasks[0]!],"把这个提醒关掉").task?.id,"a");
    assert.equal(resolveScheduledTaskReference([tasks[0]!],"不要了").task,null);
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
    assert.match((await ask("已预约2026年09月01日16:00口腔牙周科门诊")) ?? "", /识别到预约.*提前一天.*提前一小时/s);
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

    assert.match((await ask("关闭定时任务")) ?? "", /你想关闭哪一个/);
    assert.match((await ask("关闭黄金实时价格提醒")) ?? "", /准备删除/);
    assert.match((await ask("不是")) ?? "", /已取消待确认/);
    assert.match((await ask("引用：每天开盘前给你返回黄金实时价格，创建定时任务\n取消这个任务")) ?? "", /准备删除/);
    assert.match((await ask("确认取消")) ?? "", /已删除/);
    assert.equal((await listPeerScheduledTasks(db,botId,peerId)).some(task=>task.name.includes("黄金实时价格")),false);

    const beforeSubscription = await ask("这个人设有哪些定时任务");
    assert.match(beforeSubscription ?? "", /晨间天气/);
    assert.match(beforeSubscription ?? "", /\[自建任务\].*起床/);
    assert.match(beforeSubscription ?? "", /当前人设还可以订阅/);

    assert.match((await ask(`订阅${service.name}`)) ?? "", /location/);
    assert.match((await ask("上海")) ?? "", /准备订阅/);
    assert.match((await ask("嗯，确认")) ?? "", /已订阅/);
    const overview = await ask("我现在订阅了什么");
    assert.match(overview ?? "", /\[系统订阅\].*晨间天气.*上海/);

    await deleteSystemSubscriptionService(db, service.id);
    await db.close();
  });
});
