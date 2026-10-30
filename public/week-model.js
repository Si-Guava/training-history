/** Pure Monday–Sunday summaries. Plans, recorded work and training units stay distinct. */
import { analyze } from './analytics.js';
import { buildClimbAttemptTotals } from './climbing-model.js';
import { getTrainingToday } from './exercise-archive.js';

export const TRAINING_TYPES = Object.freeze([
  {id:'strength',label:'Strength',group:'strength'},
  {id:'boulder',label:'Bouldering',group:'climbing'},
  {id:'lead',label:'Lead',group:'climbing'},
  {id:'toprope',label:'Top rope',group:'climbing'},
  {id:'kilter',label:'Kilter',group:'climbing'},
  {id:'climbing_4x4',label:'4×4 climbing',group:'climbing'},
  {id:'climbing',label:'Climbing (unspecified)',group:'climbing'},
  {id:'max_hangs',label:'Max hangs',group:'hangboard'},
  {id:'repeaters',label:'Repeaters',group:'hangboard'},
  {id:'hangboard',label:'Hangboard (unspecified)',group:'hangboard'},
  {id:'other',label:'Other training',group:'other'},
].map(Object.freeze));

export const MUSCLE_GROUPS = Object.freeze([
  {id:'chest',label:'Chest'}, {id:'shoulders',label:'Shoulders'},
  {id:'upper_back',label:'Upper back'}, {id:'lats',label:'Lats'},
  {id:'biceps',label:'Biceps'}, {id:'triceps',label:'Triceps'},
  {id:'forearms',label:'Forearms / fingers'}, {id:'core',label:'Core'},
  {id:'lower_back',label:'Lower back'}, {id:'glutes',label:'Glutes'},
  {id:'quadriceps',label:'Quadriceps'}, {id:'hamstrings',label:'Hamstrings'},
  {id:'calves',label:'Calves'}, {id:'hip_flexors',label:'Hip flexors'},
].map(Object.freeze));

const typeInfo = new Map(TRAINING_TYPES.map(type=>[type.id,type]));
const finite = value => typeof value==='number' && Number.isFinite(value);
const positive = value => finite(value) && value>0;
const list = value => Array.isArray(value)?value:[];
const active = item => item && typeof item==='object' && !item.deleted_at && !item.deletedAt;
const keyText = value => String(value??'').normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]/gu,'');
const words = value => String(value??'').normalize('NFKC').toLocaleLowerCase('en').replace(/[‐‑–—_-]/g,' ').replace(/\s+/g,' ').trim();
const TYPE_ALIASES = {
  indoor_boulder:'boulder',outdoor_boulder:'boulder',bouldering:'boulder',
  indoor_lead:'lead',outdoor_lead:'lead',indoor_toprope:'toprope',outdoor_toprope:'toprope',
  top_rope:'toprope',maxhangs:'max_hangs','max hangs':'max_hangs',
  '4x4':'climbing_4x4','4×4':'climbing_4x4',fingerboard:'hangboard',
};

function dateString(value) {
  const match=typeof value==='string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if(!match)return null;
  const year=+match[1],month=+match[2],day=+match[3];
  const leap=year%4===0&&(year%100!==0||year%400===0);
  const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  return year>=1&&month>=1&&month<=12&&day>=1&&day<=days[month-1]?value:null;
}

/** Dates use the same Toronto training day as the existing app on every device. */
export function localDate(value=new Date()) {
  if(typeof value==='string') {
    const valid=dateString(value);
    if(!valid)throw new RangeError('Choose a complete, valid training date.');
    return valid;
  }
  if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw new RangeError('Choose a valid date.');
  return getTrainingToday(value);
}

