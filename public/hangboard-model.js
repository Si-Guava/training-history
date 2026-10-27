/** Pure Hangboard validation, recorded-time summaries, and lossless repeater import. */
export const HANGBOARD_PROTOCOLS = Object.freeze([
  {id:'repeaters', label:'Repeaters', description:'Cycles of repeater sets, with separate rest between hangs, sets and cycles.'},
  {id:'max_hangs', label:'Max hangs', description:'Individual holds with their own load, duration and recovery.'},
].map(Object.freeze));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HANDS = new Set(['unspecified','both','left','right']);
const LOAD_MODES = new Set(['bodyweight','added','assisted','absolute','unknown']);
const STATUSES = new Set(['unknown','completed','partial','failed']);
const finite = value => typeof value === 'number' && Number.isFinite(value);

export class HangboardValidationError extends Error {
  constructor(field,message) {
    super(message);
    this.name='HangboardValidationError';
    this.status=400;
    this.field=field;
  }
}
const fail = (field,message) => { throw new HangboardValidationError(field,message); };
function object(value,field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field,'Enter a valid hangboard workout.');
}
export function hangboardId(value,field='id') {
  if (typeof value !== 'string' || !UUID.test(value.trim())) fail(field,'This identifier is invalid. Reopen the workout and try again.');
  return value.trim().toLowerCase();
}
export function hangboardRevision(value) {
  if (!Number.isSafeInteger(value) || value<1) fail('revision','Reload the latest version of this workout before saving.');
  return value;
}
export function hangboardDate(value,field='date') {
  const match=typeof value==='string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) fail(field,'Choose a complete workout date.');
  const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]);
  const leap=year%4===0&&(year%100!==0||year%400===0);
  const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  if (year<1||month<1||month>12||day<1||day>days[month-1]) fail(field,'Choose a real calendar date.');
  return value.trim();
}
function text(value,field,maximum,{verbatim=false}={}) {
  if (value==null) return '';
  if (typeof value!=='string') fail(field,'Enter a text value.');
  // Notes are kept verbatim, including their original whitespace and wording.
  const clean=verbatim?value:value.normalize('NFC').trim().replace(/\s+/gu,' ');
  if (clean.length>maximum) fail(field,'Keep this field to '+maximum+' characters or fewer.');
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(clean)) fail(field,'Remove unsupported control characters.');
  return clean;
}
function quantity(value,field,min,max,{optional=false,integer=false,positive=false,half=false}={}) {
  if (optional&&value==null) return null;
  if (!finite(value)||value<min||value>max||(positive&&value===0)||(integer&&!Number.isInteger(value))||(half&&!Number.isInteger(value*2))) {
    fail(field,'Enter '+(integer?'a whole number':half?'a whole or half-point value':'a number')+
      (positive?' greater than zero and up to '+max:' from '+min+' to '+max)+(optional?', or leave it blank':'')+'.');
  }
  return Object.is(value,-0)?0:value;
}
function selection(value,allowed,fallback,field,message) {
  const answer=value??fallback;
  if (!allowed.has(answer)) fail(field,message);
  return answer;
}
function notApplicable(value,field,message) {
  if (value!=null) fail(field,message);
  return null;
}

function cloneWorkout(input) {
  object(input,'workout');
  try { return structuredClone(input); }
  catch { fail('workout','The workout could not be copied safely. Reload it before editing.'); }
}
function reservedIds(input) {
  const ids=new Set();
  const add=value=>{if(typeof value==='string'&&UUID.test(value.trim()))ids.add(value.trim().toLowerCase());};
  add(input.id);
  for(const set of Array.isArray(input.sets)?input.sets:[]) {
    add(set?.id);
    for(const part of Array.isArray(set?.segments)?set.segments:[])add(part?.id);
  }
  for(const cycle of Array.isArray(input.cycles)?input.cycles:[])add(cycle?.id);
  return ids;
}
function legacyCycleId(input) {
  const id=hangboardId(input.id),reserved=reservedIds(input),first=Number.parseInt(id.slice(0,8),16);
  // A stable, reversible prefix transform keeps UUID version/variant bits and
  // needs no random generation, asynchronous hashing, or data written on reads.
  // Distinct candidates guarantee a free ID among this bounded workout's IDs.
  for(let attempt=0;attempt<=reserved.size;attempt++) {
    const prefix=((first^((0x48424f41+attempt)>>>0))>>>0).toString(16).padStart(8,'0');
    const candidate=prefix+id.slice(8);
    if(!reserved.has(candidate))return candidate;
  }
  fail('cycles','A cycle identifier could not be created safely.');
}

