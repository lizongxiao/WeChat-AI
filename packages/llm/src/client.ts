import OpenAI, { type ClientOptions } from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

/**
 * Platform (admin) LLM: main site connects directly via baseURL/apiKey.
 * User custom LLM: route through tools gateway (TOOLS_BASE_URL) with `upstream`
 * so only the HF tools process dials the user's API.
 */
export interface LlmUpstream {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LlmConfig {
  /**
   * When toolsGateway is set, chat goes to tools /v1/chat/completions.
   * Otherwise baseURL is the real OpenAI-compatible platform endpoint.
   */
  baseURL: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * HF / tools gateway root (no trailing slash), e.g. http://127.0.0.1:7860
   * Used for user-custom upstream and web search.
   */
  toolsBaseUrl?: string;
  toolsApiKey?: string;
  /** Default upstream injected on every chat (user custom provider). */
  defaultUpstream?: LlmUpstream | null;
  /**
   * Per-request wall clock for one completion. Without it the OpenAI SDK
   * defaults to 600s × 3 retries = 30 minutes, during which the job holds a
   * reply-consumer slot and keeps the bot:peer chain locked.
   */
  timeoutMs?: number;
  /**
   * Override the HTTP layer used for the platform path. The OpenAI SDK bundles
   * node-fetch, so a global stub cannot reach it — this seam is what makes the
   * request body assertable, and it also leaves room for a proxy agent later.
   */
  fetchImpl?: typeof fetch;
}

/** Default completion timeout. Deliberately looser than TOOLS_TIMEOUT_MS (search). */
export const DEFAULT_LLM_TIMEOUT_MS = Number(
  process.env.LLM_TIMEOUT_MS ?? "120000",
);

export interface ChatTextPart {
  type: "text";
  text: string;
}

export interface ChatImagePart {
  type: "image_url";
  image_url: {
    /** https URL or a `data:<mime>;base64,...` URI */
    url: string;
    detail?: "auto" | "low" | "high";
  };
}

/** Multimodal content parts (OpenAI-compatible vision shape). */
export type ChatContentPart = ChatTextPart | ChatImagePart;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  /**
   * Plain text, or content parts for vision. Only `user` messages are sent as
   * parts — providers disagree about array content on system/assistant, so
   * those are flattened to text.
   */
  content: string | ChatContentPart[];
}

/** Readable text for history / logs / token bookkeeping. */
export function flattenChatContent(
  content: string | ChatContentPart[],
): string {
  if (typeof content === "string") return content;
  return content
    .map((p) => (p.type === "text" ? p.text : "[图片]"))
    .filter(Boolean)
    .join("\n");
}

export interface ChatResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
  /**
   * Builtin tools the model actually invoked. `requireToolUse` is only a
   * request — a reasoning model may refuse it — so callers that depend on
   * fresh data must check this rather than trust the flag.
   */
  toolsUsed: BuiltinToolName[];
}

export type BuiltinToolName = "get_current_time" | "web_search";

export interface ChatCallOptions {
  /** Whitelist of built-in tools to expose (empty / omit = no tools) */
  tools?: BuiltinToolName[];
  /** Require a tool call in the first round (used by fresh-data schedules). */
  requireToolUse?: boolean;
  /** IANA timezone for get_current_time (default Asia/Shanghai) */
  timeZone?: string;
  /** Max tool round-trips (default 2) */
  maxToolRounds?: number;
  /**
   * Per-call model override — used to route image messages to a vision model.
   * Ignored on the user-custom-upstream path: that provider only knows its own
   * model names, so `upstream.model` stays authoritative there.
   */
  model?: string;
  /**
   * Per-call max_tokens override. Used to keep an image caption to a
   * description rather than paying for a full reply-sized completion.
   */
  maxTokens?: number;
  /** Override default upstream for this call (user custom API via tools) */
  upstream?: LlmUpstream | null;
  /**
   * When web_search tool is enabled, called by the client to execute search
   * exclusively via the tools gateway (main site never dials search engines).
   */
  webSearch?: (query: string, maxResults?: number) => Promise<string>;
}

/**
 * Reasoning ("thinking") models reject a forced tool choice with a 400 instead
 * of ignoring it, so the call has to be replayed with `auto` rather than
 * failing the whole turn.
 */
