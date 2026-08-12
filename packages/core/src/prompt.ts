import type { MemoryRow, MessageRow, StickerPromptEntry } from "@wechat-ai/db";
import type { ChatContentPart, ChatMessage } from "@wechat-ai/llm";
import {
  REPLY_FORMAT_INSTRUCTION,
  REPLY_FORMAT_INSTRUCTION_TEXT_ONLY,
  renderAssistantHistoryForModel,
} from "./reply-format.js";

/**
 * Attachment kinds. Declared as a plain union rather than importing from
 * @wechat-ai/ilink so core stays free of protocol coupling — the worker
 * translates iLink media refs into these.
 */
export type AttachmentKind = "image" | "voice" | "video" | "file";

/** One attachment on the message currently being answered. */
export interface PromptAttachment {
  kind: AttachmentKind;
  /**
   * `data:<mime>;base64,...` — present only when the model can actually read
   * the bytes (a vision-capable model plus a supported image mime). Absent
   * means "tell the persona it exists but it cannot see/hear it".
   */
  dataUri?: string;
  mime?: string | null;
  fileName?: string;
  /**
   * Text description produced by the vision endpoint (caption mode). Present
   * means the roleplay model can "see" this attachment through words, even
   * though it never receives the bytes.
   */
  caption?: string;
}

const ATTACHMENT_LABEL: Record<AttachmentKind, string> = {
  image: "图片",
  voice: "语音",
  video: "视频",
  file: "文件",
};

function countByKind(
  attachments: PromptAttachment[],
): Array<{
  kind: AttachmentKind;
  total: number;
  /** Bytes attached to this turn (direct vision mode) */
  readable: number;
  /** Described in words by a vision endpoint (caption mode) */
  captioned: number;
}> {
  const order: AttachmentKind[] = ["image", "voice", "video", "file"];
  return order
    .map((kind) => {
      const of = attachments.filter((a) => a.kind === kind);
      return {
        kind,
        total: of.length,
        readable: of.filter((a) => Boolean(a.dataUri)).length,
        captioned: of.filter((a) => !a.dataUri && Boolean(a.caption?.trim()))
          .length,
      };
    })
    .filter((x) => x.total > 0);
}

/**
 * Tell the model what is attached and, crucially, what it cannot perceive —
 * without this a persona happily hallucinates the contents of a video it never
 * received.
 *
 * Three states per kind: bytes attached (direct mode), described in words
 * (caption mode), or nothing at all.
 */
