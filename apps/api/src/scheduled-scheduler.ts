import { randomUUID } from "node:crypto";
import {
  ensurePeer,
  getPersona,
  getContextTokenInfo,
  getSystemSubscriptionService,
  isServiceOpenToPersona,
  isUserSubscriptionActiveForCurrentPersona,
  listScheduledTasks,
  listUserSubscriptions,
  markPeerKeepAlive,
  releaseKeepAliveLock,
  saveScheduledOutbox,
  tryAcquireKeepAliveLock,
  tryAcquireScheduledExecutionLock,
  updateScheduledTask,
  updateUserSubscription,
  resolvePersonaForPeer,
  type Db,
  type ScheduledTask,
  type UserSubscription,
} from "@wechat-ai/db";
import {
  DEFAULT_KEEP_ALIVE_POLICY,
  hoursSince,
  isKeepAliveEligible,
  isStaleKeepAliveError,
  shouldPiggybackKeepAlive,
  type ChatService,
  type InboundChatResult,
  type KeepAlivePolicy,
} from "@wechat-ai/core";

export type ScheduledSendResult = {
  ok: boolean;
  reason?: string;
  error?: string;
};

export interface KeepAliveSchedulerConfig extends KeepAlivePolicy {
  maxPerScan: number;
  lockTtlSec: number;
}

export interface ScheduledSchedulerOptions {
  db: Db;
  chat: ChatService;
  intervalSec: number;
  lockTtlSec: number;
  log?: (m: string, e?: unknown) => void;
  sendReply: (
    botId: string,
    peerId: string,
    reply: InboundChatResult,
  ) => Promise<ScheduledSendResult>;
  /** Serialize delivery with ordinary replies for this peer. Generation stays
   * outside the chain so a slow LLM never delays processing a new inbound. */
  runDeliveryOnPeerChain?: <T>(
    botId: string,
    peerId: string,
    fn: () => Promise<T>,
  ) => Promise<T>;
  sendKeepAlive?: (
    botId: string,
    peerId: string,
    text: string,
  ) => Promise<ScheduledSendResult>;
  /** Probe the peer's session token (getconfig round-trip) before a manual
   * test spends an LLM generation on an unreachable session. */
  probeSession?: (
    botId: string,
    peerId: string,
  ) => Promise<{ ok: boolean; detail?: string }>;
  keepAlive?: KeepAliveSchedulerConfig;
  /** Catch-up window after a scheduled instant (ms). Default 10 minutes. */
  missedGraceMs?: number;
  /** Concurrent due-item execution cap (per-peer serialized, cross-peer parallel). */
  runConcurrency?: number;
}
export interface ScheduledTestProgress {
  level: "info" | "warn" | "error";
  stage: string;
  message: string;
  peerId?: string;
}
export type ScheduledTestProgressHandler = (event: ScheduledTestProgress) => void;
type Clock = { minute:number; hour:number; day:number; month:number; week:number };
function values(field:string, value:number, min:number,max:number) { return field.split(",").some(part => { const [base, stepRaw] = part.split("/"); const step=stepRaw?Number(stepRaw):1; if (!Number.isInteger(step)||step<1) return false; const ok = base==="*" ? true : base.includes("-") ? (()=>{const [a,b]=base.split("-").map(Number);return value>=a&&value<=b;})() : Number(base)===value; return ok && ((value-min)%step===0); }); }
/** Strict five-field cron, intentionally no natural-language execution parser. */
export function cronMatches(schedule:string, date:Date, timezone:string) { const fields=schedule.trim().split(/\s+/); if(fields.length!==5) return false; try { const parts=new Intl.DateTimeFormat("en-US",{timeZone:timezone,hour12:false,minute:"2-digit",hour:"2-digit",day:"2-digit",month:"2-digit",weekday:"short"}).formatToParts(date); const get=(t:string)=>Number(parts.find(x=>x.type===t)?.value); const weekMap:Record<string,number>={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6}; const c:Clock={minute:get("minute"),hour:get("hour"),day:get("day"),month:get("month"),week:weekMap[parts.find(x=>x.type==="weekday")?.value||""]!}; return values(fields[0]!,c.minute,0,59)&&values(fields[1]!,c.hour,0,23)&&values(fields[2]!,c.day,1,31)&&values(fields[3]!,c.month,1,12)&&values(fields[4]!,c.week,0,6); } catch { return false; } }
/** First matching UTC instant after `from`; bounded to one leap year. */
export function nextCronRun(schedule:string, timezone:string, from=new Date()) { let d=new Date(Math.floor(from.getTime()/60_000)*60_000+60_000); for(let i=0;i<527_040;i++,d=new Date(d.getTime()+60_000))if(cronMatches(schedule,d,timezone))return d.toISOString(); return null; }
/** Admin previews use the next logical schedule time, not the button-click time. */
export function scheduledPreviewTime(schedule:string, timezone:string, now=new Date()) { return nextCronRun(schedule,timezone,new Date(now.getTime()-60_000)) ?? now.toISOString(); }
function minuteKey(d:Date){return d.toISOString().slice(0,16);}
/** Manual smoke tests must not share the production schedule's dedupe key. */
export function scheduledTestLockSource(source:"task"|"subscription",runId?:string){return `${source}:test${runId?`:${runId}`:""}`;}

