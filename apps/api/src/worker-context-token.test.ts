import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inboundContextTokenAt } from "./worker.js";

describe("inboundContextTokenAt", () => {
  it("uses the iLink inbound creation time to order context tokens", () => {
    assert.equal(
      inboundContextTokenAt({ create_time_ms: 1786665667000 }),
      "2026-08-14T00:01:07.000Z",
    );
  });
});