export function buildAttachmentBlock(
  attachments: PromptAttachment[] | undefined,
): string {
  if (!attachments?.length) return "";
  const lines: string[] = ["## 本条消息的附件"];
  for (const { kind, total, readable, captioned } of countByKind(attachments)) {
    const label = ATTACHMENT_LABEL[kind];
    if (readable > 0) {
      lines.push(
        `- ${label} ×${total}：其中 ${readable} 个已随本条消息发给你，请**据实描述你真正看到的内容**。`,
      );
    }
    if (captioned > 0) {
      lines.push(
        `- ${label} ×${captioned}：你看不到原图，但**已由识图模型转成文字描述**，写在用户消息的方括号里。` +
          `请把这段描述当作你亲眼所见来回应，但只依据描述里写到的内容，不要往外扩写细节。`,
      );
    }
    const blind = total - readable - captioned;
    if (blind > 0) {
      lines.push(
        `- ${label} ×${blind}：内容**没有**发给你，你无法查看/收听。不要猜测或编造里面是什么；用人设语气说明看不了，并邀请对方用文字描述。`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * The user turn for this message: plain text when nothing is readable, content
 * parts when a vision model can see an attached image.
 */
export function buildUserContent(
  userText: string,
  attachments: PromptAttachment[] | undefined,
): string | ChatContentPart[] {
  const text = userText.trim();
  const readable = (attachments ?? []).filter((a) => a.dataUri);
  if (!readable.length) {
    // Always go through describeAttachments, never bare `text`: in caption mode
    // the description lives on the attachment, and returning just the user's
    // words would silently drop it. It also keeps this turn identical to what
    // the *next* turn will read back out of history.
    return describeAttachments(userText, attachments);
  }
  const parts: ChatContentPart[] = [];
  // Tag only what the model does NOT receive — a `[图片]` next to the actual
  // image adds nothing, while a `[视频]` beside it is the only hint it exists.
  const unsent = (attachments ?? []).filter((a) => !a.dataUri);
  const lead =
    describeAttachments(userText, unsent) ||
    describeAttachments(userText, attachments) ||
    text;
  if (lead) parts.push({ type: "text", text: lead });
  for (const a of readable) {
    parts.push({ type: "image_url", image_url: { url: a.dataUri! } });
  }
  return parts;
}

/**
 * Readable one-liner for conversation history. The bytes are never persisted,
 * so this is what later turns see — without it a follow-up like "所以呢？" loses
 * all trace that an image was sent.
 *
 * When a caption is available it goes in too, which is the real payoff of
 * caption mode: the *content* of the image survives in history rather than an
 * opaque `[图片]`, so the model can still discuss it three turns later.
 */
export function describeAttachments(
  userText: string,
  attachments: PromptAttachment[] | undefined,
): string {
  const text = (userText ?? "").trim();
  if (!attachments?.length) return text;

  const tags: string[] = [];
  const captioned = new Set<PromptAttachment>();
  for (const a of attachments) {
    const caption = a.caption?.trim();
    if (!caption) continue;
    captioned.add(a);
    tags.push(`[${ATTACHMENT_LABEL[a.kind]}：${caption}]`);
  }
  const rest = attachments.filter((a) => !captioned.has(a));
  for (const { kind, total } of countByKind(rest)) {
    tags.push(
      total > 1
        ? `[${ATTACHMENT_LABEL[kind]}×${total}]`
        : `[${ATTACHMENT_LABEL[kind]}]`,
    );
  }
  const joined = tags.join("");
  return text ? `${text}\n${joined}` : joined;
}

/**
 * Ask a vision model to describe an image.
 *
 * Deliberately persona-free and roleplay-free: this is a perception step whose
 * output is fed to the roleplay model as plain text, so it must report what is
 * actually in the frame and nothing else. Any character voice belongs to the
 * model that reads this, not the one that writes it.
 */
export function buildImageCaptionMessages(params: {
  dataUri: string;
  /** The user's own caption / question, when they sent one — helps focus it */
  userText?: string;
}): ChatMessage[] {
  const ask = (params.userText ?? "").trim();
  const focus = ask
    ? `\n用户随图说了：「${ask.slice(0, 200)}」。若与图片相关，描述时请覆盖这一点。`
    : "";
  return [
    {
      role: "system",
      content: [
        "你是图像描述器。用中文客观描述图片内容，供另一个对话模型参考。",
        "规则：",
        "- 只描述你确实看到的：主体、动作、场景、显著文字、表情与氛围",
        "- 不要扮演角色、不要与用户对话、不要评论、不要加称呼或语气词",
        "- 看不清就说看不清；绝对不要猜测或编造",
        "- 控制在 120 字以内，一段话",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        { type: "text", text: `请描述这张图片。${focus}` },
        { type: "image_url", image_url: { url: params.dataUri } },
      ],
    },
  ];
}

/** Placeholder tokens users can insert in persona editor */
export const BOT_NAME_VARS = [
  "{{bot_name}}",
  "{{BOT_NAME}}",
  "{{机器人名字}}",
  "{{机器人名称}}",
] as const;

/**
 * Replace persona template variables with runtime values.
 * Unknown placeholders are left as-is.
 */
export function applyPromptTemplate(
  template: string,
  vars: { botName: string },
): string {
  const name = (vars.botName || "助手").trim() || "助手";
  let out = template;
  for (const key of BOT_NAME_VARS) {
    out = out.split(key).join(name);
  }
  return out;
}

/** Always injected so the agent knows its display name even without variables. */
export function buildBotIdentityBlock(botName: string): string {
  const name = (botName || "助手").trim() || "助手";
  return [
    "## 智能体身份",
    `你的名字是「${name}」。在对话中以该名字自称，并接受用户这样称呼你。`,
    "若人设正文与名字冲突，以本段名字为准，其余性格设定仍以人设为准。",
  ].join("\n");
}

export function buildStickerCatalogBlock(
  stickers: StickerPromptEntry[] | undefined,
): string {
  if (!stickers?.length) return "";
  const lines = stickers.map((s) => {
    const tags = s.tags.length ? ` tags=[${s.tags.join(",")}]` : "";
    const desc = s.description ? ` — ${s.description}` : "";
    return `- slug=\`${s.slug}\` 名称=${s.display_name}${tags}${desc}`;
  });
  return [
    "## 可用表情包（仅可使用下列 slug，禁止编造）",
    "微信规则：**图片必须单独一条消息**，不能和文字写在同一条里。",
    "发图时在 messages 数组里放**单独的对象元素**（前后可以是文字元素，但是相邻的另一条消息）：",
    '正确：{"messages":["给你看～",{"type":"sticker","slug":"xxx"},"喜欢吗"]} → 三条消息：字 / 图 / 字',
    "错误：字符串里塞 JSON、或试图在一条里又字又图、或编造未列出的 slug。",
    "合适时才发，不要刷屏；每条回复最多 2 个 sticker；sticker 对象内禁止带文字。",
    ...lines,
  ].join("\n");
}

function buildMemoryBlock(memories: MemoryRow[]): string {
  if (!memories.length) return "";
  return [
    "## 关于该用户的长期记忆（仅限此用户，勿与他人混淆）",
    ...memories.map((m) => `- ${m.content}`),
  ].join("\n");
}

function buildTimeToolBlock(enabled: boolean | undefined): string {
  if (enabled === false) return "";
  return [
    "## 时间工具",
    "当你需要准确的当前日期、星期或时刻时，调用工具 get_current_time。",
    "不要凭空编造「现在几点/今天周几」；拿到工具结果后再用人设语气回复。",
  ].join("\n");
}

function buildFormatBlock(opts: {
  multiBubbleJson?: boolean;
  stickers?: StickerPromptEntry[];
}): string {
  if (opts.multiBubbleJson === false) return "";
  const hasStickers = (opts.stickers?.length ?? 0) > 0;
  return hasStickers
    ? REPLY_FORMAT_INSTRUCTION
    : REPLY_FORMAT_INSTRUCTION_TEXT_ONLY;
}

/**
 * Replay one stored turn back to the model.
 *
 * History holds display text, and for assistant turns that includes the
 * `[表情:slug]` rendering of a sticker. Fed back raw it is a worked example of
 * a format the model is explicitly forbidden to produce — and it copies what it
 * sees over what it is told, which is how literal `[表情:…]` bubbles end up in
 * WeChat. Normalize assistant turns to the sanctioned sticker JSON on the way
 * in, so the transcript and the instruction agree.
 */
function historyMessage(
  role: "user" | "assistant",
  content: string,
): ChatMessage {
  return {
    role,
    content:
      role === "assistant" ? renderAssistantHistoryForModel(content) : content,
  };
}

export function buildChatMessages(params: {
  systemPrompt: string;
  memories: MemoryRow[];
  history: MessageRow[];
  userText: string;
  /** Bot display name for identity + {{bot_name}} substitution */
  botName?: string;
  /** Assigned Persona name. It is the conversational identity, while botName
   * remains the communication account name and template-variable value. */
  personaName?: string;
  /** Append multi-bubble JSON output instruction (default true) */
  multiBubbleJson?: boolean;
  /** Enabled stickers for prompt catalog (omit or empty → text-only format) */
  stickers?: StickerPromptEntry[];
  /** Mention get_current_time tool in system prompt */
  timeToolEnabled?: boolean;
  /** Media attached to this message (images become content parts) */
  attachments?: PromptAttachment[];
}): ChatMessage[] {
  const botName = params.botName?.trim() || "助手";
  const personaBody = applyPromptTemplate(params.systemPrompt, { botName });
  const identity = buildBotIdentityBlock(params.personaName?.trim() || botName);

  const memoryBlock = buildMemoryBlock(params.memories);
  const stickerBlock = buildStickerCatalogBlock(params.stickers);
  const timeBlock = buildTimeToolBlock(params.timeToolEnabled);
  const attachmentBlock = buildAttachmentBlock(params.attachments);
  const formatBlock = buildFormatBlock({
    multiBubbleJson: params.multiBubbleJson,
    stickers: params.stickers,
  });

  const system = [
    identity,
    personaBody,
    memoryBlock,
    stickerBlock,
    timeBlock,
    attachmentBlock,
    formatBlock,
  ]
    .filter(Boolean)
    .join("\n\n");

  const messages: ChatMessage[] = [{ role: "system", content: system }];

  for (const m of params.history) {
    if (m.role === "user" || m.role === "assistant") {
      // History stores plain display text (not raw JSON)
      messages.push(historyMessage(m.role, m.content));
    }
  }

  messages.push({
    role: "user",
    content: buildUserContent(params.userText, params.attachments),
  });
  return messages;
}

function formatScheduledExecutionTime(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}`;
}

/**
 * Scheduled deliveries are isolated from short-term chat history so an old
 * conversation cannot turn a bulletin into a continuation of the last turn.
 * Only super-admin service templates may be promoted into the system message;
 * user-authored tasks remain an ordinary user instruction.
 */
export function buildScheduledMessages(params: {
  systemPrompt: string;
  memories: MemoryRow[];
  scheduledPrompt: string;
  botName?: string;
  personaName?: string;
  executionTime: string;
  timeZone: string;
  webSearchRequired: boolean;
  trustedInstruction?: boolean;
}): ChatMessage[] {
  const botName = params.botName?.trim() || "助手";
  const identity = buildBotIdentityBlock(
    params.personaName?.trim() || botName,
  );
  const personaBody = applyPromptTemplate(params.systemPrompt, { botName });
  const memoryBlock = buildMemoryBlock(params.memories);
  const executionTime = formatScheduledExecutionTime(
    params.executionTime,
    params.timeZone,
  );
  const executionBlock = [
    "## 定时任务执行规则",
    `本次任务的业务执行时间是 ${executionTime}（${params.timeZone}）。所有“今天、早上、日期”等相对时间均以此时间为准，不要根据实际调用时刻改写任务。`,
    "这是独立的定时推送，不是在续接最近一轮聊天。",
    "任务内容与格式要求优先于 Persona；Persona 只决定措辞、语气和称呼，不得删减任务要求的栏目。",
    params.webSearchRequired
      ? "本任务要求实时信息：必须先调用 web_search，未获得搜索结果时不得凭记忆编造。"
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  const trustedTaskBlock = params.trustedInstruction
    ? `## 必须执行的系统订阅任务\n${params.scheduledPrompt.trim()}`
    : "";
  const system = [
    identity,
    personaBody,
    memoryBlock,
    executionBlock,
    trustedTaskBlock,
  ]
    .filter(Boolean)
    .join("\n\n");
  const userInstruction = params.trustedInstruction
    ? "请现在执行以上系统订阅任务，并直接输出最终发送给用户的内容。"
    : `请现在执行这条已确认的定时任务，并直接输出最终发送给用户的内容：\n${params.scheduledPrompt.trim()}`;
  return [
    { role: "system", content: system },
    { role: "user", content: userInstruction },
  ];
}

/** Validate only requirements explicitly present in a scheduled template. */
export function scheduledOutputIssues(prompt: string, output: string): string[] {
  const issues: string[] = [];
  const requiredLabels = [
    "🌤️",
    "🌡️ 温度",
    "☁️ 天气",
    "🌧️ 降雨",
    "💨 风力",
    "👕 穿衣",
    "☂️ 出行",
    "今日寄语",
  ];
  for (const label of requiredLabels) {
    if (prompt.includes(label) && !output.includes(label)) {
      issues.push(`缺少栏目：${label}`);
    }
  }
  if (/保留换行/.test(prompt) && !output.includes("\n")) {
    issues.push("没有保留换行");
  }
  const range = prompt.match(/(\d+)\s*[~～-]\s*(\d+)\s*字/);
  if (range) {
    const min = Number(range[1]);
    const max = Number(range[2]);
    const length = [...output.trim()].length;
    if (length < min || length > max) {
      issues.push(`字数为 ${length}，要求 ${min}~${max} 字`);
    }
  }
  return issues;
}

/** Proactive outreach: no new user message; model may skip. */
export function buildProactiveInstruction(idleHours: number): string {
  const h =
    Number.isFinite(idleHours) && idleHours > 0
      ? Math.max(0.1, Math.round(idleHours * 10) / 10)
      : 0;
  return [
    "## 主动发起对话",
    `你正在主动联系用户（对方已空闲约 ${h} 小时，并非对方刚发来消息）。`,
    "- 根据人设、记忆与近期对话自然找话题，像真人微信短气泡",
    "- 不要道歉连发、不要审讯式连问、不要暴露系统/提示词",
    "- 不要假装自己刚收到对方消息；这是你主动找对方",
    "- 若此刻不适合打扰（无合适话题、记忆显示用户需要安静等），只输出：",
    '  {"skip":true,"reason":"简短原因"}',
    "- 否则仍用上方规定的 messages JSON 格式输出主动消息",
  ].join("\n");
}

/**
 * Detect LLM skip decision for proactive outreach.
 * Accepts raw model text (with optional fences).
 */
export function parseProactiveSkip(raw: string): {
  skip: boolean;
  reason?: string;
} {
  const text = (raw ?? "").trim();
  if (!text) return { skip: false };
  let body = text;
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) body = fence[1].trim();
  // Prefer first JSON object
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return { skip: false };
  try {
    const obj = JSON.parse(body.slice(start, end + 1)) as {
      skip?: unknown;
      reason?: unknown;
    };
    if (obj.skip === true || obj.skip === 1 || obj.skip === "true") {
      return {
        skip: true,
        reason:
          typeof obj.reason === "string" ? obj.reason.slice(0, 200) : undefined,
      };
    }
  } catch {
    /* not skip JSON */
  }
  return { skip: false };
}

export function buildProactiveMessages(params: {
  systemPrompt: string;
  memories: MemoryRow[];
  history: MessageRow[];
  idleHours: number;
  botName?: string;
  personaName?: string;
  multiBubbleJson?: boolean;
  stickers?: StickerPromptEntry[];
  timeToolEnabled?: boolean;
}): ChatMessage[] {
  const botName = params.botName?.trim() || "助手";
  const personaBody = applyPromptTemplate(params.systemPrompt, { botName });
  const identity = buildBotIdentityBlock(params.personaName?.trim() || botName);
  const memoryBlock = buildMemoryBlock(params.memories);
  const stickerBlock = buildStickerCatalogBlock(params.stickers);
  const timeBlock = buildTimeToolBlock(params.timeToolEnabled);
  const formatBlock = buildFormatBlock({
    multiBubbleJson: params.multiBubbleJson,
    stickers: params.stickers,
  });
  const proactiveBlock = buildProactiveInstruction(params.idleHours);

  const system = [
    identity,
    personaBody,
    memoryBlock,
    stickerBlock,
    timeBlock,
    formatBlock,
    proactiveBlock,
  ]
    .filter(Boolean)
    .join("\n\n");

  const messages: ChatMessage[] = [{ role: "system", content: system }];

  for (const m of params.history) {
    if (m.role === "user" || m.role === "assistant") {
      messages.push(historyMessage(m.role, m.content));
    }
  }

  messages.push({
    role: "user",
    content:
      "（系统）对方已空闲一段时间。请生成这次主动找对方聊天的消息；若不适合打扰则输出 skip JSON。",
  });
  return messages;
}

export function buildMemoryExtractMessages(params: {
  history: MessageRow[];
  existing: MemoryRow[];
}): ChatMessage[] {
  const existing =
    params.existing.length > 0
      ? params.existing.map((m) => `- ${m.content}`).join("\n")
      : "(无)";
  const transcript = params.history
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  return [
    {
      role: "system",
      content: `你是记忆整理助手。根据对话提取应长期记住的事实（昵称、偏好、关系约定）。
规则：
- 只输出 JSON 数组，元素为中文字符串，例如 ["用户喜欢咖啡","用户叫我小铃"]
- 最多 12 条；合并重复；不要编造
- 已有记忆可保留有用的并更新过时的`,
    },
    {
      role: "user",
      content: `已有记忆：\n${existing}\n\n对话：\n${transcript}\n\n请输出 JSON 数组：`,
    },
  ];
}

export function parseFactsJson(raw: string): string[] {
  const text = (raw ?? "").trim();
  if (!text) return [];
  let body = text;
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) body = fence[1].trim();
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start >= 0 && end > start) body = body.slice(start, end + 1);
  try {
    const data = JSON.parse(body) as unknown;
    if (!Array.isArray(data)) return [];
    return data
      .map((x) => (typeof x === "string" ? x.trim() : ""))
      .filter(Boolean)
      .slice(0, 12);
  } catch {
    return [];
  }
}
