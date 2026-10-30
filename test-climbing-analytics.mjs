import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {summarizeClimbing, gradeRank, parseClimbingGrade, formatMaxGrade} from './public/climbing-analytics-model.js';

const attempt = (patch = {}) => ({id: randomUUID(), climbId: randomUUID(), name: 'Test problem', gradeSystem: 'v', gradeMin: 'V5', gradeMax: '', attemptNumber: 1, completed: false, effort: null, restSeconds: null, tags: [], angle: null, ...patch});
const workout = (patch = {}) => ({id: randomUUID(), date: '2026-10-26', category: 'indoor_boulder', venue: 'Test gym', attempts: [], revision: 1, updated_at: '2026-10-26T12:00:00Z', deleted_at: null, ...patch});
const series = (numbers, patch = {}) => { const climbId = randomUUID(); return numbers.map(attemptNumber => attempt({climbId, attemptNumber, ...patch})); };

test('attempt totals use maximum session ordinals and explicit successes, never sum 1+2+3', () => {
  const rows = series([1, 2, 3]); rows[2].completed = true;
  const value = summarizeClimbing([workout({attempts: rows})]);
  assert.equal(value.totals.attempts, 3);
  assert.equal(value.totals.loggedAttempts, 3);
  assert.equal(value.totals.distinctClimbs, 1);
  assert.equal(value.totals.climbSessions, 1);
  assert.equal(value.totals.sends, 1);
  assert.equal(value.totals.sendRate, 1 / 3);
  assert.equal(value.totals.unrecordedAttempts, 0);
});

test('sparse ordinal entries include implied attempts without inventing their results or effort', () => {
  const value = summarizeClimbing([workout({attempts: series([5], {completed: true, effort: 8})})]);
  assert.equal(value.totals.attempts, 5);
  assert.equal(value.totals.loggedAttempts, 1);
  assert.equal(value.totals.unrecordedAttempts, 4);
  assert.equal(value.totals.sends, 1);
  assert.equal(value.totals.firstTrySends, 0);
  assert.equal(value.totals.meanEffort, 8);
  assert.equal(value.totals.effortCount, 1);
});

test('range-wide distinct climbs differ from climb sessions and repeat successful ascents', () => {
  const climbId = randomUUID();
  const rows = [workout({attempts: [attempt({climbId, completed: true}), attempt({climbId, attemptNumber: 2, completed: true})]}),
    workout({date: '2026-10-28', attempts: [attempt({climbId, attemptNumber: 3, completed: true})]})];
  const value = summarizeClimbing(rows);
  assert.equal(value.totals.distinctClimbs, 1);
  assert.equal(value.totals.climbSessions, 2);
  assert.equal(value.totals.attempts, 5);
  assert.equal(value.totals.sends, 3);
  assert.equal(value.totals.distinctSentClimbs, 1);
  assert.equal(value.totals.sendSessions, 2);
  assert.equal(value.totals.firstTrySends, 1, 'First try is only a session ordinal, not lifetime flash inference');
  assert.equal(value.daily.length, 2);
});

test('climb identity survives renamed climbs, reused names and different venues', () => {
  const one = randomUUID(), two = randomUUID();
  const value = summarizeClimbing([
    workout({attempts: [attempt({climbId: one, name: 'Old name'})]}),
    workout({venue: 'Second gym', attempts: [attempt({climbId: one, name: 'New name'}), attempt({climbId: two, name: 'New name'})]}),
  ]);
  assert.equal(value.totals.distinctClimbs, 2);
  assert.equal(value.totals.climbSessions, 3);
  assert.equal(value.venues.length, 2);
});