/**
 * Due decision is based on next_run_at expiry instead of "does the current
 * minute happen to match the cron". A slow LLM generation, a restart, or a
 * busy tick used to skip the configured minute entirely and the item would
 * silently wait for the next period. Now:
 *  - next_run_at expired within grace → execute now (catch-up)
 *  - expired beyond grace → skip this period and advance (mark missed)
 *  - one_time items retry after failures inside their grace window
 */
export interface ScheduledDueInput {
  enabled: boolean;
  scheduleType: "cron" | "one_time";
  schedule: string;
  timezone: string;
  executeAt?: string | null;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  lastStatus?: string | null;
  now: Date;
  /** Catch-up window after next_run_at / execute_at (ms). */
  graceMs: number;
  /** one_time retry backoff after a failed attempt (ms). */
  retryBackoffMs: number;
}

export type ScheduledDueSkipReason =
  | "disabled"
  | "future"
  | "missed_window"
  | "backoff"
  | "no_execute_at"
  | "initialized";

export interface ScheduledDueDecision {
  due: boolean;
  /** cron: next_run_at to persist (initialize / advance / advance-over-missed). */
  setNextRunAt?: string | null;
  /** one_time: grace expired without success → disable the task. */
  disable?: boolean;
  skipReason?: ScheduledDueSkipReason;
}

export const DEFAULT_MISSED_GRACE_MS = 10 * 60_000;
export const DEFAULT_ONE_TIME_RETRY_BACKOFF_MS = 60_000;

export function decideScheduledDue(input: ScheduledDueInput): ScheduledDueDecision {
  if (!input.enabled) return { due: false, skipReason: "disabled" };
  const nowMs = input.now.getTime();

  if (input.scheduleType === "one_time") {
    const executeMs = input.executeAt ? Date.parse(input.executeAt) : NaN;
    if (!Number.isFinite(executeMs)) {
      return { due: false, skipReason: "no_execute_at" };
    }
    if (executeMs > nowMs) return { due: false, skipReason: "future" };
    if (input.lastStatus === "sent") return { due: false };
    const lastRunMs = input.lastRunAt ? Date.parse(input.lastRunAt) : NaN;
    if (
      Number.isFinite(lastRunMs) &&
      nowMs - lastRunMs < input.retryBackoffMs
    ) {
      return { due: false, skipReason: "backoff" };
    }
    if (nowMs - executeMs > input.graceMs) {
      return { due: false, disable: true, skipReason: "missed_window" };
    }
    return { due: true };
  }

  // cron: expiry-driven scheduling on next_run_at
  const nextMs = input.nextRunAt ? Date.parse(input.nextRunAt) : NaN;
  if (!Number.isFinite(nextMs)) {
    return {
      due: false,
      setNextRunAt: nextCronRun(input.schedule, input.timezone, input.now),
      skipReason: "initialized",
    };
  }
  if (nextMs > nowMs) return { due: false, skipReason: "future" };
  const advanced = nextCronRun(input.schedule, input.timezone, input.now);
  if (nowMs - nextMs > input.graceMs) {
    return { due: false, setNextRunAt: advanced, skipReason: "missed_window" };
  }
  return { due: true, setNextRunAt: advanced };
}

