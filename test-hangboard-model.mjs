import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  HANGBOARD_PROTOCOLS,HangboardValidationError,hangboardId,hangboardRevision,hangboardDate,
  normalizeHangboardWorkout,summarizeHangboardWorkout,formatHangboardPattern,importRepeaterEntry,
  upgradeHangboardWorkout,splitHangboardCycle,mergeHangboardCycle,
} from './public/hangboard-model.js';

const segment=(patch={})=>({id:randomUUID(),seconds:8,count:5,...patch});
const set=(patch={})=>({
  id:randomUUID(),grip:'Open hand',edgeMm:18,hand:'both',loadMode:'bodyweight',loadLb:null,
  setup:'Portable board',isWarmup:false,status:'unknown',targetHangs:null,targetHangSeconds:null,
  restBetweenHangsSeconds:4,restAfterSetSeconds:null,segments:[segment()],effort:null,notes:'',...patch,
});
const workout=(patch={})=>({
  id:randomUUID(),date:'2026-08-14',protocol:'repeaters',title:'Evening hangs',location:'Home',
  notes:'',bodyweightLb:null,sets:[set()],...patch,
});
const maxSet=(patch={})=>set({targetHangs:null,restBetweenHangsSeconds:null,segments:[segment({count:1,seconds:10})],...patch});
function invalid(input,field) {
  assert.throws(()=>normalizeHangboardWorkout(input),error=>error instanceof HangboardValidationError&&error.status===400&&error.field===field);
}
function legacy(patch={}) {
  const id=randomUUID(),date='2026-08-14';
  const descriptions=['Open hand 18mm','Three finger drag','40 degree sloper','Half crimp 18mm','Open hand 18mm','Three finger drag','Sloper 40 degrees'];
  return {
    id,date,exercise:'Recorded hanging drill',tracking:'repeaters',loadMode:'bodyweight',
    setupLabel:'',notes:'Synthetic migration fixture.',
    records:[5,4,3,2,5,4,3].map((count,index)=>({
      record_id:'M_'+id+'_'+(index+1),entry_id:id,date,exercise:'Recorded hanging drill',
      tracking:'repeaters',duration_s:8,hold_count:count,side:null,round:index+1,
      rest_s:index===3?null:4,round_rest_s:null,is_warmup:false,load_lb:null,
      resistance_setup:'Bodyweight; no mass estimate',notes:descriptions[index],
    })),...patch,
  };
}

test('protocols have stable identities and empty workouts remain valid',()=>{
  assert.deepEqual(HANGBOARD_PROTOCOLS.map(p=>p.id),['repeaters','max_hangs']);
  assert.ok(Object.isFrozen(HANGBOARD_PROTOCOLS));assert.ok(HANGBOARD_PROTOCOLS.every(Object.isFrozen));
  for(const protocol of ['repeaters','max_hangs'])assert.deepEqual(normalizeHangboardWorkout(workout({protocol,sets:[]})).sets,[]);
  invalid(workout({protocol:'dead_hang'}),'protocol');
  invalid(workout({sets:null}),'sets');
  invalid(workout({sets:Array.from({length:101},()=>set())}),'sets');
});

test('repeaters preserve actual components, targets, load, grip and separate rests without mutation',()=>{
  const input=workout({title:'  Mixed   repeaters ',location:' Home   wall ',bodyweightLb:170,
    sets:[set({loadMode:'added',loadLb:15,hand:'left',targetHangs:6,targetHangSeconds:8,
      restBetweenHangsSeconds:4,restAfterSetSeconds:150,effort:8.5,status:'partial',
      segments:[segment({seconds:8,count:4}),segment({seconds:5,count:1})]})]});
  const before=structuredClone(input),value=normalizeHangboardWorkout(input),s=value.sets[0];
  assert.equal(value.title,'Mixed repeaters');assert.equal(value.location,'Home wall');
  assert.equal(value.bodyweightLb,170);assert.equal(s.loadMode,'added');assert.equal(s.loadLb,15);
  assert.equal(s.hand,'left');assert.equal(s.edgeMm,18);assert.equal(s.targetHangs,6);
  assert.equal(s.targetHangSeconds,8);assert.equal(s.restBetweenHangsSeconds,4);assert.equal(s.restAfterSetSeconds,null);
  assert.equal(value.cycles[0].restAfterCycleSeconds,150);
  assert.equal(s.effort,8.5);assert.equal(s.status,'partial');
  assert.equal(formatHangboardPattern(s,'repeaters'),'4 × 8 s + 1 × 5 s');
  assert.equal(summarizeHangboardWorkout(value).activeSeconds,37);
  assert.deepEqual(input,before);
});