test('Kilter angles are distinct variants and never merge with wall bouldering or lead', () => {
  const climbId = randomUUID();
  const rows = [workout({attempts: [attempt({climbId})]}),
    workout({category: 'kilter', attempts: [attempt({climbId, angle: 40, attemptNumber: 2}), attempt({climbId, angle: 50, attemptNumber: 3, completed: true})]}),
    workout({category: 'indoor_lead', attempts: [attempt({climbId, gradeSystem: 'yds', gradeMin: '5.10c', completed: true})]})];
  const all = summarizeClimbing(rows);
  assert.equal(all.totals.distinctClimbs, 4);
  const kilter = summarizeClimbing(rows, {category: 'kilter'});
  assert.equal(kilter.totals.distinctClimbs, 2);
  assert.equal(kilter.totals.attempts, 5);
  assert.deepEqual(kilter.angles.map(row => [row.angle, row.attempts, row.sends]), [[40, 2, 0], [50, 3, 1]]);
  assert.equal(summarizeClimbing(rows, {category: 'kilter', angle: 40}).totals.attempts, 2);
  assert.equal(summarizeClimbing(rows, {categories: ['indoor_boulder', 'outdoor_boulder']}).totals.distinctClimbs, 1);
  assert.equal(summarizeClimbing(rows, {categories: []}).totals.attempts, 0);
});

test('date, category, venue and scale filters are inclusive and deterministic', () => {
  const rows = [workout({date: '2026-10-25', attempts: [attempt()]}), workout({date: '2026-10-26', attempts: [attempt()]}),
    workout({date: '2026-11-01', venue: '  TEST   GYM ', attempts: [attempt({gradeSystem: 'font', gradeMin: '6C'})]}),
    workout({date: '2026-11-02', attempts: [attempt()]})];
  const value = summarizeClimbing(rows, {from: '2026-10-26', to: '2026-11-01', venue: 'test gym'});
  assert.equal(value.totals.attempts, 2);
  assert.equal(summarizeClimbing(rows, {from: '2026-10-26', to: '2026-11-01', gradeSystem: 'font'}).totals.attempts, 1);
  assert.equal(summarizeClimbing(rows, {from: 'bad-date'}).diagnostics.invalidDateFilter, true);
  assert.equal(summarizeClimbing(rows, {from: '2026-11-01', to: '2026-10-01'}).totals.attempts, 0);
});

test('duplicate snapshots count once and a newer deleted revision cannot resurrect old training', () => {
  const original = workout({attempts: [attempt({completed: true})]});
  const duplicate = structuredClone(original);
  assert.equal(summarizeClimbing([original, duplicate]).totals.sends, 1);
  const deleted = {...original, revision: 2, deleted_at: '2026-10-30T12:00:00Z'};
  assert.equal(summarizeClimbing([original, deleted]).totals.sends, 0);
  assert.equal(summarizeClimbing([deleted, original]).totals.sends, 0);
  const restored = {...deleted, revision: 3, deleted_at: null};
  assert.equal(summarizeClimbing([restored, original, deleted]).totals.sends, 1);
});

test('duplicate attempt IDs and repeated ordinals cannot inflate sends or rate', () => {
  const first = attempt({completed: true});
  const value = summarizeClimbing([workout({attempts: [first, {...first}, {...first, id: randomUUID(), completed: false}, {...first, id: randomUUID(), attemptNumber: 2, completed: true}]})]);
  assert.equal(value.totals.attempts, 2);
  assert.equal(value.totals.loggedAttempts, 2);
  assert.equal(value.totals.sends, 2);
  assert.equal(value.totals.sendRate, 1);
  assert.equal(value.diagnostics.duplicateAttemptIds, 1);
  assert.equal(value.diagnostics.duplicateAttemptNumbers, 1);
});

test('invalid attempts, invalid Kilter angles, invalid dates and empty workouts add no training', () => {
  const rows = [workout(), workout({date: '2026-02-30', attempts: [attempt()]}),
    workout({attempts: [attempt({climbId: 'bad'}), attempt({attemptNumber: 0}), attempt({completed: 'true'})]}),
    workout({category: 'kilter', attempts: [attempt({angle: null}), attempt({angle: 91}), attempt({angle: '40'})]})];
  const value = summarizeClimbing(rows);
  assert.equal(value.totals.attempts, 0);
  assert.equal(value.totals.workouts, 0);
  assert.equal(value.totals.sendRate, null);
  assert.equal(value.totals.meanEffort, null);
  assert.equal(formatMaxGrade(value), '—');
  assert.equal(value.diagnostics.invalidAttempts, 6);
});

