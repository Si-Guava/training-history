import { normalizePlan, planId, planRevision } from '../public/plan-model.js';

const MAX_BODY_BYTES=128*1024;
const response=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
const publicPlan=row=>({...JSON.parse(row.payload_json),revision:row.revision,created_at:row.created_at,updated_at:row.updated_at});
const columns='id, payload_json, payload_hash, revision, created_at, updated_at, deleted_at';
const conflict=()=>response({error:'This plan changed in another tab. Reload the latest plan before saving your changes.',conflict:true},409);
const readRow=(db,id)=>db.prepare(`SELECT ${columns} FROM workout_plans WHERE id = ?`).bind(id).first();
async function readJson(request) {
  if(!/^application\/json(?:;|$)/i.test(request.headers.get('content-type')||''))throw Object.assign(new Error('Send the plan as JSON.'),{status:415});
  const reader=request.body?.getReader();
  if(!reader)throw Object.assign(new Error('Enter a workout plan.'),{status:400});
  const chunks=[];let total=0;
  while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>MAX_BODY_BYTES){await reader.cancel();throw Object.assign(new Error('This plan is too large. Use fewer or shorter targets.'),{status:413});}chunks.push(value);}
  const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw Object.assign(new Error('The plan could not be read. Check the form and try again.'),{status:400});}
}
async function digest(value){const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('');}

/** App-scoped calendar protected by this private Site's visitor allowlist. */
export async function handlePlans(request,db,now=()=>new Date().toISOString()) {
  const method=request.method.toUpperCase();
  if(!['GET','POST','PUT','DELETE','PATCH'].includes(method))return response({error:'Method not allowed.'},405);
  const origin=request.headers.get('origin');
  if(method!=='GET'&&(request.headers.get('sec-fetch-site')==='cross-site'||(origin!==null&&origin!==new URL(request.url).origin)))return response({error:'Update plans from this dashboard.'},403);
  if(!db)return response({error:'Your plans are temporarily unavailable. Keep your changes open and retry.'},503);
  try {
    if(method==='GET'){
      const result=await db.prepare(`SELECT ${columns} FROM workout_plans WHERE deleted_at IS NULL ORDER BY workout_date, created_at, id`).all();
      return response({plans:result.results.map(publicPlan)});
    }
    if(method==='DELETE'){
      const query=new URL(request.url).searchParams,id=planId(query.get('id')),revision=planRevision(Number(query.get('revision')));
      let row=await readRow(db,id);if(!row)return response({error:'This plan was not found.'},404);
      if(row.deleted_at)return row.revision===revision+1?response({ok:true,id,revision:row.revision}):conflict();
      if(row.revision!==revision)return conflict();
      const timestamp=now();
      await db.prepare('UPDATE workout_plans SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND deleted_at IS NULL').bind(timestamp,timestamp,id,revision).run();
      row=await readRow(db,id);
      return row?.deleted_at&&row.revision===revision+1?response({ok:true,id,revision:row.revision}):conflict();
    }
    const input=await readJson(request);
    if(method==='PATCH'){
      if(input?.action!=='restore')return response({error:'Choose a supported plan action.'},400);
      const id=planId(input.id),revision=planRevision(input.revision);
      let row=await readRow(db,id);if(!row)return response({error:'This plan was not found.'},404);
      if(!row.deleted_at)return row.revision===revision+1?response({plan:publicPlan(row)}):conflict();
      if(row.revision!==revision)return conflict();
      await db.prepare('UPDATE workout_plans SET deleted_at = NULL, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND deleted_at IS NOT NULL').bind(now(),id,revision).run();
      row=await readRow(db,id);
      return row&&!row.deleted_at&&row.revision===revision+1?response({plan:publicPlan(row)}):conflict();
    }
    const {canonicalPayload,...plan}=normalizePlan(input),hash=await digest(canonicalPayload),timestamp=now();
    if(method==='POST'){
      const insert=await db.prepare('INSERT INTO workout_plans (id, workout_date, payload_json, payload_hash, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT(id) DO NOTHING').bind(plan.id,plan.date,JSON.stringify(plan),hash,timestamp,timestamp).run();
      const row=await readRow(db,plan.id);
      if(!row)throw new Error('Saved plan could not be read back.');
      if(row.deleted_at)return response({error:'This plan was deleted. Create a new plan to save it again.'},409);
      if(row.payload_hash!==hash)return conflict();
      return response({plan:publicPlan(row)},insert.meta?.changes?201:200);
    }
    const revision=planRevision(input.revision);
    let row=await readRow(db,plan.id);
    if(!row)return response({error:'This plan was not found.'},404);
    if(row.deleted_at)return response({error:'This plan was deleted in another tab. Your draft is still open.',conflict:true},409);
    if(row.revision!==revision)return row.revision===revision+1&&row.payload_hash===hash?response({plan:publicPlan(row)}):conflict();
    await db.prepare('UPDATE workout_plans SET workout_date = ?, payload_json = ?, payload_hash = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND deleted_at IS NULL').bind(plan.date,JSON.stringify(plan),hash,timestamp,plan.id,revision).run();
    row=await readRow(db,plan.id);
    return row&&!row.deleted_at&&row.revision===revision+1&&row.payload_hash===hash?response({plan:publicPlan(row)}):conflict();
  } catch(error) {
    if([400,413,415].includes(error?.status))return response({error:error.message,field:error.field||null},error.status);
    console.error('Workout plan storage request failed:',error instanceof Error?error.message:'Unknown storage error');
    return response({error:'The change could not be confirmed. Keep your draft open and retry; retries will not duplicate plans.'},503);
  }
}
