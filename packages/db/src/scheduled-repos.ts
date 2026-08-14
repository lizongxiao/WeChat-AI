import type { RedisStore } from "./client.js";
import { newId, nowIso } from "./client.js";
import { K } from "./keys.js";

export interface SystemSubscriptionService {
  id: string; name: string; description: string; prompt_template: string;
  params_schema: Record<string, unknown>; schedule: string; timezone: string;
  web_search_enabled: number; enabled: number; created_at: string; updated_at: string;
}
export interface UserSubscription {
  id: string; user_id: string; bot_id: string; peer_id: string; persona_id: string;
  service_id: string; params: Record<string, unknown>; enabled: number;
  created_at: string; updated_at: string; last_run_at?: string | null; next_run_at?: string | null;
  last_status?: string | null; last_error?: string | null;
}
export interface ScheduledTask {
  id: string; user_id: string; bot_id: string; peer_id: string; persona_id: string;
  name: string; prompt: string; schedule: string; timezone: string; web_search_enabled: number;
  /** cron tasks repeat; one_time tasks are removed from the runnable set after execute_at. */
  schedule_type?: "cron" | "one_time"; execute_at?: string | null;
  enabled: number; created_via: "chat"; created_at: string; updated_at: string;
  last_run_at?: string | null; next_run_at?: string | null; last_status?: string | null; last_error?: string | null;
}
export type PendingScheduledPlan = {
  kind: "task" | "subscription" | "task_update" | "task_cancel" | "subscription_cancel";
  user_id: string; bot_id: string; peer_id: string; persona_id: string; payload: Record<string, unknown>; created_at: string;
};

/** Deliberately small JSON-schema subset for service parameters. Keeping this
 * server-side prevents a chat client from subscribing without required input. */
export function validateSubscriptionParams(schema: Record<string, unknown>, params: Record<string, unknown>): string[] {
  const required = Array.isArray(schema.required) ? schema.required.filter((x): x is string => typeof x === "string") : [];
  const properties = (schema.properties && typeof schema.properties === "object") ? schema.properties as Record<string, Record<string, unknown>> : {};
  const errors: string[] = [];
  for (const key of required) if (params[key] === undefined || params[key] === null || params[key] === "") errors.push(`missing:${key}`);
  for (const [key, value] of Object.entries(params)) { const rule=properties[key]; if (!rule) continue; if (rule.type === "string" && typeof value !== "string") errors.push(`type:${key}`); if (rule.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) errors.push(`type:${key}`); if (Array.isArray(rule.enum) && !rule.enum.includes(value)) errors.push(`enum:${key}`); if (typeof rule.minLength === "number" && typeof value === "string" && value.length < rule.minLength) errors.push(`minLength:${key}`); }
  return errors;
}

const json = <T>(v: T) => JSON.stringify(v);
export async function listSystemSubscriptionServices(db: RedisStore, includeDisabled = false) {
  const ids = await db.redis.smembers(K.scheduledServices); if (!ids.length) return [] as SystemSubscriptionService[];
  const rows = await db.mgetJson<SystemSubscriptionService>(ids.map(K.scheduledService));
  return rows.filter((x): x is SystemSubscriptionService => Boolean(x)).filter(x => includeDisabled || Boolean(x.enabled));
}
export async function getSystemSubscriptionService(db: RedisStore, id: string) { return db.getJson<SystemSubscriptionService>(K.scheduledService(id)); }
export async function saveSystemSubscriptionService(db: RedisStore, input: Omit<SystemSubscriptionService, "id"|"created_at"|"updated_at"> & { id?: string }) {
  const old = input.id ? await getSystemSubscriptionService(db, input.id) : null;
  const row: SystemSubscriptionService = { ...old, ...input, id: input.id || newId("schedsvc"), created_at: old?.created_at || nowIso(), updated_at: nowIso() } as SystemSubscriptionService;
  await db.redis.multi().set(K.scheduledService(row.id), json(row)).sadd(K.scheduledServices, row.id).exec(); return row;
}
export async function deleteSystemSubscriptionService(db: RedisStore, id: string) { await db.redis.multi().del(K.scheduledService(id), K.scheduledServicePersonas(id)).srem(K.scheduledServices, id).exec(); }
export async function setServicePersonas(db: RedisStore, serviceId: string, personaIds: string[]) { const p = db.redis.multi().del(K.scheduledServicePersonas(serviceId)); if (personaIds.length) p.sadd(K.scheduledServicePersonas(serviceId), ...[...new Set(personaIds)]); await p.exec(); }
export async function listServicePersonaIds(db: RedisStore, serviceId: string) { return db.redis.smembers(K.scheduledServicePersonas(serviceId)); }
export async function isServiceOpenToPersona(db: RedisStore, serviceId: string, personaId: string) { return Boolean(await db.redis.sismember(K.scheduledServicePersonas(serviceId), personaId)); }
/** Reverse editor convenience: Persona stores only IDs by membership in service
 * sets; no service prompt is copied onto Persona. */