test('unknown fields remain unknown and explicit zero measurements remain zero',()=>{
  const value=normalizeHangboardWorkout(workout({title:undefined,location:undefined,notes:undefined,bodyweightLb:undefined,
    sets:[set({grip:undefined,edgeMm:undefined,hand:undefined,loadMode:undefined,loadLb:undefined,
      setup:undefined,status:undefined,targetHangs:undefined,targetHangSeconds:undefined,
      restBetweenHangsSeconds:undefined,restAfterSetSeconds:0,effort:undefined,notes:undefined,
      segments:[segment({seconds:0,count:0})]})]}));
  const s=value.sets[0];
  assert.equal(value.bodyweightLb,null);assert.equal(value.title,'');assert.equal(value.notes,'');
  assert.equal(s.grip,'');assert.equal(s.edgeMm,null);assert.equal(s.hand,'unspecified');
  assert.equal(s.loadMode,'unknown');assert.equal(s.loadLb,null);assert.equal(s.status,'unknown');
  assert.equal(s.targetHangs,null);assert.equal(s.targetHangSeconds,null);assert.equal(s.restBetweenHangsSeconds,null);
  assert.equal(s.restAfterSetSeconds,null);assert.equal(value.cycles[0].restAfterCycleSeconds,0);
  assert.equal(s.effort,null);assert.equal(s.notes,'');
  assert.deepEqual(summarizeHangboardWorkout(value),{setCount:1,cycleCount:1,hangCount:0,activeSeconds:0,workingActiveSeconds:0,warmupActiveSeconds:0});
  invalid(workout({sets:[set({segments:[segment({seconds:null})]})]}),'sets[0].segments[0].seconds');
  invalid(workout({sets:[set({segments:[segment({count:null})]})]}),'sets[0].segments[0].count');
});

test('max hangs record one hold per set and reject repeater-only data',()=>{
  const value=normalizeHangboardWorkout(workout({protocol:'max_hangs',sets:[maxSet({loadMode:'assisted',loadLb:20,targetHangSeconds:10,restAfterSetSeconds:180,status:'partial',segments:[segment({count:1,seconds:6.5})]})]}));
  assert.equal(formatHangboardPattern(value.sets[0],'max_hangs'),'6.5 s hold');
  assert.equal(summarizeHangboardWorkout(value).activeSeconds,6.5);
  invalid(workout({protocol:'max_hangs',sets:[maxSet({targetHangs:1})]}),'sets[0].targetHangs');
  invalid(workout({protocol:'max_hangs',sets:[maxSet({restBetweenHangsSeconds:0})]}),'sets[0].restBetweenHangsSeconds');
  invalid(workout({protocol:'max_hangs',sets:[maxSet({segments:[segment({count:2})]})]}),'sets[0].segments[0].count');
  invalid(workout({protocol:'max_hangs',sets:[maxSet({segments:[segment({count:0})]})]}),'sets[0].segments[0].count');
  invalid(workout({protocol:'max_hangs',sets:[maxSet({segments:[segment({count:1}),segment({count:1})]})]}),'sets[0].segments');
  const failed=normalizeHangboardWorkout(workout({protocol:'max_hangs',sets:[maxSet({status:'failed',segments:[segment({count:1,seconds:0})]})]}));
  assert.equal(failed.sets[0].segments[0].seconds,0);assert.equal(summarizeHangboardWorkout(failed).activeSeconds,0);
});

test('mass modes preserve their meaning without inventing total load or bodyweight',()=>{
  for(const loadMode of ['added','assisted','absolute']) {
    const s=normalizeHangboardWorkout(workout({sets:[set({loadMode,loadLb:42.5})]})).sets[0];
    assert.equal(s.loadMode,loadMode);assert.equal(s.loadLb,42.5);
    assert.ok(!Object.hasOwn(s,'totalLoadLb'));
  }
  for(const loadMode of ['bodyweight','unknown']) {
    invalid(workout({sets:[set({loadMode,loadLb:0})]}),'sets[0].loadLb');
    assert.equal(normalizeHangboardWorkout(workout({sets:[set({loadMode,loadLb:null})]})).sets[0].loadLb,null);
  }
  invalid(workout({sets:[set({loadMode:'weight'})]}),'sets[0].loadMode');
  invalid(workout({sets:[set({loadMode:'added',loadLb:null})]}),'sets[0].loadLb');
  invalid(workout({sets:[set({loadMode:'assisted',loadLb:-5})]}),'sets[0].loadLb');
  invalid(workout({sets:[set({loadMode:'absolute',loadLb:Infinity})]}),'sets[0].loadLb');
  invalid(workout({bodyweightLb:0}),'bodyweightLb');
});

