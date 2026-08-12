import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { LlmClient, flattenChatContent } from "./client.js";
import type { ChatMessage } from "./client.js";

let restoreFetch: (() => void) | null = null;

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

/**
 * One recorder used for both paths: the platform path goes through the SDK's
 * injectable `fetch`, the tools-gateway path uses raw global fetch.
 */
function completion(message: Record<string, unknown>) {
  return {
    id: "cmpl-1",
    object: "chat.completion",
    created: 1,
    model: "served-model",
    choices: [{ index: 0, message, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
  };
}

const ANSWER = completion({ role: "assistant", content: "看到了" });

function installFetch(
  respond: (call: Captured, index: number) => Response = () =>
    new Response(JSON.stringify(ANSWER), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
): Captured[] {
  const captured: Captured[] = [];
  const original = globalThis.fetch;
  restoreFetch = () => {
    globalThis.fetch = original;
    capturingFetch = null;
    restoreFetch = null;
  };
  const impl = (async (input: unknown, init?: RequestInit) => {
    const call: Captured = {
      url: String(
        typeof input === "object" && input && "url" in input
          ? (input as { url: string }).url
          : input,
      ),
      body: init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {},
    };
    captured.push(call);
    return respond(call, captured.length - 1);
  }) as typeof globalThis.fetch;
  globalThis.fetch = impl;
  capturingFetch = impl;
  return captured;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A reasoning model that refuses `tool_choice: required` outright. */
function installRejectingRequiredToolChoice(): Captured[] {
  return installFetch((call) =>
    call.body.tool_choice === "required"
      ? json(
          { error: { message: "Thinking mode does not support this tool_choice" } },
          400,
        )
      : json(ANSWER),
  );
}

/** A model that searches first and answers in the second round. */
function installSearchingModelFetch(): Captured[] {
  return installFetch((_call, index) =>
    index === 0
      ? json(
          completion({
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "web_search",
                  arguments: JSON.stringify({ query: "上海 今天 天气" }),
                },
              },
            ],
          }),
        )
      : json(ANSWER),
  );
}

/** A model that keeps requesting searches while tools remain available. */
function installPersistentSearchingModelFetch(): Captured[] {
  let callId = 0;
  return installFetch((call) => {
    if (!Array.isArray(call.body.tools)) return json(ANSWER);
    callId++;
    return json(
      completion({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `call_${callId}`,
            type: "function",
            function: {
              name: "web_search",
              arguments: JSON.stringify({ query: `上海 天气 ${callId}` }),
            },
          },
        ],
      }),
    );
  });
}

let capturingFetch: typeof fetch | null = null;

const IMAGE_MESSAGE: ChatMessage = {
  role: "user",
  content: [
    { type: "text", text: "这是什么" },
    {
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAAA", detail: "low" },
    },
  ],
};

function platform(): LlmClient {
  return LlmClient.forPlatform({
    baseURL: "https://llm.test/v1",
    apiKey: "k",
    model: "base-model",
    // Must be injected: the SDK bundles node-fetch and ignores global stubs.
    fetchImpl: capturingFetch ?? undefined,
  });
}

afterEach(() => {
  restoreFetch?.();
});

describe("flattenChatContent", () => {
  it("passes strings through", () => {
    assert.equal(flattenChatContent("hi"), "hi");
  });

  it("renders image parts as a placeholder so history stays readable", () => {
    assert.equal(flattenChatContent(IMAGE_MESSAGE.content), "这是什么\n[图片]");
  });

  it("drops empty text parts", () => {
    assert.equal(
      flattenChatContent([
        { type: "text", text: "" },
        { type: "text", text: "b" },
      ]),
      "b",
    );
  });
});