test('native grade ranks order V9 before V10 and YDS letters without decimal-number errors', () => {
  assert.ok(gradeRank('v', 'VB') < gradeRank('v', 'V0'));
  assert.ok(gradeRank('v', 'V9') < gradeRank('v', 'V10'));
  assert.ok(gradeRank('yds', '5.9') < gradeRank('yds', '5.10a'));
  assert.ok(gradeRank('yds', '5.10d') < gradeRank('yds', '5.11a'));
  assert.equal(gradeRank('yds', '5.10'), null, 'Unspecified subgrade is not treated as an exact a or d');
  assert.equal(gradeRank('v', 'V5+'), null);
  assert.equal(gradeRank('gym', 'Purple'), null);
  assert.equal(gradeRank('other', '15'), null);
});

test('Fontainebleau and French ranks respect letters and plus signs within each scale', () => {
  for (const [system, labels] of [['font', ['5+', '6A', '6A+', '6B', '6B+', '6C', '6C+', '7A']], ['french', ['5c+', '6a', '6a+', '6b', '6b+', '6c', '6c+', '7a']]]) {
    const ranks = labels.map(label => gradeRank(system, label));
    assert.ok(ranks.every(rank => rank !== null));
    assert.ok(ranks.every((rank, index) => !index || rank > ranks[index - 1]));
  }
  assert.equal(gradeRank('font', '6b+'), gradeRank('font', '6B+'));
});

test('highest achieved grade uses completed exact grades only and scopes remain separate', () => {
  const rows = [workout({attempts: [attempt({gradeMin: 'V6', completed: true}), attempt({gradeMin: 'V10'}), attempt({gradeSystem: 'font', gradeMin: '7A', completed: true})]}),
    workout({category: 'kilter', attempts: [attempt({gradeMin: 'V8', completed: true, angle: 40})]})];
  const value = summarizeClimbing(rows);
  assert.equal(value.maxGrades.length, 3);
  assert.equal(value.maxGrades.find(row => row.category === 'indoor_boulder' && row.gradeSystem === 'v').label, 'V6');
  assert.equal(value.maxGrades.find(row => row.category === 'kilter').label, 'V8');
  assert.match(formatMaxGrade(value), /Indoor boulder \/ V scale: V6/);
  assert.match(formatMaxGrade(value), /Kilter board \/ V scale: V8/);
});

test('grade ranges remain uncertain and never imply their upper bound was achieved', () => {
  const value = summarizeClimbing([workout({attempts: [attempt({gradeMin: 'V5', gradeMax: 'V7', completed: true}), attempt({gradeMin: 'V4', completed: true})]})]);
  assert.equal(value.maxGrades[0].label, 'V4');
  assert.equal(value.maxGrades[0].rank, 4);
  assert.equal(value.maxGrades[0].ranges[0].label, 'V5–V7');
  assert.equal(value.maxGrades[0].ranges[0].lowerRank, 5);
  assert.equal(value.maxGrades[0].ranges[0].upperRank, 7);
  assert.equal(formatMaxGrade(value), 'V4 · V5–V7 (range)');
  assert.equal(parseClimbingGrade({gradeSystem: 'v', gradeMin: 'V5–V7'}).rank, null);
  assert.equal(parseClimbingGrade({gradeSystem: 'v', gradeMin: 'V5-V7'}).isRange, true);
  assert.equal(parseClimbingGrade({gradeSystem: 'v', gradeMin: 'V5', gradeMax: 'v5'}).rank, 5);
  assert.equal(parseClimbingGrade({gradeSystem: 'v', gradeMin: 'V7', gradeMax: 'V5'}).lowerRank, null);
});

test('range-only and gym-colour sends are shown without inventing grade maxima', () => {
  const ranged = summarizeClimbing([workout({attempts: [attempt({gradeMin: 'V5', gradeMax: 'V7', completed: true})]})]);
  assert.equal(ranged.maxGrades[0].label, null);
  assert.equal(formatMaxGrade(ranged), 'V5–V7 (range)');
  const gym = summarizeClimbing([workout({attempts: [attempt({gradeSystem: 'gym', gradeMin: 'Purple', completed: true}), attempt({gradeSystem: 'gym', gradeMin: 'Blue', completed: true})]})]);
  assert.equal(gym.maxGrades[0].rank, null);
  assert.equal(gym.maxGrades[0].unrankedSends, 2);
  assert.equal(formatMaxGrade(gym), 'Unranked sends');
  assert.deepEqual(gym.grades.map(row => [row.label, row.sends]), [['Blue', 1], ['Purple', 1]]);
});

