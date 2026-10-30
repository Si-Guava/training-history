/** Read-only climbing analytics. Native grade orders never imply cross-scale equivalence. */
import { CLIMB_CATEGORIES, GRADE_SYSTEMS, categoryInfo, climbingDate } from './climbing-model.js';

const DAY = 86400000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const text = value => typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/gu, ' ') : '';
const keyText = value => text(value).toLocaleLowerCase('en');
const validId = value => typeof value === 'string' && UUID.test(value);
const validDate = value => { try { return climbingDate(value); } catch { return null; } };
const categoryLabel = value => categoryInfo(value)?.label || value;
const systemLabel = value => GRADE_SYSTEMS.find(item => item.id === value)?.label || value;

// Only unambiguous, commonly recorded labels are ranked. Local colours, plus/minus
// V labels, unsupported notation and ambiguous YDS whole grades remain unranked.
const fontLow = ['1', '2', '3', '4', '4+', '5', '5+'];
function exactGrade(system, value) {
  const raw = text(value);
  if (!raw) return null;
  if (system === 'v') {
    const label = raw.toUpperCase();
    if (label === 'VB' || label === 'V-B') return {label: 'VB', rank: -1};
    const match = /^V(0|[1-9]|1\d|20)$/.exec(label);
    return match ? {label: `V${Number(match[1])}`, rank: Number(match[1])} : null;
  }
  if (system === 'font') {
    const label = raw.toUpperCase();
    if (fontLow.includes(label)) return {label, rank: fontLow.indexOf(label)};
    const match = /^([6-9])([ABC])(\+?)$/.exec(label);
    return match ? {label, rank: 7 + (Number(match[1]) - 6) * 6 + 'ABC'.indexOf(match[2]) * 2 + (match[3] ? 1 : 0)} : null;
  }
  if (system === 'french') {
    const label = raw.toLowerCase();
    if (/^[1-3]$/.test(label)) return {label, rank: Number(label) - 1};
    const match = /^([4-9])([abc])(\+?)$/.exec(label);
    return match ? {label, rank: 3 + (Number(match[1]) - 4) * 6 + 'abc'.indexOf(match[2]) * 2 + (match[3] ? 1 : 0)} : null;
  }
  if (system === 'yds') {
    const label = raw.toLowerCase();
    const low = /^5\.([0-9])$/.exec(label);
    if (low) return {label, rank: Number(low[1])};
    const match = /^5\.(1[0-6])([abcd])$/.exec(label);
    return match ? {label, rank: 10 + (Number(match[1]) - 10) * 4 + 'abcd'.indexOf(match[2])} : null;
  }
  return null;
}

/** Rank only an exact grade in its own system. Null means not safely orderable. */
export function gradeRank(system, label) { return exactGrade(system, label)?.rank ?? null; }

/** Preserve uncertainty: a recorded range has no exact rank or achieved upper grade. */
export function parseClimbingGrade(record = {}) {
  const gradeSystem = GRADE_SYSTEMS.some(item => item.id === record.gradeSystem) ? record.gradeSystem : 'other';
  let first = text(record.gradeMin), last = text(record.gradeMax);
  const rawLabel = first ? (last && last !== first ? `${first}–${last}` : first) : 'Ungraded';
  if (first && !last) {
    const range = /^(.+?)\s*[–—-]\s*(.+)$/.exec(first);
    if (range && exactGrade(gradeSystem, range[1]) && exactGrade(gradeSystem, range[2])) {
      first = range[1]; last = range[2];
    }
  }
  const low = exactGrade(gradeSystem, first), high = last ? exactGrade(gradeSystem, last) : low;
  const same = low && high && low.rank === high.rank;
  const isRange = Boolean(last && keyText(last) !== keyText(first) && !same);
  const ordered = Boolean(low && high && low.rank <= high.rank);
  const rank = low && !isRange ? low.rank : null;
  return {
    gradeSystem, rawLabel,
    label: !first ? 'Ungraded' : isRange ? `${low?.label || first}–${high?.label || last}` : low?.label || first,
    rank, lowerRank: ordered ? low.rank : null, upperRank: ordered ? high.rank : null,
    isRange, rankable: rank !== null, orderedRange: isRange && ordered,
  };
}