/**
 * Adapt a legacy flat repeater workout without mutating the source or guessing
 * its original grouping. Explicit cycles, including an empty array, are never
 * replaced. Only the final set's recovery moves to the new single cycle.
 * All metadata and unrelated fields are copied intact for read/edit workflows.
 */
export function upgradeHangboardWorkout(input) {
  const result=cloneWorkout(input);
  if(result.cycles!==undefined)return result;
  if(result.protocol==='max_hangs') { result.cycles=[]; return result; }
  if(result.protocol!=='repeaters'||!Array.isArray(result.sets))return result;
  if(!result.sets.length) { result.cycles=[]; return result; }
  const last=result.sets.at(-1);
  const restAfterCycleSeconds=last?.restAfterSetSeconds??null;
  result.cycles=[{id:legacyCycleId(result),setIds:result.sets.map(set=>set?.id),restAfterCycleSeconds}];
  if(last&&typeof last==='object'&&!Array.isArray(last))last.restAfterSetSeconds=null;
  return result;
}

function readCycles(rawCycles,sets,protocol,unique,{validateRest=true}={}) {
  if(!Array.isArray(rawCycles)||rawCycles.length>100)fail('cycles','Use up to 100 cycles.');
  if(protocol!=='repeaters') {
    if(rawCycles.length)fail('cycles','Cycles belong to repeater workouts. Max hangs record individual sets.');
    return [];
  }
  const byId=new Map(sets.map((set,index)=>[hangboardId(set.id,'sets['+index+'].id'),{set,index}]));
  const assigned=new Set(),ordered=[];
  const cycles=rawCycles.map((raw,index)=>{
    const field='cycles['+index+']';
    object(raw,field);
    const id=unique(raw.id,field+'.id');
    if(!Array.isArray(raw.setIds)||raw.setIds.length>100)fail(field+'.setIds','List the sets in this cycle, in workout order.');
    const setIds=raw.setIds.map((value,setIndex)=>{
      const setField=field+'.setIds['+setIndex+']',setId=hangboardId(value,setField);
      if(!byId.has(setId))fail(setField,'This cycle refers to a set that is not in the workout.');
      if(assigned.has(setId))fail(setField,'Each set can belong to only one cycle.');
      assigned.add(setId);ordered.push(setId);
      return setId;
    });
    const restAfterCycleSeconds=validateRest
      ?quantity(raw.restAfterCycleSeconds,field+'.restAfterCycleSeconds',0,86400,{optional:true})
      :raw.restAfterCycleSeconds??null;
    return {...(validateRest?{}:raw),id,setIds,restAfterCycleSeconds};
  });
  const expected=sets.map(set=>hangboardId(set.id));
  if(ordered.length!==expected.length||ordered.some((id,index)=>id!==expected[index])) {
    fail('cycles','Cycles must contain every set exactly once, in the same order as the workout.');
  }
  for(const cycle of cycles) {
    if(!cycle.setIds.length)continue;
    const {set,index}=byId.get(cycle.setIds.at(-1));
    if(set.restAfterSetSeconds!=null)fail('sets['+index+'].restAfterSetSeconds','Record recovery after the last set as rest after its cycle, so the same boundary is not counted twice.');
  }
  return cycles;
}
function prepareCycleDraft(input) {
  const workout=upgradeHangboardWorkout(input);
  if(workout.protocol!=='repeaters')fail('protocol','Cycles belong to repeater workouts.');
  if(!Array.isArray(workout.sets)||workout.sets.length>100)fail('sets','Use up to 100 sets.');
  const seen=new Set([hangboardId(workout.id)]);
  const unique=(value,field)=>{
    const id=hangboardId(value,field);
    if(seen.has(id))fail(field,'Each cycle, set and hang component needs its own identifier.');
    seen.add(id);return id;
  };
  workout.sets.forEach((set,index)=>{
    const field='sets['+index+']';object(set,field);unique(set.id,field+'.id');
    for(const [partIndex,part] of (Array.isArray(set.segments)?set.segments:[]).entries()) {
      unique(part?.id,field+'.segments['+partIndex+'].id');
    }
  });
  workout.cycles=readCycles(workout.cycles,workout.sets,workout.protocol,unique,{validateRest:false});
  return workout;
}