/** ISO dates are calendar labels, so UTC calendar arithmetic never crosses a local DST hour. */
export function shiftDate(value,days) {
  const date=localDate(value);
  if(!Number.isInteger(days))throw new RangeError('Choose a whole number of days.');
  const instant=new Date(`${date}T12:00:00Z`);
  instant.setUTCDate(instant.getUTCDate()+days);
  const result=instant.toISOString().slice(0,10);
  if(!dateString(result))throw new RangeError('The selected date is outside the supported calendar.');
  return result;
}
export function weekStart(value=localDate()) {
  const date=localDate(value),day=new Date(`${date}T12:00:00Z`).getUTCDay();
  return shiftDate(date,-((day+6)%7));
}
export function weekDays(value=localDate()) {
  const start=weekStart(value);
  return Array.from({length:7},(_,index)=>shiftDate(start,index));
}

/** An explicit type always wins. Free-text inference classifies activity, never quantities. */
export function classifyTraining(name,explicitType) {
  const explicit=String(explicitType??'').trim().toLowerCase();
  if(typeInfo.has(explicit))return explicit;
  if(TYPE_ALIASES[explicit])return TYPE_ALIASES[explicit];
  const value=words(name),key=keyText(name);
  if(/repeater/.test(value))return 'repeaters';
  if(/\bmax(?:imal)?\s*hang|\bmaximum\s*hang/.test(value)||key==='maxhangs')return 'max_hangs';
  if(/\b(?:hang|finger)\s*board\b/.test(value))return 'hangboard';
  if((/\b4\s*[x×]\s*4\b|\bfour by four\b/.test(value)) && (/^(?:4\s*[x×]\s*4|four by four)$/.test(value)||/climb|boulder|board/.test(value)))return 'climbing_4x4';
  if(/\bkilter\b/.test(value))return 'kilter';
  if(/\btop\s*rope\b/.test(value)||key==='toprope')return 'toprope';
  if(/\blead(?:ing)?\b/.test(value))return 'lead';
  if(/boulder/.test(value))return 'boulder';
  if(/\bclimb(?:ing)?\b|\bmoon\s*board\b/.test(value))return 'climbing';
  if(/\b(?:running|run|walking|walk|cycling|bike|swimming|swim|cardio|mobility|stretching|yoga|rest day)\b/.test(value))return 'other';
  return 'strength';
}

const profile = (type,primary=[],secondary=[]) => ({type,primary:[...primary],secondary:secondary.filter(id=>!primary.includes(id)),mapped:primary.length>0});

