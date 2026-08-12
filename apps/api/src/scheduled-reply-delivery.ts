import type { InboundChatResult, ReplyPart } from "@wechat-ai/core";
import { splitScheduledBulletin } from "@wechat-ai/core";

/**
 * Pack a scheduled bulletin into at most three WeChat bubbles.
 * iLink does not keep in-message `\n` (and may reject it), and too many
 * consecutive sendmessage calls hit frequency limits.
 */
export function scheduledReplyParts(reply: InboundChatResult): ReplyPart[] {
  const fromParts =
    reply.kind === "reply" && reply.parts?.length
      ? reply.parts
          .filter(
            (p): p is ReplyPart & { kind: "text" } =>
              p.kind === "text" && Boolean(p.text.trim()),
          )
          .map((p) => p.text.trim())
          .join("\n")
      : "";
  const text = reply.text?.trim() || fromParts;
  if (!text) return [];
  return splitScheduledBulletin(text).map((chunk) => ({
    kind: "text" as const,
    text: chunk,
  }));
}
