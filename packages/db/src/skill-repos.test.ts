import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openDatabase } from "./client.js";
import {
  getGlobalDisabledSkills,
  getPersonaDisabledSkills,
  getPersonaSkillOverrides,
  isSkillEnabled,
  setGlobalSkillEnabled,
  setPersonaSkillOverride,
} from "./skill-repos.js";

function withRedis(
  t: TestContext,
  fn: (db: ReturnType<typeof openDatabase>) => Promise<void>,
): Promise<void> {
  const db = openDatabase(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
  return Promise.race<void>([
    db.ping().then(() => fn(db).finally(() => db.close())),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("redis timeout")), 2500),
    ),
  ]).catch((err) => {
    t.skip(`redis unavailable: ${(err as Error).message}`);
  });
}

interface TestContext {
  skip(msg: string): void;
}

describe("skill enable/disable (Redis)", () => {
  it("defaults to enabled and honors global toggle", async (t) => {
    await withRedis(t, async (db) => {
      const skill = `scheduled-test-${Date.now()}`;
      assert.equal(await isSkillEnabled(db, skill, null), true);

      await setGlobalSkillEnabled(db, skill, false);
      assert.equal(await isSkillEnabled(db, skill, null), false);
      assert.ok((await getGlobalDisabledSkills(db)).includes(skill));

      await setGlobalSkillEnabled(db, skill, true);
      assert.equal(await isSkillEnabled(db, skill, null), true);
      assert.ok(!(await getGlobalDisabledSkills(db)).includes(skill));
    });
  });

  it("persona override wins both ways over global", async (t) => {
    await withRedis(t, async (db) => {
      const skill = `scheduled-test-${Date.now()}`;
      const persona = `persona-${Date.now()}`;

      // global off, persona "on" → on for that persona only
      await setGlobalSkillEnabled(db, skill, false);
      await setPersonaSkillOverride(db, persona, skill, "on");
      assert.equal(await isSkillEnabled(db, skill, persona), true);
      assert.equal(await isSkillEnabled(db, skill, null), false);
      assert.equal(
        (await getPersonaSkillOverrides(db, persona))[skill],
        "on",
      );

      // persona "off" overrides global on
      await setGlobalSkillEnabled(db, skill, true);
      await setPersonaSkillOverride(db, persona, skill, "off");
      assert.equal(await isSkillEnabled(db, skill, null), true);
      assert.equal(await isSkillEnabled(db, skill, persona), false);
      assert.ok((await getPersonaDisabledSkills(db, persona)).includes(skill));

      // "inherit" follows global again
      await setPersonaSkillOverride(db, persona, skill, "inherit");
      assert.equal(await isSkillEnabled(db, skill, persona), true);
      assert.equal(
        (await getPersonaSkillOverrides(db, persona))[skill],
        undefined,
      );
    });
  });
});
