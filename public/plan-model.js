/** Shared validation for planned workouts and the owner's target reviews. */
export const PLAN_STATUSES = ['planned', 'hit', 'partial', 'missed', 'skipped'];
export const PLAN_STATUS_LABELS = {planned:'Planned',hit:'Hit target',partial:'Partly hit',missed:'Missed target',skipped:'Skipped'};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PlanValidationError extends Error {
  constructor(field, message) { super(message); this.name='PlanValidationError'; this.field=field; this.status=400; }
}
const fail=(field,message)=>{throw new PlanValidationError(field,message);};
export function planId(value, field='id') {
  if(typeof value!=='string'||!UUID.test(value.trim()))fail(field,'The plan identifier is invalid. Reopen the plan and try again.');
  return value.trim().toLowerCase();
}
export function planRevision(value) {
  if(!Number.isSafeInteger(value)||value<1)fail('revision','Reload the latest version of this plan before saving.');
  return value;
}
function text(value,field,limit,required=false,multiline=false) {
  if(value==null&&!required)return '';
  if(typeof value!=='string')fail(field,'Enter a text value.');
  let clean=value.normalize('NFC').replace(/\r\n?/g,'\n').trim();
  if(!multiline)clean=clean.replace(/\s+/gu,' ');
  if(required&&!clean)fail(field,field==='title'?'Give this workout a title.':field.endsWith('.exercise')?'Name the exercise or activity.':'Describe the target.');
  if(clean.length>limit)fail(field,`Keep this field to ${limit} characters or fewer.`);
  if(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(clean))fail(field,'Remove unsupported control characters.');
  return clean;
}
export function planDate(value) {
  const match=typeof value==='string'&&/^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if(!match)fail('date','Choose a complete workout date.');
  const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]);
  const leap=year%4===0&&(year%100!==0||year%400===0);
  const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  if(year<1||month<1||month>12||day<1||day>days[month-1])fail('date','Choose a real calendar date.');
  return value.trim();
}
export function normalizePlan(input) {
  if(!input||typeof input!=='object'||Array.isArray(input))fail('plan','Enter a valid workout plan.');
  const id=planId(input.id),date=planDate(input.date),title=text(input.title,'title',120,true);
  if(!Array.isArray(input.targets)||input.targets.length<1||input.targets.length>30)fail('targets','Add between 1 and 30 workout targets.');
  const seen=new Set();
  const targets=input.targets.map((item,index)=>{
    const prefix=`targets[${index}]`;
    if(!item||typeof item!=='object'||Array.isArray(item))fail(prefix,'Enter a valid workout target.');
    const targetId=planId(item.id,`${prefix}.id`);
    if(seen.has(targetId))fail(`${prefix}.id`,'Each target needs its own identifier.');
    seen.add(targetId);
    const status=item.status??'planned';
    if(!PLAN_STATUSES.includes(status))fail(`${prefix}.status`,'Choose a target result.');
    return {id:targetId,exercise:text(item.exercise,`${prefix}.exercise`,120,true),target:text(item.target,`${prefix}.target`,1000,true,true),status,comment:text(item.comment,`${prefix}.comment`,2000,false,true)};
  });
  const plan={id,date,title,targets,notes:text(input.notes,'notes',4000,false,true)};
  const canonicalPayload=JSON.stringify({date,title,targets,notes:plan.notes});
  return {...plan,canonicalPayload};
}

/** Reviews are explicit. Recorded workouts never automatically mark targets hit. */
export function planSummary(plan) {
  const targets=Array.isArray(plan?.targets)?plan.targets:[];
  const counts=Object.fromEntries(PLAN_STATUSES.map(status=>[status,targets.filter(t=>t.status===status).length]));
  const reviewed=targets.length-counts.planned;
  return {counts,reviewed,total:targets.length,label:reviewed===0?'Planned':reviewed===targets.length?(counts.hit===targets.length?'All targets hit':'Reviewed'):`${reviewed}/${targets.length} reviewed`};
}
