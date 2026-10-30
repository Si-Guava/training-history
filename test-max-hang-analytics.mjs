import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { MAX_HANG_SCORE_UNIT, MAX_HANG_EXCLUSION_LABELS, maxHangCondition, scoreMaxHangSet, summarizeMaxHangs } from './public/hangboard-analytics-model.js';

const hold = (patch = {}) => ({id: randomUUID(), grip: 'Half crimp', edgeMm: 20, hand: 'both', loadMode: 'added', loadLb: 25, setup: 'No pulley', isWarmup: false, status: 'completed', segments: [{id: randomUUID(), count: 1, seconds: 10}], ...patch});
const workout = (patch = {}) => ({id: randomUUID(), revision: 1, date: '2026-10-30', protocol: 'max_hangs', title: 'Test max hangs', location: 'Test board', bodyweightLb: 150, sets: [hold()], ...patch});

test('score combines recorded bodyweight, added load and actual time without a strength conversion', () => {
  const w = workout(), value = scoreMaxHangSet(w, w.sets[0]);
  assert.equal(value.score, 1750); assert.equal(value.loadLb, 175); assert.equal(value.seconds, 10);
  assert.equal(value.bodyweightLb, 150); assert.equal(value.addedWeightLb, 25); assert.equal(value.eligible, true);
  assert.equal(MAX_HANG_SCORE_UNIT, 'lb·s');
});

test('bodyweight hangs and assistance use their recorded meanings', () => {
  const w = workout({bodyweightLb: 165});
  const bodyweight = scoreMaxHangSet(w, hold({loadMode: 'bodyweight', loadLb: null, segments: [{count: 1, seconds: 7.5}]}));
  assert.equal(bodyweight.score, 1237.5);
  const assisted = scoreMaxHangSet(w, hold({loadMode: 'assisted', loadLb: 25}));
  assert.equal(assisted.loadLb, 140); assert.equal(assisted.assistanceLb, 25); assert.equal(assisted.score, 1400);
});

test('historical bodyweight is required for bodyweight, added and assisted loads', () => {
  for (const bodyweightLb of [undefined, null, 0, -1, '150', NaN, Infinity, 1001]) {
    for (const loadMode of ['bodyweight', 'added', 'assisted']) {
      const value = scoreMaxHangSet(workout({bodyweightLb}), hold({loadMode, loadLb: loadMode === 'bodyweight' ? null : 25}));
      assert.equal(value.score, null); assert.equal(value.reason, 'missing_bodyweight');
    }
  }
  assert.match(MAX_HANG_EXCLUSION_LABELS.missing_bodyweight, /bodyweight/);
});

test('no-hang recorded loads do not borrow bodyweight or enter the hang score', () => {
  const noHang = workout({bodyweightLb: null, sets: [hold({loadMode: 'absolute', loadLb: 40})]});
  const value = scoreMaxHangSet(noHang, noHang.sets[0]);
  assert.equal(value.score, 400); assert.equal(value.measurement, 'no_hang'); assert.equal(value.loadLb, 40);
  assert.equal(summarizeMaxHangs([noHang]).score, null);
  assert.equal(summarizeMaxHangs([noHang], {measurement: 'no_hang'}).score, 400);
  assert.throws(() => summarizeMaxHangs([noHang], {measurement: 'all'}), RangeError);
});

test('every saved max-hang set counts without a marked-completed requirement', () => {
  for (const status of ['completed', 'unknown', 'partial', 'failed', undefined, null, true]) {
    const value = scoreMaxHangSet(workout(), hold({status}));
    assert.equal(value.score, 1750); assert.equal(value.reason, null); assert.equal(value.eligible, true);
  }
  assert.equal(Object.hasOwn(MAX_HANG_EXCLUSION_LABELS, 'not_completed'), false);
  const sets = ['unknown', 'partial', 'failed', undefined].map(status => hold({status}));
  assert.equal(summarizeMaxHangs([workout({sets})]).score, 7000);
});

test('warm-ups and unrecorded warm-up state cannot produce a score', () => {
  assert.equal(scoreMaxHangSet(workout(), hold({isWarmup: true})).reason, 'warmup');
  for (const isWarmup of [undefined, null, 0, 'false']) assert.equal(scoreMaxHangSet(workout(), hold({isWarmup})).reason, 'unknown_warmup');
});

