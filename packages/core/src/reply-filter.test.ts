import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { flattenChatContent, type LlmClient } from "@wechat-ai/llm";
import {
  ReplyFilter,
  buildReplyFilterMessages,
  dropDisallowedStickers,
} from "./reply-filter.js";

/** ChatMessage.content is string | ChatContentPart[] since vision landed. */
const text = (m: { content: Parameters<typeof flattenChatContent>[0] }): string =>
  flattenChatContent(m.content);

class SeqFakeLlm implements Pick<LlmClient, "chat" | "chatWithUsage"> {
  calls = 0;
  constructor(private replies: string[] | string) {}
  private next(): string {
    this.calls++;
    if (typeof this.replies === "string") return this.replies;
    const i = Math.min(this.calls - 1, this.replies.length - 1);
    return this.replies[i] ?? "";
  }
  async chat(): Promise<string> {
    return this.next();
  }
  async chatWithUsage() {
    const text = this.next();
    return {
      text,
      promptTokens: 3,
      completionTokens: 7,
      totalTokens: 10,
      model: "fake",
      toolsUsed: [],
    };
  }
}

class FailingLlm implements Pick<LlmClient, "chat" | "chatWithUsage"> {
  async chat(): Promise<string> {
    throw new Error("llm down");
  }
  async chatWithUsage(): Promise<never> {
    throw new Error("llm down");
  }
}

function asLlm(fake: Pick<LlmClient, "chat" | "chatWithUsage">): LlmClient {
  return fake as unknown as LlmClient;
}

describe("buildReplyFilterMessages", () => {
  it("includes caps and allowed slugs", () => {
    const msgs = buildReplyFilterMessages({
      rawText: "你好呀～想你了",
      allowedStickerSlugs: ["Happy-Cat", "wave"],
      maxBubbles: 4,
      maxChunkChars: 40,
      maxStickers: 2,
    });
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0]?.role, "system");
    assert.match(text(msgs[0]!), /最多 4 个元素/);
    assert.match(text(msgs[0]!), /`happy-cat`/);
    assert.match(text(msgs[0]!), /`wave`/);
    assert.match(text(msgs[1]!), /你好呀/);
  });

  it("forbids stickers when maxStickers is 0", () => {
    const msgs = buildReplyFilterMessages({
      rawText: "hi",
      allowedStickerSlugs: ["wave"],
      maxStickers: 0,
    });
    assert.match(text(msgs[0]!), /禁止.*sticker/);
  });
});

describe("dropDisallowedStickers", () => {
  it("keeps only allow-listed slugs", () => {
    const parts = dropDisallowedStickers(
      [
        { kind: "text", text: "a" },
        { kind: "sticker", slug: "wave" },
        { kind: "sticker", slug: "nope" },
        { kind: "text", text: "b" },
      ],
      ["wave"],
    );
    assert.deepEqual(parts, [
      { kind: "text", text: "a" },
      { kind: "sticker", slug: "wave" },
      { kind: "text", text: "b" },
    ]);
  });

  it("drops all stickers when allow list empty", () => {
    const parts = dropDisallowedStickers(
      [
        { kind: "text", text: "hi" },
        { kind: "sticker", slug: "wave" },
      ],
      [],
    );
    assert.deepEqual(parts, [{ kind: "text", text: "hi" }]);
  });
});

describe("ReplyFilter", () => {
  it("parses filter JSON into ordered parts", async () => {
    const llm = new SeqFakeLlm(
      JSON.stringify({
        messages: [
          "好呀～",
          { type: "sticker", slug: "wave" },
          "下次见",
        ],
      }),
    );
    const filter = new ReplyFilter(asLlm(llm));
    const r = await filter.filter({
      rawText: "好呀～ [wave表情] 下次见",
      allowedStickerSlugs: ["wave"],
      maxStickers: 2,
    });
    assert.equal(r.usedFallback, false);
    assert.equal(r.fromFilterJson, true);
    assert.equal(llm.calls, 1);
    assert.deepEqual(r.parts, [
      { kind: "text", text: "好呀～" },
      { kind: "sticker", slug: "wave" },
      { kind: "text", text: "下次见" },
    ]);
    assert.equal(r.promptTokens, 3);
    assert.equal(r.completionTokens, 7);
  });

  it("falls back to rule parse when filter returns garbage", async () => {
    const llm = new SeqFakeLlm("这不是json也没有结构只是一段很长的话。真的。");
    const filter = new ReplyFilter(asLlm(llm));
    const r = await filter.filter({
      rawText: "原文明天见！加油！",
      maxStickers: 0,
    });
    // Non-JSON filter output → parse primary raw instead
    assert.ok(r.parts.length >= 1);
    assert.ok(r.displayText.includes("明天见") || r.displayText.includes("加油"));
    assert.equal(r.fromFilterJson, false);
    assert.equal(r.usedFallback, true);
  });

  it("falls back to primary raw when LLM throws", async () => {
    const filter = new ReplyFilter(asLlm(new FailingLlm()));
    const r = await filter.filter({
      rawText: '{"messages":["你好","在吗"]}',
      maxStickers: 0,
    });
    assert.equal(r.usedFallback, true);
    assert.equal(r.promptTokens, 0);
    assert.deepEqual(r.bubbles, ["你好", "在吗"]);
  });

  it("drops hallucinated sticker slugs", async () => {
    const llm = new SeqFakeLlm(
      JSON.stringify({
        messages: [
          "看",
          { type: "sticker", slug: "invented-slug" },
          { type: "sticker", slug: "wave" },
        ],
      }),
    );
    const filter = new ReplyFilter(asLlm(llm));
    const r = await filter.filter({
      rawText: "看",
      allowedStickerSlugs: ["wave"],
      maxStickers: 2,
    });
    const slugs = r.parts
      .filter((p) => p.kind === "sticker")
      .map((p) => (p.kind === "sticker" ? p.slug : ""));
    assert.deepEqual(slugs, ["wave"]);
  });

  it("converts stickers to text placeholders when maxStickers=0", async () => {
    const llm = new SeqFakeLlm(
      JSON.stringify({
        messages: ["hi", { type: "sticker", slug: "wave" }],
      }),
    );
    const filter = new ReplyFilter(asLlm(llm));
    const r = await filter.filter({
      rawText: "hi",
      maxStickers: 0,
      allowedStickerSlugs: ["wave"],
    });
    assert.ok(r.parts.every((p) => p.kind === "text"));
    assert.ok(r.displayText.includes("[表情:wave]") || r.parts.some((p) => p.kind === "text" && p.text.includes("表情")));
  });

  it("does not call LLM when disabled", async () => {
    const llm = new SeqFakeLlm("should-not-be-used");
    const filter = new ReplyFilter(asLlm(llm), { enabled: false });
    const r = await filter.filter({
      rawText: '{"messages":["a","b"]}',
      maxStickers: 0,
    });
    assert.equal(llm.calls, 0);
    assert.equal(r.usedFallback, true);
    assert.deepEqual(r.bubbles, ["a", "b"]);
    assert.equal(r.promptTokens, 0);
  });

  it("returns empty for blank input", async () => {
    const llm = new SeqFakeLlm("x");
    const filter = new ReplyFilter(asLlm(llm));
    const r = await filter.filter({ rawText: "   " });
    assert.equal(llm.calls, 0);
    assert.equal(r.parts.length, 0);
  });
});
