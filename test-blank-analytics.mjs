import assert from 'node:assert/strict';
import {analyze, buildCatalog, DEFAULT_BODYWEIGHT, METRIC_KEYS} from './public/analytics.js';
import {buildChartModel} from './public/chart-model.js';
import {buildSurfaceModel, surfaceDomains} from './public/surface-model.js';

// Entirely synthetic records. No imported archive is used by these checks.
const row=(id, overrides={})=>({
  record_id:`fixture-${id}`, exercise:'Synthetic pull-up', category:'Pull',
  date:'2030-01-03', session:1, source_row:id, set:id, reps:5, load_lb:10,
  is_pullup:true, is_warmup:false, is_failed:false, set_type:'Working',
  ...overrides,
});
const pullups=[
  row(1), row(2,{reps:3,load_lb:20}),
  row(3,{reps:12,load_lb:600,is_warmup:true}),
  row(4,{reps:1,load_lb:800,is_failed:true}),
];
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9, `${a} != ${b}`);
let checks=0;
function check(name, fn){fn();checks++;console.log(`PASS ${name}`);}

check('Empty edition has no default bodyweight or invented workout values',()=>{
  assert.equal(DEFAULT_BODYWEIGHT,null);
  assert.deepEqual(buildCatalog([]),[]);
  for(const metric of METRIC_KEYS){
    const a=analyze([],{metric,bodyweight:null});
    assert.equal(a.options.bodyweight,null);
    assert.equal(a.series.length,0);
    assert.equal(a.stats.first,null);
    assert.equal(a.stats.latest,null);
    assert.equal(a.stats.changePct,null);
    assert.doesNotMatch(a.metric.description,/NaN|undefined|null lb/);
  }
});

check('Missing and invalid bodyweights never become an assumed zero or default',()=>{
  for(const bodyweight of [undefined,null,'',' ',0,-1,1001,Infinity,NaN,true,false,'unknown']){
    for(const metric of ['strength','load','volume']){
      const a=analyze(pullups,{metric,bodyweight});
      assert.equal(a.options.bodyweight,null);
      assert.equal(a.series.length,0);
      assert.ok(a.rows.every(r=>r.effectiveLoad===null&&r.strengthEstimate===null));
      assert.match(a.rows[0].eligibilityReason,/bodyweight/i);
      assert.ok(a.notes.some(note=>/bodyweight/i.test(note)));
      assert.doesNotMatch(a.metric.description,/NaN|undefined|null lb/);
    }
  }
});

check('Reps and recorded added load work without bodyweight',()=>{
  const reps=analyze(pullups,{metric:'reps',bodyweight:null});
  assert.equal(reps.series[0].value,4);
  assert.equal(reps.series[0].eligibleCount,2);
  const added=analyze(pullups,{metric:'load',loadBasis:'added',bodyweight:null});
  assert.equal(added.series[0].value,15);
  assert.equal(added.series[0].eligibleCount,2);
  assert.equal(added.stats.warmupCount,1);
  assert.equal(added.stats.failedCount,1);
  assert.ok(added.rows.every(r=>r.effectiveLoad===null));
  assert.equal(analyze(pullups,{metric:'strength',loadBasis:'added',bodyweight:null}).series.length,0);
  assert.equal(analyze(pullups,{metric:'volume',loadBasis:'added',bodyweight:null}).series.length,0);
  const zero=analyze([row(5,{load_lb:0})],{metric:'load',loadBasis:'added',bodyweight:null});
  assert.equal(zero.series[0].value,0);
});

check('Entering bodyweight enables correct workout averages and totals',()=>{
  const total=analyze(pullups,{metric:'load',bodyweight:120});
  assert.equal(total.series[0].value,135);
  const strength=analyze(pullups,{metric:'strength',bodyweight:120});
  near(strength.series[0].value,(130*(1+5/30)+140*(1+3/30))/2);
  const addedStrength=analyze(pullups,{metric:'strength',loadBasis:'added',bodyweight:'120'});
  near(addedStrength.series[0].value,strength.series[0].value-120);
  assert.equal(analyze(pullups,{metric:'volume',bodyweight:120}).series[0].value,1070);
  assert.equal(analyze(pullups,{metric:'load',bodyweight:null}).series.length,0);
});

check('Catalog retains all applicable pull-up metric controls while weight is unset',()=>{
  const catalog=buildCatalog(pullups);
  for(const metric of ['strength','load','reps','volume'])assert.ok(catalog[0].metrics.includes(metric),metric);
  const missingLoad=buildCatalog([row(1,{load_lb:null})])[0];
  assert.deepEqual(missingLoad.metrics,['reps']);
});

