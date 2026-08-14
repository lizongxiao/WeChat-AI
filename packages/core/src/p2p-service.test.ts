import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createBindCode,
  openDatabase,
  saveBotCredentials,
  setPrimaryBind,
  upsertBotAccount,
  upsertContextToken,
  upsertUser,
  nowIso,
} from "@wechat-ai/db";
import { P2PService, isP2PCommand, parseAtUsername } from "./p2p-service.js";
import { CommandRegistry } from "./commands/index.js";

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

describe("P2P parse helpers", () => {
  it("parses whole-message @username only", () => {
    assert.equal(parseAtUsername("@alice"), "alice");
    assert.equal(parseAtUsername("  @Bob_1  "), "Bob_1");
    assert.equal(parseAtUsername("hello @alice"), null);
    assert.equal(parseAtUsername("@alice hi"), null);
  });

  it("detects p2p commands", () => {
    assert.equal(isP2PCommand("/绑定 ABC123"), true);
    assert.equal(isP2PCommand("/同意"), true);
    assert.equal(isP2PCommand("@user"), true);
    assert.equal(isP2PCommand("普通聊天"), false);
  });
});

describe("P2PService (Redis)", () => {
  async function withDb(
    t: { skip: (msg?: string) => void },
    fn: (db: ReturnType<typeof openDatabase>) => Promise<void>,
  ) {
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
    try {
      await fn(db);
    } finally {
      await db.close();
    }
  }

  /** Commands are dispatched through the unified registry (worker path). */
  function registryFor(svc: P2PService): CommandRegistry {
    const registry = new CommandRegistry();
    svc.registerCommands(registry);
    return registry;
  }

  function runCommand(
    registry: CommandRegistry,
    db: ReturnType<typeof openDatabase>,
    req: { botId: string; peerId: string; text: string },
  ) {
    return registry.run({
      db,
      botId: req.botId,
      peerId: req.peerId,
      text: req.text,
    });
  }

  it("bind code once + whoami + unbind", async (t) => {
    await withDb(t, async (db) => {
      const suffix = Date.now().toString(36);
      const userId = `u_p2p_${suffix}`;
      const botId = `bot_p2p_${suffix}`;
      const peerId = `peer_a@im.wechat_${suffix}`;

      await upsertUser(
        db,
        { id: userId, username: `alice_${suffix}` },
        new Set(),
      );
      await upsertBotAccount(db, {
        id: botId,
        ownerUserId: userId,
        displayName: "p2p-bot",
        botToken: "tok",
      });
      await saveBotCredentials(db, {
        botId,
        botToken: "tok-secret",
        savedAt: nowIso(),
      });

      const codeRec = await createBindCode(db, userId, `alice_${suffix}`, 600);
      const svc = new P2PService(db);
      const registry = registryFor(svc);

      const bad = await runCommand(registry, db, {
        botId,
        peerId,
        text: "/绑定 WRONG1",
      });
      assert.ok(bad?.handled);
      assert.match(bad!.reply!, /无效|过期/);

      const ok = await runCommand(registry, db, {
        botId,
        peerId,
        text: `/绑定 ${codeRec.code}`,
      });
      assert.ok(ok?.handled);
      assert.match(ok!.reply!, /已绑定/);

      const again = await runCommand(registry, db, {
        botId,
        peerId,
        text: `/绑定 ${codeRec.code}`,
      });
      assert.match(again!.reply!, /无效|过期/);

      const who = await runCommand(registry, db, {
        botId,
        peerId,
        text: "/我的身份",
      });
      assert.match(who!.reply!, new RegExp(`alice_${suffix}`));

      const un = await runCommand(registry, db, {
        botId,
        peerId,
        text: "/解绑",
      });
      assert.match(un!.reply!, /解除/);
    });
  });

  it("request → accept → relay prefix → disconnect", async (t) => {
    await withDb(t, async (db) => {
      const suffix = Date.now().toString(36);
      const aliceId = `u_a_${suffix}`;
      const bobId = `u_b_${suffix}`;
      const botA = `bot_a_${suffix}`;
      const botB = `bot_b_${suffix}`;
      const peerA = `peer_a_${suffix}@im.wechat`;
      const peerB = `peer_b_${suffix}@im.wechat`;

      await upsertUser(db, { id: aliceId, username: `Alice_${suffix}` }, new Set());
      await upsertUser(db, { id: bobId, username: `Bob_${suffix}` }, new Set());

      for (const [botId, owner] of [
        [botA, aliceId],
        [botB, bobId],
      ] as const) {
        await upsertBotAccount(db, {
          id: botId,
          ownerUserId: owner,
          displayName: botId,
          botToken: "t",
        });
        await saveBotCredentials(db, {
          botId,
          botToken: `token-${botId}`,
          savedAt: nowIso(),
        });
      }

      await setPrimaryBind(db, {
        userId: aliceId,
        username: `Alice_${suffix}`,
        botId: botA,
        peerId: peerA,
        boundAt: nowIso(),
      });
      await setPrimaryBind(db, {
        userId: bobId,
        username: `Bob_${suffix}`,
        botId: botB,
        peerId: peerB,
        boundAt: nowIso(),
      });
      await upsertContextToken(db, botB, peerB, "ctx-bob");
      await upsertContextToken(db, botA, peerA, "ctx-alice");

      const svc = new P2PService(db, { maxRequestsPerDay: 50 });
      const registry = registryFor(svc);

      // fallthrough when unbound style message
      const fall = await svc.handleInbound({
        botId: botA,
        peerId: peerA,
        text: "你好呀",
      });
      assert.equal(fall.handled, false);

      // hello @user is NOT connect
      const notAt = await svc.handleInbound({
        botId: botA,
        peerId: peerA,
        text: `hello @Bob_${suffix}`,
      });
      assert.equal(notAt.handled, false);

      const req = await svc.handleInbound({
        botId: botA,
        peerId: peerA,
        text: `@Bob_${suffix}`,
      });
      assert.equal(req.handled, true);
      assert.match(req.localReplies[0]!, /对话请求/);
      assert.equal(req.remoteSends.length, 1);
      assert.equal(req.remoteSends[0]!.botId, botB);
      assert.match(req.remoteSends[0]!.text, /对话请求/);

      const accept = await runCommand(registry, db, {
        botId: botB,
        peerId: peerB,
        text: "/同意",
      });
      assert.ok(accept?.handled);
      assert.match(accept!.reply!, /建立对话/);
      assert.equal(accept!.remoteSends!.length, 1);
      assert.equal(accept!.remoteSends![0]!.botId, botA);

      const relay = await svc.handleInbound({
        botId: botA,
        peerId: peerA,
        text: "在吗朋友",
      });
      assert.equal(relay.handled, true);
      assert.equal(relay.localReplies.length, 0);
      assert.equal(relay.remoteSends.length, 1);
      assert.equal(
        relay.remoteSends[0]!.text,
        `[Alice_${suffix}] 在吗朋友`,
      );
      assert.equal(relay.remoteSends[0]!.botId, botB);

      const disc = await runCommand(registry, db, {
        botId: botB,
        peerId: peerB,
        text: "/断开",
      });
      assert.ok(disc?.handled);
      assert.match(disc!.reply!, /断开/);
      assert.equal(disc!.remoteSends![0]!.botId, botA);

      const after = await svc.handleInbound({
        botId: botA,
        peerId: peerA,
        text: "又回到角色扮演",
      });
      assert.equal(after.handled, false);
    });
  });

  it("rejects @ self and unreachable without context", async (t) => {
    await withDb(t, async (db) => {
      const suffix = Date.now().toString(36);
      const aliceId = `u_a2_${suffix}`;
      const bobId = `u_b2_${suffix}`;
      const botA = `bot_a2_${suffix}`;
      const botB = `bot_b2_${suffix}`;
      const peerA = `peer_a2_${suffix}`;
      const peerB = `peer_b2_${suffix}`;

      await upsertUser(db, { id: aliceId, username: `aa_${suffix}` }, new Set());
      await upsertUser(db, { id: bobId, username: `bb_${suffix}` }, new Set());
      await upsertBotAccount(db, {
        id: botA,
        ownerUserId: aliceId,
        displayName: "a",
        botToken: "t",
      });
      await upsertBotAccount(db, {
        id: botB,
        ownerUserId: bobId,
        displayName: "b",
        botToken: "t",
      });
      await saveBotCredentials(db, {
        botId: botA,
        botToken: "tokA",
        savedAt: nowIso(),
      });
      await saveBotCredentials(db, {
        botId: botB,
        botToken: "tokB",
        savedAt: nowIso(),
      });
      await setPrimaryBind(db, {
        userId: aliceId,
        username: `aa_${suffix}`,
        botId: botA,
        peerId: peerA,
        boundAt: nowIso(),
      });
      await setPrimaryBind(db, {
        userId: bobId,
        username: `bb_${suffix}`,
        botId: botB,
        peerId: peerB,
        boundAt: nowIso(),
      });
      // no context_token for bob → unreachable
      await upsertContextToken(db, botA, peerA, "ctx-a");

      const svc = new P2PService(db);
      const self = await svc.handleInbound({
        botId: botA,
        peerId: peerA,
        text: `@aa_${suffix}`,
      });
      assert.match(self.localReplies[0]!, /自己/);

      const unreach = await svc.handleInbound({
        botId: botA,
        peerId: peerA,
        text: `@bb_${suffix}`,
      });
      assert.match(unreach.localReplies[0]!, /不可达/);
    });
  });
});