function rejectsForcedToolChoice(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /tool_choice/i.test(message);
}

const TIME_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_current_time",
    description:
      "Get the current date and time. Use when the user asks about now, today, weekday, or relative time.",
    parameters: {
      type: "object",
      properties: {
        timeZone: {
          type: "string",
          description:
            "Optional IANA timezone, e.g. Asia/Shanghai. Defaults to server config.",
        },
      },
      additionalProperties: false,
    },
  },
};

const WEB_SEARCH_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the public web for up-to-date facts, news, or references. Use when the answer needs current information.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query in natural language",
        },
        max_results: {
          type: "integer",
          description: "Max results 1-10 (default 5)",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

export function formatCurrentTime(timeZone = "Asia/Shanghai"): string {
  const tz = timeZone?.trim() || "Asia/Shanghai";
  const now = new Date();
  let local = "";
  let weekday = "";
  try {
    local = new Intl.DateTimeFormat("zh-CN", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(now);
    weekday = new Intl.DateTimeFormat("zh-CN", {
      timeZone: tz,
      weekday: "long",
    }).format(now);
  } catch {
    local = now.toISOString();
    weekday = "";
  }
  return JSON.stringify({
    iso: now.toISOString(),
    timeZone: tz,
    local,
    weekday,
  });
}

function normalizeBaseUrl(url: string): string {
  return (url || "").trim().replace(/\/+$/, "");
}

/**
 * Map a ChatMessage onto the SDK param type.
 *
 * Array content is only emitted for `user`. Support for array content on
 * system/assistant varies across the OpenAI-compatible endpoints this talks to,
 * so those are flattened to text instead of gambling on the provider.
 */
function toApiMessage(m: ChatMessage): ChatCompletionMessageParam {
  if (typeof m.content === "string") {
    return { role: m.role, content: m.content } as ChatCompletionMessageParam;
  }
  if (m.role !== "user") {
    return {
      role: m.role,
      content: flattenChatContent(m.content),
    } as ChatCompletionMessageParam;
  }
  return {
    role: "user",
    content: m.content.map((p) =>
      p.type === "text"
        ? { type: "text" as const, text: p.text }
        : {
            type: "image_url" as const,
            image_url: {
              url: p.image_url.url,
              ...(p.image_url.detail ? { detail: p.image_url.detail } : {}),
            },
          },
    ),
  };
}

export class LlmClient {
  private client: OpenAI;
  private model: string;
  private temperature: number;
  private maxTokens: number;
  private toolsBaseUrl: string | null;
  private toolsApiKey: string;
  private defaultUpstream: LlmUpstream | null;
  private timeoutMs: number;

  constructor(cfg: LlmConfig) {
    this.model = cfg.model;
    this.temperature = cfg.temperature ?? 0.8;
    this.maxTokens = cfg.maxTokens ?? 1024;
    this.toolsBaseUrl = cfg.toolsBaseUrl
      ? normalizeBaseUrl(cfg.toolsBaseUrl)
      : null;
    this.toolsApiKey = (cfg.toolsApiKey ?? "").trim();
    this.defaultUpstream = cfg.defaultUpstream ?? null;
    this.timeoutMs = Math.max(1000, cfg.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS);

    // Platform mode: SDK baseURL = real provider (admin LLM).
    // User custom path ignores this client and uses createViaToolsGateway + upstream.
    this.client = new OpenAI({
      apiKey: cfg.apiKey,
      baseURL: normalizeBaseUrl(cfg.baseURL),
      // Bounded per attempt; one retry only. A hung upstream must not pin a
      // reply-consumer slot for half an hour.
      timeout: this.timeoutMs,
      maxRetries: 1,
      defaultHeaders: {
        "User-Agent": "WeChat-AI/1.0",
      },
      // The SDK types this against its bundled node-fetch; a native fetch
      // satisfies everything it actually uses (ok / headers / json / body).
      ...(cfg.fetchImpl
        ? { fetch: cfg.fetchImpl as unknown as ClientOptions["fetch"] }
        : {}),
    });
  }

  /** Platform client (admin LLM), optional tools for search. */
  static forPlatform(cfg: {
    baseURL: string;
    apiKey: string;
    model: string;
    temperature?: number;
    maxTokens?: number;
    toolsBaseUrl?: string;
    toolsApiKey?: string;
    fetchImpl?: typeof fetch;
  }): LlmClient {
    return new LlmClient({
      baseURL: cfg.baseURL,
      apiKey: cfg.apiKey,
      model: cfg.model,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      toolsBaseUrl: cfg.toolsBaseUrl,
      toolsApiKey: cfg.toolsApiKey,
      defaultUpstream: null,
      fetchImpl: cfg.fetchImpl,
    });
  }

  /**
   * User custom LLM: all chat traffic goes through tools gateway with upstream.
   * Main site never dials user baseUrl.
   */
  static forUserUpstream(cfg: {
    toolsBaseUrl: string;
    toolsApiKey: string;
    upstream: LlmUpstream;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
  }): LlmClient {
    const tools = normalizeBaseUrl(cfg.toolsBaseUrl);
    if (!tools) {
      throw new Error("TOOLS_BASE_URL is required for user custom LLM");
    }
    if (!cfg.toolsApiKey?.trim()) {
      throw new Error("TOOLS_API_KEY is required for user custom LLM");
    }
    return new LlmClient({
      baseURL: tools,
      apiKey: cfg.toolsApiKey,
      model: cfg.upstream.model,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      toolsBaseUrl: tools,
      toolsApiKey: cfg.toolsApiKey,
      defaultUpstream: cfg.upstream,
      timeoutMs: cfg.timeoutMs,
    });
  }

  getToolsBaseUrl(): string | null {
    return this.toolsBaseUrl;
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const r = await this.chatWithUsage(messages);
    return r.text;
  }

  async chatWithUsage(
    messages: ChatMessage[],
    opts: ChatCallOptions = {},
  ): Promise<ChatResult> {
    const toolNames = opts.tools?.length ? opts.tools : [];
    const timeZone = opts.timeZone?.trim() || "Asia/Shanghai";
    const maxRounds = Math.max(0, opts.maxToolRounds ?? 2);
    const upstream =
      opts.upstream === undefined ? this.defaultUpstream : opts.upstream;

    const tools: ChatCompletionTool[] = [];
    if (toolNames.includes("get_current_time")) tools.push(TIME_TOOL);
    if (toolNames.includes("web_search")) tools.push(WEB_SEARCH_TOOL);
    const toolsOpt = tools.length ? tools : undefined;

    const apiMessages: ChatCompletionMessageParam[] = messages.map(toApiMessage);
    const modelOverride = opts.model?.trim() || null;
    const maxTokensOverride =
      typeof opts.maxTokens === "number" && opts.maxTokens > 0
        ? Math.floor(opts.maxTokens)
        : null;

    let promptTokens = 0;
    let completionTokens = 0;
    let model = modelOverride ?? this.model;
    const toolsUsed: BuiltinToolName[] = [];

    for (let round = 0; round <= maxRounds; round++) {
      const forceTools =
        round === 0 && opts.requireToolUse === true && Boolean(toolsOpt);
      let res;
      try {
        res = await this.createCompletion(
          apiMessages,
          toolsOpt,
          upstream,
          modelOverride,
          maxTokensOverride,
          forceTools,
        );
      } catch (err) {
        if (!forceTools || !rejectsForcedToolChoice(err)) throw err;
        res = await this.createCompletion(
          apiMessages,
          toolsOpt,
          upstream,
          modelOverride,
          maxTokensOverride,
          false,
        );
      }

      const usage = res.usage;
      promptTokens += usage?.prompt_tokens ?? 0;
      completionTokens += usage?.completion_tokens ?? 0;
      model = res.model || modelOverride || this.model;

      const choice = res.choices[0]?.message;
      if (!choice) {
        throw new Error("LLM returned empty choice");
      }

      const toolCalls = choice.tool_calls;
      if (toolsOpt && toolCalls?.length && round < maxRounds) {
        apiMessages.push({
          role: "assistant",
          content: choice.content ?? null,
          tool_calls: toolCalls,
        });
        for (const tc of toolCalls) {
          const fn = tc.function;
          const name = fn?.name ?? "";
          if (
            (name === "get_current_time" || name === "web_search") &&
            !toolsUsed.includes(name)
          ) {
            toolsUsed.push(name);
          }
          const result = await this.runBuiltinTool(
            name,
            fn?.arguments ?? "{}",
            timeZone,
            opts.webSearch,
          );
          apiMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: result,
          });
        }
        continue;
      }

      const text = (choice.content ?? "").trim();
      if (!text) {
        throw new Error("LLM returned empty content");
      }
      return {
        text,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        model,
        toolsUsed,
      };
    }

    throw new Error("LLM tool loop exceeded max rounds without final text");
  }

  private async createCompletion(
    apiMessages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[] | undefined,
    upstream: LlmUpstream | null | undefined,
    modelOverride?: string | null,
    maxTokensOverride?: number | null,
    requireToolUse = false,
  ) {
    // User custom path: must go through tools with upstream body field.
    if (upstream) {
      return this.createViaToolsGateway(
        apiMessages,
        tools,
        upstream,
        maxTokensOverride,
        requireToolUse,
      );
    }
    // Platform path: direct OpenAI SDK (admin-configured LLM).
    return this.client.chat.completions.create({
      model: modelOverride ?? this.model,
      messages: apiMessages,
      temperature: this.temperature,
      max_tokens: maxTokensOverride ?? this.maxTokens,
      ...(tools
        ? { tools, tool_choice: requireToolUse ? ("required" as const) : ("auto" as const) }
        : {}),
    });
  }

  /**
   * Call tools gateway /v1/chat/completions with upstream credentials.
   * Uses fetch so we can inject non-standard `upstream` without SDK stripping it.
   */
  private async createViaToolsGateway(
    apiMessages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[] | undefined,
    upstream: LlmUpstream,
    maxTokensOverride?: number | null,
    requireToolUse = false,
  ) {
    const toolsRoot = this.toolsBaseUrl;
    if (!toolsRoot) {
      throw new Error(
        "User custom LLM requires TOOLS_BASE_URL (HF tools gateway)",
      );
    }
    const url = `${toolsRoot}/v1/chat/completions`;
    const body: Record<string, unknown> = {
      model: upstream.model || this.model,
      messages: apiMessages,
      temperature: this.temperature,
      max_tokens: maxTokensOverride ?? this.maxTokens,
      upstream: {
        base_url: upstream.baseUrl,
        api_key: upstream.apiKey,
        model: upstream.model || this.model,
      },
    };
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = requireToolUse ? "required" : "auto";
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "WeChat-AI/1.0",
    };
    const key = this.toolsApiKey || "";
    if (key) headers.Authorization = `Bearer ${key}`;

    // Sole egress for user-custom providers, and the target is a HF Space that
    // can be cold-starting — must be bounded.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let resp: Response;
    let text: string;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      text = await resp.text();
    } catch (err: unknown) {
      if (ctrl.signal.aborted) {
        throw new Error(
          `Tools gateway chat timed out after ${this.timeoutMs}ms`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      const snippet = text.slice(0, 400);
      throw new Error(
        `Tools gateway chat failed HTTP ${resp.status}: ${snippet}`,
      );
    }
    type GatewayMsg = {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    type GatewayRes = {
      choices?: Array<{ message?: GatewayMsg }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };
    let data: GatewayRes;
    try {
      data = JSON.parse(text) as GatewayRes;
    } catch {
      throw new Error("Tools gateway returned non-JSON");
    }
    // Shape compatible with OpenAI SDK response used in chatWithUsage
    return {
      choices: (data.choices ?? []).map((c) => ({
        message: {
          content: c.message?.content ?? null,
          tool_calls: c.message?.tool_calls,
          role: "assistant" as const,
        },
      })),
      usage: {
        prompt_tokens: data.usage?.prompt_tokens ?? 0,
        completion_tokens: data.usage?.completion_tokens ?? 0,
      },
      model: data.model || upstream.model || this.model,
    };
  }

  private async runBuiltinTool(
    name: string,
    argsJson: string,
    defaultTimeZone: string,
    webSearch?: ChatCallOptions["webSearch"],
  ): Promise<string> {
    if (name === "get_current_time") {
      let tz = defaultTimeZone;
      try {
        const args = argsJson
          ? (JSON.parse(argsJson) as { timeZone?: string })
          : {};
        if (typeof args.timeZone === "string" && args.timeZone.trim()) {
          tz = args.timeZone.trim();
        }
      } catch {
        /* use default */
      }
      return formatCurrentTime(tz);
    }
    if (name === "web_search") {
      if (!webSearch) {
        return JSON.stringify({
          error: "web_search is not configured (enable WEB_SEARCH + TOOLS)",
        });
      }
      let query = "";
      let maxResults = 5;
      try {
        const args = argsJson
          ? (JSON.parse(argsJson) as {
              query?: string;
              max_results?: number;
            })
          : {};
        query = typeof args.query === "string" ? args.query.trim() : "";
        if (typeof args.max_results === "number") {
          maxResults = args.max_results;
        }
      } catch {
        return JSON.stringify({ error: "invalid web_search arguments" });
      }
      if (!query) {
        return JSON.stringify({ error: "query is required" });
      }
      try {
        return await webSearch(query, maxResults);
      } catch (err) {
        return JSON.stringify({
          error: `web_search failed: ${(err as Error).message}`,
        });
      }
    }
    return JSON.stringify({ error: `unknown tool: ${name}` });
  }
}

export interface ToolsGatewayConfig {
  toolsBaseUrl: string;
  toolsApiKey: string;
  timeoutMs?: number;
}

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Web search client — **only** calls tools gateway (never DDG from main site).
 */
export class WebSearchClient {
  private baseUrl: string;
  private apiKey: string;
  private timeoutMs: number;

  constructor(cfg: ToolsGatewayConfig) {
    this.baseUrl = normalizeBaseUrl(cfg.toolsBaseUrl);
    this.apiKey = (cfg.toolsApiKey ?? "").trim();
    this.timeoutMs = cfg.timeoutMs ?? 15_000;
    if (!this.baseUrl) {
      throw new Error("TOOLS_BASE_URL is required for web search");
    }
  }

  async search(
    query: string,
    maxResults = 5,
  ): Promise<WebSearchHit[]> {
    const url = `${this.baseUrl}/v1/web-search`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "WeChat-AI/1.0",
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          query,
          max_results: maxResults,
        }),
        signal: ctrl.signal,
      });
      const text = await resp.text();
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
      }
      const data = JSON.parse(text) as { results?: WebSearchHit[] };
      return Array.isArray(data.results) ? data.results : [];
    } finally {
      clearTimeout(timer);
    }
  }

  /** Tool-friendly JSON string for LLM tool results. */
  async searchAsToolResult(query: string, maxResults = 5): Promise<string> {
    const results = await this.search(query, maxResults);
    return JSON.stringify({ query, results });
  }
}

