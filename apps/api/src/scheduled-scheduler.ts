import { randomUUID } from "node:crypto";
import { getContextToken, getSystemSubscriptionService, getScheduledTask, getUserSubscription, isServiceOpenToPersona, isUserSubscriptionActiveForCurrentPersona, listScheduledTasks, listUserSubscriptions, tryAcquireScheduledExecutionLock, updateScheduledTask, updateUserSubscription, type Db } from "@wechat-ai/db";
import type { ChatService, InboundChatResult } from "@wechat-ai/core";

export interface ScheduledSchedulerOptions { db: Db; chat: ChatService; intervalSec: number; lockTtlSec: number; log?: (m:string,e?:unknown)=>void; sendReply:(botId:string,peerId:string,reply:InboundChatResult)=>Promise<{ok:boolean;reason?:string}>; }
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
function interpolate(template:string, params:Record<string,unknown>) { return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g,(_,k)=>typeof params[k]==="string"||typeof params[k]==="number"?String(params[k]):""); }

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
    const subs=[] as typeof candidates; for(const sub of candidates)if(await isUserSubscriptionActiveForCurrentPersona(this.opts.db,sub))subs.push(sub);
    onProgress?.({level:"info",stage:"prepare",message:`找到 ${candidates.length} 个启用订阅，其中 ${subs.length} 个当前 Persona 匹配`});
    let sent=0, skipped=0; const details:Array<{peerId:string;reason:string}>=[]; const now=new Date();
    for(const sub of subs){
      onProgress?.({level:"info",stage:"subscriber",message:"开始处理订阅用户",peerId:sub.peer_id});
      if(!(await isServiceOpenToPersona(this.opts.db,serviceId,sub.persona_id))){skipped++;details.push({peerId:sub.peer_id,reason:"persona_not_open"});onProgress?.({level:"warn",stage:"subscriber",message:"Persona 未开放此服务，已跳过",peerId:sub.peer_id});continue;}
      const prompt=interpolate(service.prompt_template,sub.params);
      const executionTime=new Date(scheduledPreviewTime(service.schedule,service.timezone,now));
      const result=await this.run("subscription",sub.id,sub.bot_id,sub.peer_id,sub.persona_id,prompt,Boolean(service.web_search_enabled),now,scheduledTestLockSource("subscription",runId),executionTime,service.timezone,event=>onProgress?.({...event,peerId:sub.peer_id}));
      if(result.sent){sent++;onProgress?.({level:"info",stage:"complete",message:"发送成功",peerId:sub.peer_id});}else {skipped++;details.push({peerId:sub.peer_id,reason:result.reason||"unknown"});onProgress?.({level:"error",stage:"complete",message:`发送失败：${result.reason||"unknown"}`,peerId:sub.peer_id});}
    }
    onProgress?.({level:skipped?"warn":"info",stage:"summary",message:`测试结束：发送 ${sent}，跳过 ${skipped}`});
    return {sent,skipped,matched:subs.length,details};
  }
  private arm(ms:number){if(this.stopped)return;this.timer=setTimeout(()=>void this.tick().catch(e=>this.opts.log?.(`[schedule] tick error ${e instanceof Error?e.message:String(e)}`)).finally(()=>this.arm(this.opts.intervalSec*1000)),ms);}
  async tick(now=new Date()){if(this.stopped||this.running)return {sent:0,skipped:0};this.running=true;let sent=0,skipped=0;try { const [tasks,subs]=await Promise.all([listScheduledTasks(this.opts.db),listUserSubscriptions(this.opts.db)]); for(const task of tasks){const oneTime=task.schedule_type==="one_time";const executeAt=task.execute_at?new Date(task.execute_at):null;const due=task.enabled&&(oneTime?Boolean(executeAt&&executeAt.getTime()<=now.getTime()&&!task.last_run_at):cronMatches(task.schedule,now,task.timezone));if(!oneTime&&(!task.next_run_at||due))await updateScheduledTask(this.opts.db,task.id,{next_run_at:nextCronRun(task.schedule,task.timezone,now)});if(!due)continue; const result=await this.run("task",task.id,task.bot_id,task.peer_id,task.persona_id,task.prompt,Boolean(task.web_search_enabled),now,"task",now,task.timezone);if(result.sent){sent++;if(oneTime)await updateScheduledTask(this.opts.db,task.id,{enabled:0,next_run_at:null});}else skipped++;} for(const sub of subs){if(!(await isUserSubscriptionActiveForCurrentPersona(this.opts.db,sub)))continue;const service=await getSystemSubscriptionService(this.opts.db,sub.service_id);if(!service?.enabled||!(await isServiceOpenToPersona(this.opts.db,service.id,sub.persona_id)))continue;const due=cronMatches(service.schedule,now,service.timezone);if(!sub.next_run_at||due)await updateUserSubscription(this.opts.db,sub.id,{next_run_at:nextCronRun(service.schedule,service.timezone,now)});if(!due)continue; const prompt=interpolate(service.prompt_template,sub.params);if((await this.run("subscription",sub.id,sub.bot_id,sub.peer_id,sub.persona_id,prompt,Boolean(service.web_search_enabled),now,"subscription",now,service.timezone)).sent)sent++;else skipped++;} } finally {this.running=false;} return {sent,skipped};}
  private async run(source:"task"|"subscription",id:string,botId:string,peerId:string,personaId:string,prompt:string,web:boolean,now:Date,lockSource:string=source,executionTime:Date=now,timeZone="Asia/Shanghai",onProgress?:ScheduledTestProgressHandler):Promise<{sent:true}|{sent:false;reason:string}>{const key=minuteKey(now);onProgress?.({level:"info",stage:"lock",message:"正在获取执行锁"});if(!(await tryAcquireScheduledExecutionLock(this.opts.db,lockSource,id,key,this.opts.lockTtlSec))){onProgress?.({level:"warn",stage:"lock",message:"本分钟已有相同执行，去重锁拒绝"});return {sent:false,reason:"duplicate_execution_lock"};}try{onProgress?.({level:"info",stage:"context",message:"正在读取会话上下文"});const tok=await getContextToken(this.opts.db,botId,peerId);if(!tok)throw new Error("no_context_token");const r=await this.opts.chat.handleScheduled({botAccountId:botId,peerId,contextToken:tok,personaId,prompt,webSearchEnabled:web,source,executionTime:executionTime.toISOString(),timeZone,onProgress:event=>onProgress?.({level:"info",stage:event.stage,message:event.message})});if(r.kind!=="reply"||!r.text)throw new Error(r.skipReason||r.kind);onProgress?.({level:"info",stage:"delivery",message:"内容生成成功，正在发送到微信"});const out=await this.opts.sendReply(botId,peerId,r);if(!out.ok)throw new Error(out.reason||"send_failed");const patch={last_run_at:now.toISOString(),last_status:"sent",last_error:null}; source==="task"?await updateScheduledTask(this.opts.db,id,patch):await updateUserSubscription(this.opts.db,id,patch);return {sent:true};}catch(e){const reason=e instanceof Error?e.message:String(e);onProgress?.({level:"error",stage:"error",message:reason});const patch={last_run_at:now.toISOString(),last_status:"error",last_error:reason};source==="task"?await updateScheduledTask(this.opts.db,id,patch).catch(()=>undefined):await updateUserSubscription(this.opts.db,id,patch).catch(()=>undefined);this.opts.log?.(`[schedule] ${source}=${id} failed`,e);return {sent:false,reason};}}
}