test('only one measured positive-duration hold is eligible; repeater components cannot aggregate into a score', () => {
  for (const segments of [[], [{count: 2, seconds: 10}], [{count: 1, seconds: 10}, {count: 1, seconds: 10}], [{count: 1, seconds: 0}], [{count: 1, seconds: -1}], [{count: 1, seconds: '10'}], [{count: 1, seconds: Infinity}], [{count: 1, seconds: 86401}]]) {
    const value = scoreMaxHangSet(workout(), hold({segments}));
    assert.equal(value.score, null); assert.equal(value.reason, 'invalid_duration');
  }
  assert.equal(scoreMaxHangSet(workout({protocol: 'repeaters'}), hold()).reason, 'protocol');
  assert.equal(summarizeMaxHangs([workout({protocol: 'repeaters'})]).recordedHolds, 0);
});

test('targets and recovery never replace or multiply measured hold time', () => {
  const value = scoreMaxHangSet(workout(), hold({targetHangSeconds: 60, restAfterSetSeconds: 900, restBetweenHangsSeconds: 600, targetHangs: 20}));
  assert.equal(value.score, 1750); assert.equal(value.seconds, 10);
});

test('unsupported, nonnumeric, negative and zero supported loads stay unscored', () => {
  for (const loadLb of [undefined, null, -1, '25', NaN, Infinity, 10001]) assert.equal(scoreMaxHangSet(workout(), hold({loadLb})).reason, 'invalid_load');
  assert.equal(scoreMaxHangSet(workout(), hold({loadMode: 'bodyweight', loadLb: 1})).reason, 'invalid_load');
  assert.equal(scoreMaxHangSet(workout(), hold({loadMode: 'unknown', loadLb: null})).reason, 'unknown_load');
  for (const assistance of [150, 151]) assert.equal(scoreMaxHangSet(workout(), hold({loadMode: 'assisted', loadLb: assistance})).reason, 'invalid_load');
  assert.equal(scoreMaxHangSet(workout(), hold({loadMode: 'absolute', loadLb: 0})).reason, 'invalid_load');
  assert.equal(scoreMaxHangSet(workout(), hold({loadLb: 0})).score, 1500);
});

test('a session score sums the actual load-time contribution of every working set', () => {
  const w = workout({sets: [hold({loadLb: 25}), hold({loadLb: 30}), hold({loadLb: 15})]});
  const value = summarizeMaxHangs([w]);
  assert.equal(value.score, 5200); assert.equal(value.best.loadLb, null); assert.equal(value.scoredHolds, 3);
  assert.equal(value.best.minLoadLb, 165); assert.equal(value.best.maxLoadLb, 180); assert.equal(value.best.totalSeconds, 30);
  assert.equal(value.byWorkout.length, 1); assert.equal(value.byWorkout[0].score, 5200); assert.equal(value.byWorkout[0].scoredHolds, 3);
  assert.equal(value.totalScore, 5200); assert.equal(value.totalSeconds, 30);
});

test('equal sets are weight multiplied by set count and hold time', () => {
  const value = summarizeMaxHangs([workout({sets: Array.from({length: 5}, () => hold({status: 'unknown'}))})]);
  assert.equal(value.score, 175 * 5 * 10);
  assert.equal(value.best.loadLb, 175); assert.equal(value.best.totalSeconds, 50); assert.equal(value.best.scoredHolds, 5);
});

test('varied durations and assisted loads are weighted per set, with recovery excluded', () => {
  const value = summarizeMaxHangs([workout({sets: [
    hold({loadLb: 25, segments: [{count: 1, seconds: 7}], restAfterSetSeconds: 180}),
    hold({loadLb: 30, segments: [{count: 1, seconds: 10}], restAfterSetSeconds: 300}),
    hold({loadMode: 'assisted', loadLb: 20, segments: [{count: 1, seconds: 6.5}]}),
  ]})]);
  assert.equal(value.score, 175 * 7 + 180 * 10 + 130 * 6.5);
  assert.equal(value.best.totalSeconds, 23.5); assert.equal(value.best.minLoadLb, 130); assert.equal(value.best.maxLoadLb, 180);
});