export async function setPersonaServiceIds(db: RedisStore, personaId:string, serviceIds:string[]) { const wanted=new Set(serviceIds); const services=await listSystemSubscriptionServices(db,true); const pipe=db.redis.multi(); for(const service of services){if(wanted.has(service.id))pipe.sadd(K.scheduledServicePersonas(service.id),personaId);else pipe.srem(K.scheduledServicePersonas(service.id),personaId);} await pipe.exec(); }
export async function listPersonaServiceIds(db: RedisStore, personaId:string) { const services=await listSystemSubscriptionServices(db,true); const memberships=await Promise.all(services.map(s=>isServiceOpenToPersona(db,s.id,personaId))); return services.filter((_,i)=>memberships[i]).map(s=>s.id); }

export async function createUserSubscription(db: RedisStore, input: Omit<UserSubscription,"id"|"created_at"|"updated_at">) {
  const row: UserSubscription = { ...input, id: newId("schedsub"), created_at: nowIso(), updated_at: nowIso(), last_run_at: null, next_run_at: null, last_status: null, last_error: null };
  await db.redis.multi().set(K.scheduledSubscription(row.id), json(row)).sadd(K.scheduledSubscriptions,row.id).sadd(K.scheduledSubscriptionsByUser(row.user_id),row.id).sadd(K.scheduledSubscriptionsByPeer(row.bot_id,row.peer_id),row.id).exec(); return row;
}
export async function listUserSubscriptions(db: RedisStore, userId?: string) { const ids = await db.redis.smembers(userId ? K.scheduledSubscriptionsByUser(userId) : K.scheduledSubscriptions); const rows = await db.mgetJson<UserSubscription>(ids.map(K.scheduledSubscription)); return rows.filter((x): x is UserSubscription => Boolean(x)); }
export async function listPeerSubscriptions(db: RedisStore, botId:string, peerId:string) { const ids=await db.redis.smembers(K.scheduledSubscriptionsByPeer(botId,peerId)); const rows=await db.mgetJson<UserSubscription>(ids.map(K.scheduledSubscription)); return rows.filter((x):x is UserSubscription=>Boolean(x)); }
export async function getUserSubscription(db: RedisStore, id: string) { return db.getJson<UserSubscription>(K.scheduledSubscription(id)); }
export async function updateUserSubscription(db: RedisStore, id: string, patch: Partial<UserSubscription>) { const old = await getUserSubscription(db,id); if (!old) throw new Error("subscription_not_found"); const row={...old,...patch,id,updated_at:nowIso()}; await db.setJson(K.scheduledSubscription(id),row); return row; }
export async function deleteUserSubscription(db: RedisStore, id: string) { const r=await getUserSubscription(db,id); if (!r) return; await db.redis.multi().del(K.scheduledSubscription(id)).srem(K.scheduledSubscriptions,id).srem(K.scheduledSubscriptionsByUser(r.user_id),id).srem(K.scheduledSubscriptionsByPeer(r.bot_id,r.peer_id),id).exec(); }