check('Ordinary lift, numbered settings and timed hold metrics do not require bodyweight',()=>{
  const lift=[row(1,{exercise:'Synthetic press',category:'Push',is_pullup:false,reps:6,load_lb:40}),row(2,{exercise:'Synthetic press',category:'Push',is_pullup:false,reps:4,load_lb:50})];
  assert.equal(analyze(lift,{metric:'load',bodyweight:null}).series[0].value,45);
  near(analyze(lift,{metric:'strength',bodyweight:null}).series[0].value,(40*1.2+50*(1+4/30))/2);
  assert.equal(analyze(lift,{metric:'volume',bodyweight:null}).series[0].value,440);
  assert.equal(analyze([row(1,{is_pullup:false,load_lb:null,stack_setting:7})],{metric:'setting',bodyweight:null}).series[0].value,7);
  const holds=[row(1,{is_pullup:false,load_lb:null,reps:null,duration_s:7,hold_count:6}),row(2,{is_pullup:false,load_lb:null,reps:null,duration_s:5,hold_count:2})];
  assert.equal(analyze(holds,{metric:'hold',bodyweight:null}).series[0].value,6.5);
  assert.equal(analyze(holds,{metric:'holdTotal',bodyweight:null}).series[0].value,52);
});

check('2D fitted change uses added-load points without inventing exposure weights',()=>{
  const dates=[row(1,{load_lb:10}),row(2,{date:'2030-01-10',session:2,load_lb:20}),row(3,{date:'2030-01-17',session:3,load_lb:30})];
  const a=analyze(dates,{metric:'load',loadBasis:'added',bodyweight:null});
  const fit=buildChartModel(a,{metric:'load',lineMode:'bestFit',fitWeight:'sets'});
  assert.equal(fit.points.length,3);
  assert.equal(fit.comparison.available,true);
  near(fit.comparison.changePct,200);
  const volume=buildChartModel(a,{metric:'load',lineMode:'bestFit',fitWeight:'volume'});
  assert.equal(volume.comparison.available,false);
  assert.match(volume.comparison.reason,/workload|volume/i);
});

check('3D total-load surface explains missing bodyweight; added-load dots remain usable',()=>{
  const totalAnalysis=analyze(pullups,{metric:'load',bodyweight:null});
  const total=buildSurfaceModel(totalAnalysis,{bodyweight:null,loadBasis:'total'});
  assert.equal(total.points.length,0);
  assert.equal(surfaceDomains(total),null);
  assert.match(total.emptyReason,/Set bodyweight/);
  const addedAnalysis=analyze(pullups,{metric:'load',bodyweight:null,loadBasis:'added'});
  const added=buildSurfaceModel(addedAnalysis,{bodyweight:null,loadBasis:'added',surfaceFit:'none'});
  assert.equal(added.points.length,1);
  assert.equal(added.points[0].z,15);
  assert.equal(added.points[0].y,4);
  assert.equal(added.points[0].volume,null);
  assert.equal(added.setCount,2);
  assert.match(added.unitNote,/Set bodyweight/);
  const weighted=buildSurfaceModel(addedAnalysis,{bodyweight:null,loadBasis:'added',fitWeight:'volume'});
  assert.equal(weighted.points.length,1);
  assert.equal(weighted.weighted.length,0);
  assert.equal(weighted.surface.available,false);
  const knownAnalysis=analyze(pullups,{metric:'load',bodyweight:120});
  const known=buildSurfaceModel(knownAnalysis,{bodyweight:120,loadBasis:'total'});
  assert.equal(known.points[0].z,135);
  assert.equal(known.points[0].volume,1070);
});

check('Empty total-load surface keeps the recorded repetition axis when bodyweight is unset',()=>{
  const a=analyze([row(1,{reps:8,load_lb:10,load_mode:'pullup'})],{metric:'load',bodyweight:null});
  const surface=buildSurfaceModel(a,{bodyweight:null,loadBasis:'total',surfaceAxis:'auto'});
  assert.equal(surface.points.length,0);
  assert.equal(surface.axis,'reps');
  assert.equal(surface.hasReps,true);
  assert.equal(surface.hasHolds,false);
  assert.equal(surface.axisLabel,'Average reps per set');
  assert.equal(surface.axisUnit,'reps');
  assert.match(surface.countLabel,/0 working sets/);
  assert.doesNotMatch(surface.countLabel,/hangs/);
  assert.match(surface.emptyReason,/Set bodyweight/);
  const holdAnalysis=analyze([row(1,{reps:null,duration_s:7,hold_count:6,load_lb:null,is_pullup:false})],{metric:'load',bodyweight:null});
  assert.equal(buildSurfaceModel(holdAnalysis,{surfaceAxis:'auto'}).axis,'hold');
});

console.log(`${checks} blank-edition analytics checks passed.`);
