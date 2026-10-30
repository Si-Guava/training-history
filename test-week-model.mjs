import test from 'node:test';
import assert from 'node:assert/strict';
import {TRAINING_TYPES,MUSCLE_GROUPS,localDate,weekStart,shiftDate,weekDays,classifyTraining,exerciseProfile,buildWeekSummary} from './public/week-model.js';

let sequence=1;
const id=()=>`${String(sequence++).padStart(8,'0')}-0000-4000-8000-000000000000`;
const row=(overrides={})=>({record_id:id(),date:'2026-10-26',session:1,exercise:'Pull-up',category:'Pull',set:sequence,reps:8,load_lb:15,set_type:'Work',...overrides});
const target=(overrides={})=>({id:id(),exercise:'Pull-up',target:'3 sets',status:'planned',comment:'',...overrides});
const plan=(targets,overrides={})=>({id:id(),date:'2026-10-26',title:'Workout',targets,...overrides});
const attempt=(overrides={})=>({id:id(),climbId:id(),attemptNumber:1,completed:false,...overrides});
const climb=(attempts,overrides={})=>({id:id(),date:'2026-10-26',category:'indoor_boulder',title:'',attempts,...overrides});
const hangSet=(overrides={})=>({id:id(),isWarmup:false,status:'unknown',segments:[{id:id(),seconds:7,count:6}],...overrides});
const hang=(sets,overrides={})=>({id:id(),date:'2026-10-26',protocol:'repeaters',title:'',sets,...overrides});
const summary=(overrides={})=>buildWeekSummary({date:'2026-10-28',today:'2026-10-30',...overrides});
const muscle=(result,id)=>result.muscles.find(item=>item.id===id);

test('Monday–Sunday boundaries include Sunday and exclude adjacent Mondays',()=>{
  assert.equal(weekStart('2026-11-01'),'2026-10-26');
  assert.equal(weekStart('2026-11-02'),'2026-11-02');
  assert.deepEqual(weekDays('2026-11-01'),['2026-10-26','2026-10-27','2026-10-28','2026-10-29','2026-10-30','2026-10-31','2026-11-01']);
  const result=summary({records:[row({date:'2026-10-25'}),row(),row({date:'2026-11-01'}),row({date:'2026-11-02'})]});
  assert.equal(result.workingSets,2);assert.equal(result.trainingDays,2);
  assert.equal(result.days[6].workingSets,1);assert.equal(result.days[0].weekday,'Monday');
});

test('calendar arithmetic handles leap days and year boundaries',()=>{
  assert.equal(weekStart('2027-01-01'),'2026-12-28');
  assert.equal(weekDays('2027-01-01').at(-1),'2027-01-03');
  assert.equal(shiftDate('2024-02-28',1),'2024-02-29');
  assert.equal(shiftDate('2024-02-29',1),'2024-03-01');
  assert.equal(shiftDate('2026-03-01',-1),'2026-02-28');
  assert.throws(()=>weekStart('2026-02-30'),RangeError);
  assert.throws(()=>shiftDate('2026-01-01',1.5),RangeError);
});

test('DST and host timezone do not move ISO training dates',()=>{
  const originalTZ=process.env.TZ;
  try {
    const outputs=['UTC','America/Toronto','Pacific/Auckland'].map(TZ=>{
      process.env.TZ=TZ;
      return JSON.stringify([weekDays('2026-03-08'),weekDays('2026-11-01'),localDate(new Date('2026-11-02T02:00:00Z'))]);
    });
    assert.equal(outputs[0],outputs[1]);assert.equal(outputs[1],outputs[2]);
    assert.equal(JSON.parse(outputs[0])[2],'2026-11-01');
    assert.equal(JSON.parse(outputs[0])[0][0],'2026-03-02');
  } finally { if(originalTZ===undefined)delete process.env.TZ;else process.env.TZ=originalTZ; }
  assert.equal(localDate('2026-11-02'),'2026-11-02');
});

