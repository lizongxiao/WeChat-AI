import type { InboundChatResult, ReplyPart } from "@wechat-ai/core";
import { splitScheduledBulletin } from "@wechat-ai/core";

/**
 * Scheduled weather / greeting bulletins are sent as one WeChat bubble per
 * blank-line paragraph (问候 / 天气 / 穿衣出行 / 寄语 / 收尾). Relying on
 * in-message `\n` alone is unreliable on iLink.
 */
export function scheduledReplyParts(reply: InboundChatResult): ReplyPart[] {
  if (reply.kind === "reply" && reply.parts?.length) {
    const textParts = reply.parts.filter(
      (p): p is ReplyPart & { kind: "text" } =>
        p.kind === "text" && Boolean(p.text.trim()),
    );
    if (textParts.length > 1) {
      return textParts.map((p) => ({ kind: "text" as const, text: p.text.trim() }));
    }
  }
  const text = reply.text?.trim() ?? "";
  if (!text) return [];
  const chunks = splitScheduledBulletin(text);
  if (!chunks.length) return [{ kind: "text" as const, text }];
  return chunks.map((chunk) => ({ kind: "text" as const, text: chunk }));
}
