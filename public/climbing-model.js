/** Shared, storage-independent validation and climb-library selection. */
import { getTrainingToday } from './exercise-archive.js';

export const CLIMB_CATEGORIES = Object.freeze([
  {id:'indoor_boulder',label:'Indoor boulder',discipline:'boulder',environment:'indoor'},
  {id:'indoor_lead',label:'Indoor lead',discipline:'lead',environment:'indoor'},
  {id:'indoor_toprope',label:'Indoor top rope',discipline:'toprope',environment:'indoor'},
  {id:'outdoor_boulder',label:'Outdoor boulder',discipline:'boulder',environment:'outdoor'},
  {id:'outdoor_lead',label:'Outdoor lead',discipline:'lead',environment:'outdoor'},
  {id:'outdoor_toprope',label:'Outdoor top rope',discipline:'toprope',environment:'outdoor'},
  {id:'kilter',label:'Kilter board',discipline:'boulder',environment:'board'},
].map(Object.freeze));
export const GRADE_SYSTEMS = Object.freeze([
  {id:'v',label:'V scale'}, {id:'font',label:'Fontainebleau'},
  {id:'yds',label:'YDS'}, {id:'french',label:'French'},
  {id:'gym',label:'Gym colour / circuit'}, {id:'other',label:'Other'},
].map(Object.freeze));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = 86400000;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const keyText = value => String(value ?? '').normalize('NFC').trim().replace(/\s+/gu,' ').toLocaleLowerCase('en');

export class ClimbingValidationError extends Error {
  constructor(field,message) { super(message); this.name='ClimbingValidationError'; this.status=400; this.field=field; }
}
const fail = (field,message) => { throw new ClimbingValidationError(field,message); };
export const categoryInfo = id => CLIMB_CATEGORIES.find(category => category.id === id) || null;
function object(value,field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field,'Enter a valid climbing workout.');
}
export function climbingId(value,field='id') {
  if (typeof value !== 'string' || !UUID.test(value.trim())) fail(field,'This identifier is invalid. Reopen the workout and try again.');
  return value.trim().toLowerCase();
}
export function climbingRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail('revision','Reload the latest version of this workout before saving.');
  return value;
}
export function climbingDate(value,field='date') {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) fail(field,'Choose a complete workout date.');
  const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]);
  const leap=year%4===0&&(year%100!==0||year%400===0);
  const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  if (year<1 || month<1 || month>12 || day<1 || day>days[month-1]) fail(field,'Choose a real calendar date.');
  return value.trim();
}
function text(value,field,limit,multiline=false) {
  if (value == null) return '';
  if (typeof value !== 'string') fail(field,'Enter a text value.');
  let clean=value.normalize('NFC').replace(/\r\n?/g,'\n').trim();
  if (!multiline) clean=clean.replace(/\s+/gu,' ');
  if (clean.length>limit) fail(field,`Keep this field to ${limit} characters or fewer.`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(clean)) fail(field,'Remove unsupported control characters.');
  return clean;
}
function quantity(value,field,min,max,{optional=false,integer=false,half=false}={}) {
  if (optional && value == null) return null;
  if (!finite(value) || value<min || value>max || (integer&&!Number.isInteger(value)) || (half&&!Number.isInteger(value*2))) {
    fail(field,`Enter ${integer?'a whole number':half?'a whole or half-point value':'a number'} from ${min} to ${max}${optional?', or leave it blank':''}.`);
  }
  return value;
}
function tags(value,field) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length>16) fail(field,'Use up to 16 climb tags.');
  const seen=new Set(),result=[];
  for (let index=0;index<value.length;index++) {
    const tag=text(value[index],`${field}[${index}]`,40);
    if (!tag) continue;
    const key=keyText(tag);
    if (!seen.has(key)) { seen.add(key); result.push(tag); }
  }
  return result;
}

