import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newerContextToken } from "./scheduled-send-token.js";

describe("newerContextToken", () => {
  it("retries only when Redis has a different token", () => {
    assert.equal(newerContextToken("t1", "t2"), "t2");
    assert.equal(newerContextToken("t1", "t1"), null);
    assert.equal(newerContextToken("t1", null), null);
    assert.equal(newerContextToken("t1", "  "), null);
  });
});