test('identifiers, calendars, revisions and bounded quantities reject malformed records',()=>{
  const id=randomUUID();assert.equal(hangboardId(id.toUpperCase()),id);
  for(const date of ['0001-01-01','2000-02-29','2024-02-29','9999-12-31'])assert.equal(hangboardDate(date),date);
  for(const date of ['0000-01-01','1900-02-29','2026-02-29','2026-13-01','2026-01-00'])assert.throws(()=>hangboardDate(date),HangboardValidationError);
  assert.equal(hangboardRevision(1),1);for(const revision of [0,-1,1.5,'1',Infinity])assert.throws(()=>hangboardRevision(revision),HangboardValidationError);
  const duplicate=set();invalid(workout({sets:[duplicate,structuredClone(duplicate)]}),'sets[1].id');
  const shared=segment();invalid(workout({sets:[set({segments:[shared,structuredClone(shared)]})]}),'sets[0].segments[1].id');
  const same=set();same.segments[0].id=same.id;invalid(workout({sets:[same]}),'sets[0].segments[0].id');
  invalid(workout({sets:[set({isWarmup:'false'})]}),'sets[0].isWarmup');
  invalid(workout({sets:[set({hand:'Left'})]}),'sets[0].hand');
  invalid(workout({sets:[set({status:'success'})]}),'sets[0].status');
  for(const edgeMm of [0,-1,201,'20',Infinity])invalid(workout({sets:[set({edgeMm})]}),'sets[0].edgeMm');
  for(const count of [-1,1.5,1001,'6'])invalid(workout({sets:[set({segments:[segment({count})]})]}),'sets[0].segments[0].count');
  for(const seconds of [-1,86401,'7',NaN])invalid(workout({sets:[set({segments:[segment({seconds})]})]}),'sets[0].segments[0].seconds');
  for(const effort of [0,10.5,7.25,NaN])invalid(workout({sets:[set({effort})]}),'sets[0].effort');
  invalid(workout({sets:[set({segments:[]})]}),'sets[0].segments');
  invalid(workout({sets:[set({segments:Array.from({length:21},()=>segment())})]}),'sets[0].segments');
  invalid(workout({sets:[set({targetHangs:0})]}),'sets[0].targetHangs');
  invalid(workout({sets:[set({targetHangSeconds:0})]}),'sets[0].targetHangSeconds');
  invalid(workout({sets:[set({restAfterSetSeconds:86401})]}),'cycles[0].restAfterCycleSeconds');
});

test('notes remain verbatim and literal text is preserved rather than executed or truncated',()=>{
  const notes='  Original wording\r\nSecond line: e\u0301 <script>alert(1)</script>  ';
  const value=normalizeHangboardWorkout(workout({notes,sets:[set({notes})]}));
  assert.equal(value.notes,notes);assert.equal(value.sets[0].notes,notes);
  assert.equal(normalizeHangboardWorkout(workout({title:"Hang'); DROP TABLE workouts; --"})).title,"Hang'); DROP TABLE workouts; --");
  invalid(workout({notes:'x'.repeat(4001)}),'notes');
  invalid(workout({sets:[set({notes:'x'.repeat(2001)})]}),'sets[0].notes');
  invalid(workout({sets:[set({grip:'x'.repeat(121)})]}),'sets[0].grip');
  invalid(workout({sets:[set({notes:'\u0000'})]}),'sets[0].notes');
});

test('recorded-time summaries count each hang once, exclude rest, and distinguish failed or warm-up sets',()=>{
  const value=normalizeHangboardWorkout(workout({sets:[
    set({hand:'both',status:'completed',restBetweenHangsSeconds:900,restAfterSetSeconds:800,segments:[segment({count:3,seconds:10})]}),
    set({hand:'left',isWarmup:true,segments:[segment({count:2,seconds:5})]}),
    set({hand:'right',status:'failed',segments:[segment({count:1,seconds:4})]}),
    set({status:'partial',segments:[segment({count:2,seconds:7}),segment({count:1,seconds:3})]}),
  ]}));
  assert.deepEqual(summarizeHangboardWorkout(value),{setCount:4,cycleCount:1,hangCount:9,activeSeconds:61,workingActiveSeconds:47,warmupActiveSeconds:10});
  assert.deepEqual(summarizeHangboardWorkout({sets:[]}),{setCount:0,cycleCount:0,hangCount:0,activeSeconds:0,workingActiveSeconds:0,warmupActiveSeconds:0});
});