describe("multimodal messages (platform path)", () => {
  it("can require the first tool call for fresh-data schedules", async () => {
    const captured = installFetch();
    await platform().chatWithUsage(
      [{ role: "user", content: "查询今天上海天气" }],
      { tools: ["web_search"], requireToolUse: true },
    );

    assert.equal(captured[0]?.body.tool_choice, "required");
  });

  it("recovers when the model rejects a required tool_choice", async () => {
    // Reasoning ("thinking") models answer `tool_choice: required` with a 400,
    // which must not turn a scheduled push into a failed run.
    const captured = installRejectingRequiredToolChoice();
    const res = await platform().chatWithUsage(
      [{ role: "user", content: "查询今天上海天气" }],
      { tools: ["web_search"], requireToolUse: true },
    );

    assert.equal(res.text, "看到了");
    assert.deepEqual(
      captured.map((c) => c.body.tool_choice),
      ["required", "auto"],
    );
  });

  it("reports which builtin tools actually ran", async () => {
    installSearchingModelFetch();
    const res = await platform().chatWithUsage(
      [{ role: "user", content: "查询今天上海天气" }],
      {
        tools: ["web_search"],
        webSearch: async () => "上海 今天 多云 28~34℃",
      },
    );

    assert.deepEqual(res.toolsUsed, ["web_search"]);
  });

  it("forces a final text answer after the tool-call limit", async () => {
    const captured = installPersistentSearchingModelFetch();
    const res = await platform().chatWithUsage(
      [{ role: "user", content: "查询今天上海天气" }],
      {
        tools: ["web_search"],
        maxToolRounds: 1,
        webSearch: async () => "上海 今天 多云 28~34℃",
      },
    );

    assert.equal(res.text, "看到了");
    assert.equal(captured.length, 3);
    assert.equal(captured[2]?.body.tools, undefined);
    assert.deepEqual(res.toolsUsed, ["web_search"]);
  });

  it("forwards user content parts verbatim", async () => {
    const captured = installFetch();
    const res = await platform().chatWithUsage([
      { role: "system", content: "你是助手" },
      IMAGE_MESSAGE,
    ]);

    assert.equal(res.text, "看到了");
    assert.equal(captured.length, 1);
    const msgs = captured[0]!.body.messages as Array<Record<string, unknown>>;
    assert.equal(msgs[0]!.content, "你是助手");
    const parts = msgs[1]!.content as Array<Record<string, unknown>>;
    assert.equal(Array.isArray(parts), true);
    assert.deepEqual(parts[0], { type: "text", text: "这是什么" });
    assert.deepEqual(parts[1], {
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAAA", detail: "low" },
    });
  });

  it("omits detail when unset", async () => {
    const captured = installFetch();
    await platform().chatWithUsage([
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }],
      },
    ]);
    const parts = (
      (captured[0]!.body.messages as Array<Record<string, unknown>>)[0]!
        .content as Array<Record<string, unknown>>
    )[0]!;
    assert.deepEqual(parts, {
      type: "image_url",
      image_url: { url: "https://x/y.png" },
    });
  });

  it("flattens array content on non-user roles", async () => {
    const captured = installFetch();
    await platform().chatWithUsage([
      {
        role: "assistant",
        content: [
          { type: "text", text: "上一轮" },
          { type: "image_url", image_url: { url: "data:image/png;base64,Z" } },
        ],
      },
      { role: "user", content: "继续" },
    ]);
    const msgs = captured[0]!.body.messages as Array<Record<string, unknown>>;
    assert.equal(msgs[0]!.content, "上一轮\n[图片]");
  });

  it("applies the per-call model override", async () => {
    const captured = installFetch();
    const res = await platform().chatWithUsage([IMAGE_MESSAGE], {
      model: "vision-model",
    });
    assert.equal(captured[0]!.body.model, "vision-model");
    // Served model from the response still wins for accounting.
    assert.equal(res.model, "served-model");
  });

  it("falls back to the constructor model without an override", async () => {
    const captured = installFetch();
    await platform().chatWithUsage([{ role: "user", content: "hi" }]);
    assert.equal(captured[0]!.body.model, "base-model");
  });

  it("ignores a blank model override", async () => {
    const captured = installFetch();
    await platform().chatWithUsage([{ role: "user", content: "hi" }], {
      model: "   ",
    });
    assert.equal(captured[0]!.body.model, "base-model");
  });
});

describe("multimodal messages (user custom upstream path)", () => {
  it("sends parts through the tools gateway and keeps upstream.model", async () => {
    const captured = installFetch();
    const client = LlmClient.forUserUpstream({
      toolsBaseUrl: "https://tools.test",
      toolsApiKey: "tk",
      upstream: {
        baseUrl: "https://user-provider.test/v1",
        apiKey: "user-key",
        model: "user-model",
      },
    });

    await client.chatWithUsage([IMAGE_MESSAGE], { model: "vision-model" });

    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.url, "https://tools.test/v1/chat/completions");
    // The user's provider only knows its own model names, so the override
    // must not leak onto this path.
    assert.equal(captured[0]!.body.model, "user-model");
    const upstream = captured[0]!.body.upstream as Record<string, unknown>;
    assert.equal(upstream.model, "user-model");
    const parts = (captured[0]!.body.messages as Array<Record<string, unknown>>)[0]!
      .content as Array<Record<string, unknown>>;
    assert.equal(Array.isArray(parts), true);
    assert.equal(parts[1]!.type, "image_url");
  });
});