/** Grades remain literal snapshots: no grade conversion or invented numeric rank. */
export function normalizeClimbingWorkout(input) {
  object(input,'workout');
  const id=climbingId(input.id),date=climbingDate(input.date),category=input.category;
  const info=categoryInfo(category);
  if (!info) fail('category','Choose one of the climbing categories.');
  const kilter=category==='kilter';
  const venue=text(input.venue,'venue',160),title=text(input.title,'title',120),notes=text(input.notes,'notes',4000,true);
  if (!kilter && input.defaultAngle != null) fail('defaultAngle','Wall angle belongs to Kilter workouts only.');
  const defaultAngle=kilter?quantity(input.defaultAngle,'defaultAngle',0,90,{optional:true}):null;
  if (!Array.isArray(input.attempts) || input.attempts.length>100) fail('attempts','Use up to 100 attempts in a workout. An empty workout is allowed.');
  const seen=new Set();
  const attempts=input.attempts.map((raw,index)=>{
    const prefix=`attempts[${index}]`;
    object(raw,prefix);
    const attemptId=climbingId(raw.id,`${prefix}.id`),climbId=climbingId(raw.climbId,`${prefix}.climbId`);
    if (seen.has(attemptId)) fail(`${prefix}.id`,'Each attempt needs its own identifier.');
    seen.add(attemptId);
    const gradeSystem=raw.gradeSystem??(info.discipline==='boulder'?'v':'yds');
    if (!GRADE_SYSTEMS.some(system=>system.id===gradeSystem)) fail(`${prefix}.gradeSystem`,'Choose a grade system.');
    const gradeMin=text(raw.gradeMin,`${prefix}.gradeMin`,40),gradeMax=text(raw.gradeMax,`${prefix}.gradeMax`,40);
    if (gradeMax&&!gradeMin) fail(`${prefix}.gradeMin`,'Enter the first grade before adding a grade range.');
    if (typeof raw.completed!=='boolean') fail(`${prefix}.completed`,'Choose whether this attempt was completed.');
    if (!kilter && raw.angle != null) fail(`${prefix}.angle`,'Wall angle belongs to Kilter attempts only.');
    return {
      id:attemptId,climbId,name:text(raw.name,`${prefix}.name`,160),tags:tags(raw.tags,`${prefix}.tags`),
      gradeSystem,gradeMin,gradeMax,
      attemptNumber:quantity(raw.attemptNumber,`${prefix}.attemptNumber`,1,9999,{integer:true}),
      completed:raw.completed,
      restSeconds:quantity(raw.restSeconds,`${prefix}.restSeconds`,0,86400,{optional:true,integer:true}),
      effort:quantity(raw.effort,`${prefix}.effort`,1,10,{optional:true,half:true}),
      notes:text(raw.notes,`${prefix}.notes`,2000,true),
      angle:kilter?quantity(raw.angle,`${prefix}.angle`,0,90):null,
    };
  });
  const workout={id,date,category,venue,title,notes,defaultAngle,attempts};
  const canonicalPayload=JSON.stringify({date,category,venue,title,notes,defaultAngle,attempts});
  return {...workout,canonicalPayload};
}

/**
 * Search-only key: displayed names and stable climb identities remain intact.
 * Compatibility-normalized letters, numbers and combining marks survive while
 * case, punctuation, symbols and spacing do not affect matching.
 */
export function climbNameKey(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]/gu,'');
}

/**
 * Search an already category/location/date-filtered catalogue without changing
 * its entries. Equal search keys are not climb identities: distinct saved IDs
 * remain distinct choices, in their existing order within each match rank.
 */