test('saved max-hang working time includes every recorded result while warm-ups stay separate',()=>{
  const statuses=['unknown','completed','partial','failed',undefined];
  const value=normalizeHangboardWorkout(workout({protocol:'max_hangs',sets:[
    ...statuses.map((status,index)=>maxSet({status,restAfterSetSeconds:180,segments:[segment({count:1,seconds:index+1})]})),
    maxSet({isWarmup:true,status:'failed',segments:[segment({count:1,seconds:5})]}),
  ]}));
  assert.deepEqual(summarizeHangboardWorkout(value),{
    setCount:6,cycleCount:0,hangCount:6,activeSeconds:20,workingActiveSeconds:15,warmupActiveSeconds:5,
  });
  const repeater=normalizeHangboardWorkout(workout({sets:[set({status:'failed',segments:[segment({count:1,seconds:4})]})]}));
  assert.equal(summarizeHangboardWorkout(repeater).workingActiveSeconds,0);
});

test('canonical retry payload ignores server metadata but retains measurement and ordering changes',()=>{
  const input=upgradeHangboardWorkout(workout({sets:[set(),set()]})),one=normalizeHangboardWorkout(input);
  const two=normalizeHangboardWorkout({...input,id:randomUUID(),revision:99,source:{entryId:randomUUID()},created_at:'ignored',updated_at:'ignored',deleted_at:'ignored'});
  assert.equal(one.canonicalPayload,two.canonicalPayload);
  assert.deepEqual(Object.keys(JSON.parse(one.canonicalPayload)),['date','protocol','title','location','notes','bodyweightLb','sets','cycles']);
  assert.notEqual(one.canonicalPayload,normalizeHangboardWorkout({...input,sets:[...input.sets].reverse(),cycles:input.cycles.map(c=>({...c,setIds:[...c.setIds].reverse()}))}).canonicalPayload);
  assert.notEqual(one.canonicalPayload,normalizeHangboardWorkout({...input,sets:input.sets.map((s,i)=>({...s,restAfterSetSeconds:i===0?0:null}))}).canonicalPayload);
  assert.equal(normalizeHangboardWorkout(one).canonicalPayload,one.canonicalPayload);
});

test('repeater import preserves every synthetic source measurement and note without inventing missing details',()=>{
  const source=legacy(),before=structuredClone(source);
  let generated=0;
  const result=importRepeaterEntry(source,{idFactory:()=>{generated++;return randomUUID();}});
  assert.equal(generated,14);assert.equal(result.id,source.id);assert.equal(result.date,source.date);
  assert.equal(result.protocol,'repeaters');assert.equal(result.title,'Repeaters');
  assert.equal(result.notes,source.notes);assert.equal(result.bodyweightLb,null);assert.equal(result.sets.length,7);
  result.sets.forEach((s,index)=>{
    const r=source.records[index];
    assert.equal(s.segments[0].seconds,r.duration_s);assert.equal(s.segments[0].count,r.hold_count);
    assert.equal(s.restBetweenHangsSeconds,r.rest_s);assert.equal(s.restAfterSetSeconds,r.round_rest_s);
    assert.equal(s.notes,r.notes);assert.equal(s.hand,'unspecified');assert.equal(s.loadMode,'bodyweight');assert.equal(s.loadLb,null);
    assert.equal(s.targetHangs,null);assert.equal(s.targetHangSeconds,null);assert.equal(s.status,'unknown');assert.equal(s.effort,null);
    assert.equal(s.isWarmup,r.is_warmup);
  });
  assert.equal(result.sets[0].edgeMm,18);assert.equal(result.sets[0].grip,'Open hand');
  assert.equal(result.sets[1].edgeMm,null);assert.equal(result.sets[1].grip,'Three finger drag');
  assert.equal(result.sets[2].edgeMm,null);assert.equal(result.sets[2].grip,'40 degree sloper');
  assert.equal(result.sets[3].restBetweenHangsSeconds,null);
  assert.deepEqual(summarizeHangboardWorkout(result),{setCount:7,cycleCount:1,hangCount:26,activeSeconds:208,workingActiveSeconds:208,warmupActiveSeconds:0});
  assert.deepEqual(source,before);
  assert.equal(normalizeHangboardWorkout(result).canonicalPayload,result.canonicalPayload);
});

test('import retains explicit left/right, load and unusual notes without cross-set assumptions',()=>{
  const source=legacy({loadMode:'weight'});
  source.records.forEach((r,i)=>{r.load_lb=60+i;r.side=i%2?'Left':'Right';});
  source.records[0].notes='  18mm + 22mm comparison\r\nKeep all notes.  ';
  source.records[1].notes='x'.repeat(150);
  source.records[2].notes='0mm mark, not an edge';
  const result=importRepeaterEntry(source);
  assert.equal(result.sets[0].edgeMm,null);assert.equal(result.sets[0].notes,source.records[0].notes);
  assert.equal(result.sets[1].grip,'');assert.equal(result.sets[1].notes,source.records[1].notes);
  assert.equal(result.sets[2].edgeMm,null);
  result.sets.forEach((s,i)=>{assert.equal(s.loadMode,'absolute');assert.equal(s.loadLb,60+i);assert.equal(s.hand,i%2?'left':'right');});
  const added=legacy({loadMode:'pullup'});added.records.forEach(r=>{r.load_lb=0;});
  assert.equal(importRepeaterEntry(added).sets[0].loadMode,'added');
  assert.equal(importRepeaterEntry(added).bodyweightLb,null);
});

