const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const reply = (body,status=200) => Response.json(body,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
const publicDeletion = row => ({id:row.id,recordIds:JSON.parse(row.record_ids_json),created_at:row.created_at});

async function readBody(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type')||'')) throw Object.assign(new Error('Send the deletion as JSON.'),{status:415});
  const reader=request.body?.getReader();
  if(!reader)throw Object.assign(new Error('Choose entries to delete.'),{status:400});
  let text='',size=0;const decoder=new TextDecoder();
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536){await reader.cancel();throw Object.assign(new Error('Delete fewer entries at once.'),{status:413})}text+=decoder.decode(value,{stream:true});}
  text+=decoder.decode();
  try{return JSON.parse(text)}catch{throw Object.assign(new Error('The deletion request could not be read.'),{status:400})}
}

// Shared history protected by this private Site's visitor allowlist.
export async function handleRecordDeletions(request,db,archiveContext,now=()=>new Date().toISOString()) {
  const method=request.method.toUpperCase();
  if(!['GET','POST','DELETE'].includes(method))return reply({error:'Method not allowed.'},405);
  const origin=request.headers.get('origin');
  if(method!=='GET'&&(request.headers.get('sec-fetch-site')==='cross-site'||(origin!==null&&origin!==new URL(request.url).origin)))return reply({error:'Manage entries from this dashboard.'},403);
  if(!db)return reply({error:'Your history is temporarily unavailable. No change was confirmed.'},503);
  try{
    if(method==='GET'){
      const result=await db.prepare('SELECT id, record_ids_json, created_at FROM record_deletions WHERE restored_at IS NULL ORDER BY created_at DESC, id').all();
      return reply({deletions:result.results.map(publicDeletion)});
    }
    if(method==='DELETE'){
      const id=new URL(request.url).searchParams.get('id');
      if(!id||!UUID.test(id))return reply({error:'Choose a deletion to undo.'},400);
      const existing=await db.prepare('SELECT id FROM record_deletions WHERE id = ?').bind(id.toLowerCase()).first();
      if(!existing)return reply({error:'That deletion was not found.'},404);
      await db.prepare('UPDATE record_deletions SET restored_at = ? WHERE id = ? AND restored_at IS NULL').bind(now(),id.toLowerCase()).run();
      return reply({ok:true});
    }
    const input=await readBody(request);
    if(!input||typeof input!=='object'||typeof input.id!=='string'||!UUID.test(input.id))return reply({error:'The deletion identifier is invalid. Please try again.'},400);
    const id=input.id.toLowerCase();
    if(!Array.isArray(input.recordIds)||!input.recordIds.length||input.recordIds.length>500||input.recordIds.some(value=>typeof value!=='string'||value.length>100))return reply({error:'Choose between 1 and 500 entries to delete.'},400);
    const recordIds=[...new Set(input.recordIds)].sort(),canonical=JSON.stringify(recordIds);
    const existing=await db.prepare('SELECT id, record_ids_json, created_at, restored_at FROM record_deletions WHERE id = ?').bind(id).first();
    if(existing){
      if(existing.restored_at)return reply({error:'This deletion was already undone. Start a new deletion if needed.'},409);
      if(existing.record_ids_json!==canonical)return reply({error:'This request already removed different entries. Refresh and try again.'},409);
      return reply({deletion:publicDeletion(existing)});
    }
    const known=new Set(archiveContext.recordIds||[]);
    const saved=await db.prepare('SELECT payload_json FROM workout_entries WHERE deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM hangboard_workouts WHERE source_entry_id = workout_entries.id)').all();
    for(const item of saved.results){const entry=JSON.parse(item.payload_json);for(const row of entry.records||[])known.add(row.record_id);}
    if(recordIds.some(recordId=>!known.has(recordId)))return reply({error:'One of those entries is no longer available. Reload your history.'},404);
    const createdAt=now();
    // Make the overlap check part of the write: stale tabs must not create two
    // active removals for the same set, or undoing one would leave it hidden.
    const insert=await db.prepare(`INSERT INTO record_deletions (id, record_ids_json, created_at)
      SELECT ?, ?, ? WHERE NOT EXISTS (
        SELECT 1 FROM record_deletions AS existing,
          json_each(existing.record_ids_json) AS removed,
          json_each(?) AS incoming
        WHERE existing.restored_at IS NULL AND removed.value = incoming.value
      ) AND NOT EXISTS (
        SELECT 1 FROM hangboard_workouts AS moved,
          json_each(moved.source_payload_json, '$.records') AS original,
          json_each(?) AS incoming
        WHERE moved.source_entry_id IS NOT NULL
          AND json_extract(original.value, '$.record_id') = incoming.value
      ) ON CONFLICT(id) DO NOTHING`).bind(id,canonical,createdAt,canonical,canonical).run();
    const persisted=await db.prepare('SELECT id, record_ids_json, created_at, restored_at FROM record_deletions WHERE id = ?').bind(id).first();
    if(!persisted)return reply({error:'One or more entries were already deleted or moved to Hangboard. Reload your history before deleting again.'},409);
    if(persisted.restored_at||persisted.record_ids_json!==canonical)return reply({error:'This deletion changed in another request. Refresh your history.'},409);
    return reply({deletion:publicDeletion(persisted)},insert.meta?.changes?201:200);
  }catch(error){
    if([400,413,415].includes(error?.status))return reply({error:error.message},error.status);
    console.error('Record deletion failed:',error instanceof Error?error.message:'Unknown storage error');
    return reply({error:'The change could not be confirmed. Retry safely; your original entries are retained.'},503);
  }
}