function profileFor(name,type,category='') {
  if(typeInfo.get(type)?.group==='hangboard')return profile(type,['forearms'],['shoulders','upper_back']);
  if(typeInfo.get(type)?.group==='climbing')return profile(type,['forearms','lats','upper_back','biceps','core'],['shoulders','glutes','quadriceps','calves']);
  if(type==='other')return profile(type);
  const value=words(name),key=keyText(name);
  if(/unidentified|unknown exercise/.test(value))return profile(type);
  // The imported notes explicitly leave the triceps-versus-lat movement unresolved.
  if(/\bpull\s*down\b/.test(value)&&/\bunspecified\b/.test(value)&&!/\blat\b|\btriceps?\b/.test(value))return profile(type);
  if(/\b(?:finger|wrist)\s*(?:curl|up|extension)|\breverse wrist|\bgrip(?:per)?\b/.test(value))return profile(type,['forearms']);
  if(/\bdead\s*hang\b|\bno\s*hang\b/.test(value))return profile(type,['forearms'],['shoulders','upper_back']);
  if(/\bface\s*pull|\brear\s*(?:delt|shoulder).*fly|\breverse\s*fly/.test(value))return profile(type,['shoulders','upper_back'],['biceps']);
  if(/\bprone\s+[ity]\b|\bexternal\s*rotation|\bshoulder\s*rotation/.test(value))return profile(type,/\bprone/.test(value)?['upper_back','shoulders']:['shoulders']);
  if(/\bupright\s*row/.test(value))return profile(type,['shoulders','upper_back'],['biceps']);
  if(/\bscapular\s*dip/.test(value))return profile(type,['shoulders','upper_back'],['triceps']);
  if(/\bscapular\s*(?:pull|pullup)/.test(value))return profile(type,['upper_back','lats'],['forearms']);
  if(/\bfront\s*lever|\blever\s*tuck|\btuck(?:ed)?\s*lever/.test(value))return profile(type,['core','lats'],['shoulders','biceps','forearms']);
  if(/\bpull\s*up|\bchin\s*up|\bweighted\s*pull\b|\bfrenchies\b|\block\s*off/.test(value))return profile(type,['lats','upper_back'],['biceps','forearms','core']);
  if(/\b(?:tricep|triceps)\b/.test(value))return profile(type,/push\s*up/.test(value)?['triceps','chest']:['triceps'],/push\s*up/.test(value)?['shoulders']:[]);
  if(/\blat\b.*pull|\bpull\s*down/.test(value))return profile(type,['lats'],['upper_back','biceps','forearms']);
  if(/\brow\b|\brows\b/.test(value))return profile(type,['upper_back','lats'],['biceps','shoulders','forearms']);
  if(/\bbench\b.*press|\bbench\b|\bchest\s*(?:press|machine)|\bdb\s*bp\b|\bpec(?:toral)?\b.*(?:deck|fly)/.test(value) && !/curl/.test(value))return profile(type,['chest'],['shoulders','triceps']);
  if(/\bpush\s*up|\bpushup/.test(value))return profile(type,['chest','triceps'],['shoulders','core']);
  if(/\bdip\b|\bdips\b/.test(value))return profile(type,['chest','triceps'],['shoulders']);
  if(/\bohp\b|\boverhead\s*press|\bshoulder\s*press|\bmilitary\s*press/.test(value))return profile(type,['shoulders'],['triceps','upper_back']);
  if(/\b(?:lateral|front|shoulder)\s*raise|\bshoulder\s*isometric/.test(value))return profile(type,['shoulders'],['upper_back']);
  if(/\bdead\s*lift|\bdeadlift|\brdl\b/.test(value))return profile(type,['glutes','hamstrings','lower_back'],['quadriceps','forearms','upper_back','core']);
  if(/\b(?:squat|lunge|split squat)|\bleg\s*press/.test(value))return profile(type,['quadriceps','glutes'],['hamstrings','core','lower_back']);
  if(/\bleg\s*curl|\bhamstring/.test(value))return profile(type,['hamstrings']);
  if(/\bleg\s*extension/.test(value))return profile(type,['quadriceps']);
  if(/\bcalf\b|\bcalves\b/.test(value))return profile(type,['calves']);
  if(/\bhip\s*side\s*raise|\bhip\s*abduction/.test(value))return profile(type,['glutes']);
  if(/\bbridge\b|\bhip\s*thrust|\bglute\b/.test(value)||(/\bhip\s*raise/.test(value)&&String(category).toLowerCase()!=='core'))return profile(type,['glutes','hamstrings'],['core','lower_back']);
  if(/\bcurl\b|\bbicep(?:s)?\b/.test(value))return profile(type,['biceps'],['forearms']);
  if(/\bhip\s*flexor/.test(value))return profile(type,['hip_flexors'],['core']);
  if(/\b(?:knee|leg|hip)\s*raise|\bcorner\s*hang\s*touch/.test(value))return profile(type,['core','hip_flexors'],/hang|ring|parallel/.test(value)?['forearms','shoulders']:[]);
  if(/\bplank\b/.test(value))return profile(type,['core'],['shoulders','glutes']);
  if(/\bsit\s*up|\bcrunch|\bab\s*wheel/.test(value))return profile(type,['core'],['hip_flexors']);
  if(key==='ohp')return profile(type,['shoulders'],['triceps']);
  return profile(type);
}