test('automatic import rejects ambiguous or malformed sources rather than changing their meaning',()=>{
  const reject=(source,field)=>assert.throws(()=>importRepeaterEntry(source),error=>error instanceof HangboardValidationError&&error.field===field);
  reject(legacy({tracking:'timed'}),'source.tracking');
  reject(legacy({loadMode:'band'}),'source.loadMode');
  reject(legacy({records:[]}),'source.records');
  reject(legacy({deleted_at:'2026-08-15T12:00:00Z'}),'source');
  const modify=(fn)=>{const source=legacy();fn(source);return source;};
  reject(modify(s=>{s.records[0].duration_s=null;}),'source.records[0].duration_s');
  reject(modify(s=>{s.records[0].hold_count=0;}),'source.records[0].hold_count');
  reject(modify(s=>{s.records[0].rest_s='4';}),'source.records[0].rest_s');
  reject(modify(s=>{s.records[0].side='Maybe left';}),'source.records[0].side');
  reject(modify(s=>{delete s.records[0].is_warmup;}),'source.records[0].is_warmup');
  reject(modify(s=>{s.records[0].load_lb=10;}),'source.records[0].load_lb');
  reject(modify(s=>{s.records[0].tracking='reps';}),'source.records[0].tracking');
  reject(modify(s=>{s.records[0].date='2026-08-15';}),'source.records[0].date');
  reject(modify(s=>{s.records[0].entry_id=randomUUID();}),'source.records[0].entry_id');
  reject(modify(s=>{s.records[0].exercise='Other exercise';}),'source.records[0].exercise');
  reject(modify(s=>{s.records[1].record_id=s.records[0].record_id;}),'source.records[1].record_id');
});

test('import rejects ambiguous same-round components but preserves distinct left and right rounds',()=>{
  const source=legacy();
  source.records[1].round=source.records[0].round;
  assert.throws(()=>importRepeaterEntry(source),error=>
    error instanceof HangboardValidationError&&error.field==='source.records[1].round'&&/multiple duration components/.test(error.message));
  source.records[0].side='Left';source.records[1].side='Right';
  const imported=importRepeaterEntry(source);
  assert.equal(imported.sets.length,source.records.length);
  assert.deepEqual(imported.sets.slice(0,2).map(s=>s.hand),['left','right']);
  for(const invalidRound of [undefined,null,0,-1,1.5,1001,'1']){
    const malformed=legacy();malformed.records[0].round=invalidRound;
    assert.throws(()=>importRepeaterEntry(malformed),error=>error instanceof HangboardValidationError&&error.field==='source.records[0].round');
  }
});


const cycle=(sets=[],patch={})=>({id:randomUUID(),setIds:sets.map(s=>s.id),restAfterCycleSeconds:null,...patch});
const helperInvalid=(fn,field)=>assert.throws(fn,error=>error instanceof HangboardValidationError&&error.status===400&&error.field===field);

test('legacy cycle adaptation is deterministic, idempotent, and preserves metadata and internal recovery',()=>{
  const input=workout({sets:[set({restAfterSetSeconds:0}),set({restAfterSetSeconds:null}),set({restAfterSetSeconds:37.5})],
    revision:4,created_at:'2026-08-14T10:00:00Z',source:{entryId:randomUUID(),recordIds:['synthetic-a','synthetic-b']}});
  const before=structuredClone(input),adapted=upgradeHangboardWorkout(input);
  assert.deepEqual(input,before);
  assert.deepEqual(adapted.source,input.source);assert.equal(adapted.revision,input.revision);assert.equal(adapted.created_at,input.created_at);
  assert.notEqual(adapted.source,input.source);assert.notEqual(adapted.sets,input.sets);
  assert.equal(adapted.cycles.length,1);assert.equal(hangboardId(adapted.cycles[0].id),adapted.cycles[0].id);
  assert.deepEqual(adapted.cycles[0].setIds,input.sets.map(s=>s.id));
  assert.equal(adapted.cycles[0].restAfterCycleSeconds,37.5);
  assert.deepEqual(adapted.sets.map(s=>s.restAfterSetSeconds),[0,null,null]);
  adapted.sets.forEach((s,index)=>assert.deepEqual(s,{...input.sets[index],restAfterSetSeconds:index===2?null:input.sets[index].restAfterSetSeconds}));
  assert.deepEqual(upgradeHangboardWorkout(input),adapted);
  assert.deepEqual(upgradeHangboardWorkout(adapted),adapted);
  assert.equal(normalizeHangboardWorkout(input).canonicalPayload,normalizeHangboardWorkout(adapted).canonicalPayload);
  const explicit={...input,cycles:[]};assert.deepEqual(upgradeHangboardWorkout(explicit),explicit);
  invalid(explicit,'cycles');
});

