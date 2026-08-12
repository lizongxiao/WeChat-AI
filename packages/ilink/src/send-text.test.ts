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

describe("sendText", () => {
  it("sends context_token and base_info", async () => {
    const calls = installFetch(() => ({ body: { ret: 0 } }));
    await client().sendText({
      toUserId: "peer-1",
      text: "夜里好",
      contextToken: "fresh-token",
    });
    assert.equal(calls.length, 1);
    const body = calls[0]!.body;
    const msg = body.msg as { context_token?: string };
    assert.equal(msg.context_token, "fresh-token");
    assert.deepEqual(body.base_info, { channel_version: "1.0.2" });
  });

  it("does not retry without context_token on prepare failed ret=-2", async () => {
    const calls = installFetch(() => ({
      body: { ret: -2, errcode: 0, errmsg: "prepare failed" },
    }));
    await assert.rejects(
      () =>
        client().sendText({
          toUserId: "peer-1",
          text: "夜里好",
          contextToken: "stale-token",
        }),
      /prepare failed/,
    );
    assert.equal(calls.length, 1);
    const msg = calls[0]!.body.msg as { context_token?: string };
    assert.equal(msg.context_token, "stale-token");
  });
});