export async function createScheduledTask(db: RedisStore, input: Omit<ScheduledTask,"id"|"created_at"|"updated_at"|"created_via">) { const row:ScheduledTask={...input,schedule_type:input.schedule_type||"cron",execute_at:input.execute_at||null,id:newId("schedtask"),created_via:"chat",created_at:nowIso(),updated_at:nowIso(),last_run_at:null,next_run_at:null,last_status:null,last_error:null}; await db.redis.multi().set(K.scheduledTask(row.id),json(row)).sadd(K.scheduledTasks,row.id).sadd(K.scheduledTasksByUser(row.user_id),row.id).sadd(K.scheduledTasksByPeer(row.bot_id,row.peer_id),row.id).exec(); return row; }
export async function listScheduledTasks(db: RedisStore,userId?:string) { const ids=await db.redis.smembers(userId?K.scheduledTasksByUser(userId):K.scheduledTasks); const rows=await db.mgetJson<ScheduledTask>(ids.map(K.scheduledTask)); return rows.filter((x):x is ScheduledTask=>Boolean(x)); }
export async function listPeerScheduledTasks(db: RedisStore,botId:string,peerId:string) { const ids=await db.redis.smembers(K.scheduledTasksByPeer(botId,peerId)); const rows=await db.mgetJson<ScheduledTask>(ids.map(K.scheduledTask)); return rows.filter((x):x is ScheduledTask=>Boolean(x)); }
export async function getScheduledTask(db: RedisStore,id:string){return db.getJson<ScheduledTask>(K.scheduledTask(id));}
export async function updateScheduledTask(db: RedisStore,id:string,patch:Partial<ScheduledTask>){const old=await getScheduledTask(db,id);if(!old)throw new Error("task_not_found");const row={...old,...patch,id,updated_at:nowIso()};await db.setJson(K.scheduledTask(id),row);return row;}
export async function deleteScheduledTask(db: RedisStore,id:string){const r=await getScheduledTask(db,id);if(!r)return;await db.redis.multi().del(K.scheduledTask(id)).srem(K.scheduledTasks,id).srem(K.scheduledTasksByUser(r.user_id),id).srem(K.scheduledTasksByPeer(r.bot_id,r.peer_id),id).exec();}
export async function savePendingScheduledPlan(db: RedisStore, plan: PendingScheduledPlan, ttlSec=600) { await db.redis.set(K.scheduledPending(plan.bot_id,plan.peer_id),json(plan),"EX",ttlSec); }
export async function getPendingScheduledPlan(db: RedisStore,botId:string,peerId:string){return db.getJson<PendingScheduledPlan>(K.scheduledPending(botId,peerId));}
export async function clearPendingScheduledPlan(db: RedisStore,botId:string,peerId:string){await db.redis.del(K.scheduledPending(botId,peerId));}
export async function tryAcquireScheduledExecutionLock(db: RedisStore, source:string,id:string, minute:string,ttlSec=120){return (await db.redis.set(K.scheduledExecutionLock(source,id,minute),"1","EX",ttlSec,"NX")) === "OK";}

export const SCHEDULED_OUTBOX_TTL_SEC = 36 * 3600;

export interface ScheduledOutboxItem {
  botId: string;
  peerId: string;
  source: "task" | "subscription";
  id: string;
  texts: string[];
  createdAt: string;
}

export async function saveScheduledOutbox(
  db: RedisStore,
  item: Omit<ScheduledOutboxItem, "createdAt"> & { createdAt?: string },
  ttlSec = SCHEDULED_OUTBOX_TTL_SEC,
): Promise<ScheduledOutboxItem> {
  const row: ScheduledOutboxItem = {
    ...item,
    texts: item.texts.map((t) => t.trim()).filter(Boolean),
    createdAt: item.createdAt || new Date().toISOString(),
  };
  if (!row.texts.length) return row;
  await db.redis.set(
    K.scheduledOutbox(row.botId, row.peerId),
    json(row),
    "EX",
    Math.max(60, ttlSec),
  );
  return row;
}

export async function takeScheduledOutbox(
  db: RedisStore,
  botId: string,
  peerId: string,
): Promise<ScheduledOutboxItem | null> {
  const key = K.scheduledOutbox(botId, peerId);
  const raw = await db.redis.get(key);
  if (!raw) return null;
  await db.redis.del(key);
  try {
    const parsed = JSON.parse(raw) as ScheduledOutboxItem;
    if (!parsed || !Array.isArray(parsed.texts) || !parsed.texts.length) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
