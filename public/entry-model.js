/** Shared, pure validation for manual workout entries. All entered masses are lb. */
const CATEGORIES = new Set(['Pull', 'Push', 'Legs', 'Arms', 'Shoulders', 'Core', 'Grip', 'Other']);
const TRACKING = new Set(['reps', 'timed', 'repeaters']);
const LOAD_MODES = new Set(['weight', 'dumbbell', 'pullup', 'bodyweight', 'stack', 'band']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const nameKey = value => value.normalize('NFC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('en-CA');

export class EntryValidationError extends Error {
  constructor(field, message) {
    super(message);
    this.name = 'EntryValidationError';
    this.status = 400;
    this.field = field;
    this.issues = [{ field, message }];
  }
}

function fail(field, message) { throw new EntryValidationError(field, message); }
function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field, 'Enter a valid workout entry.');
  return value;
}
function label(value, field, maximum, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string') fail(field, `Enter ${field === 'exercise' ? 'an exercise name' : 'a text value'}.`);
  const cleaned = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (required && !cleaned) fail(field, field === 'exercise' ? 'Enter an exercise name.' : 'Enter a band or resistance label.');
  if (cleaned.length > maximum) fail(field, `Keep ${field} to ${maximum} characters or fewer.`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(cleaned)) fail(field, `${field} contains an unsupported control character.`);
  return cleaned;
}
function note(value, field, maximum) {
  if (value == null) return '';
  if (typeof value !== 'string') fail(field, 'Notes must be text.');
  const cleaned = value.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  if (cleaned.length > maximum) fail(field, `Keep ${field} to ${maximum} characters or fewer.`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(cleaned)) fail(field, 'Notes contain an unsupported control character.');
  return cleaned;
}
function quantity(value, field, minimum, maximum, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(field, `Enter a number for ${field}.`);
  if (value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
    fail(field, `Enter ${integer ? 'a whole number' : 'a number'} from ${minimum} to ${maximum} for ${field}.`);
  }
  return Object.is(value, -0) ? 0 : value;
}
function positive(value, field, maximum) {
  const result = quantity(value, field, 0, maximum);
  if (result <= 0) fail(field, `${field} must be greater than zero.`);
  return result;
}
function validDate(value) {
  if (typeof value !== 'string') fail('date', 'Choose a complete workout date.');
  const cleaned = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cleaned);
  if (!match) fail('date', 'Choose a complete date in YYYY-MM-DD format.');
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) fail('date', 'Choose a real calendar date.');
  return cleaned;
}

/**
 * Returns sanitized input plus analytics-compatible records. Throws
 * EntryValidationError with {status:400, field, issues:[{field,message}]}.
 * No timestamps, random IDs, storage, browser globals, or bodyweight assumptions.
 */