export function searchClimbCatalog(items=[],query='') {
  const rows=(Array.isArray(items)?items:[]).filter(item=>item&&typeof item==='object'&&!Array.isArray(item));
  const needle=climbNameKey(query);
  if(!needle)return rows.slice();
  return rows.map((item,index)=>{
    const name=climbNameKey(item.name);
    let rank=name===needle?0:name.startsWith(needle)?1:name.includes(needle)?2:Infinity;
    if(!Number.isFinite(rank)) {
      const fields=[item.venue,item.gradeMin,item.gradeMax,formatClimbGrade(item),item.gradeSystem,
        ...(Array.isArray(item.tags)?item.tags:[]),finite(item.angle)?String(item.angle):''];
      if(fields.some(value=>climbNameKey(value).includes(needle)))rank=3;
    }
    return {item,index,rank};
  }).filter(match=>Number.isFinite(match.rank)).sort((a,b)=>a.rank-b.rank||a.index-b.index).map(match=>match.item);
}

/**
 * Derive lifetime counts from the complete active history, independently of
 * catalogue/history filters. Attempt numbers are session ordinals: each
 * workout contributes its highest number for a climb (and Kilter angle), not
 * the sum of its row numbers. Sparse numbering includes implied earlier tries.
 * Rebuild from current snapshots after edits, deletions or restoration.
 */
export function buildClimbAttemptTotals(workouts=[]) {
  const groups=new Map();
  for (const workout of Array.isArray(workouts)?workouts:[]) {
    if (!workout || workout.deleted_at || workout.deletedAt || !validId(workout.id) || !categoryInfo(workout.category)) continue;
    const kilter=workout.category==='kilter',workoutId=workout.id.toLowerCase();
    for (const attempt of Array.isArray(workout.attempts)?workout.attempts:[]) {
      if (!attempt || !validId(attempt.id) || !validId(attempt.climbId) || !Number.isInteger(attempt.attemptNumber) || attempt.attemptNumber<1 || attempt.attemptNumber>9999) continue;
      if (kilter && (!finite(attempt.angle) || attempt.angle<0 || attempt.angle>90)) continue;
      const key=`${workout.category}:${attempt.climbId.toLowerCase()}`,angle=kilter?attempt.angle:null;
      if (!groups.has(key)) groups.set(key,{kilter,sessions:new Map()});
      const sessions=groups.get(key).sessions;
      if (!sessions.has(workoutId)) sessions.set(workoutId,new Map());
      const maxima=sessions.get(workoutId);
      maxima.set(angle,Math.max(maxima.get(angle)||0,attempt.attemptNumber));
    }
  }
  const index=new Map();
  for (const [key,{kilter,sessions}] of groups) {
    let attempts=0;
    const angles=new Map();
    for (const maxima of sessions.values()) for (const [angle,count] of maxima) {
      attempts+=count;
      if (kilter) {
        if (!angles.has(angle)) angles.set(angle,{angle,attempts:0,sessions:0});
        const total=angles.get(angle);total.attempts+=count;total.sessions++;
      }
    }
    index.set(key,{attempts,sessions:sessions.size,angles:[...angles.values()].sort((a,b)=>a.angle-b.angle)});
  }
  return index;
}

/** Return all-angle totals and, for a valid Kilter angle, its separate totals. */
export function climbAttemptTotalsFor(index,category,climbId,angle=null) {
  const total=index instanceof Map && categoryInfo(category) && validId(climbId)?index.get(`${category}:${climbId.toLowerCase()}`):null;
  const hasAngle=category==='kilter' && finite(angle) && angle>=0 && angle<=90;
  const variant=hasAngle?total?.angles.find(item=>item.angle===angle):null;
  return {attempts:total?.attempts??0,sessions:total?.sessions??0,angleAttempts:hasAngle?(variant?.attempts??0):null,angleSessions:hasAngle?(variant?.sessions??0):null};
}

