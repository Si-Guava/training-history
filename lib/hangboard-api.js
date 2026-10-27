import { normalizeHangboardWorkout, upgradeHangboardWorkout, importRepeaterEntry, hangboardId, hangboardRevision } from '../public/hangboard-model.js';

const MAX_BODY_BYTES = 512 * 1024;
const response = (data, status = 200) => Response.json(data, {
  status, headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'},
});
const columns = 'id, protocol, payload_json, payload_hash, revision, created_at, updated_at, deleted_at, source_entry_id, source_payload_json, source_payload_hash';
const conflict = (message = 'This Hangboard workout changed in another tab. Reload its latest version before saving your changes.') =>
  response({error:message,conflict:true},409);
const readRow = (db,id) => db.prepare(`SELECT ${columns} FROM hangboard_workouts WHERE id = ?`).bind(id).first();
const readImported = (db,id) => db.prepare(`SELECT ${columns} FROM hangboard_workouts WHERE source_entry_id = ?`).bind(id).first();
function publicWorkout(row) {
  let source = null;
  if (row.source_entry_id) {
    const original = JSON.parse(row.source_payload_json);
    source = {entryId:row.source_entry_id,exercise:original.exercise,date:original.date,recordCount:original.records.length,importedAt:row.created_at};
  }
  return {...upgradeHangboardWorkout(JSON.parse(row.payload_json)),revision:row.revision,created_at:row.created_at,updated_at:row.updated_at,deleted_at:row.deleted_at ?? null,source};
}
const deletionResult = row => response({ok:true,id:row.id,revision:row.revision,deleted_at:row.deleted_at});

async function readJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) throw Object.assign(new Error('Send the Hangboard workout as JSON.'),{status:415});
  const reader = request.body?.getReader();
  if (!reader) throw Object.assign(new Error('Enter a Hangboard workout.'),{status:400});
  const chunks = [];let total = 0;
  for (;;) {
    const {done,value} = await reader.read();if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {await reader.cancel();throw Object.assign(new Error('This workout is too large. Use fewer sets or shorter notes.'),{status:413});}
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);let offset = 0;
  for (const chunk of chunks) {bytes.set(chunk,offset);offset += chunk.byteLength;}
  try {return JSON.parse(new TextDecoder().decode(bytes));}
  catch {throw Object.assign(new Error('The workout could not be read. Check the form and try again.'),{status:400});}
}
async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2,'0')).join('');
}

// Old snapshots have hashes from before cycles existed. Compare their current
// normalized meaning on retry without rewriting the stored bytes during reads.
async function samePayload(row,hash) {
  if (row.payload_hash === hash) return true;
  const {canonicalPayload} = normalizeHangboardWorkout(JSON.parse(row.payload_json));
  return await digest(canonicalPayload) === hash;
}

/**
 * Assign one existing repeater save to Hangboard without changing its source.
 * The guarded INSERT is the move: the strength API excludes assigned IDs,
 * including when the Hangboard snapshot is later soft-deleted. A single SQL
 * statement checks source bytes, deletion state and record-level removals.
 */
async function importExisting(requestedId, db, now) {
  const id = hangboardId(requestedId,'sourceEntryId');
  const existing = await readImported(db,id);
  if (existing) return response({workout:publicWorkout(existing)});
  const source = await db.prepare('SELECT id, payload_json, payload_hash, created_at, deleted_at FROM workout_entries WHERE id = ?').bind(id).first();
  if (!source) return response({error:'That strength workout was not found.'},404);
  if (source.deleted_at) return conflict('That strength workout was deleted. Restore it before moving it to Hangboard.');
  const entry = JSON.parse(source.payload_json);
  if (entry.tracking !== 'repeaters') return response({error:'Only a workout explicitly logged as repeaters can be moved with this action.'},400);
  const {canonicalPayload,...workout} = importRepeaterEntry(entry);
  // Never trust an ID embedded in source JSON over the selected storage row.
  if (workout.id !== id) return conflict('The source workout identity is inconsistent. No records were moved.');
  const hash = await digest(canonicalPayload),timestamp = now();
  const inserted = await db.prepare(`INSERT INTO hangboard_workouts
    (id, workout_date, protocol, payload_json, payload_hash, revision, created_at, updated_at, source_entry_id, source_payload_json, source_payload_hash)
    SELECT ?, ?, ?, ?, ?, 1, ?, ?, source.id, source.payload_json, source.payload_hash
    FROM workout_entries AS source
    WHERE source.id = ? AND source.payload_hash = ? AND source.payload_json = ? AND source.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM record_deletions AS deletion,
          json_each(deletion.record_ids_json) AS removed,
          json_each(source.payload_json, '$.records') AS source_record
        WHERE deletion.restored_at IS NULL AND removed.value = json_extract(source_record.value, '$.record_id')
      )
    ON CONFLICT DO NOTHING`).bind(workout.id,workout.date,workout.protocol,JSON.stringify(workout),hash,timestamp,timestamp,id,source.payload_hash,source.payload_json).run();
  const saved = await readImported(db,id);
  if (!saved) return conflict('The source workout changed, contains deleted sets, or conflicts with an existing Hangboard workout. No records were moved. Reload and retry.');
  if (saved.source_payload_hash !== source.payload_hash || saved.source_payload_json !== source.payload_json) return conflict('Another request moved a different version of this source workout. Reload the Hangboard history.');
  return response({workout:publicWorkout(saved)},inserted.meta?.changes ? 201 : 200);
}