test('completion comes only from explicit reviews, including past and future targets',()=>{
  const targets=['planned','hit','partial','missed','skipped'].map(status=>target({status}));
  const result=summary({plans:[plan(targets)],records:[row()]});
  assert.equal(result.planned,5);assert.equal(result.completed,1);assert.equal(result.partial,1);
  assert.equal(result.missed,1);assert.equal(result.skipped,1);assert.equal(result.pending,1);
  assert.equal(result.loggedExercises,1);assert.equal(result.trainingDays,1);assert.equal(result.plannedDays,1);
  assert.equal(summary({date:'2026-11-09',plans:[plan([target({status:'hit'}),target()],{date:'2026-11-09'})]}).completed,1);
  assert.equal(summary({date:'2026-10-19',plans:[plan([target()],{date:'2026-10-19'})]}).missed,0);
});

test('working sets reuse analytics exclusions, retain unknown load, and do not require an estimate',()=>{
  const records=[row(),row({is_warmup:true}),row({set_type:'Warm-up'}),row({is_failed:true}),row({reps:0}),row({set_type:'Technique practice'}),row({notes:'Failed attempt'}),row({reps:null,duration_s:null}),row({load_lb:null,reps:5}),row({reps:3.5}),row({notes:'Not a failed attempt'})];
  const result=summary({records});
  assert.equal(result.workingSets,4);
  assert.equal(result.loggedExercises,1);
  assert.equal(muscle(result,'lats').workingSets,4);
});

test('strength exercise occurrences group by date, session and normalized name, never by set',()=>{
  const first=row();
  const result=summary({records:[first,{...first},row({exercise:'PULL UP'}),row({session:2}),row({date:'2026-10-27'})]});
  assert.equal(result.workingSets,4);assert.equal(result.loggedExercises,3);assert.equal(result.trainingDays,2);
  assert.equal(result.days[0].loggedExercises,2);
});

test('each filter applies to plans, actuals, muscles, days and the type breakdown',()=>{
  const records=[row()];
  const plans=[plan([target(),target({exercise:'Bouldering'}),target({exercise:'Repeaters'})])];
  const climbingWorkouts=[climb([attempt()])],hangboardWorkouts=[hang([hangSet()])];
  const result=summary({records,plans,climbingWorkouts,hangboardWorkouts,types:['boulder']});
  assert.equal(result.planned,1);assert.equal(result.loggedExercises,1);assert.equal(result.climbingSessions,1);
  assert.equal(result.workingSets,0);assert.equal(result.hangSets,0);assert.equal(result.byType.strength.planned,0);
  assert.equal(result.byType.boulder.loggedExercises,1);assert.equal(result.days[0].planned,1);
  assert.equal(muscle(result,'forearms').plannedPrimary,1);assert.equal(muscle(result,'forearms').climbingSessions,1);
  const empty=summary({records,plans,climbingWorkouts,hangboardWorkouts,types:[]});
  assert.equal(empty.planned,0);assert.equal(empty.loggedExercises,0);assert.equal(empty.trainingDays,0);
  assert.ok(empty.muscles.every(item=>item.actualPrimary===0&&item.plannedPrimary===0));
  assert.equal(summary({records,types:new Set(['strength'])}).workingSets,1);
});

test('climbing attempts use per-climb session maxima and failed sends still count as training',()=>{
  const climbId=id(),otherId=id();
  const workout=climb([attempt({climbId,attemptNumber:1}),attempt({climbId,attemptNumber:4,completed:true}),attempt({climbId:otherId,attemptNumber:2,completed:false})]);
  const result=summary({climbingWorkouts:[workout,{...workout},climb([])]});
  assert.equal(result.climbingSessions,1);assert.equal(result.loggedExercises,1);
  assert.equal(result.attempts,6);assert.equal(result.sends,1);assert.equal(result.completed,0);
  const allFailed=summary({climbingWorkouts:[climb([attempt({attemptNumber:3,completed:false})])]});
  assert.equal(allFailed.loggedExercises,1);assert.equal(allFailed.attempts,3);assert.equal(allFailed.sends,0);
});

test('Kilter angles remain separate attempt series and explicit climbing types do not double-count',()=>{
  const climbId=id();
  const result=summary({climbingWorkouts:[climb([attempt({climbId,angle:30,attemptNumber:2}),attempt({climbId,angle:40,attemptNumber:3})],{category:'kilter'})]});
  assert.equal(result.attempts,5);assert.equal(result.climbingSessions,1);
  assert.equal(result.byType.kilter.climbingSessions,1);assert.equal(result.byType.boulder.climbingSessions,0);
  assert.equal(summary({climbingWorkouts:[climb([attempt()],{title:'Climb 4x4'})]}).byType.climbing_4x4.climbingSessions,1);
});

