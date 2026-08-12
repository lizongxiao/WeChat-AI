import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ILinkClient, ILinkError, isStaleSessionError } from "./client.js";

interface Call {
  path: string;
  body: Record<string, unknown>;
}

type Reply = { status?: number; body: unknown };

let restoreFetch: (() => void) | null = null;

function installFetch(handler: (path: string, body: Record<string, unknown>) => Reply): Call[] {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  restoreFetch = () => {
    globalThis.fetch = original;
    restoreFetch = null;
  };
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    calls.push({ path, body });
    const reply = handler(path, body);
    const status = reply.status ?? 200;
    return {
      ok: status < 400,
      status,
      headers: new Headers(),
      json: async () => reply.body,
      text: async () => JSON.stringify(reply.body),
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  return calls;
}

function client(): ILinkClient {
  return new ILinkClient({
    botToken: "tok",
    baseUrl: "https://ilink.test",
  });
}

afterEach(() => {
  restoreFetch?.();
});

describe("isStaleSessionError", () => {
  it("treats prepare failed ret=-2 as stale session", () => {
    assert.equal(
      isStaleSessionError(new ILinkError("prepare failed", -2, 0)),
      true,
    );
    assert.equal(
      isStaleSessionError(new ILinkError("unknown error", -2)),
      true,
    );
    assert.equal(
      isStaleSessionError(new ILinkError("session expired", 0, -14)),
      true,
    );
    assert.equal(
      isStaleSessionError(new ILinkError("frequency limit", -2)),
      false,
    );
  });
});

describe("sendText stale context_token", () => {
  it("retries once without context_token on prepare failed ret=-2", async () => {
    const calls = installFetch((_path, body) => {
      const msg = body.msg as { context_token?: string };
      if (msg.context_token) {
        return { body: { ret: -2, errcode: 0, errmsg: "prepare failed" } };
      }
      return { body: { ret: 0 } };
    });

    await client().sendText({
      toUserId: "peer-1",
      text: "夜里好",
      contextToken: "stale-token",
    });

    assert.equal(calls.length, 2);
    const first = calls[0]!.body.msg as { context_token?: string };
    const second = calls[1]!.body.msg as { context_token?: string };
    assert.equal(first.context_token, "stale-token");
    assert.equal(second.context_token, "");
  });

  it("skips the stale token on the next send to the same peer", async () => {
    const calls = installFetch((_path, body) => {
      const msg = body.msg as { context_token?: string };
      if (msg.context_token) {
        return { body: { ret: -2, errcode: 0, errmsg: "prepare failed" } };
      }
      return { body: { ret: 0 } };
    });
    const c = client();
    await c.sendText({
      toUserId: "peer-1",
      text: "第一条",
      contextToken: "stale-token",
    });
    await c.sendText({
      toUserId: "peer-1",
      text: "第二条",
      contextToken: "stale-token",
    });
    assert.equal(calls.length, 3);
    const third = calls[2]!.body.msg as { context_token?: string; item_list?: Array<{ text_item?: { text?: string } }> };
    assert.equal(third.context_token, "");
    assert.equal(third.item_list?.[0]?.text_item?.text, "第二条");
  });

  it("uses a fresh token again after markContextFresh", async () => {
    let n = 0;
    const calls = installFetch((_path, body) => {
      n += 1;
      const msg = body.msg as { context_token?: string };
      if (n === 1 && msg.context_token) {
        return { body: { ret: -2, errcode: 0, errmsg: "prepare failed" } };
      }
      return { body: { ret: 0 } };
    });
    const c = client();
    await c.sendText({
      toUserId: "peer-1",
      text: "a",
      contextToken: "stale",
    });
    c.markContextFresh("peer-1");
    await c.sendText({
      toUserId: "peer-1",
      text: "b",
      contextToken: "fresh-token",
    });
    const last = calls[calls.length - 1]!.body.msg as { context_token?: string };
    assert.equal(last.context_token, "fresh-token");
  });

  it("does not retry a genuine rate-limit ret=-2", async () => {
    installFetch(() => ({
      body: { ret: -2, errcode: 0, errmsg: "frequency limit" },
    }));
    await assert.rejects(
      () =>
        client().sendText({
          toUserId: "peer-1",
          text: "hi",
          contextToken: "tok",
        }),
      /frequency limit/,
    );
  });
});
