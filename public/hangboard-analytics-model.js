/**
 * Descriptive max-hang analytics. The score is supported load × recorded time
 * (lb·s), not a force measurement, predicted maximum, or physiological model.
 * No current/profile bodyweight or unrecorded result is ever substituted.
 */
import { hangboardDate } from './hangboard-model.js';

export const MAX_HANG_SCORE_UNIT = 'lb·s';
export const MAX_HANG_EXCLUSION_LABELS = Object.freeze({
  missing_bodyweight: 'Workout bodyweight not recorded',
  not_completed: 'Result not marked Completed',
  unknown_load: 'Load not recorded',
  invalid_load: 'Load cannot be scored',
  invalid_duration: 'Single-hold duration missing or invalid',
  warmup: 'Warm-up hold',
  unknown_warmup: 'Warm-up status not recorded',
  protocol: 'Not a max-hang workout',
  deleted: 'Deleted record',
  invalid_date: 'Workout date invalid',
});
const finite = value => typeof value === 'number' && Number.isFinite(value);
const positive = value => finite(value) && value > 0;
const clean = value => typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/gu, ' ') : '';
const key = value => clean(value).toLocaleLowerCase('en');
const handLabels = {both: 'Both hands', left: 'Left hand', right: 'Right hand', unspecified: 'Hands not recorded'};
const validDate = value => { try { return hangboardDate(value); } catch { return null; } };

/** Keep no-hang loads and unlike recorded conditions out of a shared series. */
export function maxHangCondition(workout = {}, set = {}) {
  const measurement = set.loadMode === 'absolute' ? 'no_hang' : 'hang';
  const grip = clean(set.grip), location = clean(workout.location), setup = clean(set.setup);
  const hand = Object.hasOwn(handLabels, set.hand) ? set.hand : 'unspecified';
  const edgeMm = positive(set.edgeMm) && set.edgeMm <= 200 ? set.edgeMm : null;
  const conditionKey = JSON.stringify([measurement, key(grip), edgeMm, hand, key(location), key(setup)]);
  const conditionLabel = [grip || 'Grip not recorded', edgeMm === null ? 'Edge not recorded' : `${edgeMm} mm`, handLabels[hand], location || 'Board / location not recorded', setup].filter(Boolean).join(' · ');
  return {measurement, conditionKey, conditionLabel, conditionComplete: !!grip && edgeMm !== null && hand !== 'unspecified' && !!location, grip, edgeMm, hand, location, setup};
}

/**
 * Inspect one hold. Ineligible results deliberately retain a null score.
 * Absolute loads describe the logger's separate no-hang mode, never BW + load.
 */
export function scoreMaxHangSet(workout = {}, set = {}) {
  workout = workout && typeof workout === 'object' ? workout : {};
  set = set && typeof set === 'object' ? set : {};
  const condition = maxHangCondition(workout, set);
  const result = {
    eligible: false, reason: null, score: null, loadLb: null, seconds: null,
    bodyweightLb: positive(workout.bodyweightLb) && workout.bodyweightLb <= 1000 ? workout.bodyweightLb : null,
    addedWeightLb: set.loadMode === 'added' && finite(set.loadLb) ? set.loadLb : null,
    assistanceLb: set.loadMode === 'assisted' && finite(set.loadLb) ? set.loadLb : null,
    loadMode: set.loadMode || 'unknown', workoutId: clean(workout.id), setId: clean(set.id),
    date: validDate(workout.date), title: clean(workout.title), ...condition,
  };
  const excluded = reason => ({...result, reason});
  if (workout.protocol !== 'max_hangs') return excluded('protocol');
  if (workout.deleted_at || workout.deletedAt || set.deleted_at || set.deletedAt) return excluded('deleted');
  if (!result.date) return excluded('invalid_date');
  if (set.isWarmup !== false) return excluded(set.isWarmup === true ? 'warmup' : 'unknown_warmup');
  if (set.status !== 'completed') return excluded('not_completed');
  if (!Array.isArray(set.segments) || set.segments.length !== 1 || set.segments[0]?.count !== 1 || !positive(set.segments[0]?.seconds) || set.segments[0].seconds > 86400) return excluded('invalid_duration');
  result.seconds = set.segments[0].seconds;
  if (!['bodyweight', 'added', 'assisted', 'absolute'].includes(set.loadMode)) return excluded('unknown_load');
  if (set.loadMode !== 'bodyweight' && (!finite(set.loadLb) || set.loadLb < 0 || set.loadLb > 10000)) return excluded('invalid_load');
  if (set.loadMode === 'bodyweight' && set.loadLb != null) return excluded('invalid_load');
  if (set.loadMode === 'absolute') result.loadLb = set.loadLb;
  else {
    if (result.bodyweightLb === null) return excluded('missing_bodyweight');
    result.loadLb = result.bodyweightLb + (set.loadMode === 'added' ? set.loadLb : set.loadMode === 'assisted' ? -set.loadLb : 0);
  }
  if (!positive(result.loadLb)) return excluded('invalid_load');
  result.score = result.loadLb * result.seconds;
  if (!positive(result.score)) return excluded('invalid_load');
  return {...result, eligible: true};
}