test('different sessions on the same day stay separate and the headline selects the best session', () => {
  const a = workout({id: 'session-a', sets: [hold({loadLb: 100})]});
  const b = workout({id: 'session-b', sets: [hold(), hold(), hold()]});
  const value = summarizeMaxHangs([a, b]);
  assert.equal(value.byWorkout.length, 2); assert.deepEqual(value.byWorkout.map(row => row.score), [2500, 5250]);
  assert.equal(value.score, 5250); assert.equal(value.best.workoutId, b.id); assert.equal(value.best.scoredHolds, 3);
  assert.equal(value.totalScore, 7750); assert.equal(value.totalSeconds, 40);
});

test('session totals exclude warm-ups, invalid time and load, and separate no-hang sets', () => {
  const w = workout({sets: [
    hold({status: 'unknown'}), hold({status: 'failed'}),
    hold({isWarmup: true}), hold({loadMode: 'unknown', loadLb: null}),
    hold({segments: [{count: 1, seconds: 0}]}),
    hold({loadMode: 'absolute', loadLb: 40}), hold({loadMode: 'absolute', loadLb: 50}),
  ]});
  const value = summarizeMaxHangs([w]);
  assert.equal(value.score, 3500); assert.equal(value.best.scoredHolds, 2); assert.equal(value.best.totalSeconds, 20);
  assert.deepEqual(value.excluded, {warmup: 1, unknown_load: 1, invalid_duration: 1});
  const noHang = summarizeMaxHangs([w], {measurement: 'no_hang'});
  assert.equal(noHang.score, 900); assert.equal(noHang.best.scoredHolds, 2); assert.equal(noHang.best.totalSeconds, 20);
  assert.equal(noHang.best.minLoadLb, 40); assert.equal(noHang.best.maxLoadLb, 50);
});

test('inclusive dates handle Monday to Sunday and the daylight-saving boundary', () => {
  const dates = ['2026-10-25', '2026-10-26', '2026-10-30', '2026-11-01', '2026-11-02'];
  const value = summarizeMaxHangs(dates.map((date, index) => workout({date, sets: [hold({loadLb: index})]})), {start: '2026-10-26', end: '2026-11-01'});
  assert.equal(value.scoredHolds, 3); assert.deepEqual(value.byWorkout.map(row => row.date), ['2026-10-26', '2026-10-30', '2026-11-01']);
  assert.equal(value.best.date, '2026-11-01');
  assert.throws(() => summarizeMaxHangs([], {start: '2026-02-30'}), RangeError);
  assert.throws(() => summarizeMaxHangs([], {start: '2026-11-01', end: '2026-10-26'}), RangeError);
});

test('setups preserve hand, edge, grip, location, setup and no-hang distinctions', () => {
  const w = workout(), s = hold(), base = maxHangCondition(w, s);
  for (const changed of [{hand: 'left'}, {hand: 'right'}, {edgeMm: 18}, {grip: 'Open hand'}, {setup: 'Pulley'}, {loadMode: 'absolute'}]) assert.notEqual(maxHangCondition(w, {...s, ...changed}).conditionKey, base.conditionKey);
  assert.notEqual(maxHangCondition({...w, location: 'Different board'}, s).conditionKey, base.conditionKey);
  assert.equal(maxHangCondition({...w, location: '  TEST   board '}, {...s, grip: ' half   CRIMP '}).conditionKey, base.conditionKey);
  assert.equal(base.conditionComplete, true);
});

test('missing setup metadata never establishes a complete comparison condition', () => {
  const w = workout(), s = hold();
  for (const changed of [{hand: 'unspecified'}, {edgeMm: null}, {grip: ''}]) assert.equal(maxHangCondition(w, {...s, ...changed}).conditionComplete, false);
  assert.equal(maxHangCondition({...w, location: ''}, s).conditionComplete, false);
  const value = summarizeMaxHangs([workout({sets: [hold({grip: ''})]})]);
  assert.equal(value.conditionsIncomplete, true); assert.equal(value.score, 1750);
});

