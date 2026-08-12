/**
 * The chat scheduling boundary.  These are deliberately server-side tools:
 * the model may select a tool, but it never receives a Redis client or task id
 * outside the current bot/peer scope.
 */
import { clearPendingScheduledPlan, createScheduledTask, createUserSubscription, deleteScheduledTask, getBindByPeer, getPendingScheduledPlan, getPersonasByIds, getSystemSubscriptionService, isServiceOpenToPersona, listPeerScheduledTasks, listSystemSubscriptionServices, resolvePersonaForPeer, savePendingScheduledPlan, updateScheduledTask, validateSubscriptionParams } from "@wechat-ai/db";
import type { Db, ScheduledTask } from "@wechat-ai/db";

export const scheduledChatTools = [
  { name:"prepare_scheduled_task", description:"Use only for an explicit request to remind, notify, or send something at a stated future time. Prepares a task and asks for confirmation; never creates it." },
  { name:"confirm_scheduled_task", description:"Use only after the user explicitly confirms the currently displayed scheduled-task operation." },
  { name:"list_my_scheduled_tasks", description:"List only the caller's scheduled tasks when they ask to view or manage their tasks." },
  { name:"update_scheduled_task", description:"Prepare a change to the caller's task (time, content, persona, enabled state). It always needs confirmation." },
  { name:"cancel_scheduled_task", description:"Prepare deletion of the caller's task, or discard the caller's pending task. It always needs confirmation for an existing task." },
] as const;

type ParsedPlan = { name:string; prompt:string; schedule:string; schedule_type:"cron"|"one_time"; execute_at?:string; timezone:"Asia/Shanghai"; web_search_enabled:number; display:string };
const YES=/^\s*(确认|可以|创建|确定|好的|好)\s*[！!。.]?\s*$/;
const NO=/^\s*(取消|不用了|算了|不要)\s*[！!。.]?\s*$/;
const executionIntent=/(提醒我|通知我|每(?:天|日).*(?:给我发|发给我)|定时|到时候告诉我|每周.*(?:提醒|通知|发给我)|明天.*(?:提醒|通知|发给我)|今天.*(?:提醒|通知|发给我))/;

function clock(text:string) {
  const match=text.match(/(?:早上|上午|中午|下午|晚上)?\s*(\d{1,2})(?:点|:|：)(\d{1,2})?/);
  if(!match)return null;
  let hour=Number(match[1]), minute=Number(match[2]||0);
  if((/下午|晚上/.test(text))&&hour<12)hour+=12;
  if(hour>23||minute>59)return null;
  return {hour,minute,label:`${String(hour).padStart(2,"0")}:${String(minute).padStart(2,"0")}`};
}
function shanghaiDate(now:Date){const p=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(now);const n=(type:string)=>Number(p.find(x=>x.type===type)?.value);return {year:n("year"),month:n("month"),day:n("day")};}
function oneTimeAt(dayOffset:number,time:{hour:number;minute:number},now:Date){const d=shanghaiDate(now);const utc=Date.UTC(d.year,d.month-1,d.day+dayOffset,time.hour-8,time.minute);return new Date(utc).toISOString();}
function weekdays(text:string){const map:Record<string,number>={一:1,二:2,三:3,四:4,五:5,六:6,日:0,天:0};const m=text.match(/每周([一二三四五六日天、，,]+)/);if(!m)return null;const values=[...m[1]!].map(x=>map[x]).filter((x):x is number=>x!==undefined);return values.length?[...new Set(values)].join(","):null;}
function taskName(text:string){const clean=text.replace(/(?:每天|每日|工作日|每周[一二三四五六日天、，,]*|今天|明天).{0,20}?(?:提醒我|通知我|给我发|发给我|到时候告诉我)/," ").replace(/[，,。！!？?]/g," ").trim();return (clean||"定时任务").slice(0,40);}
export function parseScheduledTask(text:string, now=new Date()): ParsedPlan | { question:string } | null {
  if(!executionIntent.test(text))return null;
  const time=clock(text); if(!time)return {question:"几点提醒你？"};
  const prompt=text.trim(); const web=/联网|最新.*(?:新闻|资讯)|(?:查|搜索).*(?:新闻|资讯|资料)/.test(text)?1:0;
  const days=weekdays(text);
  if(/明天/.test(text)||/今天/.test(text)) { const offset=/明天/.test(text)?1:0; const execute_at=oneTimeAt(offset,time,now); return {name:taskName(text),prompt,schedule:"",schedule_type:"one_time",execute_at,timezone:"Asia/Shanghai",web_search_enabled:web,display:`${/明天/.test(text)?"明天":"今天"} ${time.label}`}; }
  const dow=days ?? (/工作日/.test(text)?"1-5":"*");
  return {name:taskName(text),prompt,schedule:`${time.minute} ${time.hour} * * ${dow}`,schedule_type:"cron",timezone:"Asia/Shanghai",web_search_enabled:web,display:days?`每周${text.match(/每周([一二三四五六日天、，,]+)/)?.[1]} ${time.label}`:/工作日/.test(text)?`工作日 ${time.label}`:`每天 ${time.label}`};
}
function formatTask(task:ScheduledTask, personaName:string){const when=task.schedule_type==="one_time"&&task.execute_at?new Intl.DateTimeFormat("zh-CN",{timeZone:task.timezone,dateStyle:"medium",timeStyle:"short",hour12:false}).format(new Date(task.execute_at)):task.schedule;return `${task.name}\n   ${when}（${task.timezone}）\n   人设：${personaName}\n   ${task.enabled?"已启用":"已暂停"}`;}
async function actor(db:Db,botId:string,peerId:string){const bind=await getBindByPeer(db,botId,peerId);return bind?.userId||`wechat:${botId}:${peerId}`;}
async function ownTask(db:Db,botId:string,peerId:string,id:string){const tasks=await listPeerScheduledTasks(db,botId,peerId);return tasks.find(x=>x.id===id)||null;}

