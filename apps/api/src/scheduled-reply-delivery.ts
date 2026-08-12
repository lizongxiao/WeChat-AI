import type { InboundChatResult, ReplyPart } from "@wechat-ai/core";

/**
 * Preserve ChatService's ordered delivery plan for scheduled replies. This is
 * intentionally the same `parts → sendReplyPart/sendHumanParts` representation
 * used by ordinary inbound chat, rather than flattening it to `result.text`.
 */
export function scheduledReplyParts(reply: InboundChatResult): ReplyPart[] {
  if (reply.parts?.length) return reply.parts;
  if (reply.bubbles?.length) {
    return reply.bubbles.map((text) => ({ kind: "text" as const, text }));
  }
  return reply.text?.trim()
    ? [{ kind: "text" as const, text: reply.text.trim() }]
    : [];
}