test('filtering a setup produces only its score while keeping other setup choices available', () => {
  const w = workout({sets: [hold(), hold({edgeMm: 15, loadLb: 10})]});
  const all = summarizeMaxHangs([w]);
  assert.equal(all.mixedConditions, true); assert.equal(all.byWorkout.length, 1); assert.equal(all.score, 3350);
  assert.equal(all.best.conditionKey, null); assert.equal(all.best.conditionComplete, false); assert.equal(all.best.mixedConditions, true);
  assert.equal(all.best.conditionKeys.length, 2); assert.equal(all.best.scoredHolds, 2);
  const conditionKey = maxHangCondition(w, w.sets[1]).conditionKey;
  const filtered = summarizeMaxHangs([w], {conditionKey});
  assert.equal(filtered.score, 1600); assert.equal(filtered.scoredHolds, 1); assert.equal(filtered.conditions.length, 2); assert.equal(filtered.mixedConditions, false);
  assert.equal(filtered.best.conditionKey, conditionKey); assert.equal(filtered.best.conditionComplete, true); assert.equal(filtered.best.totalSeconds, 10);
});

test('newest revision wins before filtering and deleted snapshots cannot revive old scores', () => {
  const old = workout(), updated = {...old, revision: 2, sets: [hold({loadLb: 35})]};
  for (const sequence of [[old, updated], [updated, old]]) { const value = summarizeMaxHangs(sequence); assert.equal(value.score, 1850); assert.equal(value.scoredHolds, 1); }
  const removed = {...updated, revision: 3, deleted_at: '2026-10-31T00:00:00Z'};
  assert.equal(summarizeMaxHangs([removed, old, updated]).score, null);
  assert.equal(summarizeMaxHangs([old, {...updated, date: '2026-11-02'}], {start: '2026-10-26', end: '2026-11-01'}).score, null);
  for (const snapshots of [[updated, {...updated, deleted_at: '2026-10-31T00:00:00Z'}], [{...updated, deleted_at: '2026-10-31T00:00:00Z'}, updated]]) {
    assert.equal(summarizeMaxHangs(snapshots).score, null);
  }
});

test('duplicate set snapshots do not inflate scored-hold counts', () => {
  const s = hold(), w = workout({sets: [s, {...s, id: s.id.toUpperCase()}]});
  const value = summarizeMaxHangs([w, w]);
  assert.equal(value.scoredHolds, 1); assert.equal(value.score, 1750); assert.equal(value.best.totalSeconds, 10);
});

test('session-score ties are deterministic and retain actual loads and times', () => {
  const a = workout({id: 'session-a', sets: [hold({loadLb: 50, segments: [{count: 1, seconds: 10}]})]});
  const b = workout({id: 'session-b', sets: [hold({loadLb: 10, segments: [{count: 1, seconds: 12.5}]})]});
  for (const sessions of [[a, b], [b, a]]) {
    const best = summarizeMaxHangs(sessions).best;
    assert.equal(best.score, 2000); assert.equal(best.workoutId, a.id); assert.equal(best.loadLb, 200); assert.equal(best.totalSeconds, 10);
  }
});

test('unscored records are explained and absence is null rather than zero', () => {
  const value = summarizeMaxHangs([workout({bodyweightLb: null, sets: [hold(), hold({status: 'unknown'}), hold({isWarmup: true})]})]);
  assert.equal(value.score, null); assert.equal(value.best, null); assert.equal(value.scoredHolds, 0); assert.equal(value.recordedHolds, 3);
  assert.deepEqual(value.excluded, {missing_bodyweight: 2, warmup: 1});
  assert.equal(summarizeMaxHangs([]).score, null);
  assert.equal(summarizeMaxHangs([]).totalScore, null);
});

test('analytics tolerate malformed input and leave source snapshots unchanged', () => {
  assert.equal(scoreMaxHangSet(null, null).score, null); assert.equal(summarizeMaxHangs(null).score, null);
  assert.equal(summarizeMaxHangs([null, {}, workout({date: 'bad'}), workout({sets: null})]).score, null);
  const source = [workout({sets: [hold(), hold({status: 'partial'})]})], original = structuredClone(source);
  summarizeMaxHangs(source); assert.deepEqual(source, original);
});