/**
 * Start a new cycle at atSetId. The previous set's recovery becomes recovery
 * after the head cycle; the original cycle's recovery follows the tail cycle.
 * Incomplete numeric fields in an editor draft are preserved for later review.
 */
export function splitHangboardCycle(input,cycleId,atSetId,{idFactory=()=>crypto.randomUUID()}={}) {
  const workout=prepareCycleDraft(input),cycleKey=hangboardId(cycleId,'cycleId'),setKey=hangboardId(atSetId,'atSetId');
  const index=workout.cycles.findIndex(cycle=>cycle.id===cycleKey);
  if(index<0)fail('cycles','Choose an existing cycle to split.');
  if(workout.cycles.length>=100)fail('cycles','Use up to 100 cycles.');
  const cycle=workout.cycles[index],splitAt=cycle.setIds.indexOf(setKey);
  if(splitAt<=0)fail('cycles['+index+'].setIds','Choose a set after the first set in this cycle to start the next cycle.');
  if(typeof idFactory!=='function')fail('cycles','A new cycle identifier could not be created.');
  const newId=hangboardId(idFactory(),'cycles['+(index+1)+'].id');
  if(reservedIds(workout).has(newId))fail('cycles['+(index+1)+'].id','The new cycle needs a distinct identifier.');
  const previousSet=workout.sets.find(set=>hangboardId(set.id)===cycle.setIds[splitAt-1]);
  const head={...cycle,setIds:cycle.setIds.slice(0,splitAt),restAfterCycleSeconds:previousSet.restAfterSetSeconds??null};
  const tail={id:newId,setIds:cycle.setIds.slice(splitAt),restAfterCycleSeconds:cycle.restAfterCycleSeconds??null};
  previousSet.restAfterSetSeconds=null;
  workout.cycles.splice(index,1,head,tail);
  return workout;
}

/**
 * Merge the selected cycle with the immediately preceding cycle. Their known
 * boundary recovery becomes rest before the next set. Ambiguous empty-cycle
 * recoveries are rejected instead of being silently discarded or summed.
 */
export function mergeHangboardCycle(input,cycleId) {
  const workout=prepareCycleDraft(input),key=hangboardId(cycleId,'cycleId');
  const index=workout.cycles.findIndex(cycle=>cycle.id===key);
  if(index<=0)fail('cycles','Choose a cycle with a previous cycle to merge.');
  const previous=workout.cycles[index-1],current=workout.cycles[index];
  const beforeRest=previous.restAfterCycleSeconds??null,afterRest=current.restAfterCycleSeconds??null;
  const beforeHasSets=previous.setIds.length>0,afterHasSets=current.setIds.length>0;
  let mergedRest;
  if(beforeHasSets&&afterHasSets) {
    const lastPreviousSet=workout.sets.find(set=>hangboardId(set.id)===previous.setIds.at(-1));
    lastPreviousSet.restAfterSetSeconds=beforeRest;
    mergedRest=afterRest;
  } else if(!beforeHasSets&&afterHasSets) {
    if(beforeRest!==null)fail('cycles['+(index-1)+'].restAfterCycleSeconds','The empty cycle has recorded recovery before the next cycle. Move or clear that recovery explicitly before merging.');
    mergedRest=afterRest;
  } else {
    if(beforeRest!==null&&afterRest!==null)fail('cycles['+index+'].restAfterCycleSeconds','Both cycles have recorded recovery and one is empty. Review these two intervals before merging so neither is discarded.');
    mergedRest=afterRest??beforeRest;
  }
  workout.cycles.splice(index-1,2,{...previous,setIds:[...previous.setIds,...current.setIds],restAfterCycleSeconds:mergedRest});
  return workout;
}