export async function prepare_scheduled_task(db:Db,input:{botId:string;peerId:string;text:string;now?:Date}) {
  const parsed=parseScheduledTask(input.text,input.now); if(!parsed)return null; if("question" in parsed)return parsed.question;
  const persona=await resolvePersonaForPeer(db,input.botId,input.peerId);if(!persona)return "当前没有可用人设。";
  const user_id=await actor(db,input.botId,input.peerId);
  await savePendingScheduledPlan(db,{kind:"task",user_id,bot_id:input.botId,peer_id:input.peerId,persona_id:persona.id,payload:parsed,created_at:new Date().toISOString()});
  return `准备创建定时任务：\n\n任务：${parsed.name}\n执行：${parsed.display}\n时区：Asia/Shanghai\n人设：${persona.display_name}\n内容：${parsed.prompt}\n\n确认创建吗？`;
}
export async function confirm_scheduled_task(db:Db,input:{botId:string;peerId:string}) {
  const pending=await getPendingScheduledPlan(db,input.botId,input.peerId);if(!pending)return "没有待确认的定时操作。";
  const user_id=await actor(db,input.botId,input.peerId);if(pending.user_id!==user_id)return "待确认任务不属于当前会话。";
  if(pending.kind==="task"){const p=pending.payload;const task=await createScheduledTask(db,{user_id,bot_id:pending.bot_id,peer_id:pending.peer_id,persona_id:pending.persona_id,name:String(p.name),prompt:String(p.prompt),schedule:String(p.schedule||""),schedule_type:p.schedule_type==="one_time"?"one_time":"cron",execute_at:typeof p.execute_at==="string"?p.execute_at:null,timezone:String(p.timezone||"Asia/Shanghai"),web_search_enabled:Number(p.web_search_enabled)||0,enabled:1});await clearPendingScheduledPlan(db,input.botId,input.peerId);return `已创建「${task.name}」。`;}
  const task=await ownTask(db,input.botId,input.peerId,String(pending.payload.task_id));if(!task){await clearPendingScheduledPlan(db,input.botId,input.peerId);return "该任务已不存在或不属于当前会话。";}
  await clearPendingScheduledPlan(db,input.botId,input.peerId);
  if(pending.kind==="task_cancel"){await deleteScheduledTask(db,task.id);return "已删除该定时任务。";}
  if(pending.kind==="task_update"){await updateScheduledTask(db,task.id,pending.payload.patch as Partial<ScheduledTask>);return "已更新该定时任务。";}
  return "该操作不能在这里确认。";
}
export async function list_my_scheduled_tasks(db:Db,input:{botId:string;peerId:string}){const tasks=await listPeerScheduledTasks(db,input.botId,input.peerId);if(!tasks.length)return "你现在还没有自建定时任务。";const personas=await getPersonasByIds(db,tasks.map(x=>x.persona_id));return `你现在有 ${tasks.length} 个自建任务：\n`+tasks.map((t,i)=>`${i+1}. ${formatTask(t,personas.get(t.persona_id)?.display_name||"已不可用")}`).join("\n");}
export async function update_scheduled_task(db:Db,input:{botId:string;peerId:string;taskId:string;patch:Partial<ScheduledTask>;summary:string}){const task=await ownTask(db,input.botId,input.peerId,input.taskId);if(!task)return "没有找到当前会话的该定时任务。";const user_id=await actor(db,input.botId,input.peerId);await savePendingScheduledPlan(db,{kind:"task_update",user_id,bot_id:input.botId,peer_id:input.peerId,persona_id:task.persona_id,payload:{task_id:task.id,patch:input.patch},created_at:new Date().toISOString()});return `准备更新「${task.name}」：${input.summary}\n确认吗？`;}
export async function cancel_scheduled_task(db:Db,input:{botId:string;peerId:string;taskId?:string}){if(!input.taskId){await clearPendingScheduledPlan(db,input.botId,input.peerId);return "已取消待确认的定时操作。";}const task=await ownTask(db,input.botId,input.peerId,input.taskId);if(!task)return "没有找到当前会话的该定时任务。";const user_id=await actor(db,input.botId,input.peerId);await savePendingScheduledPlan(db,{kind:"task_cancel",user_id,bot_id:input.botId,peer_id:input.peerId,persona_id:task.persona_id,payload:{task_id:task.id},created_at:new Date().toISOString()});return `准备删除「${task.name}」，确认吗？`;}