/** Protected by this private Site's visitor allowlist. */
export async function handleHangboardWorkouts(request, db, now = () => new Date().toISOString()) {
  const method = request.method.toUpperCase();
  if (!['GET','POST','PUT','DELETE','PATCH'].includes(method)) return response({error:'Method not allowed.'},405);
  const origin = request.headers.get('origin');
  if (method !== 'GET' && (request.headers.get('sec-fetch-site') === 'cross-site' || (origin !== null && origin !== new URL(request.url).origin))) return response({error:'Update Hangboard workouts from this dashboard.'},403);
  if (!db) return response({error:'Your Hangboard history is temporarily unavailable. Keep your draft open and retry.'},503);
  try {
    if (method === 'GET') {
      const result = await db.prepare(`SELECT ${columns} FROM hangboard_workouts ORDER BY workout_date DESC, created_at DESC, id`).all();
      const all = result.results.map(publicWorkout);
      return response({workouts:all.filter(workout => !workout.deleted_at),deletedWorkouts:all.filter(workout => workout.deleted_at)});
    }
    if (method === 'DELETE') {
      const query = new URL(request.url).searchParams;
      const id = hangboardId(query.get('id')),revision = hangboardRevision(Number(query.get('revision')));
      let row = await readRow(db,id);
      if (!row) return response({error:'This Hangboard workout was not found.'},404);
      if (row.deleted_at) return row.revision === revision + 1 ? deletionResult(row) : conflict();
      if (row.revision !== revision) return conflict();
      const timestamp = now();
      await db.prepare('UPDATE hangboard_workouts SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND deleted_at IS NULL').bind(timestamp,timestamp,id,revision).run();
      row = await readRow(db,id);
      return row?.deleted_at && row.revision === revision + 1 ? deletionResult(row) : conflict();
    }
    const input = await readJson(request);
    if (method === 'POST' && input?.action === 'import_repeaters') return await importExisting(input.sourceEntryId,db,now);
    if (method === 'PATCH') {
      if (input?.action !== 'restore') return response({error:'Choose a supported Hangboard action.'},400);
      const id = hangboardId(input.id),revision = hangboardRevision(input.revision);
      let row = await readRow(db,id);
      if (!row) return response({error:'This Hangboard workout was not found.'},404);
      if (!row.deleted_at) return row.revision === revision + 1 ? response({workout:publicWorkout(row)}) : conflict();
      if (row.revision !== revision) return conflict();
      await db.prepare('UPDATE hangboard_workouts SET deleted_at = NULL, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND deleted_at IS NOT NULL').bind(now(),id,revision).run();
      row = await readRow(db,id);
      return row && !row.deleted_at && row.revision === revision + 1 ? response({workout:publicWorkout(row)}) : conflict();
    }
    if (input?.action != null) return response({error:'Choose a supported Hangboard action.'},400);
    const {canonicalPayload,...workout} = normalizeHangboardWorkout(input);
    const hash = await digest(canonicalPayload),timestamp = now();
    if (method === 'POST') {
      const inserted = await db.prepare('INSERT INTO hangboard_workouts (id, workout_date, protocol, payload_json, payload_hash, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT(id) DO NOTHING').bind(workout.id,workout.date,workout.protocol,JSON.stringify(workout),hash,timestamp,timestamp).run();
      const row = await readRow(db,workout.id);
      if (!row) throw new Error('Saved Hangboard workout could not be read back.');
      if (row.deleted_at) return conflict('This workout was deleted. Restore it from Deleted workouts or create a new workout.');
      if (!await samePayload(row,hash)) return conflict();
      return response({workout:publicWorkout(row)},inserted.meta?.changes ? 201 : 200);
    }
    const revision = hangboardRevision(input.revision);
    let row = await readRow(db,workout.id);
    if (!row) return response({error:'This Hangboard workout was not found.'},404);
    if (row.deleted_at) return conflict('This workout was deleted in another tab. Your draft is still open.');
    if (row.protocol !== workout.protocol) return response({error:'A saved workout stays in its original protocol. Create a separate workout to log another protocol.',field:'protocol'},400);
    if (row.revision !== revision) return row.revision === revision + 1 && await samePayload(row,hash) ? response({workout:publicWorkout(row)}) : conflict();
    // A tab running the old flat-set editor must not erase saved cycle grouping
    // or cycle recovery. Exact already-committed retries above remain read-only.
    const stored = JSON.parse(row.payload_json);
    if (row.protocol === 'repeaters' && Object.hasOwn(stored,'cycles') && !Object.hasOwn(input,'cycles')) {
      return conflict('This workout now uses cycles. Reload its latest version before editing so its cycle groups and rest times are preserved.');
    }
    await db.prepare('UPDATE hangboard_workouts SET workout_date = ?, payload_json = ?, payload_hash = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND protocol = ? AND deleted_at IS NULL').bind(workout.date,JSON.stringify(workout),hash,timestamp,workout.id,revision,workout.protocol).run();
    row = await readRow(db,workout.id);
    return row && !row.deleted_at && row.revision === revision + 1 && row.payload_hash === hash ? response({workout:publicWorkout(row)}) : conflict();
  } catch (error) {
    if ([400,413,415].includes(error?.status)) return response({error:error.message,field:error.field || null},error.status);
    console.error('Hangboard storage request failed:',error instanceof Error ? error.message : 'Unknown storage error');
    return response({error:'The change could not be confirmed. Keep your draft open and retry; retries will not duplicate workouts.'},503);
  }
}