/** Built-in fallbacks when subscription params are blank (common in smoke tests). */
export const SCHEDULED_PARAM_DEFAULTS: Record<string, string> = {
  location: "深圳",
  city: "深圳",
  place: "深圳",
  地区: "深圳",
  城市: "深圳",
};

function schemaParamDefault(
  schema: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const properties = schema?.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return undefined;
  }
  const rule = (properties as Record<string, Record<string, unknown>>)[key];
  if (!rule) return undefined;
  if (typeof rule.default === "string" && rule.default.trim()) {
    return rule.default.trim();
  }
  if (typeof rule.default === "number" && Number.isFinite(rule.default)) {
    return String(rule.default);
  }
  return undefined;
}

/**
 * Fill empty subscription params from schema defaults, then built-in defaults.
 * Keeps smoke tests and partial subscriptions from failing on blank {{location}}.
 */
export function resolveScheduledParams(
  params: Record<string, unknown> = {},
  schema?: Record<string, unknown>,
): { params: Record<string, unknown>; defaultsApplied: string[] } {
  const out: Record<string, unknown> = { ...params };
  const defaultsApplied: string[] = [];
  const required = Array.isArray(schema?.required)
    ? schema.required.filter((x): x is string => typeof x === "string")
    : [];
  const propertyKeys =
    schema?.properties &&
    typeof schema.properties === "object" &&
    !Array.isArray(schema.properties)
      ? Object.keys(schema.properties as object)
      : [];
  const keys = new Set<string>([
    ...Object.keys(out),
    ...required,
    ...propertyKeys,
  ]);
  for (const key of keys) {
    const cur = out[key];
    const empty =
      cur === undefined ||
      cur === null ||
      (typeof cur === "string" && !cur.trim());
    if (!empty) {
      if (typeof cur === "string") out[key] = cur.trim();
      continue;
    }
    const fromSchema = schemaParamDefault(schema, key);
    if (fromSchema !== undefined) {
      out[key] = fromSchema;
      defaultsApplied.push(key);
      continue;
    }
    const builtin = SCHEDULED_PARAM_DEFAULTS[key];
    if (builtin) {
      out[key] = builtin;
      defaultsApplied.push(key);
    }
  }
  return { params: out, defaultsApplied };
}

function interpolate(template:string, params:Record<string,unknown>) {
  return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, k: string) => {
    const value = params[k];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return SCHEDULED_PARAM_DEFAULTS[k] ?? "";
  });
}
function locationHintFromParams(params:Record<string,unknown>= {}) {
  for (const key of ["location", "city", "place", "地区", "城市"]) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return SCHEDULED_PARAM_DEFAULTS.location;
}