export async function probeToolsHealth(
  toolsBaseUrl: string,
  timeoutMs = 8000,
): Promise<{ ok: boolean; detail: string }> {
  const base = normalizeBaseUrl(toolsBaseUrl);
  if (!base) return { ok: false, detail: "TOOLS_BASE_URL empty" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${base}/health`, { signal: ctrl.signal });
    const text = await resp.text();
    if (!resp.ok) {
      return { ok: false, detail: `HTTP ${resp.status}: ${text.slice(0, 120)}` };
    }
    return { ok: true, detail: text.slice(0, 200) };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Load platform LLM config (admin). Does not use tools for chat.
 * Tools URL is separate for search / user custom APIs.
 */
export function loadLlmConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LlmConfig {
  const apiKey = env.LLM_API_KEY ?? "";
  if (!apiKey) {
    throw new Error("LLM_API_KEY is required (platform / admin LLM)");
  }
  const toolsBaseUrl = (env.TOOLS_BASE_URL ?? "").trim() || undefined;
  const toolsApiKey = (env.TOOLS_API_KEY ?? "").trim() || undefined;
  return {
    baseURL: env.LLM_BASE_URL ?? "https://api.openai.com/v1",
    apiKey,
    model: env.LLM_MODEL ?? "gpt-4o-mini",
    toolsBaseUrl,
    toolsApiKey,
  };
}
