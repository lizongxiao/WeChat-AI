/**
 * Skill enable/disable storage.
 *
 * Effective state has three levels, in precedence order:
 *   1. persona explicit override — "on" / "off" (per-persona enabled/disabled sets)
 *   2. global disabled set
 *   3. default: enabled
 *
 * Skill catalogs themselves live in code (apps/api registers them); Redis
 * only records the toggles.
 */
import type { RedisStore } from "./client.js";
import { K } from "./keys.js";

export type PersonaSkillOverride = "on" | "off" | "inherit";

/** Set of skill ids disabled globally (SMEMBERS). */
export async function getGlobalDisabledSkills(
  db: RedisStore,
): Promise<string[]> {
  return db.redis.smembers(K.skillsDisabledGlobal);
}

/** Global toggle. enabled=false adds to the disabled set, true removes. */
export async function setGlobalSkillEnabled(
  db: RedisStore,
  skillId: string,
  enabled: boolean,
): Promise<void> {
  if (enabled) await db.redis.srem(K.skillsDisabledGlobal, skillId);
  else await db.redis.sadd(K.skillsDisabledGlobal, skillId);
}

/** Set of skill ids disabled for one persona (explicit "off"). */
export async function getPersonaDisabledSkills(
  db: RedisStore,
  personaId: string,
): Promise<string[]> {
  return db.redis.smembers(K.skillsDisabledPersona(personaId));
}

/**
 * Per-persona three-state override:
 *  - "on"      → force enabled regardless of global
 *  - "off"     → force disabled regardless of global
 *  - "inherit" → follow the global toggle (default)
 */
export async function setPersonaSkillOverride(
  db: RedisStore,
  personaId: string,
  skillId: string,
  mode: PersonaSkillOverride,
): Promise<void> {
  const onKey = K.skillsEnabledPersona(personaId);
  const offKey = K.skillsDisabledPersona(personaId);
  if (mode === "on") {
    await db.redis.sadd(onKey, skillId);
    await db.redis.srem(offKey, skillId);
  } else if (mode === "off") {
    await db.redis.srem(onKey, skillId);
    await db.redis.sadd(offKey, skillId);
  } else {
    await db.redis.srem(onKey, skillId);
    await db.redis.srem(offKey, skillId);
  }
}

/** All per-persona overrides as a map (for admin UI). */
export async function getPersonaSkillOverrides(
  db: RedisStore,
  personaId: string,
): Promise<Record<string, PersonaSkillOverride>> {
  const [onList, offList] = await Promise.all([
    db.redis.smembers(K.skillsEnabledPersona(personaId)),
    db.redis.smembers(K.skillsDisabledPersona(personaId)),
  ]);
  const out: Record<string, PersonaSkillOverride> = {};
  for (const id of onList) out[id] = "on";
  for (const id of offList) out[id] = "off";
  return out;
}

/**
 * Effective skill state for a peer's current persona (or global-only when
 * personaId is null/undefined). Persona override wins; then global; default
 * enabled.
 */
export async function isSkillEnabled(
  db: RedisStore,
  skillId: string,
  personaId: string | null | undefined,
): Promise<boolean> {
  if (personaId) {
    const [forcedOn, forcedOff] = await Promise.all([
      db.redis.sismember(K.skillsEnabledPersona(personaId), skillId),
      db.redis.sismember(K.skillsDisabledPersona(personaId), skillId),
    ]);
    if (forcedOn) return true;
    if (forcedOff) return false;
  }
  const globalDisabled = await db.redis.sismember(
    K.skillsDisabledGlobal,
    skillId,
  );
  return !globalDisabled;
}