function weekStart(date) {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() - (parsed.getUTCDay() + 6) % 7);
  return parsed.toISOString().slice(0, 10);
}
function addDays(date, days) { return new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10); }
function snapshotOrder(a, b) {
  const revision = item => Number.isSafeInteger(item.revision) ? item.revision : 0;
  return revision(a) - revision(b) || String(a.updated_at || a.updatedAt || '').localeCompare(String(b.updated_at || b.updatedAt || '')) ||
    Number(Boolean(a.deleted_at || a.deletedAt)) - Number(Boolean(b.deleted_at || b.deletedAt)) || JSON.stringify(a).localeCompare(JSON.stringify(b));
}
function dedupeWorkouts(workouts, diagnostics) {
  const byId = new Map();
  for (const workout of Array.isArray(workouts) ? workouts : []) {
    if (!workout || !validId(workout.id)) { diagnostics.invalidWorkouts++; continue; }
    const id = workout.id.toLowerCase();
    if (byId.has(id)) diagnostics.duplicateWorkouts++;
    if (!byId.has(id) || snapshotOrder(workout, byId.get(id)) > 0) byId.set(id, workout);
  }
  return [...byId.values()].filter(workout => {
    if (workout.deleted_at || workout.deletedAt) return false;
    if (!categoryInfo(workout.category) || !validDate(workout.date)) { diagnostics.invalidWorkouts++; return false; }
    return true;
  });
}

/** Build explicit try slots, retaining the existing maximum-ordinal attempt convention. */
function workoutRows(workout, diagnostics) {
  const variants = new Map(), ids = new Set(), info = categoryInfo(workout.category);
  for (const [index, attempt] of (Array.isArray(workout.attempts) ? workout.attempts : []).entries()) {
    if (!attempt || attempt.deleted_at || attempt.deletedAt) continue;
    if (!validId(attempt.id) || !validId(attempt.climbId) || !Number.isInteger(attempt.attemptNumber) || attempt.attemptNumber < 1 || attempt.attemptNumber > 9999 || typeof attempt.completed !== 'boolean' ||
      (workout.category === 'kilter' && (!finite(attempt.angle) || attempt.angle < 0 || attempt.angle > 90))) { diagnostics.invalidAttempts++; continue; }
    const attemptId = attempt.id.toLowerCase();
    if (ids.has(attemptId)) { diagnostics.duplicateAttemptIds++; continue; }
    ids.add(attemptId);
    const angle = workout.category === 'kilter' ? attempt.angle : null;
    const climbId = attempt.climbId.toLowerCase();
    const variantKey = `${workout.category}:${climbId}:${angle ?? ''}`;
    if (!variants.has(variantKey)) variants.set(variantKey, new Map());
    const slots = variants.get(variantKey);
    const row = {
      workoutId: workout.id.toLowerCase(), date: workout.date, category: workout.category,
      discipline: info.discipline, environment: info.environment, venue: text(workout.venue),
      climbId, variantKey, sessionKey: `${workout.id.toLowerCase()}:${variantKey}`, angle,
      id: attemptId, name: text(attempt.name), attemptNumber: attempt.attemptNumber,
      completed: attempt.completed, grade: parseClimbingGrade(attempt),
      effort: finite(attempt.effort) && attempt.effort >= 1 && attempt.effort <= 10 ? attempt.effort : null,
      restSeconds: finite(attempt.restSeconds) && attempt.restSeconds >= 0 ? attempt.restSeconds : null,
      tags: [...new Map((Array.isArray(attempt.tags) ? attempt.tags : []).map(tag => [keyText(tag), text(tag)]).filter(([key]) => key)).values()],
      index,
    };
    const previous = slots.get(attempt.attemptNumber);
    if (previous) diagnostics.duplicateAttemptNumbers++;
    // Same session ordinal denotes one try. An explicitly recorded success is
    // retained; a second copy cannot inflate sends or make send rate exceed 100%.
    if (!previous || row.completed || !previous.completed) slots.set(attempt.attemptNumber, row);
  }
  const rows = [];
  for (const slots of variants.values()) {
    let previousNumber = 0;
    for (const row of [...slots.values()].sort((a, b) => a.attemptNumber - b.attemptNumber)) {
      row.attemptContribution = row.attemptNumber - previousNumber;
      previousNumber = row.attemptNumber;
      rows.push(row);
    }
  }
  return rows;
}