function latestSnapshots(workouts) {
  const selected = new Map();
  for (const [index, workout] of (Array.isArray(workouts) ? workouts : []).entries()) {
    if (!workout || typeof workout !== 'object' || Array.isArray(workout)) continue;
    const id = key(workout.id) || `index:${index}`, previous = selected.get(id);
    const revision = Number.isSafeInteger(workout.revision) ? workout.revision : 0;
    const priorRevision = Number.isSafeInteger(previous?.revision) ? previous.revision : 0;
    const stamp = String(workout.updated_at || workout.updatedAt || workout.created_at || '');
    const priorStamp = String(previous?.updated_at || previous?.updatedAt || previous?.created_at || '');
    if (!previous || revision > priorRevision || revision === priorRevision && (stamp > priorStamp || stamp === priorStamp && !!(workout.deleted_at || workout.deletedAt))) selected.set(id, workout);
  }
  return [...selected.values()];
}

const bestFirst = (a, b) => b.score - a.score || b.loadLb - a.loadLb || String(b.date).localeCompare(String(a.date)) || a.workoutId.localeCompare(b.workoutId) || a.setId.localeCompare(b.setId);

/**
 * Best single hold in an inclusive date interval; volume is never summed into
 * this score. `measurement` defaults to genuine hangs; no-hangs stay separate.
 */
export function summarizeMaxHangs(workouts = [], {start = null, end = null, conditionKey = null, measurement = 'hang'} = {}) {
  if (start !== null && !validDate(start) || end !== null && !validDate(end)) throw new RangeError('Use valid calendar dates for max-hang analytics.');
  if (start && end && start > end) throw new RangeError('The start date must not be after the end date.');
  if (!['hang', 'no_hang'].includes(measurement)) throw new RangeError('Choose hangs or no-hangs.');
  const holds = [], excluded = {}, available = new Map();
  const countExcluded = reason => { excluded[reason] = (excluded[reason] || 0) + 1; };
  let recordedHolds = 0;
  for (const workout of latestSnapshots(workouts)) {
    if (workout.deleted_at || workout.deletedAt || workout.protocol !== 'max_hangs') continue;
    const date = validDate(workout.date);
    if (!date || start && date < start || end && date > end) continue;
    const seenSets = new Set();
    for (const set of Array.isArray(workout.sets) ? workout.sets : []) {
      if (!set || typeof set !== 'object' || Array.isArray(set)) continue;
      const setKey = key(set.id);
      if (setKey && seenSets.has(setKey)) continue;
      if (setKey) seenSets.add(setKey);
      const hold = scoreMaxHangSet(workout, set);
      if (hold.measurement !== measurement) continue;
      if (!available.has(hold.conditionKey)) available.set(hold.conditionKey, {key: hold.conditionKey, label: hold.conditionLabel, complete: hold.conditionComplete, measurement: hold.measurement, recordedHolds: 0, scoredHolds: 0, best: null});
      const condition = available.get(hold.conditionKey);
      condition.recordedHolds++;
      if (hold.eligible) {
        condition.scoredHolds++;
        if (!condition.best || bestFirst(hold, condition.best) < 0) condition.best = hold;
      }
      if (conditionKey && hold.conditionKey !== conditionKey) continue;
      recordedHolds++;
      if (!hold.eligible) { countExcluded(hold.reason); continue; }
      holds.push(hold);
    }
  }
  holds.sort(bestFirst);
  const byWorkout = new Map();
  for (const hold of holds) {
    const id = `${hold.workoutId}:${hold.conditionKey}`;
    if (!byWorkout.has(id)) byWorkout.set(id, {workoutId: hold.workoutId, date: hold.date, title: hold.title, conditionKey: hold.conditionKey, conditionLabel: hold.conditionLabel, conditionComplete: hold.conditionComplete, measurement: hold.measurement, score: hold.score, best: hold, scoredHolds: 0});
    byWorkout.get(id).scoredHolds++;
  }
  const conditions = [...available.values()].sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  const activeConditionKeys = new Set(holds.map(hold => hold.conditionKey));
  return {
    score: holds[0]?.score ?? null, best: holds[0] ?? null, unit: MAX_HANG_SCORE_UNIT,
    scoredHolds: holds.length, recordedHolds, excluded, holds, conditions,
    byWorkout: [...byWorkout.values()].sort((a, b) => a.date.localeCompare(b.date) || a.workoutId.localeCompare(b.workoutId) || a.conditionKey.localeCompare(b.conditionKey)),
    mixedConditions: activeConditionKeys.size > 1,
    conditionsIncomplete: holds.some(hold => !hold.conditionComplete),
    start, end, measurement,
  };
}
