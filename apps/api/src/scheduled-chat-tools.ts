/**
 * The chat scheduling boundary.  These are deliberately server-side tools:
 * the model may select a tool, but it never receives a Redis client or task id
 * outside the current bot/peer scope.
 *
 * Exposed to the chat pipeline as the pluggable `scheduledSkill` (see the
 * skill system in @wechat-ai/core); `handleScheduledChatTool` stays exported
 * for direct/legacy callers and tests.
 */
import type { ChatSkill } from "@wechat-ai/core";
import {
  clearPendingScheduledPlan,
  createScheduledTask,
  createUserSubscription,
  deleteScheduledTask,
  deleteUserSubscription,
  getBindByPeer,
  getPendingScheduledPlan,
  getSystemSubscriptionService,
  isServiceOpenToPersona,
  listPeerScheduledTasks,
  listPeerSubscriptions,
  listSystemSubscriptionServices,
  resolvePersonaForPeer,
  savePendingScheduledPlan,
  updateScheduledTask,
  validateSubscriptionParams,
} from "@wechat-ai/db";
import type {
  Db,
  ScheduledTask,
  SystemSubscriptionService,
} from "@wechat-ai/db";

export const scheduledChatTools = [
  { name:"prepare_scheduled_task", description:"Use only for an explicit request to remind, notify, or send something at a stated future time. Prepares a task and asks for confirmation; never creates it." },
  { name:"confirm_scheduled_task", description:"Use only after the user explicitly confirms the currently displayed scheduled-task operation." },
  { name:"list_my_scheduled_tasks", description:"List the caller's system subscriptions, self-created tasks, and available services under the current Persona." },
  { name:"update_scheduled_task", description:"Prepare a change to the caller's task (time, content, persona, enabled state). It always needs confirmation." },
  { name:"cancel_scheduled_task", description:"Prepare deletion of the caller's task, or discard the caller's pending task. It always needs confirmation for an existing task." },
] as const;

type ParsedPlan = { name:string; prompt:string; schedule:string; schedule_type:"cron"|"one_time"; execute_at?:string; timezone:"Asia/Shanghai"; web_search_enabled:number; display:string };
const YES=/^\s*(?:确认(?:创建|订阅|取消)?|可以(?:创建|订阅)?|创建吧?|确定|好(?:的)?(?:[，,]\s*)?(?:确认|创建|订阅|取消)?吧?|嗯+(?:[，,]\s*)?(?:确认|可以|创建|订阅)(?:吧)?)\s*[！!。.]?\s*$/;
const NO=/^\s*(?:不是|关闭|取消|不用了|算了|不要(?:了)?|不需要(?:提醒)?|暂不(?:需要)?(?:提醒)?|先不(?:创建|订阅|弄)(?:了)?|(?:这个)?(?:需要)?(?:去掉|取消|关闭)(?:这个)?提醒(?:了)?)\s*[！!。.]?\s*$/;
export function isScheduledCancelIntent(text:string){return NO.test(text);}
const SCHEDULE_SIGNAL =
  /(?:每天|每日|工作日|每周[一二三四五六日天、，,\s]*|今天|明天)/;
const ACTION_SIGNAL =
  /(?:提醒|通知|叫我|喊我|发送|发给我|给我发|推送|播报|告诉我|定时任务)/;
