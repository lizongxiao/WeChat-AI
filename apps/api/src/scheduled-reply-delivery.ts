import type { InboundChatResult, ReplyPart } from "@wechat-ai/core";

/**
 * A scheduled result is deliberately a single WeChat message. ChatService has
 * already retained its internal paragraph layout in `text`; do not reuse the
 * ordinary-chat bubble list because that list is capped at five entries.
 */
export function scheduledReplyParts(reply: InboundChatResult): ReplyPart[] {
  return reply.text?.trim()
    ? [{ kind: "text" as const, text: reply.text.trim() }]
    : [];
}