export class ScheduledScheduler {
  private stopped=true; private timer:ReturnType<typeof setTimeout>|null=null; private running=false;
  constructor(private opts:ScheduledSchedulerOptions) {}
  start(){if(!this.stopped)return;this.stopped=false;this.arm(1500);}
  stop(){this.stopped=true;if(this.timer)clearTimeout(this.timer);this.timer=null;}
  /** Super-admin smoke test: only sends to peers that actually subscribed to
   * this service under one of its allowed Personas; it never becomes a broad
   * Persona broadcast. */
  async testService(serviceId:string, personaId?:string, onProgress?:ScheduledTestProgressHandler, runId:string=randomUUID()) {
    const service=await getSystemSubscriptionService(this.opts.db,serviceId);
    if(!service?.enabled) throw new Error("service_unavailable");
    onProgress?.({level:"info",stage:"prepare",message:`已加载服务「${service.name}」，计划 ${service.schedule}（${service.timezone}）`});
    const candidates=(await listUserSubscriptions(this.opts.db)).filter(s=>s.enabled&&s.service_id===serviceId&&(!personaId||s.persona_id===personaId));
    const subs=[] as typeof candidates;
    for(const sub of candidates){
      if(await isUserSubscriptionActiveForCurrentPersona(this.opts.db,sub)){subs.push(sub);continue;}
      // Surface the exact data decision in the smoke-test transcript. This is
      // intentionally a skip: a subscription belongs to the Persona selected
      // when it was created and must not leak into a later Persona switch.
      const [subPersona,currentPersona]=await Promise.all([
        getPersona(this.opts.db,sub.persona_id),
        resolvePersonaForPeer(this.opts.db,sub.bot_id,sub.peer_id),
      ]);
      onProgress?.({
        level:"warn",stage:"subscriber",peerId:sub.peer_id,
        message:`订阅 Persona「${subPersona?.display_name??sub.persona_id}」与当前 Persona「${currentPersona?.display_name??currentPersona?.id??"未配置"}」不一致，未参与本次测试`,
      });
    }
    onProgress?.({level:"info",stage:"prepare",message:`找到 ${candidates.length} 个启用订阅，其中 ${subs.length} 个当前 Persona 匹配`});
    let sent=0, skipped=0; const details:Array<{peerId:string;reason:string}>=[]; const now=new Date();
    for(const sub of subs){
      onProgress?.({level:"info",stage:"subscriber",message:"开始处理订阅用户",peerId:sub.peer_id});
      if(!(await isServiceOpenToPersona(this.opts.db,serviceId,sub.persona_id))){skipped++;details.push({peerId:sub.peer_id,reason:"persona_not_open"});onProgress?.({level:"warn",stage:"subscriber",message:"Persona 未开放此服务，已跳过",peerId:sub.peer_id});continue;}
      // Probe the session before spending an LLM generation: a stale token
      // fails at delivery anyway, so fail fast with an actionable message.
      if(this.opts.probeSession){
        const tokenInfo=await getContextTokenInfo(this.opts.db,sub.bot_id,sub.peer_id);
        const inboundHours=hoursSince(tokenInfo?.inboundAt ?? null, now);
        const probe=await this.opts.probeSession(sub.bot_id,sub.peer_id);
        if(!probe.ok){
          skipped++;
          const detail=probe.detail||"session_expired";
          const reason=detail==="no_context_token"?"no_context_token":`session_probe_failed:${detail}`;
          details.push({peerId:sub.peer_id,reason});
          const idle=inboundHours!=null?`（最后入站约 ${Math.round(inboundHours*10)/10} 小时前）`:"（无入站记录）";
          onProgress?.({
            level:"warn",
            stage:"subscriber",
            message:`发送前会话探测失败${idle}：${detail}。请让该用户先给机器人发一条消息，再重新测试。`,
            peerId:sub.peer_id,
          });
          continue;
        }
      }
      const resolved=resolveScheduledParams(sub.params,service.params_schema);
      if(resolved.defaultsApplied.length){
        onProgress?.({
          level:"warn",
          stage:"prepare",
          message:`参数缺失，已用默认值：${resolved.defaultsApplied
            .map((key)=>`${key}=${String(resolved.params[key])}`)
            .join("，")}`,
          peerId:sub.peer_id,
        });
      }
      const prompt=interpolate(service.prompt_template,resolved.params);
      // Smoke tests use wall-clock now so greetings/date match the click time.
      // Production cron runs already fire at the schedule instant, so tick keeps now.
      const executionTime=now;
      onProgress?.({
        level:"info",
        stage:"prepare",
        message:`测试按当前时刻执行（${executionTime.toLocaleString("zh-CN",{timeZone:service.timezone,hour12:false})}，${service.timezone}），正式调度仍按 ${service.schedule}`,
        peerId:sub.peer_id,
      });
      const result=await this.run("subscription",sub.id,sub.bot_id,sub.peer_id,sub.persona_id,prompt,Boolean(service.web_search_enabled),now,scheduledTestLockSource("subscription",runId),executionTime,service.timezone,event=>onProgress?.({...event,peerId:sub.peer_id}),locationHintFromParams(resolved.params));
      if(result.sent){sent++;onProgress?.({level:"info",stage:"complete",message:"发送成功",peerId:sub.peer_id});}
      else if(result.reason?.startsWith("queued_until_inbound")){skipped++;details.push({peerId:sub.peer_id,reason:result.reason});const real=result.reason.slice("queued_until_inbound:".length)||"未知原因";onProgress?.({level:"warn",stage:"complete",message:`会话令牌可能失效（${real}），已排队等用户开口补发`,peerId:sub.peer_id});}
      else {skipped++;details.push({peerId:sub.peer_id,reason:result.reason||"unknown"});onProgress?.({level:"error",stage:"complete",message:`发送失败：${result.reason||"unknown"}`,peerId:sub.peer_id});}
    }
    onProgress?.({level:skipped?"warn":"info",stage:"summary",message:`测试结束：发送 ${sent}，跳过 ${skipped}`});
    return {sent,skipped,matched:subs.length,details};
  }
  applyRuntimeOptions(patch: Partial<Pick<ScheduledSchedulerOptions, "keepAlive">>): void {
    if (patch.keepAlive) {
      this.opts.keepAlive = { ...this.keepAliveConfig(), ...patch.keepAlive };
    }
  }
  private keepAliveConfig(): KeepAliveSchedulerConfig {
    return {
      ...DEFAULT_KEEP_ALIVE_POLICY,
      maxPerScan: 10,
      lockTtlSec: 180,
      ...this.opts.keepAlive,
    };
  }
  private keepAlivePolicy(): KeepAlivePolicy {
    const k = this.keepAliveConfig();
    return {
      enabled: k.enabled,
      afterHours: k.afterHours,
      maxHours: k.maxHours,
      minIntervalHours: k.minIntervalHours,
      quietHours: k.quietHours,
      quietTimeZone: k.quietTimeZone,
      dueSoonHours: k.dueSoonHours,
    };
  }
  private peerKey(botId: string, peerId: string): string {
    return `${botId}\0${peerId}`;
  }
  private arm(ms:number){if(this.stopped)return;this.timer=setTimeout(()=>void this.tick().catch(e=>this.opts.log?.(`[schedule] tick error ${e instanceof Error?e.message:String(e)}`)).finally(()=>this.armAligned()),ms);}
  /**
   * Re-arm on the fixed interval boundary (epoch-aligned) instead of
   * "last tick end + interval". Serial LLM generations used to push every
   * subsequent tick later and later, so ticks drifted across the configured
   * minute boundaries.
   */
  private armAligned(){
    if(this.stopped)return;
    const intervalMs=this.opts.intervalSec*1000;
    const nowMs=Date.now();
    const next=Math.ceil(nowMs/intervalMs)*intervalMs;
    const delay=Math.max(200,next-nowMs);
    this.timer=setTimeout(()=>void this.tick().catch(e=>this.opts.log?.(`[schedule] tick error ${e instanceof Error?e.message:String(e)}`)).finally(()=>this.armAligned()),delay);
  }
  async tick(now=new Date()){
    if(this.stopped||this.running)return {sent:0,skipped:0,missed:0};
    this.running=true;
    let sent=0,skipped=0,missed=0;
    const delivered=new Set<string>();
    const graceMs=this.opts.missedGraceMs ?? DEFAULT_MISSED_GRACE_MS;
    type DueRun = {
      key: string;
      run: () => Promise<{sent:true}|{sent:false;reason:string}>;
      after: (r:{sent:true}|{sent:false;reason:string}) => Promise<void>;
    };
    const dueRuns: DueRun[] = [];
    try {
      const [tasks,subs]=await Promise.all([listScheduledTasks(this.opts.db),listUserSubscriptions(this.opts.db)]);
      for(const task of tasks){
        const oneTime=task.schedule_type==="one_time";
        const decision=decideScheduledDue({
          enabled:Boolean(task.enabled),
          scheduleType:oneTime?"one_time":"cron",
          schedule:task.schedule,
          timezone:task.timezone,
          executeAt:task.execute_at,
          nextRunAt:task.next_run_at,
          lastRunAt:task.last_run_at,
          lastStatus:task.last_status,
          now,
          graceMs,
          retryBackoffMs:DEFAULT_ONE_TIME_RETRY_BACKOFF_MS,
        });
        if(decision.disable){
          await updateScheduledTask(this.opts.db,task.id,{enabled:0,last_status:"missed",last_error:"one_time_grace_expired"}).catch(()=>undefined);
          missed++;
          continue;
        }
        if(decision.setNextRunAt&&decision.setNextRunAt!==task.next_run_at){
          await updateScheduledTask(this.opts.db,task.id,{next_run_at:decision.setNextRunAt}).catch(()=>undefined);
        }
        if(decision.skipReason==="missed_window")missed++;
        if(!decision.due)continue;
        const key=this.peerKey(task.bot_id,task.peer_id);
        dueRuns.push({
          key,
          run:()=>this.run("task",task.id,task.bot_id,task.peer_id,task.persona_id,task.prompt,Boolean(task.web_search_enabled),now,"task",now,task.timezone),
          after:async(result)=>{
            if(result.sent){
              sent++;
              delivered.add(key);
              if(oneTime)await updateScheduledTask(this.opts.db,task.id,{enabled:0}).catch(()=>undefined);
            } else skipped++;
          },
        });
      }
      for(const sub of subs){
        if(!(await isUserSubscriptionActiveForCurrentPersona(this.opts.db,sub)))continue;
        const service=await getSystemSubscriptionService(this.opts.db,sub.service_id);
        if(!service?.enabled||!(await isServiceOpenToPersona(this.opts.db,service.id,sub.persona_id)))continue;
        const decision=decideScheduledDue({
          enabled:Boolean(sub.enabled),
          scheduleType:"cron",
          schedule:service.schedule,
          timezone:service.timezone,
          nextRunAt:sub.next_run_at,
          now,
          graceMs,
          retryBackoffMs:DEFAULT_ONE_TIME_RETRY_BACKOFF_MS,
        });
        if(decision.setNextRunAt&&decision.setNextRunAt!==sub.next_run_at){
          await updateUserSubscription(this.opts.db,sub.id,{next_run_at:decision.setNextRunAt}).catch(()=>undefined);
        }
        if(decision.skipReason==="missed_window")missed++;
        if(!decision.due)continue;
        const resolved=resolveScheduledParams(sub.params,service.params_schema);
        const prompt=interpolate(service.prompt_template,resolved.params);
        const key=this.peerKey(sub.bot_id,sub.peer_id);
        dueRuns.push({
          key,
          run:()=>this.run("subscription",sub.id,sub.bot_id,sub.peer_id,sub.persona_id,prompt,Boolean(service.web_search_enabled),now,"subscription",now,service.timezone,undefined,locationHintFromParams(resolved.params)),
          after:async(result)=>{
            if(result.sent){
              sent++;
              delivered.add(key);
            } else skipped++;
          },
        });
      }
      await this.executeDueRuns(dueRuns,this.opts.runConcurrency ?? 4);
      await this.scanKeepAlive(now, tasks, subs, delivered);
    } finally {this.running=false;}
    return {sent,skipped,missed};
  }