test('native hangboard keeps working sets and active seconds separate from strength and rest',()=>{
  const workout=hang([
    hangSet({isWarmup:true}),hangSet({status:'failed'}),
    hangSet({status:'partial',segments:[{id:id(),seconds:7,count:5},{id:id(),seconds:3,count:1}]}),
    hangSet({segments:[{id:id(),seconds:10,count:1}],restAfterSetSeconds:600}),
  ]);
  const result=summary({hangboardWorkouts:[workout,{...workout},hang([])]});
  assert.equal(result.loggedExercises,1);assert.equal(result.hangSets,2);assert.equal(result.hangSeconds,48);
  assert.equal(result.workingSets,0);assert.equal(muscle(result,'forearms').workingSets,0);
  assert.equal(muscle(result,'forearms').hangSets,2);
  const warmupOnly=summary({hangboardWorkouts:[hang([hangSet({isWarmup:true})])]});
  assert.equal(warmupOnly.loggedExercises,1);assert.equal(warmupOnly.hangSets,0);
  assert.equal(muscle(warmupOnly,'forearms').actualPrimary,0);
});

test('legacy repeater components preserve hold time and group rounds instead of inflating sets',()=>{
  const entry_id=id();
  const common={entry_id,exercise:'No-hang repeater',tracking:'repeaters',reps:null,duration_s:7,hold_count:6,round:1,side:'Left'};
  const result=summary({records:[row(common),row({...common,hold_count:1,duration_s:3}),row({...common,side:'Right'})]});
  assert.equal(result.loggedExercises,1);assert.equal(result.hangSets,2);assert.equal(result.hangSeconds,87);
  assert.equal(result.workingSets,0);assert.equal(result.byType.repeaters.hangSets,2);
});

test('timed strength holds are not silently reclassified as hangboard repeaters',()=>{
  const result=summary({records:[row({exercise:'Side plank',category:'Core',tracking:'timed',reps:null,duration_s:30,hold_count:1})]});
  assert.equal(result.workingSets,1);assert.equal(result.hangSets,0);assert.equal(result.hangSeconds,0);
  assert.equal(result.byType.strength.loggedExercises,1);assert.equal(muscle(result,'core').workingSets,1);
  assert.equal(exerciseProfile('Hangboard').primary.includes('core'),false);
});

test('generic hangboard is its own filter and does not imply wall climbing or a specific protocol',()=>{
  assert.equal(classifyTraining('Fingerboard'),'hangboard');
  assert.equal(classifyTraining('Hangboard repeaters'),'repeaters');
  const result=summary({records:[row({exercise:'Hangboard',tracking:'timed',reps:null,duration_s:10,hold_count:1})],plans:[plan([target({exercise:'Hangboard'})])]});
  assert.equal(result.byType.hangboard.planned,1);assert.equal(result.byType.hangboard.loggedExercises,1);
  assert.equal(result.hangSets,1);assert.equal(result.climbingSessions,0);assert.equal(result.workingSets,0);
  assert.equal(muscle(result,'lats').plannedPrimary,0);assert.equal(muscle(result,'forearms').plannedPrimary,1);
});

test('imported hangboard sources cannot be counted again from a stale strength snapshot',()=>{
  const entry_id=id(),record=row({entry_id,exercise:'Dead hang',tracking:'repeaters',reps:null,duration_s:7,hold_count:6});
  const moved=hang([hangSet()],{source:{entryId:entry_id}});
  const result=summary({records:[record],hangboardWorkouts:[moved]});
  assert.equal(result.loggedExercises,1);assert.equal(result.hangSets,1);assert.equal(result.hangSeconds,42);
  const deleted=summary({records:[record],hangboardWorkouts:[{...moved,deleted_at:'2026-10-28T12:00:00Z'}]});
  assert.equal(deleted.loggedExercises,0);
});

test('structured planned strength sets are optional and are not extracted from prose',()=>{
  const result=summary({plans:[plan([
    target({plannedSets:3}),target({exercise:'Bench press',target:'100 sets of 5'}),
    target({exercise:'Repeaters',trainingType:'repeaters',plannedSets:99}),
  ])]});
  assert.equal(result.planned,3);assert.equal(result.plannedSets,3);assert.equal(result.unknownPlannedSets,1);
  assert.equal(muscle(result,'lats').plannedSets,3);assert.equal(muscle(result,'biceps').plannedSecondarySets,3);
  assert.equal(muscle(result,'chest').plannedSets,0);assert.equal(muscle(result,'chest').unknownPlannedSets,1);
  assert.equal(muscle(result,'forearms').plannedSets,0);
});