/** General exercise-to-muscle exposure, not an estimate of stimulus or recovery. */
export function exerciseProfile(name,category='') {
  return profileFor(name,classifyTraining(name,category),category);
}

const countKeys=['planned','completed','partial','missed','skipped','pending','loggedExercises','workingSets','climbingSessions','attempts','sends','hangSets','hangSeconds','trainingDays','plannedDays','plannedSets','unknownPlannedSets'];
const counts = () => Object.fromEntries(countKeys.map(key=>[key,0]));
const hasRecordedUnits = row => positive(row.reps)||positive(row.duration_s);
function deduplicate(items,idKey='id') {
  const byId=new Map(),withoutIds=[];
  for(const item of list(items)) {
    if(!item||typeof item!=='object')continue;
    if(!item[idKey]){withoutIds.push(item);continue;}
    const previous=byId.get(item[idKey]);
    if(!previous||Number(item.revision||0)>=Number(previous.revision||0))byId.set(item[idKey],item);
  }
  return [...byId.values(),...withoutIds];
}
function itemBase(id,date,exercise,type,source,category='') {
  return {id,date,exercise,type,source,workingSets:0,climbingSessions:0,attempts:0,sends:0,hangSets:0,hangSeconds:0,profile:profileFor(exercise,type,category)};
}

/**
 * Summary contracts:
 * - completed is explicit calendar targets marked hit; actual logs never change reviews.
 * - loggedExercises counts working strength exercise/session blocks, nonempty climbing
 *   workouts, and nonempty hangboard workouts. Sets and attempts are separate units.
 * - muscle planned/actual Primary/Secondary values count exercise blocks. Strength sets,
 *   climbing sessions and hang sets are separate, never weighted into a synthetic score.
 */