/**
 * Normalize recorded workout fields without deriving targets, successful
 * completion, bodyweight, or unrecorded rest. A workout may be saved empty.
 */
export function normalizeHangboardWorkout(input) {
  object(input,'workout');
  const id=hangboardId(input.id),date=hangboardDate(input.date),protocol=input.protocol;
  if (!HANGBOARD_PROTOCOLS.some(item=>item.id===protocol)) fail('protocol','Choose Repeaters or Max hangs.');
  const repeaters=protocol==='repeaters';
  input=upgradeHangboardWorkout(input);
  const title=text(input.title,'title',120),location=text(input.location,'location',160);
  const notes=text(input.notes,'notes',4000,{verbatim:true});
  const bodyweightLb=quantity(input.bodyweightLb,'bodyweightLb',0,1000,{optional:true,positive:true});
  if (!Array.isArray(input.sets)||input.sets.length>100) fail('sets','Use up to 100 sets. An empty workout is allowed.');
  const seen=new Set([id]);
  function unique(value,field) {
    const key=hangboardId(value,field);
    if (seen.has(key)) fail(field,'Each cycle, set and hang component needs its own identifier.');
    seen.add(key);
    return key;
  }
  const sets=input.sets.map((raw,index)=>{
    const field='sets['+index+']';
    object(raw,field);
    const setId=unique(raw.id,field+'.id');
    const hand=selection(raw.hand,HANDS,'unspecified',field+'.hand','Choose both hands, left, right, or unspecified.');
    const loadMode=selection(raw.loadMode,LOAD_MODES,'unknown',field+'.loadMode','Choose how the load was recorded.');
    const loadLb=loadMode==='bodyweight'||loadMode==='unknown'
      ?notApplicable(raw.loadLb,field+'.loadLb','Leave load blank for bodyweight or unknown load.')
      :quantity(raw.loadLb,field+'.loadLb',0,10000);
    if (typeof raw.isWarmup!=='boolean') fail(field+'.isWarmup','Choose whether this was a warm-up set.');
    const status=selection(raw.status,STATUSES,'unknown',field+'.status','Choose a recorded set result or leave it unknown.');
    const targetHangs=repeaters
      ?quantity(raw.targetHangs,field+'.targetHangs',1,1000,{optional:true,integer:true})
      :notApplicable(raw.targetHangs,field+'.targetHangs','A max-hang set contains one hold; leave repeater target count blank.');
    const restBetweenHangsSeconds=repeaters
      ?quantity(raw.restBetweenHangsSeconds,field+'.restBetweenHangsSeconds',0,86400,{optional:true})
      :notApplicable(raw.restBetweenHangsSeconds,field+'.restBetweenHangsSeconds','For max hangs, record recovery as rest after the set.');
    if (!Array.isArray(raw.segments)||raw.segments.length<1||raw.segments.length>(repeaters?20:1)) {
      fail(field+'.segments',repeaters?'Add between 1 and 20 hang components to this set.':'A max-hang set records exactly one hold.');
    }
    const segments=raw.segments.map((part,partIndex)=>{
      const partField=field+'.segments['+partIndex+']';
      object(part,partField);
      const segmentId=unique(part.id,partField+'.id');
      const seconds=quantity(part.seconds,partField+'.seconds',0,86400);
      const count=quantity(part.count,partField+'.count',repeaters?0:1,repeaters?1000:1,{integer:true});
      return {id:segmentId,seconds,count};
    });
    return {
      id:setId,grip:text(raw.grip,field+'.grip',120),
      edgeMm:quantity(raw.edgeMm,field+'.edgeMm',0,200,{optional:true,positive:true}),
      hand,loadMode,loadLb,setup:text(raw.setup,field+'.setup',200),
      isWarmup:raw.isWarmup,status,targetHangs,
      targetHangSeconds:quantity(raw.targetHangSeconds,field+'.targetHangSeconds',0,86400,{optional:true,positive:true}),
      restBetweenHangsSeconds,
      restAfterSetSeconds:quantity(raw.restAfterSetSeconds,field+'.restAfterSetSeconds',0,86400,{optional:true}),
      segments,effort:quantity(raw.effort,field+'.effort',1,10,{optional:true,half:true}),
      notes:text(raw.notes,field+'.notes',2000,{verbatim:true}),
    };
  });
  const cycles=readCycles(input.cycles,sets,protocol,unique);
  const workout={id,date,protocol,title,location,notes,bodyweightLb,sets,cycles};
  const canonicalPayload=JSON.stringify({date,protocol,title,location,notes,bodyweightLb,sets,cycles});
  return {...workout,canonicalPayload};
}

