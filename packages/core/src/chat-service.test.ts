import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  approvePeer,
  listMemories,
  listRecentMessages,
  openDatabase,
  replaceMemories,
  seedPersonas,
  setAssignment,
  setPeerProactiveEnabled,
  getPersonaBySlug,
  upsertBotAccount,
} from "@wechat-ai/db";
import type { BuiltinToolName, LlmClient } from "@wechat-ai/llm";
import { ChatService } from "./chat-service.js";

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

class FakeLlm implements Pick<LlmClient, "chat" | "chatWithUsage"> {
  calls = 0;
  lastMessages: unknown;
  lastOpts: unknown;
  constructor(
    private reply: string | string[],
    private toolsUsed: BuiltinToolName[] = [],
  ) {}
  private next(): string {
    this.calls++;
    if (typeof this.reply === "string") return this.reply;
    const i = Math.min(this.calls - 1, this.reply.length - 1);
    return this.reply[i] ?? "";
  }
  async chat(): Promise<string> {
    return this.next();
  }
  async chatWithUsage(messages?: unknown, opts?: unknown) {
    this.lastMessages = messages;
    this.lastOpts = opts;
    return {
      text: this.next(),
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      model: "fake",
      toolsUsed: this.toolsUsed,
    };
  }
}

function asLlm(fake: FakeLlm): LlmClient {
  return fake as unknown as LlmClient;
}