function aggregate(rows) {
  const variants = new Set(), sentVariants = new Set(), sessions = new Set(), sentSessions = new Set(), workouts = new Set(), dates = new Set();
  let attempts = 0, sends = 0, effortSum = 0, effortCount = 0, firstTrySends = 0, restSeconds = 0, restCount = 0;
  for (const row of rows) {
    variants.add(row.variantKey); sessions.add(row.sessionKey); workouts.add(row.workoutId); dates.add(row.date);
    attempts += row.attemptContribution;
    if (row.completed) { sends++; sentVariants.add(row.variantKey); sentSessions.add(row.sessionKey); if (row.attemptNumber === 1) firstTrySends++; }
    if (row.effort !== null) { effortSum += row.effort; effortCount++; }
    if (row.restSeconds !== null) { restSeconds += row.restSeconds; restCount++; }
  }
  return {
    distinctClimbs: variants.size, climbSessions: sessions.size, attempts, loggedAttempts: rows.length,
    unrecordedAttempts: Math.max(0, attempts - rows.length), sends, distinctSentClimbs: sentVariants.size,
    sendSessions: sentSessions.size, sendRate: attempts ? sends / attempts : null,
    climbConversion: sessions.size ? sentSessions.size / sessions.size : null,
    meanEffort: effortCount ? effortSum / effortCount : null, effortCount, firstTrySends,
    restSeconds, restCount, workouts: workouts.size, days: dates.size,
  };
}

function gradeEvidence(row) {
  return {label: row.grade.label, rank: row.grade.rank, lowerRank: row.grade.lowerRank, upperRank: row.grade.upperRank,
    date: row.date, name: row.name, climbId: row.climbId, workoutId: row.workoutId, angle: row.angle};
}
function maximumGrades(rows) {
  const scopes = new Map();
  for (const row of rows) {
    if (!row.completed) continue;
    const key = `${row.category}:${row.grade.gradeSystem}`;
    if (!scopes.has(key)) scopes.set(key, {category: row.category, gradeSystem: row.grade.gradeSystem, exact: null, ranges: new Map(), rangedSends: 0, unrankedSends: 0});
    const scope = scopes.get(key);
    if (row.grade.rank !== null) {
      if (!scope.exact || row.grade.rank > scope.exact.rank || row.grade.rank === scope.exact.rank && row.date > scope.exact.date) scope.exact = gradeEvidence(row);
    } else if (row.grade.isRange) {
      scope.rangedSends++;
      const range = scope.ranges.get(row.grade.label) || {...gradeEvidence(row), count: 0};
      range.count++;
      scope.ranges.set(row.grade.label, range);
    } else scope.unrankedSends++;
  }
  return [...scopes.values()].map(scope => ({...scope, label: scope.exact?.label ?? null, rank: scope.exact?.rank ?? null,
    ranges: [...scope.ranges.values()].sort((a, b) => (b.lowerRank ?? -Infinity) - (a.lowerRank ?? -Infinity) || (b.upperRank ?? -Infinity) - (a.upperRank ?? -Infinity) || a.label.localeCompare(b.label)),
  })).sort((a, b) => CLIMB_CATEGORIES.findIndex(item => item.id === a.category) - CLIMB_CATEGORIES.findIndex(item => item.id === b.category) || a.gradeSystem.localeCompare(b.gradeSystem));
}

/** Exact maximum and range evidence remain visibly distinct. */
export function formatMaxGrade(summaryOrScopes, {includeScope = null, rangeLimit = 2} = {}) {
  const scopes = Array.isArray(summaryOrScopes) ? summaryOrScopes : summaryOrScopes?.maxGrades || [];
  if (!scopes.length) return '—';
  const showScope = includeScope ?? scopes.length > 1;
  return scopes.map(scope => {
    const parts = scope.label ? [scope.label] : [];
    const relevantRanges = scope.ranges.filter(range => scope.rank === null || range.upperRank === null || range.upperRank > scope.rank);
    for (const range of relevantRanges.slice(0, rangeLimit)) parts.push(`${range.label} (range)`);
    if (relevantRanges.length > rangeLimit) parts.push(`+${relevantRanges.length - rangeLimit} ranges`);
    if (!parts.length) parts.push(scope.unrankedSends ? 'Unranked sends' : 'No exact grade');
    const label = parts.join(' · ');
    return showScope ? `${categoryLabel(scope.category)} / ${systemLabel(scope.gradeSystem)}: ${label}` : label;
  }).join('; ');
}

