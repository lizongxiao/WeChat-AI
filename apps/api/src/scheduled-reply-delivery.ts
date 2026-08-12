import type { InboundChatResult, ReplyPart } from "@wechat-ai/core";
import { splitScheduledBulletin } from "@wechat-ai/core";

function flattenPartNewlines(text: string): string[] {
  return text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Scheduled weather / greeting bulletins are sent as one WeChat bubble per
 * line. iLink does not keep in-message `\n`, and a text_item that contains
 * newlines can fail the send entirely.
 */
export function scheduledReplyParts(reply: InboundChatResult): ReplyPart[] {
  if (reply.kind === "reply" && reply.parts?.length) {
    const textParts = reply.parts.filter(
      (p): p is ReplyPart & { kind: "text" } =>
        p.kind === "text" && Boolean(p.text.trim()),
    );
    if (textParts.length > 0) {
      const lines = textParts.flatMap((p) => flattenPartNewlines(p.text));
      if (lines.length) {
        return lines.map((text) => ({ kind: "text" as const, text }));
      }
    }
  }
  const text = reply.text?.trim() ?? "";
  if (!text) return [];
  const chunks = splitScheduledBulletin(text);
  if (!chunks.length) return flattenPartNewlines(text).map((t) => ({ kind: "text" as const, text: t }));
  return chunks.map((chunk) => ({ kind: "text" as const, text: chunk }));
}
