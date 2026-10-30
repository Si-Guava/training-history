import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { normalizePlan, PLAN_TRAINING_TYPES } from './public/plan-model.js';
import { TRAINING_TYPES } from './public/week-model.js';
import { handlePlans } from './lib/plans-api.js';

const legacy={id:'70000000-0000-4000-8000-000000000001',date:'2026-10-30',title:'Pull session',targets:[{id:'70000000-0000-4000-8000-000000000002',exercise:'Pull-up',target:'3 sets of 5',status:'planned',comment:''}],notes:''};
const withTarget=fields=>({...structuredClone(legacy),targets:[{...legacy.targets[0],...fields}]});

test('every weekly filter type can be saved by the planner',()=>{
  assert.deepEqual([...PLAN_TRAINING_TYPES].sort(),TRAINING_TYPES.map(type=>type.id).sort());
});

test('legacy targets retain exactly the same payload and retry hash input',()=>{
  const expected=JSON.stringify({date:legacy.date,title:legacy.title,targets:legacy.targets,notes:''});
  const result=normalizePlan(legacy);
  assert.deepEqual(result.targets,legacy.targets);
  assert.equal(result.canonicalPayload,expected);
  assert.equal(normalizePlan(withTarget({trainingType:'',plannedSets:null})).canonicalPayload,expected);
  assert.equal(normalizePlan(withTarget({trainingType:null,plannedSets:''})).canonicalPayload,expected);
  assert.equal(Object.hasOwn(result.targets[0],'trainingType'),false);
  assert.equal(Object.hasOwn(result.targets[0],'plannedSets'),false);
});

test('all supported training types persist without inferring target completion',()=>{
  for(const trainingType of PLAN_TRAINING_TYPES){
    const result=normalizePlan(withTarget({trainingType}));
    assert.equal(result.targets[0].trainingType,trainingType);
    assert.equal(result.targets[0].status,'planned');
    assert.equal(Object.hasOwn(result.targets[0],'plannedSets'),false);
  }
});

test('working-set counts are optional integers and never parsed from target text',()=>{
  assert.equal(Object.hasOwn(normalizePlan(legacy).targets[0],'plannedSets'),false);
  for(const plannedSets of [1,3,1000])assert.equal(normalizePlan(withTarget({trainingType:'strength',plannedSets})).targets[0].plannedSets,plannedSets);
  for(const plannedSets of [0,-1,1.5,1001,NaN,Infinity,'3',true])assert.throws(()=>normalizePlan(withTarget({trainingType:'strength',plannedSets})),error=>error.status===400&&error.field==='targets[0].plannedSets');
});

test('invalid training types and strength counts on other training are rejected',()=>{
  for(const trainingType of ['invalid','Strength',{},12,true])assert.throws(()=>normalizePlan(withTarget({trainingType})),error=>error.status===400&&error.field==='targets[0].trainingType');
  for(const trainingType of PLAN_TRAINING_TYPES.filter(type=>type!=='strength'))assert.throws(()=>normalizePlan(withTarget({trainingType,plannedSets:3})),error=>error.status===400&&error.field==='targets[0].plannedSets');
});

test('new metadata does not mutate input or overwrite explicit review states',()=>{
  const value=withTarget({trainingType:'strength',plannedSets:4,status:'partial',comment:'Only two sets today.'});
  const snapshot=structuredClone(value),result=normalizePlan(value);
  assert.deepEqual(value,snapshot);
  assert.equal(result.targets[0].status,'partial');
  assert.equal(result.targets[0].comment,'Only two sets today.');
  assert.equal(result.targets[0].plannedSets,4);
});

test('API saves/reloads metadata, retries safely, and rejects stale edits',async()=>{
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE workout_plans (id TEXT PRIMARY KEY NOT NULL, workout_date TEXT NOT NULL, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)');
  const db={prepare(sql){const statement=sqlite.prepare(sql);let values=[];return {bind(...args){values=args;return this;},async all(){return {results:statement.all(...values)};},async first(){return statement.get(...values)??null;},async run(){return {meta:{changes:Number(statement.run(...values).changes)}};}};}};
  const request=async(method,payload)=>{
    const response=await handlePlans(new Request('https://training.example/api/plans',{method,headers:{'Content-Type':'application/json',Origin:'https://training.example'},...(method==='GET'?{}:{body:JSON.stringify(payload)})}),db,()=> '2026-10-30T12:00:00.000Z');
    return {status:response.status,body:await response.json()};
  };
  try{
    const value=withTarget({trainingType:'strength',plannedSets:3});
    const first=await request('POST',value);
    assert.equal(first.status,201);
    assert.equal((await request('POST',value)).status,200);
    assert.deepEqual((await request('GET')).body.plans[0].targets,value.targets);
    const edit={...first.body.plan,targets:[{...value.targets[0],plannedSets:5,status:'hit'}]};
    assert.equal((await request('PUT',edit)).status,200);
    assert.equal((await request('PUT',edit)).status,200);
    assert.equal((await request('PUT',{...edit,targets:[{...edit.targets[0],plannedSets:7}]})).status,409);
    const saved=(await request('GET')).body.plans[0];
    assert.equal(saved.targets[0].plannedSets,5);
    assert.equal(saved.targets[0].status,'hit');
    assert.equal(saved.revision,2);
  }finally{sqlite.close();}
});
