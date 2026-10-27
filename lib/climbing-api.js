import { normalizeClimbingWorkout, climbingId, climbingRevision } from '../public/climbing-model.js';

const MAX_BODY_BYTES = 512 * 1024;
const response = (data, status = 200) => Response.json(data, {
  status,
  headers: {'Cache-Control':'private, no-store', 'X-Content-Type-Options':'nosniff'},
});
const columns = 'id, category, payload_json, payload_hash, revision, created_at, updated_at, deleted_at';
const publicWorkout = row => ({
  ...JSON.parse(row.payload_json),
  revision:row.revision,
  created_at:row.created_at,
  updated_at:row.updated_at,
  deleted_at:row.deleted_at ?? null,
});
const conflict = (message = 'This climbing workout changed in another tab. Reload its latest version before saving your changes.') =>
  response({error:message, conflict:true}, 409);
const readRow = (db, id) => db.prepare(`SELECT ${columns} FROM climbing_workouts WHERE id = ?`).bind(id).first();
const deletionResult = row => response({ok:true, id:row.id, revision:row.revision, deleted_at:row.deleted_at});

async function readJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) {
    throw Object.assign(new Error('Send the climbing workout as JSON.'), {status:415});
  }
  const reader = request.body?.getReader();
  if (!reader) throw Object.assign(new Error('Enter a climbing workout.'), {status:400});
  const chunks = [];
  let total = 0;
  while (true) {
    const {done,value} = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw Object.assign(new Error('This workout is too large. Use fewer attempts or shorter notes.'), {status:413});
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw Object.assign(new Error('The workout could not be read. Check the form and try again.'), {status:400}); }
}

async function digest(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Shared log protected by the Site's private visitor allowlist. */
export async function handleClimbingWorkouts(request, db, now = () => new Date().toISOString()) {
  const method = request.method.toUpperCase();
  if (!['GET','POST','PUT','DELETE','PATCH'].includes(method)) return response({error:'Method not allowed.'}, 405);
  const origin = request.headers.get('origin');
  if (method !== 'GET' && (request.headers.get('sec-fetch-site') === 'cross-site' || (origin !== null && origin !== new URL(request.url).origin))) {
    return response({error:'Update climbing workouts from this dashboard.'}, 403);
  }
  if (!db) return response({error:'Your climbing history is temporarily unavailable. Keep your draft open and retry.'}, 503);
  try {
    if (method === 'GET') {
      const result = await db.prepare(`SELECT ${columns} FROM climbing_workouts ORDER BY workout_date DESC, created_at DESC, id`).all();
      const all = result.results.map(publicWorkout);
      return response({workouts:all.filter(workout => !workout.deleted_at), deletedWorkouts:all.filter(workout => workout.deleted_at)});
    }
    if (method === 'DELETE') {
      const query = new URL(request.url).searchParams;
      const id = climbingId(query.get('id'));
      const revision = climbingRevision(Number(query.get('revision')));
      let row = await readRow(db, id);
      if (!row) return response({error:'This climbing workout was not found.'}, 404);
      if (row.deleted_at) return row.revision === revision + 1 ? deletionResult(row) : conflict();
      if (row.revision !== revision) return conflict();
      const timestamp = now();
      await db.prepare('UPDATE climbing_workouts SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND deleted_at IS NULL')
        .bind(timestamp, timestamp, id, revision).run();
      row = await readRow(db, id);
      return row?.deleted_at && row.revision === revision + 1 ? deletionResult(row) : conflict();
    }
    const input = await readJson(request);
    if (method === 'PATCH') {
      if (input?.action !== 'restore') return response({error:'Choose a supported climbing workout action.'}, 400);
      const id = climbingId(input.id);
      const revision = climbingRevision(input.revision);
      let row = await readRow(db, id);
      if (!row) return response({error:'This climbing workout was not found.'}, 404);
      if (!row.deleted_at) return row.revision === revision + 1 ? response({workout:publicWorkout(row)}) : conflict();
      if (row.revision !== revision) return conflict();
      await db.prepare('UPDATE climbing_workouts SET deleted_at = NULL, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND deleted_at IS NOT NULL')
        .bind(now(), id, revision).run();
      row = await readRow(db, id);
      return row && !row.deleted_at && row.revision === revision + 1 ? response({workout:publicWorkout(row)}) : conflict();
    }
    const {canonicalPayload,...workout} = normalizeClimbingWorkout(input);
    const hash = await digest(canonicalPayload);
    const timestamp = now();
    if (method === 'POST') {
      const inserted = await db.prepare('INSERT INTO climbing_workouts (id, workout_date, category, payload_json, payload_hash, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT(id) DO NOTHING')
        .bind(workout.id, workout.date, workout.category, JSON.stringify(workout), hash, timestamp, timestamp).run();
      const row = await readRow(db, workout.id);
      if (!row) throw new Error('Saved climbing workout could not be read back.');
      if (row.deleted_at) return conflict('This workout was deleted. Restore it from Deleted workouts or create a new workout.');
      if (row.payload_hash !== hash) return conflict();
      return response({workout:publicWorkout(row)}, inserted.meta?.changes ? 201 : 200);
    }
    const revision = climbingRevision(input.revision);
    let row = await readRow(db, workout.id);
    if (!row) return response({error:'This climbing workout was not found.'}, 404);
    if (row.deleted_at) return conflict('This workout was deleted in another tab. Your draft is still open.');
    if (row.category !== workout.category) return response({error:'A saved workout stays in its original climbing category. Create a separate workout in the other category.',field:'category'}, 400);
    if (row.revision !== revision) {
      return row.revision === revision + 1 && row.payload_hash === hash ? response({workout:publicWorkout(row)}) : conflict();
    }
    await db.prepare('UPDATE climbing_workouts SET workout_date = ?, payload_json = ?, payload_hash = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND category = ? AND deleted_at IS NULL')
      .bind(workout.date, JSON.stringify(workout), hash, timestamp, workout.id, revision, workout.category).run();
    row = await readRow(db, workout.id);
    return row && !row.deleted_at && row.revision === revision + 1 && row.payload_hash === hash ? response({workout:publicWorkout(row)}) : conflict();
  } catch (error) {
    if ([400,413,415].includes(error?.status)) return response({error:error.message,field:error.field || null}, error.status);
    console.error('Climbing workout storage request failed:', error instanceof Error ? error.message : 'Unknown storage error');
    return response({error:'The change could not be confirmed. Keep your draft open and retry; retries will not duplicate workouts.'}, 503);
  }
}