/** Counts include recorded components once: hands and rest never multiply time. */
export function summarizeHangboardWorkout(workout={}) {
  const cycleCount=workout.protocol==='repeaters'
    ?Array.isArray(workout.cycles)?workout.cycles.length:workout.cycles===undefined&&Array.isArray(workout.sets)&&workout.sets.length?1:0
    :0;
  const summary={setCount:0,cycleCount,hangCount:0,activeSeconds:0,workingActiveSeconds:0,warmupActiveSeconds:0};
  for (const set of Array.isArray(workout.sets)?workout.sets:[]) {
    if (!set||typeof set!=='object') continue;
    summary.setCount++;
    let seconds=0;
    for (const part of Array.isArray(set.segments)?set.segments:[]) {
      if (!finite(part?.seconds)||part.seconds<0||!Number.isInteger(part.count)||part.count<0) continue;
      summary.hangCount+=part.count;
      seconds+=part.seconds*part.count;
    }
    summary.activeSeconds+=seconds;
    if (set.isWarmup===true) summary.warmupActiveSeconds+=seconds;
    else if (set.status!=='failed') summary.workingActiveSeconds+=seconds;
  }
  return summary;
}

/** Rest is intentionally separate so unknown recovery cannot look like zero. */
export function formatHangboardPattern(set={},protocol='repeaters') {
  const parts=(Array.isArray(set.segments)?set.segments:[])
    .filter(part=>finite(part?.seconds)&&part.seconds>=0&&Number.isInteger(part.count)&&part.count>=0);
  if (!parts.length) return 'Hang duration not recorded';
  if (protocol==='max_hangs') return String(parts[0].seconds)+' s hold';
  return parts.map(part=>String(part.count)+' × '+String(part.seconds)+' s').join(' + ');
}

function legacyGrip(note) {
  const original=typeof note==='string'?note.trim():'';
  const matches=[...original.matchAll(/\b(\d+(?:\.\d+)?)\s*mm\b/giu)];
  let edgeMm=null,grip=original;
  if (matches.length===1) {
    const value=Number(matches[0][1]);
    if (finite(value)&&value>0&&value<=200) {
      edgeMm=value;
      grip=(original.slice(0,matches[0].index)+original.slice(matches[0].index+matches[0][0].length)).replace(/\s+/gu,' ').trim();
    }
  }
  // Long prose remains entirely in notes rather than being truncated into a grip.
  return {grip:grip.length<=120?grip:'',edgeMm};
}

/**
 * Move one saved repeater entry into a Hangboard snapshot. Source persistence and
 * idempotency belong to the API. The original payload is retained there intact.
 * Child IDs are assigned only when a new import is created; no source is mutated.
 */