  /**
   * Execute due items with bounded concurrency: items of the same peer run
   * serially (message order + per-peer rate), different peers run in parallel
   * so one slow LLM generation no longer delays every other subscriber's
   * scheduled instant.
   */
  private async executeDueRuns(
    runs: Array<{
      key: string;
      run: () => Promise<{sent:true}|{sent:false;reason:string}>;
      after: (r:{sent:true}|{sent:false;reason:string}) => Promise<void>;
    }>,
    concurrency: number,
  ): Promise<void> {
    if(!runs.length)return;
    const byPeer=new Map<string, typeof runs>();
    for(const r of runs){
      const g=byPeer.get(r.key);
      if(g)g.push(r);
      else byPeer.set(r.key,[r]);
    }
    const groups=[...byPeer.values()];
    let idx=0;
    const worker=async()=>{
      while(idx<groups.length){
        const group=groups[idx++]!;
        for(const r of group){
          const result=await r.run();
          await r.after(result);
        }
      }
    };
    const workers=Math.min(Math.max(1,concurrency),groups.length);
    await Promise.all(Array.from({length:workers},worker));
  }
  private async run(source:"task"|"subscription",id:string,botId:string,peerId:string,personaId:string,prompt:string,web:boolean,now:Date,lockSource:string=source,executionTime:Date=now,timeZone="Asia/Shanghai",onProgress?:ScheduledTestProgressHandler,locationHint?:string):Promise<{sent:true}|{sent:false;reason:string}>{
    const key=minuteKey(now);
    onProgress?.({level:"info",stage:"lock",message:"正在获取执行锁"});
    if(!(await tryAcquireScheduledExecutionLock(this.opts.db,lockSource,id,key,this.opts.lockTtlSec))){
      onProgress?.({level:"warn",stage:"lock",message:"本分钟已有相同执行，去重锁拒绝"});
      return {sent:false,reason:"duplicate_execution_lock"};
    }
    let generated:InboundChatResult|null=null;
    try{
      onProgress?.({level:"info",stage:"context",message:"正在读取会话上下文"});
      const info=await getContextTokenInfo(this.opts.db,botId,peerId);
      const tok=info?.token;
      if(!tok)throw new Error("no_context_token");
      onProgress?.({level:"info",stage:"context",message:`已找到会话令牌（${tok.length} 字符）`});
      const askKeepAliveReply=shouldPiggybackKeepAlive(info.inboundAt,this.keepAlivePolicy(),now);
      const r=await this.opts.chat.handleScheduled({
        botAccountId:botId,peerId,contextToken:tok,personaId,prompt,webSearchEnabled:web,source,
        executionTime:executionTime.toISOString(),timeZone,locationHint,askKeepAliveReply,
        onProgress:event=>onProgress?.({level:"info",stage:event.stage,message:event.message}),
      });
      if(r.kind!=="reply"||!r.text)throw new Error(r.skipReason||r.kind);
      generated=r;
      onProgress?.({level:"info",stage:"delivery",message:"内容生成成功，正在发送到微信"});
      const deliver=()=>this.opts.sendReply(botId,peerId,r);
      const out=this.opts.runDeliveryOnPeerChain
        ?await this.opts.runDeliveryOnPeerChain(botId,peerId,deliver)
        :await deliver();
      if(!out.ok){
        const sendReason=out.error?`${out.reason}: ${out.error}`:(out.reason||"send_failed");
        throw new Error(sendReason);
      }
      const patch={last_run_at:now.toISOString(),last_status:"sent",last_error:null};
      source==="task"?await updateScheduledTask(this.opts.db,id,patch):await updateUserSubscription(this.opts.db,id,patch);
      if(askKeepAliveReply){
        await markPeerKeepAlive(this.opts.db,botId,peerId,{sent:true}).catch(()=>undefined);
      }
      return {sent:true};
    }catch(e){
      const reason=e instanceof Error?e.message:String(e);
      if(generated?.bubbles?.length && isStaleKeepAliveError(reason)){
        await saveScheduledOutbox(this.opts.db,{
          botId,peerId,source,id,texts:generated.bubbles,
        }).catch(()=>undefined);
        onProgress?.({level:"warn",stage:"error",message:`会话令牌可能失效（${reason.slice(0,160)}），已排队等用户开口补发`});
        const patch={last_run_at:now.toISOString(),last_status:"error",last_error:`queued_until_inbound: ${reason.slice(0,160)}`};
        source==="task"?await updateScheduledTask(this.opts.db,id,patch).catch(()=>undefined):await updateUserSubscription(this.opts.db,id,patch).catch(()=>undefined);
        this.opts.log?.(`[schedule] ${source}=${id} queued until inbound`,e);
        return {sent:false,reason:`queued_until_inbound: ${reason.slice(0,160)}`};
      }
      onProgress?.({level:"error",stage:"error",message:reason});
      const patch={last_run_at:now.toISOString(),last_status:"error",last_error:reason};
      source==="task"?await updateScheduledTask(this.opts.db,id,patch).catch(()=>undefined):await updateUserSubscription(this.opts.db,id,patch).catch(()=>undefined);
      this.opts.log?.(`[schedule] ${source}=${id} failed`,e);
      return {sent:false,reason};
    }
  }
  private soonerIso(a?: string | null, b?: string | null): string | null {
    const ta = a ? Date.parse(a) : NaN;
    const tb = b ? Date.parse(b) : NaN;
    if (Number.isFinite(ta) && Number.isFinite(tb)) return ta <= tb ? a! : b!;
    if (Number.isFinite(ta)) return a!;
    if (Number.isFinite(tb)) return b!;
    return null;
  }
  private async scanKeepAlive(
    now: Date,
    tasks: ScheduledTask[],
    subs: UserSubscription[],
    delivered: Set<string>,
  ): Promise<void> {
    const cfg = this.keepAliveConfig();
    const sendKeepAlive = this.opts.sendKeepAlive;
    if (!cfg.enabled || !sendKeepAlive) return;
    const policy = this.keepAlivePolicy();
    const candidates = new Map<string, { botId: string; peerId: string; nextScheduledAt: string | null }>();
    const bump = (botId: string, peerId: string, nextAt: string | null) => {
      const key = this.peerKey(botId, peerId);
      const existing = candidates.get(key);
      if (existing) {
        existing.nextScheduledAt = this.soonerIso(existing.nextScheduledAt, nextAt);
        return;
      }
      candidates.set(key, { botId, peerId, nextScheduledAt: nextAt });
    };
    for (const task of tasks) {
      if (!task.enabled) continue;
      const next =
        task.schedule_type === "one_time"
          ? task.execute_at ?? null
          : task.next_run_at || nextCronRun(task.schedule, task.timezone, now);
      bump(task.bot_id, task.peer_id, next);
    }
    for (const sub of subs) {
      if (!(await isUserSubscriptionActiveForCurrentPersona(this.opts.db, sub))) continue;
      const service = await getSystemSubscriptionService(this.opts.db, sub.service_id);
      if (!service?.enabled || !(await isServiceOpenToPersona(this.opts.db, service.id, sub.persona_id))) continue;
      const next = sub.next_run_at || nextCronRun(service.schedule, service.timezone, now);
      bump(sub.bot_id, sub.peer_id, next);
    }
    let processed = 0;
    for (const cand of candidates.values()) {
      if (processed >= cfg.maxPerScan) break;
      if (delivered.has(this.peerKey(cand.botId, cand.peerId))) continue;
      const info = await getContextTokenInfo(this.opts.db, cand.botId, cand.peerId);
      const peer = await ensurePeer(this.opts.db, cand.botId, cand.peerId);
      const elig = isKeepAliveEligible({
        hasToken: Boolean(info?.token),
        inboundAt: info?.inboundAt,
        lastKeepAliveAt: peer.last_keep_alive_at,
        lastKeepAliveError: peer.last_keep_alive_error,
        nextScheduledAt: cand.nextScheduledAt,
        now,
        policy,
      });
      if (!elig.ok) continue;
      const locked = await tryAcquireKeepAliveLock(
        this.opts.db,
        cand.botId,
        cand.peerId,
        cfg.lockTtlSec,
      );
      if (!locked) continue;
      processed++;
      try {
        const tok = info!.token;
        const result = await this.opts.chat.handleKeepAlive({
          botAccountId: cand.botId,
          peerId: cand.peerId,
          contextToken: tok,
          inboundHours: elig.inboundHours,
        });
        if (result.kind !== "reply" || !result.text) {
          this.opts.log?.(
            `[keepalive] skip bot=${cand.botId} peer=${cand.peerId} reason=${result.skipReason ?? result.kind}`,
          );
          continue;
        }
        const out = await sendKeepAlive(cand.botId, cand.peerId, result.text);
        if (out.ok) {
          await markPeerKeepAlive(this.opts.db, cand.botId, cand.peerId, { sent: true });
          this.opts.log?.(`[keepalive] sent bot=${cand.botId} peer=${cand.peerId}`);
          continue;
        }
        const sendReason = out.error ? `${out.reason}: ${out.error}` : (out.reason || "send_failed");
        await markPeerKeepAlive(this.opts.db, cand.botId, cand.peerId, {
          sent: false,
          error: isStaleKeepAliveError(sendReason) ? sendReason : null,
        });
        this.opts.log?.(
          `[keepalive] send failed bot=${cand.botId} peer=${cand.peerId}: ${sendReason}`,
        );
      } catch (err) {
        this.opts.log?.(
          `[keepalive] error bot=${cand.botId} peer=${cand.peerId}`,
          err,
        );
      } finally {
        await releaseKeepAliveLock(this.opts.db, cand.botId, cand.peerId).catch(() => undefined);
      }
    }
  }
}