test('grade buckets allocate ordinal increments without double-counting metadata changes', () => {
  const climbId = randomUUID();
  const value = summarizeClimbing([workout({attempts: [attempt({climbId, gradeMin: 'V4'}), attempt({climbId, gradeMin: 'V5', attemptNumber: 3, completed: true})]})]);
  assert.equal(value.totals.attempts, 3);
  assert.deepEqual(value.grades.map(row => [row.label, row.attempts, row.sends]), [['V4', 1, 0], ['V5', 2, 1]]);
  assert.equal(value.grades.reduce((sum, row) => sum + row.attempts, 0), value.totals.attempts);
  assert.equal(value.grades.reduce((sum, row) => sum + row.sends, 0), value.totals.sends);
});

test('grade scale filtering retains only the attributed attempts and successes', () => {
  const climbId = randomUUID();
  const rows = [workout({attempts: [attempt({climbId, gradeMin: 'V4'}), attempt({climbId, gradeSystem: 'font', gradeMin: '6C', attemptNumber: 3, completed: true})]})];
  assert.equal(summarizeClimbing(rows, {gradeSystem: 'v'}).totals.attempts, 1);
  assert.equal(summarizeClimbing(rows, {gradeSystem: 'font'}).totals.attempts, 2);
  assert.equal(summarizeClimbing(rows, {gradeSystem: 'font'}).totals.sends, 1);
});

test('daily and Monday–Sunday weekly series handle year boundary and DST without reassigning dates', () => {
  const rows = ['2025-12-28', '2025-12-29', '2026-01-04', '2026-01-05', '2026-11-01', '2026-11-02'].map(date => workout({date, attempts: [attempt({completed: true})]}));
  const value = summarizeClimbing(rows);
  assert.deepEqual(value.weekly.map(row => [row.date, row.end, row.attempts]), [
    ['2025-12-22', '2025-12-28', 1], ['2025-12-29', '2026-01-04', 2], ['2026-01-05', '2026-01-11', 1], ['2026-10-26', '2026-11-01', 1], ['2026-11-02', '2026-11-08', 1],
  ]);
  assert.deepEqual(value.daily.map(row => row.date), rows.map(row => row.date));
});

test('tag, environment, angle and venue breakdowns retain known effort only and never mutate input', () => {
  const rows = [workout({attempts: [attempt({tags: ['Crimps', 'crimps', 'Slab'], effort: 6, restSeconds: 0, completed: true}), attempt({tags: ['Slab'], effort: 8, restSeconds: 120})]}),
    workout({category: 'outdoor_boulder', venue: '', attempts: [attempt({effort: null})]})];
  const before = structuredClone(rows), value = summarizeClimbing(rows);
  assert.equal(value.totals.meanEffort, 7);
  assert.equal(value.totals.effortCount, 2);
  assert.equal(value.totals.restSeconds, 120);
  assert.equal(value.tags.find(row => row.key === 'slab').climbSessions, 2);
  assert.equal(value.tags.find(row => row.key === 'crimps').climbSessions, 1);
  assert.equal(value.environments.length, 2);
  assert.ok(value.venues.some(row => row.label === 'Unspecified venue'));
  assert.deepEqual(rows, before);
});

test('empty inputs have explicit unknown rates and no fabricated zero-grade successes', () => {
  for (const input of [undefined, null, [], [workout()]]) {
    const value = summarizeClimbing(input);
    assert.equal(value.totals.distinctClimbs, 0);
    assert.equal(value.totals.sendRate, null);
    assert.equal(value.totals.meanEffort, null);
    assert.deepEqual(value.daily, []);
    assert.deepEqual(value.maxGrades, []);
  }
});