test('legacy adaptation keeps zero distinct from unknown and leaves max-hang recovery intact',()=>{
  for(const rest of [undefined,null,0,86400]) {
    const input=workout({sets:[set({restAfterSetSeconds:rest})]});
    const result=normalizeHangboardWorkout(input);
    assert.equal(result.cycles[0].restAfterCycleSeconds,rest??null);
    assert.equal(result.sets[0].restAfterSetSeconds,null);
  }
  const max=workout({protocol:'max_hangs',sets:[maxSet({restAfterSetSeconds:0}),maxSet({restAfterSetSeconds:180})]});
  const adapted=upgradeHangboardWorkout(max);
  assert.deepEqual(adapted.sets,max.sets);assert.deepEqual(adapted.cycles,[]);
  assert.deepEqual(normalizeHangboardWorkout(max).sets.map(s=>s.restAfterSetSeconds),[0,180]);
  assert.equal(summarizeHangboardWorkout(normalizeHangboardWorkout(max)).cycleCount,0);
  for(const protocol of ['repeaters','max_hangs'])assert.deepEqual(upgradeHangboardWorkout(workout({protocol,sets:[]})).cycles,[]);
});

test('derived legacy cycle identifiers avoid every reserved identifier without random reads',()=>{
  const input=workout(),first=upgradeHangboardWorkout(input).cycles[0].id;
  input.sets[0].id=first;
  const second=upgradeHangboardWorkout(input).cycles[0].id;
  assert.notEqual(second,first);assert.notEqual(second,input.id);
  input.sets[0].segments[0].id=second;
  const third=upgradeHangboardWorkout(input).cycles[0].id;
  assert.notEqual(third,first);assert.notEqual(third,second);assert.notEqual(third,input.id);
  assert.equal(upgradeHangboardWorkout(input).cycles[0].id,third);
  assert.equal(normalizeHangboardWorkout(input).cycles[0].id,third);
});

test('cycles must reference every set exactly once and retain the workout order',()=>{
  const sets=[set(),set(),set()],input=workout({sets,cycles:[cycle(sets.slice(0,2)),cycle(sets.slice(2))]});
  assert.deepEqual(normalizeHangboardWorkout(input).cycles,input.cycles);
  const changed=(fn)=>{const copy=structuredClone(input);fn(copy);return copy;};
  invalid(changed(w=>{w.cycles[1].setIds.push(w.sets[0].id);}),'cycles[1].setIds[1]');
  invalid(changed(w=>{w.cycles[0].setIds[0]=randomUUID();}),'cycles[0].setIds[0]');
  invalid(changed(w=>{w.cycles[0].setIds.pop();}),'cycles');
  invalid(changed(w=>{w.cycles[0].setIds.reverse();}),'cycles');
  invalid(changed(w=>{w.cycles.reverse();}),'cycles');
  invalid(changed(w=>{w.cycles[0].setIds=null;}),'cycles[0].setIds');
  invalid(changed(w=>{w.cycles[0].setIds[0]='bad-id';}),'cycles[0].setIds[0]');
  invalid(changed(w=>{w.cycles[1].id=w.cycles[0].id;}),'cycles[1].id');
  invalid(changed(w=>{w.cycles[0].id=w.id;}),'cycles[0].id');
  invalid(changed(w=>{w.cycles[0].id=w.sets[0].id;}),'cycles[0].id');
  invalid(changed(w=>{w.cycles[0].id=w.sets[0].segments[0].id;}),'cycles[0].id');
  const upper=changed(w=>{w.cycles[0].id=w.cycles[0].id.toUpperCase();w.cycles[0].setIds=w.cycles[0].setIds.map(id=>id.toUpperCase());});
  assert.deepEqual(normalizeHangboardWorkout(upper).cycles,input.cycles);
});

