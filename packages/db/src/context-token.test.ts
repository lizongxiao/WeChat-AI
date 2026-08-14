import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openDatabase } from "./client.js";
import { getContextTokenInfo, upsertContextToken } from "./repos.js";

describe("context token ordering (Redis)", () => {
  it("does not let a delayed older inbound overwrite the newest token", async (t) => {
    const db = openDatabase(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
    try {
      await Promise.race([
        db.ping(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("redis timeout")), 2500)),
      ]);
    } catch (err) {
      await db.close().catch(() => undefined);
      t.skip(`redis unavailable: ${(err as Error).message}`);
      return;
    }

    const botId = `ctx-order-${Date.now()}`;
    const peerId = "peer-1";
    await upsertContextToken(db, botId, peerId, "new-token", "2026-08-14T00:01:00.000Z");
    await upsertContextToken(db, botId, peerId, "old-token", "2026-08-14T00:00:00.000Z");
    assert.deepEqual(await getContextTokenInfo(db, botId, peerId), {
      token: "new-token",
      inboundAt: "2026-08-14T00:01:00.000Z",
    });

    // A redelivery for the same inbound may carry a replacement token.
    await upsertContextToken(db, botId, peerId, "redelivered-token", "2026-08-14T00:01:00.000Z");
    assert.equal((await getContextTokenInfo(db, botId, peerId))?.token, "redelivered-token");
    await db.close();
  });
});