export function buildWeekSummary({date=localDate(),today=localDate(),records=[],plans=[],climbingWorkouts=[],hangboardWorkouts=[],types}={}) {
  const dates=weekDays(date),start=dates[0],end=dates[6],todayDate=localDate(today);
  const selected=new Set(types==null?TRAINING_TYPES.map(type=>type.id):types instanceof Set?[...types]:list(types));
  const within=item=>active(item)&&dateString(item.date)&&item.date>=start&&item.date<=end;
  const categories=new Map(list(records).filter(active).filter(row=>row.exercise&&row.category).map(row=>[keyText(row.exercise),row.category]));
  const plannedItems=[];
  for(const plan of deduplicate(plans).filter(within)) {
    for(const target of deduplicate(plan.targets)) {
      if(!active(target)||typeof target.exercise!=='string'||!target.exercise.trim())continue;
      const type=classifyTraining(target.exercise,target.trainingType);
      if(!selected.has(type))continue;
      const status=['hit','partial','missed','skipped'].includes(target.status)?target.status:'planned';
      const plannedSets=type==='strength'&&Number.isInteger(target.plannedSets)&&target.plannedSets>0&&target.plannedSets<=1000?target.plannedSets:null;
      plannedItems.push({id:target.id||`${plan.id}:${plannedItems.length}`,planId:plan.id,date:plan.date,exercise:target.exercise,type,status,target:target.target||'',comment:target.comment||'',plannedSets,profile:profileFor(target.exercise,type,target.category||categories.get(keyText(target.exercise)))});
    }
  }

  const actualItems=[];
  const hangs=deduplicate(hangboardWorkouts);
  // The API excludes migrated sources too; this protects a stale client snapshot.
  const importedEntries=new Set(hangs.map(workout=>workout.source?.entryId||workout.source_entry_id).filter(Boolean));
  const sourceRecords=deduplicate(records,'record_id').filter(row=>within(row)&&!importedEntries.has(row.entry_id));
  const workingRows=analyze(sourceRecords,{from:start,to:end,metric:'reps'}).rows.filter(row=>row.included&&hasRecordedUnits(row));
  const groups=new Map();
  for(const row of workingRows) {
    const legacyType=row.tracking==='repeaters'?'repeaters':row.tracking==='max_hangs'?'max_hangs':row.trainingType;
    const type=classifyTraining(row.exercise,legacyType);
    if(!selected.has(type))continue;
    const group=typeInfo.get(type)?.group;
    const session=row.session??row.entry_id??'';
    const id=group==='hangboard'?`legacy:${row.date}:${row.entry_id||session}:${type}`:`strength:${row.date}:${session}:${keyText(row.exercise)}`;
    if(!groups.has(id))groups.set(id,{...itemBase(id,row.date,row.exercise,type,group==='hangboard'?'legacy_hangboard':'strength',row.category),rows:[]});
    groups.get(id).rows.push(row);
  }
  for(const item of groups.values()) {
    const group=typeInfo.get(item.type)?.group;
    if(group==='hangboard') {
      item.hangSets=new Set(item.rows.map((row,index)=>`${row.round??row.set??row.record_id??index}:${row.side||''}`)).size;
      item.hangSeconds=item.rows.reduce((sum,row)=>sum+(positive(row.duration_s)?row.duration_s*(positive(row.hold_count)?row.hold_count:1):0),0);
    } else if(group==='climbing') {
      item.climbingSessions=1;
    } else if(item.type==='strength')item.workingSets=item.rows.length;
    delete item.rows;
    actualItems.push(item);
  }

  for(const workout of deduplicate(climbingWorkouts).filter(within)) {
    const attempts=deduplicate(workout.attempts).filter(active);
    if(!attempts.length)continue;
    const inferred=classifyTraining(workout.title);
    const type=workout.trainingType?classifyTraining(workout.title,workout.trainingType):inferred==='climbing_4x4'?'climbing_4x4':classifyTraining(workout.title,workout.category);
    if(!selected.has(type))continue;
    const item=itemBase(`climbing:${workout.id}`,workout.date,workout.title||typeInfo.get(type)?.label||'Climbing',type,'climbing');
    item.climbingSessions=1;
    item.attempts=[...buildClimbAttemptTotals([{...workout,attempts}]).values()].reduce((sum,total)=>sum+total.attempts,0);
    item.sends=attempts.filter(attempt=>attempt.completed===true).length;
    actualItems.push(item);
  }

  for(const workout of hangs.filter(within)) {
    const sets=deduplicate(workout.sets).filter(active);
    if(!sets.length)continue;
    const type=classifyTraining(workout.title,workout.protocol);
    if(!selected.has(type))continue;
    const item=itemBase(`hangboard:${workout.id}`,workout.date,workout.title||typeInfo.get(type)?.label||'Hangboard',type,'hangboard');
    for(const set of sets) {
      if(set.isWarmup===true||set.status==='failed')continue;
      const seconds=list(set.segments).reduce((sum,part)=>sum+(positive(part?.seconds)&&Number.isInteger(part.count)&&part.count>0?part.seconds*part.count:0),0);
      if(seconds>0){item.hangSets++;item.hangSeconds+=seconds;}
    }
    actualItems.push(item);
  }
  const chronological=(a,b)=>a.date.localeCompare(b.date)||a.exercise.localeCompare(b.exercise)||String(a.id).localeCompare(String(b.id));
  plannedItems.sort(chronological);actualItems.sort(chronological);
  const days=dates.map((value,index)=>({date:value,weekday:['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'][index],isToday:value===todayDate,isFuture:value>todayDate,...counts(),plannedItems:[],actualItems:[]}));
  const dayByDate=new Map(days.map(day=>[day.date,day]));
  const byType=Object.fromEntries(TRAINING_TYPES.map(type=>[type.id,{...type,...counts()}]));
  const summary={start,end,today:todayDate,isCurrent:start<=todayDate&&end>=todayDate,isFuture:start>todayDate,...counts(),days,byType,plannedItems,actualItems};
  const add=(targets,key,value=1)=>targets.forEach(target=>{target[key]+=value;});
  for(const item of plannedItems) {
    const day=dayByDate.get(item.date),destinations=[summary,day,byType[item.type]];
    day.plannedItems.push(item);add(destinations,'planned');
    add(destinations,{hit:'completed',partial:'partial',missed:'missed',skipped:'skipped',planned:'pending'}[item.status]);
    if(item.type==='strength')add(destinations,item.plannedSets==null?'unknownPlannedSets':'plannedSets',item.plannedSets??1);
  }
  for(const item of actualItems) {
    const day=dayByDate.get(item.date),destinations=[summary,day,byType[item.type]];
    day.actualItems.push(item);add(destinations,'loggedExercises');
    for(const key of ['workingSets','climbingSessions','attempts','sends','hangSets','hangSeconds'])add(destinations,key,item[key]||0);
  }
  summary.trainingDays=new Set(actualItems.map(item=>item.date)).size;
  summary.plannedDays=new Set(plannedItems.map(item=>item.date)).size;
  for(const day of days){day.trainingDays=day.actualItems.length?1:0;day.plannedDays=day.plannedItems.length?1:0;}
  for(const type of TRAINING_TYPES){byType[type.id].trainingDays=new Set(actualItems.filter(item=>item.type===type.id).map(item=>item.date)).size;byType[type.id].plannedDays=new Set(plannedItems.filter(item=>item.type===type.id).map(item=>item.date)).size;}

  const muscles=MUSCLE_GROUPS.map(muscle=>({...muscle,plannedPrimary:0,plannedSecondary:0,actualPrimary:0,actualSecondary:0,plannedSets:0,plannedSecondarySets:0,unknownPlannedSets:0,workingSets:0,secondarySets:0,climbingSessions:0,secondaryClimbingSessions:0,hangSets:0,secondaryHangSets:0}));
  const muscleById=new Map(muscles.map(muscle=>[muscle.id,muscle]));
  const unmapped=new Map();
  const trackUnmapped=(item,field)=>{
    if(item.profile.mapped)return;
    const key=`${item.type}:${keyText(item.exercise)}`;
    if(!unmapped.has(key))unmapped.set(key,{exercise:item.exercise,type:item.type,planned:0,actual:0,workingSets:0});
    const entry=unmapped.get(key);entry[field]++;if(field==='actual')entry.workingSets+=item.workingSets;
  };
  for(const item of plannedItems) {
    trackUnmapped(item,'planned');
    for(const relation of ['primary','secondary'])for(const id of item.profile[relation]) {
      const muscle=muscleById.get(id);if(!muscle)continue;
      muscle[relation==='primary'?'plannedPrimary':'plannedSecondary']++;
      if(item.type==='strength') {
        if(item.plannedSets!=null)muscle[relation==='primary'?'plannedSets':'plannedSecondarySets']+=item.plannedSets;
        else if(relation==='primary')muscle.unknownPlannedSets++;
      }
    }
  }
  for(const item of actualItems) {
    trackUnmapped(item,'actual');
    // Empty/failed/warm-up-only hangboard work is logged, but is not working exposure.
    if(typeInfo.get(item.type)?.group==='hangboard'&&!item.hangSets)continue;
    for(const relation of ['primary','secondary'])for(const id of item.profile[relation]) {
      const muscle=muscleById.get(id);if(!muscle)continue;
      muscle[relation==='primary'?'actualPrimary':'actualSecondary']++;
      muscle[relation==='primary'?'workingSets':'secondarySets']+=item.workingSets;
      muscle[relation==='primary'?'climbingSessions':'secondaryClimbingSessions']+=item.climbingSessions;
      muscle[relation==='primary'?'hangSets':'secondaryHangSets']+=item.hangSets;
    }
  }
  summary.muscles=muscles;
  summary.unmapped=[...unmapped.values()].sort((a,b)=>a.exercise.localeCompare(b.exercise));
  return summary;
}