test('cycle boundaries have one recovery value, with bounds and empty cycles validated explicitly',()=>{
  const sets=[set({restAfterSetSeconds:60}),set(),set()],input=workout({sets,cycles:[cycle(sets.slice(0,2),{restAfterCycleSeconds:540}),cycle(sets.slice(2))]});
  const changed=(fn)=>{const copy=structuredClone(input);fn(copy);return copy;};
  for(const value of [0,30])invalid(changed(w=>{w.sets[1].restAfterSetSeconds=value;}),'sets[1].restAfterSetSeconds');
  invalid(changed(w=>{w.sets[2].restAfterSetSeconds=0;}),'sets[2].restAfterSetSeconds');
  invalid(changed(w=>{w.sets[0].restAfterSetSeconds=-1;}),'sets[0].restAfterSetSeconds');
  for(const value of [-1,86401,Infinity,NaN,'540'])invalid(changed(w=>{w.cycles[0].restAfterCycleSeconds=value;}),'cycles[0].restAfterCycleSeconds');
  for(const value of [undefined,null,0,0.5,86400])assert.equal(normalizeHangboardWorkout(changed(w=>{w.cycles[0].restAfterCycleSeconds=value;})).cycles[0].restAfterCycleSeconds,value??null);
  invalid({...input,cycles:null},'cycles');
  invalid({...input,cycles:Array.from({length:101},()=>cycle())},'cycles');
  const empty=normalizeHangboardWorkout(workout({sets:[],cycles:Array.from({length:100},()=>cycle())}));
  assert.equal(empty.cycles.length,100);assert.equal(summarizeHangboardWorkout(empty).cycleCount,100);
  const withEmpty=normalizeHangboardWorkout({...input,cycles:[cycle([],{restAfterCycleSeconds:0}),...input.cycles,cycle()]});
  assert.equal(withEmpty.cycles.length,4);assert.equal(summarizeHangboardWorkout(withEmpty).cycleCount,4);
  invalid(workout({protocol:'max_hangs',sets:[maxSet()],cycles:[cycle()]}),'cycles');
});

test('regrouping preserves all recorded measurements and keeps recovery out of hang-time totals',()=>{
  const sets=Array.from({length:7},(_,i)=>set({notes:'  Synthetic original '+i+'\n',segments:[segment({count:i+1,seconds:5})]}));
  const input=normalizeHangboardWorkout(workout({sets})),before=structuredClone(input);
  const regrouped=normalizeHangboardWorkout({...input,cycles:[cycle(sets.slice(0,4),{restAfterCycleSeconds:540}),cycle(sets.slice(4))]});
  assert.deepEqual(regrouped.sets,input.sets);assert.deepEqual(input,before);
  const first=summarizeHangboardWorkout(input),second=summarizeHangboardWorkout(regrouped);
  assert.equal(first.cycleCount,1);assert.equal(second.cycleCount,2);
  assert.deepEqual({...second,cycleCount:first.cycleCount},first);
  assert.equal(second.hangCount,28);assert.equal(second.activeSeconds,140);
  assert.notEqual(regrouped.canonicalPayload,input.canonicalPayload);
  const changedRecovery=normalizeHangboardWorkout({...regrouped,cycles:regrouped.cycles.map((c,i)=>({...c,restAfterCycleSeconds:i===0?0:null}))});
  assert.notEqual(changedRecovery.canonicalPayload,regrouped.canonicalPayload);
  assert.deepEqual(summarizeHangboardWorkout(changedRecovery),second);
});

test('splitting and merging cycles transfer the same interval without changing recorded sets or metadata',()=>{
  for(const boundaryRest of [null,0,45.5])for(const trailingRest of [null,0,300]) {
    const original=upgradeHangboardWorkout(workout({sets:[set({restAfterSetSeconds:60}),set({restAfterSetSeconds:boundaryRest}),set({restAfterSetSeconds:trailingRest})],
      revision:7,source:{entryId:randomUUID()},notes:'  Keep the original text.\n'}));
    const before=structuredClone(original),newId=randomUUID();
    const split=splitHangboardCycle(original,original.cycles[0].id,original.sets[2].id,{idFactory:()=>newId});
    assert.deepEqual(original,before);assert.equal(split.revision,7);assert.deepEqual(split.source,original.source);assert.equal(split.notes,original.notes);
    assert.deepEqual(split.cycles.map(c=>c.id),[original.cycles[0].id,newId]);
    assert.deepEqual(split.cycles.map(c=>c.setIds),[original.sets.slice(0,2).map(s=>s.id),[original.sets[2].id]]);
    assert.deepEqual(split.cycles.map(c=>c.restAfterCycleSeconds),[boundaryRest,trailingRest]);
    assert.equal(split.sets[1].restAfterSetSeconds,null);
    split.sets.forEach((s,i)=>assert.deepEqual(s,{...original.sets[i],restAfterSetSeconds:i===1?null:original.sets[i].restAfterSetSeconds}));
    const merged=mergeHangboardCycle(split,newId);
    assert.deepEqual(merged,original);assert.equal(normalizeHangboardWorkout(merged).canonicalPayload,normalizeHangboardWorkout(original).canonicalPayload);
    assert.equal(split.sets[1].restAfterSetSeconds,null);
  }
});