const CLOCK_TOKEN = /(?:凌晨|早上|上午|中午|下午|晚上)?\s*(?:\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*(?:点|时|:|：)/;

function hasExecutionIntent(text:string) {
  return (
    (SCHEDULE_SIGNAL.test(text) && ACTION_SIGNAL.test(text)) ||
    (/帮我|给我|设置|创建|新增/.test(text) &&
      ACTION_SIGNAL.test(text) &&
      CLOCK_TOKEN.test(text)) ||
    (/(?:提醒我|通知我|叫我|喊我)/.test(text) && CLOCK_TOKEN.test(text))
  );
}

function chineseNumber(raw:string):number|null {
  if(/^\d+$/.test(raw))return Number(raw);
  const map:Record<string,number>={零:0,"〇":0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
  if(raw==="十")return 10;
  const ten=raw.indexOf("十");
  if(ten>=0){
    const left=ten===0?1:map[raw[ten-1]!] ?? 0;
    const right=ten===raw.length-1?0:map[raw[ten+1]!] ?? 0;
    return left*10+right;
  }
  return raw.length===1 ? map[raw] ?? null : null;
}

function clock(text:string,preference:"first"|"last"="last") {
  // Appointment messages often contain both the visit time and a later
  // reminder request. The reminder clock is conventionally the final clock.
  const matches=[...text.matchAll(/(凌晨|早上|上午|中午|下午|晚上)?\s*(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*(?:点|时|:|：)\s*(?:(半|一刻|三刻)|(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*分?)?/g)];
  const match=preference==="first"?matches[0]:matches.at(-1);
  if(!match)return null;
  const period=match[1]||"";
  let hour=chineseNumber(match[2]!);
  if(hour===null)return null;
  const namedMinute=match[3];
  const rawMinute=match[4];
  let minute=namedMinute==="半"?30:namedMinute==="一刻"?15:namedMinute==="三刻"?45:rawMinute?chineseNumber(rawMinute):0;
  if(minute===null)return null;
  if((period==="下午"||period==="晚上"||period==="中午")&&hour<12)hour+=12;
  if(period==="凌晨"&&hour===12)hour=0;
  if(hour>23||minute>59)return null;
  return {hour,minute,label:`${String(hour).padStart(2,"0")}:${String(minute).padStart(2,"0")}`};
}
function shanghaiDate(now:Date){const p=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(now);const n=(type:string)=>Number(p.find(x=>x.type===type)?.value);return {year:n("year"),month:n("month"),day:n("day")};}
function oneTimeAt(dayOffset:number,time:{hour:number;minute:number},now:Date){const d=shanghaiDate(now);const utc=Date.UTC(d.year,d.month-1,d.day+dayOffset,time.hour-8,time.minute);return new Date(utc).toISOString();}
function explicitDate(text:string){
  const match=text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if(!match)return null;
  const year=Number(match[1]); const month=Number(match[2]); const day=Number(match[3]);
  const probe=new Date(Date.UTC(year,month-1,day));
  if(probe.getUTCFullYear()!==year||probe.getUTCMonth()!==month-1||probe.getUTCDate()!==day)return null;
  return {year,month,day};
}
function oneTimeOn(date:{year:number;month:number;day:number},time:{hour:number;minute:number}){return new Date(Date.UTC(date.year,date.month-1,date.day,time.hour-8,time.minute)).toISOString();}
function isAppointmentContext(text:string){return explicitDate(text)!==null&&clock(text)!==null&&/(?:预约|门诊|就诊|取号|科室|医生)/.test(text);}
function appointmentDetails(text:string){const date=explicitDate(text);const time=clock(text,"first");if(!date||!time||!isAppointmentContext(text))return null;return {date,time,at:oneTimeOn(date,time)};}
function appointmentDisplay(iso:string,suffix:string){const parts=new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).formatToParts(new Date(iso));const get=(type:string)=>parts.find(x=>x.type===type)?.value||"";return `${get("year")}年${get("month")}月${get("day")}日 ${get("hour")}:${get("minute")}（${suffix}）`;}
export function parseAppointmentReminder(appointmentText:string,answer:string):ParsedPlan|null {
  const appointment=appointmentDetails(appointmentText);if(!appointment)return null;
  const match=answer.match(/提前\s*(半|\d+|[零〇一二两三四五六七八九十]+)\s*(天|日|个?小时|钟头|分钟)/);
  let execute_at:string;let suffix:string;
  if(match){
    const amount=match[1]==="半"?0.5:chineseNumber(match[1]!);if(amount===null||amount<=0)return null;
    const unit=match[2]!;const milliseconds=/天|日/.test(unit)?amount*86_400_000:/小时|钟头/.test(unit)?amount*3_600_000:amount*60_000;
    execute_at=new Date(Date.parse(appointment.at)-milliseconds).toISOString();
    suffix=/天|日/.test(unit)?`提前${amount}天`:/小时|钟头/.test(unit)?`提前${amount===0.5?"半":amount}小时`:`提前${amount}分钟`;
  }else{
    const customTime=clock(answer);if(!customTime)return null;
    const full=explicitDate(answer);const monthDay=answer.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
    let customDate=full|| (monthDay?{year:appointment.date.year,month:Number(monthDay[1]),day:Number(monthDay[2])}:null);
    if(!customDate&&/(?:前一天|前1天|提前一天)/.test(answer)){const previous=new Date(Date.UTC(appointment.date.year,appointment.date.month-1,appointment.date.day-1));customDate={year:previous.getUTCFullYear(),month:previous.getUTCMonth()+1,day:previous.getUTCDate()};}
    if(!customDate)return null;
    execute_at=oneTimeOn(customDate,customTime);if(Date.parse(execute_at)>=Date.parse(appointment.at))return null;
    suffix="自定义提醒";
  }
  return {name:taskName(`${appointmentText} 提醒我就诊`),prompt:`就诊提醒：${appointmentText.trim()}`,schedule:"",schedule_type:"one_time",execute_at,timezone:"Asia/Shanghai",web_search_enabled:0,display:appointmentDisplay(execute_at,suffix)};
}
function weekdays(text:string){const map:Record<string,number>={一:1,二:2,三:3,四:4,五:5,六:6,日:0,天:0};const m=text.match(/每周([一二三四五六日天、，,]+)/);if(!m)return null;const values=[...m[1]!].map(x=>map[x]).filter((x):x is number=>x!==undefined);return values.length?[...new Set(values)].join(","):null;}
function taskName(text:string){
  const action=text.match(/(?:提醒我|通知我|叫我|喊我|给(?:我|你)(?:发送|发|推送|播报|返回)?|发给我|向我(?:发送|推送|播报)|发送|推送|播报|告诉我)\s*([^，。！？!?]+)\s*$/)?.[1];
  const clean=(action||text)
    .replace(/^(?:一下|一声|每天|每日)\s*/,"")
    .replace(/(?:创建|新建|新增|设置|添加)(?:一个)?定时任务/g,"")
    .replace(/(?:凌晨|早上|上午|中午|下午|晚上)?\s*(?:\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*(?:点|时|:|：)\s*(?:(?:半|一刻|三刻)|(?:\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*分?)?/g,"")
    .replace(/[，,。！!？?]/g," ")
    .trim();
  return (clean||"定时任务").slice(0,40);
}
export function parseScheduledTask(text:string, now=new Date()): ParsedPlan | { question:string } | null {
  if(!hasExecutionIntent(text))return null;
  const time=clock(text); if(!time)return {question:"几点提醒你？"};
  const prompt=text.trim(); const web=/(?:联网|实时|最新|天气|新闻|资讯|搜索|查询|查一下)/.test(text)?1:0;
  const days=weekdays(text);
  const date=explicitDate(text);
  if(date){const execute_at=oneTimeOn(date,time);const display=`${date.year}年${String(date.month).padStart(2,"0")}月${String(date.day).padStart(2,"0")}日 ${time.label}`;return {name:taskName(text),prompt,schedule:"",schedule_type:"one_time",execute_at,timezone:"Asia/Shanghai",web_search_enabled:web,display};}
  if(/明天/.test(text)||/今天/.test(text)) { const offset=/明天/.test(text)?1:0; const execute_at=oneTimeAt(offset,time,now); return {name:taskName(text),prompt,schedule:"",schedule_type:"one_time",execute_at,timezone:"Asia/Shanghai",web_search_enabled:web,display:`${/明天/.test(text)?"明天":"今天"} ${time.label}`}; }
  if(!/(?:每天|每日|工作日|每周)/.test(text))return {question:`你希望今天、明天，还是每天 ${time.label} 提醒？`};
  const dow=days ?? (/工作日/.test(text)?"1-5":"*");
  return {name:taskName(text),prompt,schedule:`${time.minute} ${time.hour} * * ${dow}`,schedule_type:"cron",timezone:"Asia/Shanghai",web_search_enabled:web,display:days?`每周${text.match(/每周([一二三四五六日天、，,]+)/)?.[1]} ${time.label}`:/工作日/.test(text)?`工作日 ${time.label}`:`每天 ${time.label}`};
}
function formatCron(schedule:string) {
  const [minute,hour,, ,week]=schedule.trim().split(/\s+/);
  if(minute===undefined||hour===undefined||week===undefined)return schedule;
  const time=`${String(hour).padStart(2,"0")}:${String(minute).padStart(2,"0")}`;
  if(week==="*")return `每天 ${time}`;
  if(week==="1-5")return `工作日 ${time}`;
  const names:Record<string,string>={0:"日",1:"一",2:"二",3:"三",4:"四",5:"五",6:"六"};
  const days=week.split(",").map(x=>names[x]||x).join("、");
  return `每周${days} ${time}`;
}
function formatTask(task:ScheduledTask){
  const when=task.schedule_type==="one_time"&&task.execute_at
    ? new Intl.DateTimeFormat("zh-CN",{timeZone:task.timezone,dateStyle:"medium",timeStyle:"short",hour12:false}).format(new Date(task.execute_at))
    : formatCron(task.schedule);
  return `${task.name}｜${when}｜${task.enabled?"已启用":"已暂停"}`;
}
function orderedTasks(tasks:ScheduledTask[]){return [...tasks].sort((a,b)=>(Date.parse(a.created_at)||0)-(Date.parse(b.created_at)||0)||a.id.localeCompare(b.id));}
const CANCELLATION_VERB=/(?:取消|删除|移除|关闭|停止|停掉|关掉|不要了|不再)/;
function cancellationIntent(text:string){return CANCELLATION_VERB.test(text)&&/(?:定时任务|任务|提醒|推送|订阅|第\s*(?:\d+|[一二两三四五六七八九十]+)\s*(?:个|条|项)?|这个|那个|它)/.test(text);}
function chineseOrdinal(raw:string){const value=chineseNumber(raw);return value&&value>0?value:null;}
export function resolveScheduledTaskReference(tasks:ScheduledTask[],text:string):{task:ScheduledTask|null;candidates:ScheduledTask[]} {
  const ordered=orderedTasks(tasks);
  const ordinal=text.match(/第\s*(\d+|[一二两三四五六七八九十]+)\s*(?:个|条|项)?/);
  if(ordinal){const index=chineseOrdinal(ordinal[1]!);const task=index?ordered[index-1]||null:null;return {task,candidates:task?[task]:ordered};}
  const normalized=text.replace(/[\s，,。！!？?：:“”'"《》【】\[\]()（）]/g,"");
  const exact=ordered.filter(task=>normalized.includes(task.name.replace(/\s/g,"")));
  if(exact.length===1)return {task:exact[0]!,candidates:exact};
  if(exact.length>1)return {task:null,candidates:exact};
  const promptMatches=ordered.filter(task=>{
    const prompt=task.prompt.replace(/[\s，,。！!？?：:“”'"《》【】\[\]()（）]/g,"");
    const snippets=[...prompt.matchAll(/[\u3400-\u9fffA-Za-z0-9]{4,}/g)].map(match=>match[0]!);
    return snippets.some(snippet=>normalized.includes(snippet)||snippet.includes(normalized));
  });
  if(promptMatches.length===1)return {task:promptMatches[0]!,candidates:promptMatches};
  if(ordered.length===1&&cancellationIntent(text))return {task:ordered[0]!,candidates:ordered};
  return {task:null,candidates:promptMatches.length?promptMatches:ordered};
}
function cancellationCandidates(tasks:ScheduledTask[]){return orderedTasks(tasks).map((task,index)=>`${index+1}. ${formatTask(task)}`).join("\n");}
function formatSubscription(service:SystemSubscriptionService|undefined,params:Record<string,unknown>,enabled:number){
  const values=Object.values(params).filter(x=>typeof x==="string"||typeof x==="number").join("、");
  return `${service?.name||"已下线服务"}${values?`（${values}）`:""}｜${service?formatCron(service.schedule):"计划未知"}｜${enabled?"已启用":"已暂停"}`;
}
export function isScheduledOverviewIntent(text:string) {
  const normalized=text.replace(/[？?！!。.\s]/g,"");
  return (
    /^(?:我的)?(?:定时任务|任务列表|提醒列表|订阅列表|推送列表)$/.test(normalized) ||
    /(?:定时任务|提醒|订阅|推送)(?:列表|清单)$/.test(normalized) ||
    /(?:你|当前人设|这个人设).*(?:分配|绑定|开放).*(?:定时任务|提醒|订阅|推送)/.test(normalized) ||
    /(?:我|当前|这个人设|现在).*(?:订阅了什么|订阅哪些)/.test(normalized) ||
    /(?:我|你|当前|这个人设|现在).*(?:有|有哪些|有什么|订阅了).*(?:定时任务|提醒|订阅|推送)/.test(normalized) ||
    /(?:看看|查看|查询|列出).*(?:定时任务|提醒|订阅|推送)/.test(normalized) ||
    /(?:定时任务|提醒|订阅|推送).*(?:有哪些|有什么|查看|看看)/.test(normalized)
  );
}
async function actor(db:Db,botId:string,peerId:string){const bind=await getBindByPeer(db,botId,peerId);return bind?.userId||`wechat:${botId}:${peerId}`;}
async function ownTask(db:Db,botId:string,peerId:string,id:string){const tasks=await listPeerScheduledTasks(db,botId,peerId);return tasks.find(x=>x.id===id)||null;}
async function ownSubscription(db:Db,botId:string,peerId:string,id:string){const subscriptions=await listPeerSubscriptions(db,botId,peerId);return subscriptions.find(x=>x.id===id)||null;}

export async function list_current_persona_schedules(db:Db,input:{botId:string;peerId:string}) {
  const persona=await resolvePersonaForPeer(db,input.botId,input.peerId);
  if(!persona)return "当前没有可用人设。";
  const [allTasks,allSubscriptions,services]=await Promise.all([
    listPeerScheduledTasks(db,input.botId,input.peerId),
    listPeerSubscriptions(db,input.botId,input.peerId),
    listSystemSubscriptionServices(db),
  ]);
  const tasks=orderedTasks(allTasks.filter(x=>x.persona_id===persona.id));
  const subscriptions=allSubscriptions.filter(x=>x.persona_id===persona.id);
  const serviceMap=new Map(services.map(x=>[x.id,x]));
  const openChecks=await Promise.all(services.map(x=>isServiceOpenToPersona(db,x.id,persona.id)));
  const subscribedIds=new Set(subscriptions.map(x=>x.service_id));
  const available=services.filter((_,i)=>openChecks[i]&&!subscribedIds.has(services[i]!.id));
  const lines=[`当前人设：${persona.display_name}`];
  if(subscriptions.length||tasks.length){
    lines.push("已配置的定时推送：");
    let index=1;
    for(const sub of subscriptions)lines.push(`${index++}. [系统订阅] ${formatSubscription(serviceMap.get(sub.service_id),sub.params,sub.enabled)}`);
    for(const task of tasks)lines.push(`${index++}. [自建任务] ${formatTask(task)}`);
  }else{
    lines.push("当前人设还没有已配置的定时推送。");
  }
  if(available.length){
    lines.push("当前人设还可以订阅：");
    available.forEach((service,i)=>lines.push(`${i+1}. ${service.name}｜${formatCron(service.schedule)}${service.description?`｜${service.description}`:""}`));
    lines.push("直接回复“订阅 + 服务名称”即可。");
  }
  return lines.join("\n");
}

export async function prepare_scheduled_task(db:Db,input:{botId:string;peerId:string;text:string;now?:Date}) {
  const parsed=parseScheduledTask(input.text,input.now); if(!parsed)return null;
  const persona=await resolvePersonaForPeer(db,input.botId,input.peerId);if(!persona)return "当前没有可用人设。";
  const user_id=await actor(db,input.botId,input.peerId);
  if("question" in parsed){
    await savePendingScheduledPlan(db,{kind:"task",user_id,bot_id:input.botId,peer_id:input.peerId,persona_id:persona.id,payload:{draft_text:input.text,collecting:"schedule"},created_at:new Date().toISOString()});
    return parsed.question;
  }
  await savePendingScheduledPlan(db,{kind:"task",user_id,bot_id:input.botId,peer_id:input.peerId,persona_id:persona.id,payload:parsed,created_at:new Date().toISOString()});
  return `准备创建定时任务：\n\n任务：${parsed.name}\n执行：${parsed.display}\n时区：Asia/Shanghai\n人设：${persona.display_name}\n内容：${parsed.prompt}\n\n确认创建吗？`;
}
export async function confirm_scheduled_task(db:Db,input:{botId:string;peerId:string}) {
  const pending=await getPendingScheduledPlan(db,input.botId,input.peerId);if(!pending)return "没有待确认的定时操作。";
  const user_id=await actor(db,input.botId,input.peerId);if(pending.user_id!==user_id)return "待确认任务不属于当前会话。";
  if(pending.kind==="task"){const p=pending.payload;const task=await createScheduledTask(db,{user_id,bot_id:pending.bot_id,peer_id:pending.peer_id,persona_id:pending.persona_id,name:String(p.name),prompt:String(p.prompt),schedule:String(p.schedule||""),schedule_type:p.schedule_type==="one_time"?"one_time":"cron",execute_at:typeof p.execute_at==="string"?p.execute_at:null,timezone:String(p.timezone||"Asia/Shanghai"),web_search_enabled:Number(p.web_search_enabled)||0,enabled:1});await clearPendingScheduledPlan(db,input.botId,input.peerId);return `已创建「${task.name}」。`;}
  if(pending.kind==="subscription_cancel"){const subscription=await ownSubscription(db,input.botId,input.peerId,String(pending.payload.subscription_id));if(!subscription){await clearPendingScheduledPlan(db,input.botId,input.peerId);return "该订阅已不存在或不属于当前会话。";}await deleteUserSubscription(db,subscription.id);await clearPendingScheduledPlan(db,input.botId,input.peerId);return "已取消该订阅。";}
  const task=await ownTask(db,input.botId,input.peerId,String(pending.payload.task_id));if(!task){await clearPendingScheduledPlan(db,input.botId,input.peerId);return "该任务已不存在或不属于当前会话。";}
  await clearPendingScheduledPlan(db,input.botId,input.peerId);
  if(pending.kind==="task_cancel"){await deleteScheduledTask(db,task.id);return "已删除该定时任务。";}
  if(pending.kind==="task_update"){await updateScheduledTask(db,task.id,pending.payload.patch as Partial<ScheduledTask>);return "已更新该定时任务。";}
  return "该操作不能在这里确认。";
}
export async function list_my_scheduled_tasks(db:Db,input:{botId:string;peerId:string}){return list_current_persona_schedules(db,input);}
export async function update_scheduled_task(db:Db,input:{botId:string;peerId:string;taskId:string;patch:Partial<ScheduledTask>;summary:string}){const task=await ownTask(db,input.botId,input.peerId,input.taskId);if(!task)return "没有找到当前会话的该定时任务。";const user_id=await actor(db,input.botId,input.peerId);await savePendingScheduledPlan(db,{kind:"task_update",user_id,bot_id:input.botId,peer_id:input.peerId,persona_id:task.persona_id,payload:{task_id:task.id,patch:input.patch},created_at:new Date().toISOString()});return `准备更新「${task.name}」：${input.summary}\n确认吗？`;}
export async function cancel_scheduled_task(db:Db,input:{botId:string;peerId:string;taskId?:string}){if(!input.taskId){await clearPendingScheduledPlan(db,input.botId,input.peerId);return "已取消待确认的定时操作。";}const task=await ownTask(db,input.botId,input.peerId,input.taskId);if(!task)return "没有找到当前会话的该定时任务。";const user_id=await actor(db,input.botId,input.peerId);await savePendingScheduledPlan(db,{kind:"task_cancel",user_id,bot_id:input.botId,peer_id:input.peerId,persona_id:task.persona_id,payload:{task_id:task.id},created_at:new Date().toISOString()});return `准备删除「${task.name}」，确认吗？`;}

function serviceKey(text:string){
  return text.replace(/[\s，,。！!？?]/g,"").replace(/(?:我想|帮我|开通|开启|取消|订阅|服务|专属|每日|每天)/g,"").toLowerCase();
}
function mentionedService(text:string,services:SystemSubscriptionService[]){
  const query=serviceKey(text);
  return services.find(service=>{
    const key=serviceKey(service.name);
    return text.includes(service.name)||(query.length>=2&&key.length>=2&&(query.includes(key)||key.includes(query)));
  });
}
function pendingTaskConfirmation(parsed:ParsedPlan,personaName:string){
  return `准备创建定时任务：\n\n任务：${parsed.name}\n执行：${parsed.display}\n时区：Asia/Shanghai\n人设：${personaName}\n内容：${parsed.prompt}\n\n确认创建吗？`;
}

/** Compatibility adapter until the general chat tool runner exposes arbitrary tools. */
export async function handleScheduledChatTool(db:Db,input:{botId:string;peerId:string;text:string}) : Promise<string|null> {  const text=input.text.trim();
  const pending=await getPendingScheduledPlan(db,input.botId,input.peerId);
  if(pending){
    if(isScheduledCancelIntent(text))return cancel_scheduled_task(db,{...input});
    if(pending.kind==="task"&&pending.payload.collecting==="appointment_reminder"){
      const appointmentText=String(pending.payload.draft_text||"");
      if(/^(?:自定义|其他|别的)(?:时间)?$/.test(text))return "你希望提前多久提醒？例如“提前 2 小时”或“提前 3 天”。也可以说“当天上午 8 点”。";
      const relative=parseAppointmentReminder(appointmentText,text);
      const absolute=relative?null:parseScheduledTask(`${appointmentText} ${text}`);
      const parsed=relative||(absolute&&!("question" in absolute)?absolute:null);
      if(!parsed)return "请选择“提前一天”“提前一小时”，或告诉我自定义时间，例如“提前 90 分钟”“当天上午 8 点”。不需要可回复“取消”。";
      await savePendingScheduledPlan(db,{...pending,payload:parsed,created_at:new Date().toISOString()});
      const persona=await resolvePersonaForPeer(db,input.botId,input.peerId);
      return pendingTaskConfirmation(parsed,persona?.display_name||"当前人设");
    }
    if(pending.kind==="task"&&pending.payload.collecting==="schedule"){
      if(pending.payload.contextual===true&&!hasExecutionIntent(text)){
        await clearPendingScheduledPlan(db,input.botId,input.peerId);
      }else{
      if(YES.test(text))return "还需要先补充执行日期或时间。";
      const draft=`${String(pending.payload.draft_text||"")} ${text}`.trim();
      const parsed=parseScheduledTask(draft);
      if(!parsed||"question" in parsed){
        await savePendingScheduledPlan(db,{...pending,payload:{draft_text:draft,collecting:"schedule"},created_at:new Date().toISOString()});
        return parsed&&"question" in parsed?parsed.question:"请补充完整的执行时间，例如“每天早上 8 点”。";
      }
      await savePendingScheduledPlan(db,{...pending,payload:parsed,created_at:new Date().toISOString()});
      const persona=await resolvePersonaForPeer(db,input.botId,input.peerId);
      return pendingTaskConfirmation(parsed,persona?.display_name||"当前人设");
      }
    }
    if(pending.kind==="subscription"&&typeof pending.payload.collecting==="string"){
      const service=await getSystemSubscriptionService(db,String(pending.payload.service_id));
      if(!service){await clearPendingScheduledPlan(db,input.botId,input.peerId);return "该订阅服务已不可用。";}
      const params={...((pending.payload.params as Record<string,unknown>)||{}),[pending.payload.collecting]:text};
      const missing=validateSubscriptionParams(service.params_schema,params).find(x=>x.startsWith("missing:"));
      await savePendingScheduledPlan(db,{...pending,payload:{...pending.payload,params,collecting:missing?missing.slice(8):null}});
      return missing?`还需要填写 ${missing.slice(8)}。`:`准备订阅：\n${service.name}\n${formatCron(service.schedule)}（${service.timezone}）\n确认订阅吗？`;
    }
    if(YES.test(text)){
      if(pending.kind==="subscription"){
        const service=await getSystemSubscriptionService(db,String(pending.payload.service_id));
        const params=(pending.payload.params as Record<string,unknown>)||{};
        if(!service?.enabled||!(await isServiceOpenToPersona(db,service.id,pending.persona_id))||validateSubscriptionParams(service.params_schema,params).length)return "该订阅计划已失效，请重新发起订阅。";
        const existing=(await listPeerSubscriptions(db,input.botId,input.peerId)).find(x=>x.service_id===service.id);
        await createUserSubscription(db,{user_id:pending.user_id,bot_id:pending.bot_id,peer_id:pending.peer_id,persona_id:pending.persona_id,service_id:service.id,params,enabled:1});
        await clearPendingScheduledPlan(db,input.botId,input.peerId);
        return existing
          ? `已更新「${service.name}」的订阅人设和参数，之后会按计划推送。`
          : `已订阅「${service.name}」，之后会按计划推送。`;
      }
      return confirm_scheduled_task(db,input);
    }
    if(pending.kind==="task"&&/(改成|改为|换成)/.test(text)){
      const previous=pending.payload as Record<string,unknown>;
      const merged=parseScheduledTask(`${text.replace(/^(改成|改为|换成)/,"")} 提醒我 ${String(previous.name||"")}`);
      if(merged&&!("question" in merged)){await savePendingScheduledPlan(db,{...pending,payload:{...previous,...merged},created_at:new Date().toISOString()});return `已更新待创建任务：\n执行：${merged.display}\n确认创建吗？`;}
    }
  }
  if(isScheduledOverviewIntent(text))return list_current_persona_schedules(db,input);
  if(/有什么可以订阅|可订阅|能订阅/.test(text))return list_current_persona_schedules(db,input);
  const persona=await resolvePersonaForPeer(db,input.botId,input.peerId);
  const services=await listSystemSubscriptionServices(db);
  const service=mentionedService(text,services);
  if(service&&/(?:取消|停止|关闭).{0,4}订阅|取消订阅/.test(text)){
    if(!persona)return "当前没有可用人设。";
    const subscription=(await listPeerSubscriptions(db,input.botId,input.peerId)).find(x=>x.persona_id===persona.id&&x.service_id===service.id);
    if(!subscription)return `当前人设没有订阅「${service.name}」。`;
    await savePendingScheduledPlan(db,{kind:"subscription_cancel",user_id:await actor(db,input.botId,input.peerId),bot_id:input.botId,peer_id:input.peerId,persona_id:persona.id,payload:{subscription_id:subscription.id},created_at:new Date().toISOString()});
    return `准备取消订阅「${service.name}」，确认吗？`;
  }
  if(service&&/(?:订阅|开通|开启)/.test(text)){
    if(!persona||!(await isServiceOpenToPersona(db,service.id,persona.id)))return "没有找到当前人设可订阅的服务。";
    const required=Array.isArray(service.params_schema.required)?service.params_schema.required.find((x):x is string=>typeof x==="string"):undefined;
    await savePendingScheduledPlan(db,{kind:"subscription",user_id:await actor(db,input.botId,input.peerId),bot_id:input.botId,peer_id:input.peerId,persona_id:persona.id,payload:{service_id:service.id,params:{},collecting:required||null},created_at:new Date().toISOString()});
    return required?`你想订阅的 ${required} 是什么？`:`准备订阅：\n${service.name}\n${formatCron(service.schedule)}（${service.timezone}）\n确认订阅吗？`;
  }
  const tasks=(await listPeerScheduledTasks(db,input.botId,input.peerId)).filter(t=>!persona||t.persona_id===persona.id);
  const referenced=resolveScheduledTaskReference(tasks,text);
  const target=referenced.task;
  if(cancellationIntent(text)||(target!==null&&CANCELLATION_VERB.test(text))){
    if(target)return cancel_scheduled_task(db,{...input,taskId:target.id});
    if(!tasks.length)return "当前人设没有可取消的自建定时任务。";
    return `你想关闭哪一个定时任务？\n${cancellationCandidates(referenced.candidates)}`;
  }
  if(target&&/(暂停|恢复|启用|改成|改为)/.test(text)){const parsed=parseScheduledTask(`${text} 提醒我`);const patch=parsed&&!("question" in parsed)?{schedule:parsed.schedule,schedule_type:parsed.schedule_type,execute_at:parsed.execute_at||null,timezone:parsed.timezone}:{enabled:/暂停/.test(text)?0:1};return update_scheduled_task(db,{...input,taskId:target.id,patch,summary:/暂停/.test(text)?"暂停":/恢复|启用/.test(text)?"恢复启用":"修改执行时间"});}
  if(isAppointmentContext(text)&&persona){
    const appointment=appointmentDetails(text)!;
    await savePendingScheduledPlan(db,{kind:"task",user_id:await actor(db,input.botId,input.peerId),bot_id:input.botId,peer_id:input.peerId,persona_id:persona.id,payload:{draft_text:text,collecting:"appointment_reminder",contextual:true},created_at:new Date().toISOString()});
    const visit=appointmentDisplay(appointment.at,"预约时间").replace("（预约时间）","");
    return `识别到预约：${visit}。\n你希望何时提醒？可以回复“提前一天”“提前一小时”“当天上午 8 点”或自定义“提前 90 分钟”。不需要提醒可回复“取消”。`;
  }
  return prepare_scheduled_task(db,input);
}

/**
 * The scheduled capability as a pluggable skill. Deterministic interception
 * (regex + confirmation boundary) — no LLM-generated text can reach Redis.
 */
export const scheduledSkill: ChatSkill = {
  id: "scheduled",
  name: "定时任务",
  description:
    "创建/查看/修改/取消定时提醒与推送订阅（说“每天 8 点提醒我…”或“订阅 + 服务名”）",
  handle: async (ctx) =>
    handleScheduledChatTool(ctx.db, {
      botId: ctx.botId,
      peerId: ctx.peerId,
      text: ctx.text,
    }),
};
