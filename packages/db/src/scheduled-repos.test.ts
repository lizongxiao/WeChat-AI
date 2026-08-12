import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { subscriptionMatchesCurrentPersona, validateSubscriptionParams } from "./scheduled-repos.js";
import { openDatabase } from "./client.js";
import { createScheduledTask, listPeerScheduledTasks } from "./scheduled-repos.js";

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

describe("subscription current-persona eligibility", () => {
  const subscription = { id:"sub", user_id:"u", bot_id:"b", peer_id:"p", persona_id:"weather", service_id:"daily-weather", params:{}, enabled:1, created_at:"", updated_at:"" };
  it("does not count or deliver an old Persona subscription after a peer switches", () => {
    assert.equal(subscriptionMatchesCurrentPersona(subscription, "weather"), true);
    assert.equal(subscriptionMatchesCurrentPersona(subscription, "news"), false);
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