describe("ChatService multi-user isolation (Redis)", () => {
  it("keeps separate memories per peer", async (t) => {
    let db;
    try {
      db = openDatabase(redisUrl);
      await Promise.race([
        db.ping(),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("timeout")), 2500),
        ),
      ]);
    } catch {
      try {
        await db?.close();
      } catch {
        /* ignore */
      }
      t.skip("Redis not available");
      return;
    }
    await seedPersonas(db);
    const cat = (await getPersonaBySlug(db, "catgirl"))!;
    const botId = `bot_test_${Date.now()}`;
    await upsertBotAccount(db, {
      id: botId,
      ownerUserId: "u_test",
      displayName: "test",
      botToken: "test-token",
    });

    await approvePeer(db, botId, "user_a@im.wechat");
    await approvePeer(db, botId, "user_b@im.wechat");
    await setAssignment(db, botId, "user_a@im.wechat", cat.id);
    await setAssignment(db, botId, "user_b@im.wechat", cat.id);
    await replaceMemories(db, botId, "user_a@im.wechat", cat.id, ["A 喜欢草莓"]);
    await replaceMemories(db, botId, "user_b@im.wechat", cat.id, ["B 喜欢蓝莓"]);

    const memA = await listMemories(db, botId, "user_a@im.wechat", cat.id);
    const memB = await listMemories(db, botId, "user_b@im.wechat", cat.id);
    assert.equal(memA[0]?.content, "A 喜欢草莓");
    assert.equal(memB[0]?.content, "B 喜欢蓝莓");

    const chat = new ChatService(db, asLlm(new FakeLlm("喵～你好")), {
      allowUnapproved: false,
      memoryExtractEveryN: 999,
      // Keep isolation test free of second-pass filter coupling
      replyFilterEnabled: false,
    });
    const r1 = await chat.handleInbound({
      botAccountId: botId,
      peerId: "user_a@im.wechat",
      text: "嗨",
      contextToken: "tok-a",
    });
    assert.equal(r1.kind, "reply");
    await db.close();
  });

  it("handleInbound uses reply filter second LLM pass", async (t) => {
    let db;
    try {
      db = openDatabase(redisUrl);
      await Promise.race([
        db.ping(),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("timeout")), 2500),
        ),
      ]);
    } catch {
      try {
        await db?.close();
      } catch {
        /* ignore */
      }
      t.skip("Redis not available");
      return;
    }
    await seedPersonas(db);
    const cat = (await getPersonaBySlug(db, "catgirl"))!;
    const botId = `bot_filter_${Date.now()}`;
    await upsertBotAccount(db, {
      id: botId,
      ownerUserId: "u_test",
      displayName: "test",
      botToken: "test-token",
    });
    await approvePeer(db, botId, "user_f@im.wechat");
    await setAssignment(db, botId, "user_f@im.wechat", cat.id);

    const fake = new FakeLlm([
      "好呀～想你了 下次见哦",
      JSON.stringify({ messages: ["好呀～", "想你了", "下次见哦"] }),
    ]);
    const chat = new ChatService(db, asLlm(fake), {
      allowUnapproved: false,
      memoryExtractEveryN: 999,
      replyFilterEnabled: true,
      stickersEnabled: false,
    });
    const r = await chat.handleInbound({
      botAccountId: botId,
      peerId: "user_f@im.wechat",
      text: "嗨",
      contextToken: "tok-f",
    });
    assert.equal(r.kind, "reply");
    assert.equal(fake.calls, 2, "primary + filter LLM");
    assert.ok(r.parts && r.parts.length >= 2, JSON.stringify(r.parts));
    assert.equal(r.bubblesFromJson, true);
    await db.close();
  });

  it("handleProactive skips without writing user message", async (t) => {
    let db;
    try {
      db = openDatabase(redisUrl);
      await Promise.race([
        db.ping(),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("timeout")), 2500),
        ),
      ]);
    } catch {
      try {
        await db?.close();
      } catch {
        /* ignore */
      }
      t.skip("Redis not available");
      return;
    }
    await seedPersonas(db);
    const cat = (await getPersonaBySlug(db, "catgirl"))!;
    const botId = `bot_proactive_${Date.now()}`;
    await upsertBotAccount(db, {
      id: botId,
      ownerUserId: "u_test",
      displayName: "test",
      botToken: "test-token",
    });
    await approvePeer(db, botId, "user_p@im.wechat");
    await setAssignment(db, botId, "user_p@im.wechat", cat.id);
    await setPeerProactiveEnabled(db, botId, "user_p@im.wechat", true);

    const chat = new ChatService(
      db,
      asLlm(new FakeLlm('{"skip":true,"reason":"quiet"}')),
      {
        allowUnapproved: false,
        memoryExtractEveryN: 999,
        replyFilterEnabled: true,
      },
    );
    const r = await chat.handleProactive({
      botAccountId: botId,
      peerId: "user_p@im.wechat",
      contextToken: "tok-p",
      idleHours: 14,
    });
    assert.equal(r.kind, "skip");
    const hist = await listRecentMessages(db, botId, "user_p@im.wechat", 20);
    assert.equal(hist.length, 0);
    await db.close();
  });

  it("handleProactive stores assistant reply", async (t) => {
    let db;
    try {
      db = openDatabase(redisUrl);
      await Promise.race([
        db.ping(),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("timeout")), 2500),
        ),
      ]);
    } catch {
      try {
        await db?.close();
      } catch {
        /* ignore */
      }
      t.skip("Redis not available");
      return;
    }
    await seedPersonas(db);
    const cat = (await getPersonaBySlug(db, "catgirl"))!;
    const botId = `bot_proactive2_${Date.now()}`;
    await upsertBotAccount(db, {
      id: botId,
      ownerUserId: "u_test",
      displayName: "test",
      botToken: "test-token",
    });
    await approvePeer(db, botId, "user_q@im.wechat");
    await setAssignment(db, botId, "user_q@im.wechat", cat.id);
    await setPeerProactiveEnabled(db, botId, "user_q@im.wechat", true);

    const fake = new FakeLlm([
      "想你啦 在干嘛喵",
      JSON.stringify({ messages: ["想你啦", "在干嘛喵"] }),
    ]);
    const chat = new ChatService(db, asLlm(fake), {
      allowUnapproved: false,
      memoryExtractEveryN: 999,
      replyFilterEnabled: true,
      stickersEnabled: false,
    });
    const r = await chat.handleProactive({
      botAccountId: botId,
      peerId: "user_q@im.wechat",
      contextToken: "tok-q",
      idleHours: 15,
    });
    assert.equal(r.kind, "reply");
    assert.equal(fake.calls, 2);
    assert.ok(r.parts && r.parts.length >= 1);
    const hist = await listRecentMessages(db, botId, "user_q@im.wechat", 20);
    assert.equal(hist.length, 1);
    assert.equal(hist[0]?.role, "assistant");
    await db.close();
  });

  it("handleInbound single-pass parses primary multi-bubble JSON (filter off)", async (t) => {
    let db;
    try {
      db = openDatabase(redisUrl);
      await Promise.race([
        db.ping(),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("timeout")), 2500),
        ),
      ]);
    } catch {
      try {
        await db?.close();
      } catch {
        /* ignore */
      }
      t.skip("Redis not available");
      return;
    }
    await seedPersonas(db);
    const cat = (await getPersonaBySlug(db, "catgirl"))!;
    const botId = `bot_single_${Date.now()}`;
    await upsertBotAccount(db, {
      id: botId,
      ownerUserId: "u_test",
      displayName: "test",
      botToken: "test-token",
    });
    await approvePeer(db, botId, "user_s@im.wechat");
    await setAssignment(db, botId, "user_s@im.wechat", cat.id);

    const fake = new FakeLlm(
      JSON.stringify({
        messages: [
          "给你看～",
          { type: "sticker", slug: "wave" },
          "喜欢吗",
        ],
      }),
    );
    const chat = new ChatService(db, asLlm(fake), {
      allowUnapproved: false,
      memoryExtractEveryN: 999,
      // default path: no second-pass filter
      replyFilterEnabled: false,
      stickersEnabled: false,
    });
    const r = await chat.handleInbound({
      botAccountId: botId,
      peerId: "user_s@im.wechat",
      text: "嗨",
      contextToken: "tok-s",
    });
    assert.equal(r.kind, "reply");
    assert.equal(fake.calls, 1, "primary LLM only");
    assert.equal(r.bubblesFromJson, true);
    // stickersEnabled false → no catalog; dropDisallowedStickers drops unknown stickers
    assert.ok(r.parts && r.parts.length >= 2, JSON.stringify(r.parts));
    assert.ok(
      r.parts!.every((p) => p.kind === "text"),
      "without sticker catalog, stickers must be dropped",
    );
    assert.ok(
      !JSON.stringify(r.parts).includes('"type":"sticker"') ||
        r.parts!.some((p) => p.kind === "text" && p.text.includes("给你看")),
    );
    await db.close();
  });

  it("runs a scheduled task with its saved persona, not the peer's current persona", async (t) => {
    let db;
    try { db = openDatabase(redisUrl); await Promise.race([db.ping(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2500))]); }
    catch { try { await db?.close(); } catch {} t.skip("Redis not available"); return; }
    await seedPersonas(db);
    const [cat, girlfriend] = await Promise.all([getPersonaBySlug(db, "catgirl"), getPersonaBySlug(db, "girlfriend")]);
    assert.ok(cat); assert.ok(girlfriend);
    const botId=`bot_scheduled_persona_${Date.now()}`; const peerId="scheduled_peer@im.wechat";
    await upsertBotAccount(db,{id:botId,ownerUserId:"u_test",displayName:"test",botToken:"test-token"});
    await approvePeer(db,botId,peerId);
    await setAssignment(db,botId,peerId,girlfriend!.id);
    const fake=new FakeLlm("定时结果");
    const chat=new ChatService(db,asLlm(fake),{allowUnapproved:false,memoryExtractEveryN:999,stickersEnabled:false});
    const result=await chat.handleScheduled({botAccountId:botId,peerId,contextToken:"tok",personaId:cat!.id,prompt:"发送日报",webSearchEnabled:false});
    assert.equal(result.kind,"reply");
    assert.equal(result.personaId,cat!.id);
    assert.equal((fake.lastMessages as unknown[]).length,2,"scheduled execution must not replay recent chat");
    assert.match(JSON.stringify(fake.lastMessages),/定时任务执行规则/);
    await db.close();
  });

  it("fetches fresh data server-side before asking the persona to write", async (t) => {
    let db;
    try { db = openDatabase(redisUrl); await Promise.race([db.ping(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2500))]); }
    catch { try { await db?.close(); } catch {} t.skip("Redis not available"); return; }
    await seedPersonas(db);
    const cat = await getPersonaBySlug(db, "catgirl");
    assert.ok(cat);
    const botId=`bot_scheduled_search_${Date.now()}`; const peerId="scheduled_search_peer@im.wechat";
    await upsertBotAccount(db,{id:botId,ownerUserId:"u_test",displayName:"test",botToken:"test-token"});
    await approvePeer(db,botId,peerId);
    await setAssignment(db,botId,peerId,cat!.id);
    let searchQuery="";
    const progress:string[]=[];
    const fake=new FakeLlm("今天多云 28~34℃");
    const chat=new ChatService(db,asLlm(fake),{allowUnapproved:false,memoryExtractEveryN:999,stickersEnabled:false,webSearchEnabled:true,webSearchRunner:async(query)=>{searchQuery=query;return "上海：多云，28~34℃，东南风";}});
    const result=await chat.handleScheduled({botAccountId:botId,peerId,contextToken:"tok",personaId:cat!.id,prompt:"播报今天上海的天气",webSearchEnabled:true,source:"subscription",onProgress:event=>progress.push(event.stage)});
    const failed=new ChatService(db,asLlm(new FakeLlm("不应发送")),{allowUnapproved:false,memoryExtractEveryN:999,stickersEnabled:false,webSearchEnabled:true,webSearchRunner:async()=>{throw new Error("search down");}});
    const blocked=await failed.handleScheduled({botAccountId:botId,peerId,contextToken:"tok",personaId:cat!.id,prompt:"播报今天上海的天气",webSearchEnabled:true,source:"subscription"});
    await db.close();
    assert.equal(result.kind,"reply");
    assert.match(searchQuery,/上海.*天气/);
    assert.match(JSON.stringify(fake.lastMessages),/28~34℃/);
    assert.deepEqual(progress,["web_search","web_search","generation","generation","validation"]);
    assert.equal(blocked.kind,"skip");
    assert.match(blocked.skipReason??"",/^web_search_failed:/);
  });
});