test('cycle operations support incomplete editor drafts and leave neighboring cycles unchanged',()=>{
  const sets=[set(),set({restAfterSetSeconds:0}),set({segments:[segment({count:null,seconds:null})],loadMode:'added',loadLb:null}),set()];
  const input=workout({title:'  Draft ',sets,cycles:[cycle(sets.slice(0,1)),cycle(sets.slice(1,3),{restAfterCycleSeconds:17}),cycle(sets.slice(3))],revision:2});
  const before=structuredClone(input),newId=randomUUID();
  const split=splitHangboardCycle(input,input.cycles[1].id,sets[2].id,{idFactory:()=>newId});
  assert.deepEqual(split.cycles[0],input.cycles[0]);assert.deepEqual(split.cycles[3],input.cycles[2]);
  assert.equal(split.sets[2].segments[0].seconds,null);assert.equal(split.sets[2].segments[0].count,null);assert.equal(split.sets[2].loadLb,null);assert.equal(split.title,'  Draft ');
  assert.deepEqual(mergeHangboardCycle(split,newId),input);assert.deepEqual(input,before);
});

test('invalid cycle draft operations fail before changing the caller data',()=>{
  const input=upgradeHangboardWorkout(workout({sets:[set(),set()]})),before=structuredClone(input),id=input.cycles[0].id;
  helperInvalid(()=>splitHangboardCycle(input,id,input.sets[0].id),'cycles[0].setIds');
  helperInvalid(()=>splitHangboardCycle(input,id,randomUUID()),'cycles[0].setIds');
  helperInvalid(()=>splitHangboardCycle(input,randomUUID(),input.sets[1].id),'cycles');
  helperInvalid(()=>splitHangboardCycle(input,id,input.sets[1].id,{idFactory:()=>input.sets[0].segments[0].id}),'cycles[1].id');
  helperInvalid(()=>splitHangboardCycle(input,id,input.sets[1].id,{idFactory:null}),'cycles');
  helperInvalid(()=>mergeHangboardCycle(input,id),'cycles');
  helperInvalid(()=>mergeHangboardCycle(input,randomUUID()),'cycles');
  const max=workout({protocol:'max_hangs',sets:[maxSet()]});
  helperInvalid(()=>splitHangboardCycle(max,id,max.sets[0].id),'protocol');
  helperInvalid(()=>mergeHangboardCycle(max,id),'protocol');
  const full={...input,cycles:[...input.cycles,...Array.from({length:99},()=>cycle())]};
  helperInvalid(()=>splitHangboardCycle(full,id,input.sets[1].id),'cycles');
  assert.deepEqual(input,before);
});

test('merging empty cycles preserves the recoveries it can represent and rejects ambiguous intervals',()=>{
  const make=(previousSets,currentSets,beforeRest,afterRest)=>{
    const sets=[...previousSets,...currentSets];
    return workout({sets,cycles:[cycle(previousSets,{restAfterCycleSeconds:beforeRest}),cycle(currentSets,{restAfterCycleSeconds:afterRest})]});
  };
  for(const beforeRest of [0,60]) {
    const input=make([],[set()],beforeRest,180),before=structuredClone(input);
    helperInvalid(()=>mergeHangboardCycle(input,input.cycles[1].id),'cycles[0].restAfterCycleSeconds');
    assert.deepEqual(input,before);
  }
  for(const afterRest of [null,0,180]) {
    const input=make([],[set()],null,afterRest),merged=mergeHangboardCycle(input,input.cycles[1].id);
    assert.equal(merged.cycles[0].id,input.cycles[0].id);assert.deepEqual(merged.sets,input.sets);
    assert.equal(merged.cycles[0].restAfterCycleSeconds,afterRest);
  }
  for(const populated of [false,true])for(const [beforeRest,afterRest,expected] of [[null,null,null],[0,null,0],[null,0,0],[60,null,60],[null,180,180]]) {
    const input=make(populated?[set()]:[],[],beforeRest,afterRest),merged=mergeHangboardCycle(input,input.cycles[1].id);
    assert.deepEqual(merged.sets,input.sets);assert.equal(merged.cycles.length,1);assert.equal(merged.cycles[0].restAfterCycleSeconds,expected);
    assert.deepEqual(normalizeHangboardWorkout(merged).cycles,merged.cycles);
  }
  for(const populated of [false,true])for(const [beforeRest,afterRest] of [[0,0],[0,180],[60,0],[60,180]]) {
    const input=make(populated?[set()]:[],[],beforeRest,afterRest),before=structuredClone(input);
    helperInvalid(()=>mergeHangboardCycle(input,input.cycles[1].id),'cycles[1].restAfterCycleSeconds');
    assert.deepEqual(input,before);
  }
});