function groupRows(rows, keyFn, detailFn, {maxGrades = false} = {}) {
  const groups = new Map();
  for (const row of rows) {
    const values = keyFn(row);
    for (const value of Array.isArray(values) ? values : [values]) {
      if (!groups.has(value)) groups.set(value, []);
      groups.get(value).push(row);
    }
  }
  return [...groups].map(([key, members]) => ({key, ...detailFn(key, members), ...aggregate(members), ...(maxGrades ? {maxGrades: maximumGrades(members)} : {})}));
}

/**
 * Filters are inclusive. Passing categories:[] deliberately selects nothing.
 * Distinct climbs count category+stable climb ID (+angle for Kilter) once in
 * the selected period. climbSessions counts that identity once per workout.
 * Attempts sum each workout/variant's maximum ordinal, never 1+2+3. When
 * metadata changes between tries, ordinal increments belong to that saved
 * snapshot, ensuring grade buckets do not duplicate the same implied tries.
 */
export function summarizeClimbing(workouts = [], options = {}) {
  const diagnostics = {invalidWorkouts: 0, invalidAttempts: 0, duplicateWorkouts: 0, duplicateAttemptIds: 0, duplicateAttemptNumbers: 0, invalidDateFilter: false};
  const from = options.from ? validDate(options.from) : null, to = options.to ? validDate(options.to) : null;
  diagnostics.invalidDateFilter = Boolean(options.from && !from || options.to && !to || from && to && from > to);
  const categories = options.categories !== undefined ? new Set(Array.isArray(options.categories) ? options.categories : []) : options.category ? new Set([options.category]) : null;
  const venue = keyText(options.venue), gradeSystem = options.gradeSystem && options.gradeSystem !== 'all' ? options.gradeSystem : null;
  const angle = finite(options.angle) ? options.angle : null;
  const selected = dedupeWorkouts(workouts, diagnostics).filter(workout => !diagnostics.invalidDateFilter && (!categories || categories.has(workout.category)) && (!from || workout.date >= from) && (!to || workout.date <= to) && (!venue || keyText(workout.venue) === venue));
  const rows = selected.flatMap(workout => workoutRows(workout, diagnostics)).filter(row => (!gradeSystem || row.grade.gradeSystem === gradeSystem) && (angle === null || row.category === 'kilter' && row.angle === angle))
    .sort((a, b) => a.date.localeCompare(b.date) || a.workoutId.localeCompare(b.workoutId) || a.variantKey.localeCompare(b.variantKey) || a.attemptNumber - b.attemptNumber);
  const daily = groupRows(rows, row => row.date, date => ({date}), {maxGrades: true}).sort((a, b) => a.date.localeCompare(b.date));
  const weekly = groupRows(rows, row => weekStart(row.date), date => ({date, end: addDays(date, 6)}), {maxGrades: true}).sort((a, b) => a.date.localeCompare(b.date));
  const grades = groupRows(rows, row => JSON.stringify([row.category, row.grade.gradeSystem, row.grade.label]), (key, members) => ({category: members[0].category, ...members[0].grade}))
    .sort((a, b) => a.category.localeCompare(b.category) || a.gradeSystem.localeCompare(b.gradeSystem) || (a.lowerRank ?? Infinity) - (b.lowerRank ?? Infinity) || Number(a.isRange) - Number(b.isRange) || a.label.localeCompare(b.label));
  const angles = groupRows(rows.filter(row => row.category === 'kilter'), row => row.angle, angle => ({angle, label: `${angle}°`}), {maxGrades: true}).sort((a, b) => a.angle - b.angle);
  const tags = groupRows(rows, row => row.tags.map(keyText), (key, members) => ({label: members[0].tags.find(tag => keyText(tag) === key) || key})).sort((a, b) => b.climbSessions - a.climbSessions || a.label.localeCompare(b.label));
  const environments = groupRows(rows, row => row.environment, key => ({label: {indoor: 'Indoor', outdoor: 'Outdoor', board: 'Board'}[key] || key}));
  const venues = groupRows(rows, row => keyText(row.venue), (key, members) => ({label: members[0].venue || 'Unspecified venue'})).sort((a, b) => b.climbSessions - a.climbSessions || a.label.localeCompare(b.label));
  return {totals: aggregate(rows), maxGrades: maximumGrades(rows), daily, weekly, grades, angles, tags, environments, venues, diagnostics,
    gradeSystems: [...new Set(rows.map(row => row.grade.gradeSystem))],
    dateRange: {from: from || daily[0]?.date || null, to: to || daily.at(-1)?.date || null}};
}
