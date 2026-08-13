import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "./config.js";
import { planInboundMedia, unreadableMediaReply } from "./inbound-media.js";

/**
 * Guards the shipped-off state of optional features.
 *
 * Image understanding costs tokens on every picture and needs a vision endpoint
 * that most deployments do not have, so it must stay off unless an operator
 * explicitly turns it on. A test is the only way that stays true — a default in
 * a 400-line config function is one careless edit away from flipping.
 */

/** Nothing set: exactly what a fresh checkout with no .env gets. */
const bare = () => loadConfig({} as NodeJS.ProcessEnv);

describe("shipped defaults: image understanding is off", () => {
  it("visionEnabled is false with no env at all", () => {
    assert.equal(bare().visionEnabled, false);
  });

  it("only the exact string \"true\" enables it", () => {
    for (const raw of ["1", "yes", "on", "TRUE", "True", " true", "true "]) {
      assert.equal(
        loadConfig({ VISION_ENABLED: raw } as NodeJS.ProcessEnv).visionEnabled,
        false,
        `VISION_ENABLED=${JSON.stringify(raw)} must not enable vision`,
      );
    }
    assert.equal(
      loadConfig({ VISION_ENABLED: "true" } as NodeJS.ProcessEnv).visionEnabled,
      true,
    );
  });

  it("ships with no vision endpoint or model configured", () => {
    const cfg = bare();
    assert.equal(cfg.visionModel, "");
    assert.equal(cfg.visionBaseUrl, "");
    assert.equal(cfg.visionApiKey, "");
  });

  it("downloads nothing while it is off, whatever arrives", () => {
    const refs = [
      { kind: "image" as const, index: 0, encryptQueryParam: "a" },
      { kind: "image" as const, index: 1, encryptQueryParam: "b" },
      { kind: "voice" as const, index: 2, encryptQueryParam: "c" },
      { kind: "video" as const, index: 3, encryptQueryParam: "d" },
      { kind: "file" as const, index: 4, encryptQueryParam: "e" },
    ];
    const cfg = bare();
    const plan = planInboundMedia(refs, {
      visionEnabled: cfg.visionEnabled,
      maxImages: cfg.visionMaxImages,
    });
    assert.equal(
      plan.filter((p) => p.download).length,
      0,
      "no CDN fetch may happen while vision is off",
    );
  });

  it("answers an image with a canned line, costing no model call", () => {
    const reply = unreadableMediaReply([
      { kind: "image", index: 0, encryptQueryParam: "a" },
    ]);
    assert.match(reply, /看不了图片/);
  });

  it("defaults the mode to caption, so turning it on never needs a vision-capable roleplay model", () => {
    // Only matters once someone sets VISION_ENABLED=true, but the safe mode has
    // to be the default one — `direct` errors outright on a text-only model.
    assert.equal(bare().visionMode, "caption");
  });
});

describe("shipped defaults: WeChat's own voice transcript is ON", () => {
  it("is enabled with no env at all", () => {
    // Deliberately opposite to vision: the transcript arrives inside the inbound
    // message, so using it costs nothing and needs no model.
    assert.equal(bare().voiceTranscriptEnabled, true);
  });

  it("only the exact string \"false\" disables it", () => {
    for (const raw of ["0", "no", "off", "FALSE", "False", " false"]) {
      assert.equal(
        loadConfig({ VOICE_TRANSCRIPT_ENABLED: raw } as NodeJS.ProcessEnv)
          .voiceTranscriptEnabled,
        true,
        `VOICE_TRANSCRIPT_ENABLED=${JSON.stringify(raw)} must not disable it`,
      );
    }
    assert.equal(
      loadConfig({ VOICE_TRANSCRIPT_ENABLED: "false" } as NodeJS.ProcessEnv)
        .voiceTranscriptEnabled,
      false,
    );
  });

  it("is independent of the vision switch", () => {
    const cfg = bare();
    assert.equal(cfg.visionEnabled, false);
    assert.equal(cfg.voiceTranscriptEnabled, true);
  });
});

describe("shipped defaults: other optional features stay off", () => {
  it("proactive outreach is off", () => {
    assert.equal(bare().proactiveEnabled, false);
  });

  it("session keep-alive for scheduled subscribers is on", () => {
    assert.equal(bare().keepAliveEnabled, true);
  });

  it("web search is off", () => {
    assert.equal(bare().webSearchEnabled, false);
  });

  it("the second-pass reply filter is off", () => {
    assert.equal(bare().replyFilterEnabled, false);
  });

  it("unapproved users cannot chat", () => {
    assert.equal(bare().allowUnapproved, false);
  });
});