export function normalizeEntry(input, context = {}) {
  object(input, 'entry');
  if (typeof input.id !== 'string' || !UUID.test(input.id.trim())) fail('id', 'The entry identifier is invalid. Reopen the entry form and try again.');
  const id = input.id.trim().toLowerCase();
  const date = validDate(input.date);
  const requestedName = label(input.exercise, 'exercise', 120, true);
  const catalog = Array.isArray(context.catalog) ? context.catalog : [];
  const known = catalog.find(item => typeof item?.name === 'string' && nameKey(item.name) === nameKey(requestedName));
  const exercise = known ? label(known.name, 'exercise', 120, true) : requestedName;
  const category = known ? known.category : input.category;
  if (!CATEGORIES.has(category)) fail('category', 'Choose an exercise category.');
  const tracking = input.tracking;
  if (!TRACKING.has(tracking)) fail('tracking', 'Choose repetitions, single holds, or hangboard repeaters.');
  const timed = tracking === 'timed' || tracking === 'repeaters';
  const loadMode = input.loadMode;
  if (!LOAD_MODES.has(loadMode)) fail('loadMode', 'Choose how the resistance is recorded.');
  if (known?.isPullup && loadMode !== 'pullup') fail('loadMode', 'For this pull-up exercise, enter added weight only; use 0 for bodyweight.');
  const setupLabel = label(input.setupLabel, 'setupLabel', 200, loadMode === 'band');
  const notes = note(input.notes, 'notes', 2000);
  if (!Array.isArray(input.sets) || input.sets.length < 1 || input.sets.length > 50) fail('sets', 'Add between 1 and 50 sets.');

  const sets = input.sets.map((raw, index) => {
    const prefix = `sets[${index}]`;
    object(raw, prefix);
    const reps = tracking === 'reps' ? positive(raw.reps, `${prefix}.reps`, 10000) : null;
    const duration_s = timed ? positive(raw.duration_s, `${prefix}.duration_s`, 86400) : null;
    const hold_count = timed
      ? quantity(raw.hold_count === undefined && tracking === 'timed' ? 1 : raw.hold_count, `${prefix}.hold_count`, 1, 1000, true)
      : null;
    const load = ['weight', 'dumbbell', 'pullup', 'stack'].includes(loadMode)
      ? quantity(raw.load, `${prefix}.load`, 0, 10000) : null;
    if (raw.warmup !== undefined && typeof raw.warmup !== 'boolean') fail(`${prefix}.warmup`, 'The warm-up choice must be true or false.');
    const warmup = raw.warmup === true;
    const side = raw.side == null || raw.side === '' ? null : raw.side;
    if (side !== null && side !== 'Left' && side !== 'Right') fail(`${prefix}.side`, 'Choose left, right, or both/all sides.');
    const set = { reps, duration_s, hold_count, load, warmup, side, notes: note(raw.notes, `${prefix}.notes`, 1000) };
    if (tracking === 'repeaters') {
      set.round = quantity(raw.round === undefined ? index + 1 : raw.round, `${prefix}.round`, 1, 1000, true);
      set.rest_s = raw.rest_s === undefined || raw.rest_s === null ? null : quantity(raw.rest_s, `${prefix}.rest_s`, 0, 86400);
      set.round_rest_s = raw.round_rest_s === undefined || raw.round_rest_s === null ? null : quantity(raw.round_rest_s, `${prefix}.round_rest_s`, 0, 86400);
    }
    return set;
  });

  const dateSessions = context.dateSessions && typeof context.dateSessions === 'object' ? context.dateSessions : {};
  const existingSession = own(dateSessions, date) ? dateSessions[date] : null;
  const session = Number.isSafeInteger(existingSession) && existingSession > 0 ? existingSession : Number(date.replaceAll('-', ''));
  const loadBasis = {
    weight: 'Recorded load', dumbbell: 'Per dumbbell', pullup: 'Added load; total shown separately',
    bodyweight: timed ? 'Hold duration' : 'Repetitions',
    stack: 'Machine setting; mass unknown', band: 'Band colour; resistance unknown',
  }[loadMode];
  const records = sets.map((set, index) => {
    const setup = loadMode === 'stack' ? `Stack setting ${set.load}; mass unknown`
      : loadMode === 'bodyweight' ? 'Bodyweight; no mass estimate'
      : loadMode === 'pullup' ? set.load === 0 ? 'Bodyweight pull-up' : 'Added weight' : '';
    return {
      record_id: `M_${id}_${index + 1}`, entry_id: id, source_type: 'manual', source_row: null,
      exercise, category, date, session, set: index + 1,
      reps: set.reps,
      load_lb: ['weight', 'dumbbell', 'pullup'].includes(loadMode) ? set.load : null,
      pullup_total_lb: null, is_pullup: loadMode === 'pullup', load_basis: loadBasis,
      stack_setting: loadMode === 'stack' ? set.load : null,
      duration_s: set.duration_s, hold_count: set.hold_count, side: set.side, round: set.round ?? null,
      ...(tracking === 'repeaters' ? {tracking, rest_s:set.rest_s, round_rest_s:set.round_rest_s} : {}),
      is_warmup: set.warmup, set_type: set.warmup ? 'Warm-up' : tracking === 'repeaters' ? 'Repeater round' : tracking === 'timed' && set.hold_count > 1 ? 'Repeater component' : 'Work',
      additional_reps: null, additional_type: null,
      resistance_setup: [setup, setupLabel].filter(Boolean).join('; ') || null,
      notes: [notes, set.notes].filter(Boolean).join('\n') || null,
      date_basis: 'Date entered on site', source_photo: null,
      original_exercise: exercise, original_variation: setupLabel || null, original_reps: set.reps,
    };
  });
  const canonicalPayload = JSON.stringify({ date, exercise, category, tracking, loadMode, setupLabel, notes, sets });
  return { id, date, exercise, category, tracking, loadMode, setupLabel, notes, records, canonicalPayload };
}
