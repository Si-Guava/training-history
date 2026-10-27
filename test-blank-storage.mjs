import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { handleWorkouts } from './lib/workout-api.js';
import { handleRecordDeletions } from './lib/record-deletions-api.js';
import { handlePlans } from './lib/plans-api.js';
import { handleClimbingWorkouts } from './lib/climbing-api.js';
import { handleHangboardWorkouts } from './lib/hangboard-api.js';

const context=JSON.parse(readFileSync('lib/archive-context.json','utf8'));
assert.deepEqual(context,{catalog:[],dateSessions:{},recordIds:[]});
const scope={window:{}};
vm.runInNewContext(readFileSync('public/data.js','utf8'),scope);
const archive=JSON.parse(JSON.stringify(scope.window.TRAINING_DATA));
for (const key of ['records','exercise_index','omitted','rules']) assert.deepEqual(archive[key],[]);
assert.deepEqual(archive.settings,{});
const sql=new DatabaseSync(':memory:');
const journal=JSON.parse(readFileSync('drizzle/meta/_journal.json','utf8'));
for(const entry of journal.entries.toSorted((a,b)=>a.idx-b.idx)) sql.exec(readFileSync('drizzle/'+entry.tag+'.sql','utf8'));
const db={prepare(query){const stmt=sql.prepare(query);let values=[];return {bind(...args){values=args;return this;},async all(){return {results:stmt.all(...values)};},async first(){return stmt.get(...values)??null;},async run(){return {success:true,meta:{changes:Number(stmt.run(...values).changes)}};}};}};
const origin='https://fresh-log.example';
const clock=()=> '2027-01-02T12:00:00.000Z';
async function call(kind,method='GET',payload){
 const request=new Request(origin+'/api/'+kind,{method,headers:{'content-type':'application/json',origin},...(payload?{body:JSON.stringify(payload)}:{})});
 const handlers={workouts:r=>handleWorkouts(r,db,context,clock),'record-deletions':r=>handleRecordDeletions(r,db,context,clock),plans:r=>handlePlans(r,db,clock),'climbing-workouts':r=>handleClimbingWorkouts(r,db,clock),'hangboard-workouts':r=>handleHangboardWorkouts(r,db,clock)};
 const response=await handlers[kind](request);return {status:response.status,body:await response.json()};
}
for(const [kind,key] of [['workouts','entries'],['record-deletions','deletions'],['plans','plans'],['climbing-workouts','workouts'],['hangboard-workouts','workouts']]){
 const result=await call(kind);assert.equal(result.status,200,kind);assert.deepEqual(result.body[key],[],kind);if(result.body.deletedWorkouts)assert.deepEqual(result.body.deletedWorkouts,[]);
}
console.log('PASS all five histories start empty after schema-only migrations');
const entry={id:crypto.randomUUID(),date:'2027-01-02',exercise:'Synthetic exercise',category:'Push',tracking:'reps',loadMode:'weight',sets:[{load:20,reps:8}]};
let result=await call('workouts','POST',entry);assert.equal(result.status,201,JSON.stringify(result.body));assert.equal(result.body.entry.records.length,1);
result=await call('workouts');assert.equal(result.body.entries.length,1);assert.equal(result.body.entries[0].exercise,entry.exercise);
console.log('PASS first strength entry creates an exercise without an imported catalog');
for(const category of ['indoor_boulder','kilter']){
 const input={id:crypto.randomUUID(),date:'2027-01-02',category,attempts:[],...(category==='kilter'?{defaultAngle:40}:{})};
 result=await call('climbing-workouts','POST',input);assert.equal(result.status,201,JSON.stringify(result.body));assert.equal(result.body.workout.category,category);
}
console.log('PASS fresh climbing and Kilter workouts save independently');
for(const protocol of ['repeaters','max_hangs']){
 result=await call('hangboard-workouts','POST',{id:crypto.randomUUID(),date:'2027-01-02',protocol,sets:[],cycles:[]});
 assert.equal(result.status,201,JSON.stringify(result.body));assert.equal(result.body.workout.bodyweightLb,null);
}
console.log('PASS fresh Hangboard workouts save without bodyweight or source entries');
result=await call('plans','POST',{id:crypto.randomUUID(),date:'2027-01-02',title:'Synthetic plan',targets:[{id:crypto.randomUUID(),exercise:'Synthetic exercise',target:'One working set'}]});
assert.equal(result.status,201,JSON.stringify(result.body));
assert.deepEqual(context,{catalog:[],dateSessions:{},recordIds:[]});
console.log('PASS planning starts from an empty log and leaves source context empty');
sql.close();
