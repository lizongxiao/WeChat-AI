import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { flattenChatContent } from "@wechat-ai/llm";
import {
  applyPromptTemplate,
  buildBotIdentityBlock,
  buildChatMessages,
} from "./prompt.js";

/** ChatMessage.content is string | ChatContentPart[] since vision landed. */
const text = (m: { content: Parameters<typeof flattenChatContent>[0] }): string =>
  flattenChatContent(m.content);

describe("applyPromptTemplate", () => {
  it("replaces bot name variables", () => {
    const t = applyPromptTemplate(
      "我是{{bot_name}}，也叫{{机器人名字}}。",
      { botName: "小铃" },
    );
    assert.equal(t, "我是小铃，也叫小铃。");
  });
});

describe("buildChatMessages bot identity", () => {
  it("injects bot name into system", () => {
    const msgs = buildChatMessages({
      systemPrompt: "你是猫娘{{bot_name}}。",
      memories: [],
      history: [],
      userText: "hi",
      botName: "小铃",
      multiBubbleJson: false,
    });
    assert.match(text(msgs[0]!), /小铃/);
    assert.match(text(msgs[0]!), /智能体身份/);
    assert.doesNotMatch(text(msgs[0]!), /\{\{bot_name\}\}/);
  });

  it("uses the assigned Persona as the conversational identity", () => {
    const msgs = buildChatMessages({
      systemPrompt: "你负责正常聊天，账号名变量仍是 {{bot_name}}。",
      memories: [], history: [], userText: "你是谁？", botName: "猫娘", personaName: "卢姥爷", multiBubbleJson: false,
    });
    const system = text(msgs[0]!);
    assert.match(system, /你的名字是「卢姥爷」/);
    assert.match(system, /账号名变量仍是 猫娘/);
    assert.doesNotMatch(system, /你的名字是「猫娘」/);
  });
});

describe("buildBotIdentityBlock", () => {
  it("uses fallback name", () => {
    assert.match(buildBotIdentityBlock("  "), /助手/);
  });
});
