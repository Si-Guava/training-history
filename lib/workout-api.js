import { normalizeEntry } from '../public/entry-model.js';

const MAX_BODY_BYTES = 128 * 1024;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const strengthRows = 'SELECT id, payload_json, created_at FROM workout_entries WHERE deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM hangboard_workouts WHERE source_entry_id = workout_entries.id) ORDER BY created_at, id';
const response = (data, status = 200) => Response.json(data, {
  status,
  headers: {'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'},
});

function publicEntry(row) {
  const entry = JSON.parse(row.payload_json);
  return {...entry, created_at:row.created_at,
    records:entry.records.map(record => ({...record,created_at:row.created_at}))};
}

async function readJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) {
    throw Object.assign(new Error('Send the workout as JSON.'), {status:415});
  }
  const reader = request.body?.getReader();
  if (!reader) throw Object.assign(new Error('Enter at least one set.'), {status:400});
  let total = 0;
  const chunks = [];
  while (true) {
    const {done,value} = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw Object.assign(new Error('This entry is too large. Save fewer sets at a time.'), {status:413});
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw Object.assign(new Error('The workout could not be read. Check the form and try again.'), {status:400}); }
}

function rejectCrossOrigin(request) {
  const origin = request.headers.get('origin');
  return request.headers.get('sec-fetch-site') === 'cross-site' ||
    (origin !== null && origin !== new URL(request.url).origin);
}

async function digest(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2,'0')).join('');
}

/**
 * One app-scoped history for this private, allowlisted Site. Sites dispatch enforces its
 * private audience for all pages and API routes; service calls use its supported
 * Site-scoped credential. Do not make this Site public without adding write
 * authorization. No browser-stored identity or client-supplied owner is trusted.
 */
export async function handleWorkouts(request, db, archiveContext, now = () => new Date().toISOString()) {
  const method = request.method.toUpperCase();
  if (!['GET','POST','DELETE'].includes(method)) return response({error:'Method not allowed.'},405);
  if (method !== 'GET' && rejectCrossOrigin(request)) return response({error:'Save entries from this dashboard.'},403);
  if (!db) return response({error:'Saved entries are temporarily unavailable. Your form has not been cleared.'},503);
  try {
    if (method === 'GET') {
      const result = await db.prepare(strengthRows).all();
      return response({entries:result.results.map(publicEntry)});
    }
    if (method === 'DELETE') {
      const id = new URL(request.url).searchParams.get('id');
      if (!id || !ID_PATTERN.test(id)) return response({error:'Choose a saved entry to remove.'},400);
      const existing = await db.prepare('SELECT id FROM workout_entries WHERE id = ?').bind(id).first();
      if (!existing) return response({error:'That saved entry was not found.'},404);
      await db.prepare('UPDATE workout_entries SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM hangboard_workouts WHERE source_entry_id = workout_entries.id)').bind(now(),id).run();
      const moved = await db.prepare('SELECT id FROM hangboard_workouts WHERE source_entry_id = ?').bind(id).first();
      if (moved) return response({error:'This workout has moved to Hangboard. Manage or delete it from the Hangboard tab.'},409);
      return response({ok:true});
    }

    const input = await readJson(request);
    const saved = await db.prepare(strengthRows).all();
    const catalog = [...archiveContext.catalog];
    const dateSessions = {...archiveContext.dateSessions};
    for (const row of saved.results) {
      const entry = publicEntry(row);
      catalog.push({name:entry.exercise,category:entry.category,isPullup:entry.records.some(record=>record.is_pullup)});
      if (entry.records[0]) dateSessions[entry.date] ??= entry.records[0].session;
    }
    let normalized;
    try { normalized = normalizeEntry(input,{catalog,dateSessions}); }
    catch (error) {
      return response({error:error instanceof Error ? error.message : 'Check the workout fields.',field:error?.field || null},400);
    }
    const {canonicalPayload,...entry} = normalized;
    const payloadHash = await digest(canonicalPayload);
    const createdAt = now();
    const insert = await db.prepare('INSERT INTO workout_entries (id, workout_date, exercise_name, payload_json, payload_hash, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
      .bind(entry.id,entry.date,entry.exercise,JSON.stringify(entry),payloadHash,createdAt).run();
    const persisted = await db.prepare('SELECT id, payload_json, payload_hash, created_at, deleted_at FROM workout_entries WHERE id = ?').bind(entry.id).first();
    if (!persisted) throw new Error('Saved entry could not be read back.');
    const moved = await db.prepare('SELECT id FROM hangboard_workouts WHERE source_entry_id = ?').bind(entry.id).first();
    if (moved) return response({error:'This workout has moved to Hangboard. Open its saved workout there.'},409);
    if (persisted.deleted_at) return response({error:'This entry was removed. Start a new entry to save these sets.'},409);
    if (persisted.payload_hash !== payloadHash) return response({error:'An earlier version of this entry was already saved. Reload your history before saving it again.'},409);
    return response({entry:publicEntry(persisted)},insert.meta?.changes ? 201 : 200);
  } catch (error) {
    if ([400,413,415].includes(error?.status)) return response({error:error.message},error.status);
    console.error('Workout storage request failed:',error instanceof Error ? error.message : 'Unknown storage error');
    return response({error:'Your entry could not be confirmed as saved. Keep this form open and retry; a retry will not add duplicate sets.'},503);
  }
}
