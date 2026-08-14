import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openDatabase } from "./client.js";
import { validateSubscriptionParams, createScheduledTask, createUserSubscription, deleteUserSubscription, listPeerScheduledTasks, listScheduledExecutionLogs, listUserSubscriptions, saveScheduledExecutionLog, saveScheduledOutbox, takeScheduledOutbox } from "./scheduled-repos.js";

describe("subscription parameter validation", () => {
  const schema = {
    type: "object",
    required: ["location"],
    properties: { location: { type: "string", minLength: 2 } },
  };
  it("requires service inputs before confirmation", () => {
    assert.deepEqual(validateSubscriptionParams(schema, {}), ["missing:location"]);
    assert.deepEqual(validateSubscriptionParams(schema, { location: "深" }), ["minLength:location"]);
    assert.deepEqual(validateSubscriptionParams(schema, { location: "深圳" }), []);
  });
});

describe("scheduled task peer isolation (Redis)", () => {
  it("never lists another peer's task", async (t) => {
    const db = openDatabase(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
    try { await Promise.race([db.ping(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2500))]); }
    catch { await db.close().catch(() => undefined); t.skip("Redis not available"); return; }
    const botId=`scheduled_iso_${Date.now()}`;
    await createScheduledTask(db,{user_id:"same-account",bot_id:botId,peer_id:"peer-a",persona_id:"persona-a",name:"A only",prompt:"A",schedule:"0 9 * * *",timezone:"Asia/Shanghai",web_search_enabled:0,enabled:1});
    await createScheduledTask(db,{user_id:"same-account",bot_id:botId,peer_id:"peer-b",persona_id:"persona-b",name:"B only",prompt:"B",schedule:"0 9 * * *",timezone:"Asia/Shanghai",web_search_enabled:0,enabled:1});
    const a=await listPeerScheduledTasks(db,botId,"peer-a");
    assert.deepEqual(a.map(x=>x.name),["A only"]);
    await db.close();
  });
});

describe("system subscription delivery slots (Redis)", () => {
  it("re-subscribing replaces the Persona and parameters instead of adding a second delivery", async (t) => {
    const db = openDatabase(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
    try { await Promise.race([db.ping(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2500))]); }
    catch { await db.close().catch(() => undefined); t.skip("Redis not available"); return; }
    const suffix = Date.now().toString(36);
    const input = { user_id:`user_${suffix}`, bot_id:`bot_${suffix}`, peer_id:`peer_${suffix}`, service_id:`service_${suffix}`, enabled:1 };
    const first = await createUserSubscription(db, { ...input, persona_id:"persona-old", params:{ location:"上海" } });
    const replacement = await createUserSubscription(db, { ...input, persona_id:"persona-new", params:{ location:"深圳" } });
    assert.equal(replacement.id, first.id);
    const rows = await listUserSubscriptions(db, input.user_id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.persona_id, "persona-new");
    assert.deepEqual(rows[0]?.params, { location:"深圳" });
    assert.equal(rows[0]?.next_run_at, null);
    await deleteUserSubscription(db, replacement.id);
    assert.equal((await listUserSubscriptions(db, input.user_id)).length, 0);
    await db.close();
  });
});

describe("scheduled outbox (Redis)", () => {
  it("keeps only the latest bulletin per peer and take() consumes it", async (t) => {
    const db = openDatabase(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
    try {
      await Promise.race([
        db.ping(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2500)),
      ]);
    } catch {
      await db.close().catch(() => undefined);
      t.skip("Redis not available");
      return;
    }
    const botId = `outbox_${Date.now()}`;
    const peerId = "peer-outbox";
    await saveScheduledOutbox(db, {
      botId,
      peerId,
      source: "subscription",
      id: "old",
      texts: ["旧的天气"],
    });
    await saveScheduledOutbox(db, {
      botId,
      peerId,
      source: "subscription",
      id: "new",
      texts: ["早上好", "深圳多云"],
    });
    const item = await takeScheduledOutbox(db, botId, peerId);
    assert.equal(item?.id, "new");
    assert.deepEqual(item?.texts, ["早上好", "深圳多云"]);
    assert.equal(await takeScheduledOutbox(db, botId, peerId), null);
    await db.close();
  });
});

describe("scheduled execution logs (Redis)", () => {
  it("keeps trigger/status metadata and supports server-side filtering", async (t) => {
    const db = openDatabase(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
    try { await Promise.race([db.ping(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2500))]); }
    catch { await db.close().catch(() => undefined); t.skip("Redis not available"); return; }
    const suffix = Date.now().toString(36);
    const base = { source:"subscription" as const, target_id:`sub_${suffix}`, bot_id:`bot_${suffix}`, peer_id:`peer_${suffix}`, persona_id:"persona" };
    await saveScheduledExecutionLog(db, { ...base, trigger:"natural", status:"sent", reason:null });
    await saveScheduledExecutionLog(db, { ...base, trigger:"test", status:"failed", reason:"delivery_failed_discarded: ret=-2" });
    const filtered = await listScheduledExecutionLogs(db, { trigger:"test", status:"failed", limit:10 });
    assert.ok(filtered.some(row => row.target_id === base.target_id && row.reason?.includes("discarded")));
    await db.close();
  });
});