/** Return the supplied grade or range, preserving gym-specific notation. */
export function formatClimbGrade(record={}) {
  const first=typeof record.gradeMin==='string'?record.gradeMin.trim():'';
  const last=typeof record.gradeMax==='string'?record.gradeMax.trim():'';
  return first?(last&&last!==first?`${first}–${last}`:first):'Ungraded';
}
function validDate(value) { try { return climbingDate(value); } catch { return null; } }
function validId(value) { return typeof value==='string'&&UUID.test(value); }
function later(a,b) {
  return a.date.localeCompare(b.date) || a.updatedAt.localeCompare(b.updatedAt) || a.workoutId.localeCompare(b.workoutId) || a.index-b.index;
}
function snapshot(candidate) {
  const {workout,attempt}=candidate;
  return {
    id:attempt.climbId.toLowerCase(),climbId:attempt.climbId.toLowerCase(),category:workout.category,venue:workout.venue||'',
    name:attempt.name||'',tags:Array.isArray(attempt.tags)?[...attempt.tags]:[],
    gradeSystem:attempt.gradeSystem,gradeMin:attempt.gradeMin||'',gradeMax:attempt.gradeMax||'',
    angle:finite(attempt.angle)?attempt.angle:null,lastLoggedDate:workout.date,lastWorkoutId:workout.id,
  };
}

/**
 * Build choices from all saved, undeleted workouts. Recent selection is only a
 * view: it never removes older workouts or changes their climb snapshots.
 * The inclusive cutoff is referenceDate minus 30 calendar days. Invalid or
 * absent category is rejected, so separate climbing histories cannot mix.
 */
export function buildClimbCatalog(workouts=[],{category,referenceDate=getTrainingToday(),includeOlder=false,venue=''}={}) {
  if (!categoryInfo(category)) fail('category','Choose a climbing category for the climb library.');
  const today=climbingDate(referenceDate,'referenceDate');
  const cutoff=new Date(Date.parse(`${today}T12:00:00Z`)-30*DAY).toISOString().slice(0,10);
  const location=keyText(venue),groups=new Map();
  for (const workout of Array.isArray(workouts)?workouts:[]) {
    if (!workout || workout.deleted_at || workout.deletedAt || workout.category!==category || !validDate(workout.date)) continue;
    if (location&&keyText(workout.venue)!==location) continue;
    // Future entries must not hide an otherwise recently logged past attempt.
    if (!includeOlder&&workout.date>today) continue;
    for (let index=0;index<(Array.isArray(workout.attempts)?workout.attempts.length:0);index++) {
      const attempt=workout.attempts[index];
      if (!attempt||!validId(attempt.climbId)) continue;
      const key=`${category}:${attempt.climbId.toLowerCase()}`;
      const candidate={workout,attempt,index,date:workout.date,updatedAt:String(workout.updated_at||workout.created_at||''),workoutId:String(workout.id||'')};
      if (!groups.has(key)) groups.set(key,[]);
      groups.get(key).push(candidate);
    }
  }
  const items=[];
  for (const candidates of groups.values()) {
    candidates.sort(later);
    const newest=candidates.at(-1);
    if (!includeOlder&&newest.date<cutoff) continue;
    const item=snapshot(newest);
    // Keep angle-specific grade memories separate; selecting a different board
    // angle must not imply that the latest grade applies at that angle.
    const variants=new Map();
    if (category==='kilter') for (const candidate of candidates) {
      if (!finite(candidate.attempt.angle)) continue;
      const detail=snapshot(candidate);
      variants.set(detail.angle,{angle:detail.angle,gradeSystem:detail.gradeSystem,gradeMin:detail.gradeMin,gradeMax:detail.gradeMax,lastLoggedDate:detail.lastLoggedDate,lastWorkoutId:detail.lastWorkoutId,venue:detail.venue});
    }
    item.variants=[...variants.values()].sort((a,b)=>a.angle-b.angle);
    items.push(item);
  }
  return items.sort((a,b)=>b.lastLoggedDate.localeCompare(a.lastLoggedDate)||a.name.localeCompare(b.name)||a.venue.localeCompare(b.venue)||a.climbId.localeCompare(b.climbId));
}