test('muscle exposure keeps primary, secondary, strength sets and climbing sessions separate',()=>{
  const result=summary({records:[row(),row()],plans:[plan([target({plannedSets:3})])],climbingWorkouts:[climb([attempt()])],hangboardWorkouts:[hang([hangSet()])]});
  assert.equal(muscle(result,'lats').workingSets,2);assert.equal(muscle(result,'lats').climbingSessions,1);
  assert.equal(muscle(result,'lats').actualPrimary,2);assert.equal(muscle(result,'lats').plannedPrimary,1);
  assert.equal(muscle(result,'biceps').secondarySets,2);assert.equal(muscle(result,'biceps').workingSets,0);
  assert.equal(muscle(result,'forearms').hangSets,1);assert.equal(muscle(result,'forearms').climbingSessions,1);
  assert.equal(muscle(result,'quadriceps').actualPrimary,0);assert.equal(muscle(result,'quadriceps').actualSecondary,1);
});

test('unknown exercises stay visible and never receive invented muscle contributions',()=>{
  const result=summary({records:[row({exercise:'Mystery machine'})],plans:[plan([target({exercise:'Mystery machine',plannedSets:4})])]});
  assert.equal(result.loggedExercises,1);assert.equal(result.workingSets,1);
  assert.deepEqual(result.unmapped,[{exercise:'Mystery machine',type:'strength',planned:1,actual:1,workingSets:1}]);
  assert.ok(result.muscles.every(item=>!item.actualPrimary&&!item.plannedPrimary));
  assert.equal(exerciseProfile('UAP (unidentified)','Pull').mapped,false);
  assert.equal(exerciseProfile('Aquamarine (unidentified)','Other').mapped,false);
  assert.equal(exerciseProfile('Band pulldown (unspecified)','Pull').mapped,false);
  assert.equal(exerciseProfile('Cable pulldown (unspecified)','Pull').mapped,false);
  assert.equal(exerciseProfile('Lat pulldown','Pull').mapped,true);
});

test('exercise type inference respects explicit categories and does not interpret strength rep schemes as climbing',()=>{
  assert.equal(classifyTraining('Squat 4x4'),'strength');
  assert.equal(classifyTraining('4x4'),'climbing_4x4');
  assert.equal(classifyTraining('Climb 4×4'),'climbing_4x4');
  assert.equal(classifyTraining('Anything','indoor_toprope'),'toprope');
  assert.equal(classifyTraining('Bouldering','strength'),'strength');
  assert.equal(classifyTraining('Dead hang','repeaters'),'repeaters');
  assert.equal(classifyTraining('Max-hangs'),'max_hangs');
  assert.equal(exerciseProfile('Tricep pushup').primary.includes('triceps'),true);
  assert.deepEqual(exerciseProfile('Finger curl').primary,['forearms']);
  assert.equal(TRAINING_TYPES.length,11);assert.equal(MUSCLE_GROUPS.length,14);
});

test('latest snapshots, deletions and invalid dates do not duplicate or leak across weeks',()=>{
  const old=plan([target()],{revision:1}),latest={...old,revision:2,targets:[target({status:'hit'})]};
  const workout=climb([attempt()]);
  const result=summary({plans:[latest,old,{...plan([target()]),deletedAt:'2026-10-27'}],records:[row({date:'2026-02-31'}),row({deleted_at:'now'})],climbingWorkouts:[{...workout,revision:2,attempts:[]},{...workout,revision:1}]});
  assert.equal(result.planned,1);assert.equal(result.completed,1);assert.equal(result.loggedExercises,0);
});

test('summary construction does not mutate source records, plans, workouts or filter selections',()=>{
  const input={date:'2026-10-28',today:'2026-10-30',records:[row()],plans:[plan([target()])],climbingWorkouts:[climb([attempt()])],hangboardWorkouts:[hang([hangSet()])],types:['strength','repeaters','boulder']};
  const before=structuredClone(input);
  buildWeekSummary(input);
  assert.deepEqual(input,before);
});
