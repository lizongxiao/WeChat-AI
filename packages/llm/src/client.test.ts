import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  trimWebSearchContext,
  WEB_SEARCH_CONTEXT_MAX_CHARS,
} from "./client.js";
import { formatCurrentTime, loadLlmConfigFromEnv } from "./client.js";

describe("formatCurrentTime", () => {
  it("returns JSON with iso and Asia/Shanghai fields", () => {
    const raw = formatCurrentTime("Asia/Shanghai");
    const obj = JSON.parse(raw) as {
      iso: string;
      timeZone: string;
      local: string;
      weekday: string;
    };
    assert.equal(obj.timeZone, "Asia/Shanghai");
    assert.ok(obj.iso.includes("T"));
    assert.ok(obj.local.length > 0);
  });
});

describe("loadLlmConfigFromEnv", () => {
  it("loads platform LLM and optional tools gateway", () => {
    const cfg = loadLlmConfigFromEnv({
      LLM_API_KEY: "sk-platform",
      LLM_BASE_URL: "https://api.openai.com/v1",
      LLM_MODEL: "gpt-4o-mini",
      TOOLS_BASE_URL: "http://127.0.0.1:7860",
      TOOLS_API_KEY: "tools-secret",
    });
    assert.equal(cfg.apiKey, "sk-platform");
    assert.equal(cfg.toolsBaseUrl, "http://127.0.0.1:7860");
    assert.equal(cfg.toolsApiKey, "tools-secret");
  });

  it("requires LLM_API_KEY for platform", () => {
    assert.throws(() => loadLlmConfigFromEnv({}), /LLM_API_KEY/);
  });
});

describe("trimWebSearchContext", () => {
  it("caps oversized search JSON by dropping trailing hits", () => {
    const results = Array.from({ length: 8 }, (_, i) => ({
      title: `hit-${i}`,
      url: `https://example.com/${i}`,
      snippet: "x".repeat(900),
    }));
    const raw = JSON.stringify({ query: "上海 天气", results });
    assert.ok(raw.length > WEB_SEARCH_CONTEXT_MAX_CHARS);
    const trimmed = trimWebSearchContext(raw);
    assert.ok(trimmed.length <= WEB_SEARCH_CONTEXT_MAX_CHARS + 1);
    const parsed = JSON.parse(trimmed.replace(/…$/, "")) as {
      results: Array<{ snippet: string }>;
    };
    assert.ok(parsed.results.length < 8);
    assert.ok(parsed.results.every((r) => r.snippet.length <= 480));
  });
});