/** Compatibility adapter until the general chat tool runner exposes arbitrary tools. */
export async function handleScheduledChatTool(db:Db,input:{botId:string;peerId:string;text:string}) : Promise<string|null> {
  const text=input.text.trim();const pending=await getPendingScheduledPlan(db,input.botId,input.peerId);
  if(pending?.kind==="subscription"&&typeof pending.payload.collecting==="string"){const service=await getSystemSubscriptionService(db,String(pending.payload.service_id));if(!service){await clearPendingScheduledPlan(db,input.botId,input.peerId);return "该订阅服务已不可用。";}const params={...((pending.payload.params as Record<string,unknown>)||{}),[pending.payload.collecting]:text};const missing=validateSubscriptionParams(service.params_schema,params).find(x=>x.startsWith("missing:"));await savePendingScheduledPlan(db,{...pending,payload:{...pending.payload,params,collecting:missing?missing.slice(8):null}});return missing?`还需要填写 ${missing.slice(8)}。`:`准备订阅：\n${service.name}\n${service.schedule}（${service.timezone}）\n确认订阅吗？`;}
  if(pending){if(YES.test(text)){if(pending.kind==="subscription"){const service=await getSystemSubscriptionService(db,String(pending.payload.service_id));const params=(pending.payload.params as Record<string,unknown>)||{};if(!service?.enabled||!(await isServiceOpenToPersona(db,service.id,pending.persona_id))||validateSubscriptionParams(service.params_schema,params).length)return "该订阅计划已失效，请重新发起订阅。";await createUserSubscription(db,{user_id:pending.user_id,bot_id:pending.bot_id,peer_id:pending.peer_id,persona_id:pending.persona_id,service_id:service.id,params,enabled:1});await clearPendingScheduledPlan(db,input.botId,input.peerId);return "已订阅，之后会按计划推送。";}return confirm_scheduled_task(db,input);}if(NO.test(text))return cancel_scheduled_task(db,{...input});if(pending.kind==="task"&&/(改成|改为|换成)/.test(text)){const previous=pending.payload as Record<string,unknown>;const merged=parseScheduledTask(`${text.replace(/^(改成|改为|换成)/,"")} 提醒我 ${String(previous.name||"")}`);if(merged&&!("question" in merged)){await savePendingScheduledPlan(db,{...pending,payload:{...previous,...merged},created_at:new Date().toISOString()});return `已更新待创建任务：\n执行：${merged.display}\n确认创建吗？`;}}}
  if(/^(我的)?(?:定时任务|任务列表)[？?！!。.]?$/.test(text))return list_my_scheduled_tasks(db,input);
  if(/有什么可以订阅|可订阅/.test(text)){const persona=await resolvePersonaForPeer(db,input.botId,input.peerId);if(!persona)return "当前没有可用人设。";const all=await listSystemSubscriptionServices(db);const services=[] as typeof all;for(const service of all)if(await isServiceOpenToPersona(db,service.id,persona.id))services.push(service);return services.length?`当前可以订阅：\n${services.map((s,i)=>`${i+1}. ${s.name}`).join("\n")}`:"当前人设没有开放订阅服务。";}
  if(/^订阅/.test(text)){const persona=await resolvePersonaForPeer(db,input.botId,input.peerId);const service=(await listSystemSubscriptionServices(db)).find(x=>text.includes(x.name));if(!persona||!service||!(await isServiceOpenToPersona(db,service.id,persona.id)))return "没有找到当前人设可订阅的服务。";const required=Array.isArray(service.params_schema.required)?service.params_schema.required.find((x):x is string=>typeof x==="string"):undefined;await savePendingScheduledPlan(db,{kind:"subscription",user_id:await actor(db,input.botId,input.peerId),bot_id:input.botId,peer_id:input.peerId,persona_id:persona.id,payload:{service_id:service.id,params:{},collecting:required||null},created_at:new Date().toISOString()});return required?`你想订阅的 ${required} 是什么？`:`准备订阅：\n${service.name}\n${service.schedule}（${service.timezone}）\n确认订阅吗？`;}
  const tasks=await listPeerScheduledTasks(db,input.botId,input.peerId);const target=tasks.find(t=>text.includes(t.name));
  if(target&&/(取消|删除)/.test(text))return cancel_scheduled_task(db,{...input,taskId:target.id});
  if(target&&/(暂停|恢复|启用|改成|改为)/.test(text)){const parsed=parseScheduledTask(`${text} 提醒我`);const patch=parsed&&!("question" in parsed)?{schedule:parsed.schedule,schedule_type:parsed.schedule_type,execute_at:parsed.execute_at||null,timezone:parsed.timezone}:{enabled:/暂停/.test(text)?0:1};return update_scheduled_task(db,{...input,taskId:target.id,patch,summary:/暂停/.test(text)?"暂停":/恢复|启用/.test(text)?"恢复启用":"修改执行时间"});}
  return prepare_scheduled_task(db,input);
}