export function importRepeaterEntry(entry,{idFactory=()=>crypto.randomUUID()}={}) {
  object(entry,'source');
  if (entry.tracking!=='repeaters') fail('source.tracking','Only an explicitly recorded repeater workout can be moved automatically.');
  const id=hangboardId(entry.id,'source.id'),date=hangboardDate(entry.date,'source.date');
  if (entry.deleted_at||entry.deletedAt) fail('source','Restore this source workout before moving it.');
  if (!Array.isArray(entry.records)||entry.records.length<1||entry.records.length>100) fail('source.records','The source must contain between 1 and 100 recorded repeater sets.');
  const modeMap={bodyweight:'bodyweight',weight:'absolute',pullup:'added'};
  const loadMode=modeMap[entry.loadMode];
  if (!loadMode) fail('source.loadMode','This source load setup needs review before it can be moved without changing its meaning.');
  if (typeof idFactory!=='function') fail('source.idFactory','The import could not create set identifiers.');
  const seenRecords=new Set(),seenRounds=new Set();
  const sets=entry.records.map((record,index)=>{
    const field='source.records['+index+']';
    object(record,field);
    if (typeof record.record_id!=='string'||!record.record_id||seenRecords.has(record.record_id)) fail(field+'.record_id','Every source record must have a distinct recorded identifier.');
    seenRecords.add(record.record_id);
    if (record.tracking!=null&&record.tracking!=='repeaters') fail(field+'.tracking','The source contains a set recorded with a different tracking method.');
    if (record.date!=null&&record.date!==date) fail(field+'.date','The source contains sets from different dates.');
    if (record.entry_id!=null&&hangboardId(record.entry_id,field+'.entry_id')!==id) fail(field+'.entry_id','A source set belongs to a different saved entry.');
    if (record.exercise!=null&&entry.exercise!=null&&record.exercise!==entry.exercise) fail(field+'.exercise','The source contains sets from different exercises.');
    const seconds=quantity(record.duration_s,field+'.duration_s',0,86400,{positive:true});
    const count=quantity(record.hold_count,field+'.hold_count',1,1000,{integer:true});
    const hand=record.side==null||record.side===''?'unspecified':record.side==='Left'?'left':record.side==='Right'?'right':null;
    if (!hand) fail(field+'.side','The source hand selection could not be read without guessing.');
    const round=quantity(record.round,field+'.round',1,1000,{integer:true});
    const roundKey=String(round)+':'+hand;
    if (seenRounds.has(roundKey)) {
      fail(field+'.round','This legacy round contains multiple duration components for the same hand selection. Review their grouping before moving it so components do not become separate full sets.');
    }
    seenRounds.add(roundKey);
    if (typeof record.is_warmup!=='boolean') fail(field+'.is_warmup','The source warm-up status could not be read without guessing.');
    const loadLb=loadMode==='bodyweight'
      ?notApplicable(record.load_lb,field+'.load_lb','The source mixes bodyweight with a numeric load and needs review.')
      :quantity(record.load_lb,field+'.load_lb',0,10000);
    const notes=text(record.notes,field+'.notes',2000,{verbatim:true});
    return {
      id:idFactory(),...legacyGrip(notes),hand,loadMode,loadLb,
      setup:record.resistance_setup??entry.setupLabel??'',
      isWarmup:record.is_warmup,status:'unknown',
      targetHangs:null,targetHangSeconds:null,
      restBetweenHangsSeconds:quantity(record.rest_s,field+'.rest_s',0,86400,{optional:true}),
      restAfterSetSeconds:quantity(record.round_rest_s,field+'.round_rest_s',0,86400,{optional:true}),
      segments:[{id:idFactory(),seconds,count}],effort:null,notes,
    };
  });
  return normalizeHangboardWorkout({
    id,date,protocol:'repeaters',title:'Repeaters',location:'',
    notes:entry.notes??'',bodyweightLb:null,sets,
  });
}
