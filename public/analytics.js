/** Pure analysis of the standardized workout records. All loads are pounds. */
export const DEFAULT_BODYWEIGHT = null;
export const METRIC_KEYS = ['strength', 'load', 'reps', 'volume', 'hold', 'holdTotal', 'setting'];
const CATEGORY_ORDER = ['Pull', 'Push', 'Legs', 'Arms', 'Shoulders', 'Core', 'Grip', 'Other'];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const sum = values => values.reduce((total, value) => total + value, 0);
const text = row => [row.notes, row.resistance_setup, row.original_variation, row.set_type].filter(Boolean).join(' ');
const chronological = (a, b) => String(a.date).localeCompare(String(b.date)) || (Number(a.session) - Number(b.session)) || (Number(a.source_row) - Number(b.source_row));
const isWarmup = row => typeof row.is_warmup === 'boolean' ? row.is_warmup : /\bwarm[\s_-]?ups?\b/i.test(text(row).replace(/\b(?:not(?: a)?|no|without)\s+warm[\s_-]?ups?\b/gi, ''));

// A failed attempt differs from a completed set taken to failure. Notes can be
// shared by all rows in a manual entry, so a reference to one set must stay local.
const failureMarker = value => /\bfailed\b|\bunsuccessful\b|\baborted\b|\bincomplete (?:set|attempt)\b|\b(?:set|attempt) (?:was )?incomplete\b|\bfailure notation\b/i.test(value) || /^\s*failure[.!]?\s*$/i.test(value);
const unclearMarker = value => /completed[^.]*unclear|unclear[^.]*completed|failure notation/i.test(value);
const withoutNegatedFailure = value => value
  .replace(/\b(?:did not|didn't|does not|doesn't|not|never)\s+fail(?:ed|ure)?\b/gi, '')
  .replace(/\b(?:no|without|not an?)\s+(?:failed|unsuccessful|incomplete)\s+(?:sets?|reps?|attempts?)\b/gi, '')
  .replace(/\b(?:no|without)\s+failures?(?: notation)?\b/gi, '')
  .replace(/\bnot\s+unclear\b/gi, 'clear');
const recordGroup = row => row.entry_id ? `entry:${row.entry_id}` : `${row.exercise}__${row.date}__${row.session}`;
function recordPeers(records) {
  const groups = new Map();
  for (const row of records) {
    const key = recordGroup(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}
function scopedFailureText(row, peers = [row]) {
  const pieces = [row.notes, row.resistance_setup, row.original_variation, row.set_type].filter(Boolean).flatMap(value => String(value).split(/[.;\n]/));
  return pieces.map(withoutNegatedFailure).filter(piece => {
    if (!failureMarker(piece) && !unclearMarker(piece)) return true;
    let target = null;
    const numbered = piece.match(/\b(?:set|attempt)\s*(?:#\s*)?(\d+)\b/i);
    if (numbered) target = Number(numbered[1]);
    else if (/\b(?:first|last|final|other|previous|next)\s+(?:set|attempt)\b/i.test(piece)) return false;
    if (target !== null) return Number(row.set) === target;
    // Unnumbered first/last references are not rebound when records are deleted.
    // A shared, unscoped manual-entry comment does not identify which set failed.
    const shared = row.source_type === 'manual' && peers.filter(peer => text(peer).includes(piece.trim())).length > 1;
    return !shared || /\b(?:all|every)\s+(?:sets?|attempts?)\b/i.test(piece);
  }).join('. ');
}
function isFailed(row, notes) {
  if (typeof row.is_failed === 'boolean') return row.is_failed;
  if (/^(?:failed|failure|failed attempt|incomplete|aborted|unsuccessful)(?: set)?$/i.test(String(row.set_type || '').trim())) return true;
  if (finite(row.reps) && row.reps <= 0 && !(finite(row.duration_s) && row.duration_s > 0)) return true;
  return notes.split(/[.;\n]/).some(failureMarker);
}

function workingSetReason(row) {
  if (row.isWarmup) return 'Warm-up excluded';
  if (row.isFailed) return 'Failed or unsuccessful set excluded';
  if (unclearCompletedReps(row)) return 'Completed reps are unclear';
  if (/^(?:cool[ -]?down|form practice|technique practice|practice|skipped|planned)$/i.test(String(row.set_type || '').trim())) return 'Non-working set excluded';
  return null;
}

const completedUnits = row => finite(row.duration_s) && row.duration_s > 0 && finite(row.hold_count) && row.hold_count > 0 ? row.hold_count : 1;
const average = (rows, key, weight = row => row.averageUnits) => {
  const valid = rows.filter(row => finite(row[key]));
  const units = sum(valid.map(weight));
  return units > 0 ? sum(valid.map(row => row[key] * weight(row))) / units : null;
};
const ambiguousLoadRole = row => /\bUAP\b|machine dip/i.test(row.exercise || '') || /resistance or assistance|resistance\/assistance|load role unclear/i.test(row.resistance_setup || '');
const unclearCompletedReps = row => typeof row.completedRepsUnclear === 'boolean' ? row.completedRepsUnclear : unclearMarker(text(row));
const isKipping = row => /\bkip(?:s|ping)?\b/i.test(text(row));
const keyFor = row => `${row.date}__${row.session}`;

function normalizeOptions(options = {}) {
  const suppliedWeight = typeof options.bodyweight === 'number' || typeof options.bodyweight === 'string' && options.bodyweight.trim() !== '';
  const weightValid = suppliedWeight && finite(Number(options.bodyweight)) && Number(options.bodyweight) >= 1 && Number(options.bodyweight) <= 1000;
  return {
    exercise: options.exercise,
    from: options.from || '',
    to: options.to || '9999-12-31',
    metric: METRIC_KEYS.includes(options.metric) ? options.metric : 'strength',
    method: options.method === 'brzycki' ? 'brzycki' : 'epley',
    bodyweight: weightValid ? Number(options.bodyweight) : DEFAULT_BODYWEIGHT,
    invalidBodyweight: options.bodyweight != null && options.bodyweight !== '' && !weightValid,
    repCap: Number.isFinite(Number(options.repCap)) ? Math.max(1, Math.min(35, Math.floor(Number(options.repCap)))) : 10,
    includeWarmups: false, // Plots and fits always use completed working sets, including after preference migration.
    loadBasis: options.loadBasis === 'added' ? 'added' : 'total',
    minReps: Number.isFinite(Number(options.minReps)) ? Math.max(0, Number(options.minReps)) : 0,
    side: ['Left', 'Right'].includes(options.side) ? options.side : 'all',
  };
}

function strengthReason(row, options, allowMissingBodyweight = false) {
  if (!row.included) return row.workingExclusionReason || 'Non-working set excluded';
  if (ambiguousLoadRole(row)) return 'Resistance or assistance role is unknown';
  const missingBodyweight = row.is_pullup && !finite(options.bodyweight);
  if (missingBodyweight && !allowMissingBodyweight) return 'Set bodyweight in Chart settings for pull-up strength estimates';
  const pendingTotal = allowMissingBodyweight && missingBodyweight && finite(row.load_lb);
  if (!finite(row.effectiveLoad) && !pendingTotal) return 'No known weight in lb';
  if (!pendingTotal && row.effectiveLoad <= 0) return 'No positive load for an estimate';
  if (!finite(row.reps) || row.reps < 1) return 'No completed dynamic reps';
  if (!Number.isInteger(row.reps)) return 'Fractional reps retained, excluded from strength estimate';
  if (row.reps > options.repCap) return `Above the ${options.repCap}-rep estimate limit`;
  if (isKipping(row)) return 'Kipping set excluded from strict strength estimate';
  if (unclearCompletedReps(row)) return 'Completed reps are unclear';
  return null;
}

function estimateStrength(row, options) {
  if (strengthReason(row, options)) return null;
  const reps = row.reps;
  const predicted = reps === 1 ? row.effectiveLoad : options.method === 'brzycki'
    ? row.effectiveLoad * 36 / (37 - reps)
    : row.effectiveLoad * (1 + reps / 30);
  return predicted - (row.is_pullup && options.loadBasis === 'added' ? options.bodyweight : 0);
}

function metricReason(row, options, allowMissingBodyweight = false) {
  if (!row.included) return row.workingExclusionReason || 'Non-working set excluded';
  if (options.metric === 'strength') return strengthReason(row, options, allowMissingBodyweight);
  if (options.metric === 'setting') return finite(row.stack_setting) ? null : 'No numbered machine stack setting';
  if (options.metric === 'hold' || options.metric === 'holdTotal') return finite(row.duration_s) && row.duration_s > 0 ? null : 'No recorded hold duration';
  if (options.metric === 'reps') return finite(row.reps) && row.reps > 0 ? null : 'No dynamic reps recorded';
  const missingBodyweight = row.is_pullup && !finite(options.bodyweight);
  const needsTotal = options.metric === 'volume' || options.loadBasis !== 'added';
  if (missingBodyweight && needsTotal && !allowMissingBodyweight) return 'Set bodyweight in Chart settings for pull-up total load and volume';
  const pendingTotal = allowMissingBodyweight && missingBodyweight && finite(row.load_lb);
  const measuredLoad = options.metric === 'load' ? row.displayLoad : row.effectiveLoad;
  if (!finite(measuredLoad) && !pendingTotal) return 'No known weight in lb';
  if (options.metric === 'volume') {
    if (ambiguousLoadRole(row)) return 'Resistance or assistance role is unknown';
    if (!finite(row.reps) || row.reps <= 0) return 'No dynamic reps recorded';
    if (unclearCompletedReps(row)) return 'Completed reps are unclear';
    return null;
  }
  if (options.minReps > 0 && (!finite(row.reps) || row.reps < options.minReps)) return `Fewer than ${options.minReps} recorded reps`;
  if (unclearCompletedReps(row)) return 'Completed reps are unclear';
  return null;
}

function enrichRow(source, options, peers) {
  const scopedNotes = scopedFailureText(source, peers);
  const effectiveLoad = finite(source.load_lb) && (!source.is_pullup || finite(options.bodyweight))
    ? source.load_lb + (source.is_pullup ? options.bodyweight : 0) : null;
  const row = {
    ...source,
    effectiveLoad,
    displayLoad: source.is_pullup && options.loadBasis === 'added' ? source.load_lb : effectiveLoad,
    isWarmup: isWarmup(source),
    isFailed: isFailed(source, scopedNotes),
    completedRepsUnclear: unclearMarker(scopedNotes),
    workingExclusionReason: null,
    included: false,
    averageUnits: ['strength', 'reps'].includes(options.metric) ? 1 : completedUnits(source),
    strengthEstimate: null,
    metricValue: null,
    eligibilityReason: null,
    metricEligible: false,
  };
  row.workingExclusionReason = workingSetReason(row);
  row.included = !row.workingExclusionReason;
  row.strengthEstimate = estimateStrength(row, options);
  row.strengthEligibilityReason = strengthReason(row, options);
  row.eligibilityReason = metricReason(row, options);
  if (!row.eligibilityReason) {
    switch (options.metric) {
      case 'strength': row.metricValue = row.strengthEstimate; break;
      case 'load': row.metricValue = row.displayLoad; break;
      case 'reps': row.metricValue = row.reps; break;
      case 'volume': row.metricValue = row.effectiveLoad * row.reps; break;
      case 'hold': row.metricValue = row.duration_s; break;
      case 'holdTotal': row.metricValue = row.duration_s * (finite(row.hold_count) && row.hold_count > 0 ? row.hold_count : 1); break;
      case 'setting': row.metricValue = row.stack_setting; break;
    }
  }
  row.metricEligible = finite(row.metricValue);
  return row;
}

function describeMetric(options, rows, available) {
  const pullup = rows.some(row => row.is_pullup);
  const setting = rows.length > 0 && rows.every(ambiguousLoadRole);
  const perDumbbell = rows.length > 0 && rows.every(row => row.load_basis === 'Per dumbbell');
  const loadQualifier = pullup ? (options.loadBasis === 'added' ? 'added' : 'total') : perDumbbell ? 'per dumbbell' : '';
  const definitions = {
    strength: {
      label: `Average estimated 1RM${loadQualifier ? ` (${loadQualifier})` : ''}`,
      unit: 'lb',
      description: `Mean of the ${options.method === 'brzycki' ? 'Brzycki' : 'Epley'} estimates for eligible working sets of 1–${options.repCap} reps in each workout. Each set is estimated before averaging. Warm-ups and failed sets are excluded. ${pullup ? finite(options.bodyweight) ? `Calculated from ${options.bodyweight.toFixed(2)} lb bodyweight plus added load${options.loadBasis === 'added' ? ', then bodyweight is subtracted from the estimate' : ''}.` : 'Set bodyweight in Chart settings to calculate pull-up strength estimates; no bodyweight is assumed.' : perDumbbell ? 'Dumbbell estimates are per dumbbell.' : ''}`.trim(),
    },
    load: {
      label: setting ? 'Average machine setting' : `Average load${loadQualifier ? ` (${loadQualifier})` : ''}`,
      unit: 'lb',
      description: setting ? 'Average working-set pound setting per workout; whether it supplies resistance or assistance is unknown.' : `Mean load across completed working sets in each workout${options.minReps > 0 ? ` with at least ${options.minReps} reps` : ''}. Timed components are averaged per completed hold.${pullup ? ` ${options.loadBasis === 'added' ? 'Recorded added weight only; bodyweight is not needed for this metric.' : finite(options.bodyweight) ? 'Includes the selected constant bodyweight.' : 'Set bodyweight in Chart settings to show total load; no bodyweight is assumed.'}` : perDumbbell ? ' Per dumbbell.' : ''}`,
    },
    reps: { label: 'Average reps', unit: 'reps', description: 'Mean base reps per completed working set in each workout. Loads may differ; warm-ups and failed sets are excluded, and additional reps stay in the details.' },
    volume: { label: 'Logged volume', unit: 'lb·reps', description: `Sum of known load × base reps across completed working sets per workout.${pullup ? finite(options.bodyweight) ? ' Includes bodyweight plus added load.' : ' Set bodyweight in Chart settings to calculate pull-up volume; no bodyweight is assumed.' : perDumbbell ? ' Per dumbbell.' : ''} Unknown loads, unclear completed counts and additional reps are excluded.` },
    hold: { label: 'Average hold', unit: 's', description: 'Mean seconds per completed working hold in each workout. Repeater components are weighted by their completed-hang counts; warm-ups, failed attempts and rest are excluded.' },
    holdTotal: { label: 'Total hold time', unit: 's', description: `Sum of hold duration × completed-hang count across working holds per workout. Warm-ups, failed attempts and rest are excluded.${options.side === 'all' ? ' Includes both sides where recorded.' : ` ${options.side} side only.`}` },
    setting: { label: 'Average stack setting', unit: 'setting', description: 'Mean numbered stack setting across completed working sets per workout. These numbers are not pounds or strength estimates; compare only the same machine and setup.' },
  };
  return { key: options.metric, ...definitions[options.metric], available };
}

/** Returns all exercise choices without discarding unscored records. */
export function buildCatalog(records = []) {
  const groups = new Map();
  for (const record of records) {
    if (!groups.has(record.exercise)) groups.set(record.exercise, []);
    groups.get(record.exercise).push(record);
  }
  return [...groups.entries()].map(([name, rows]) => {
    const options = normalizeOptions();
    const peers = recordPeers(rows);
    const enriched = rows.map(row => enrichRow(row, options, peers.get(recordGroup(row))));
    // Catalog choices describe what the recorded exercise can support. Missing
    // bodyweight disables calculations, without hiding the controls needed later.
    const metrics = METRIC_KEYS.filter(metric => enriched.some(row => !metricReason(row, { ...options, metric }, true)));
    const hasRepeater = rows.some(row => finite(row.hold_count));
    const defaultMetric = metrics.includes('strength') ? 'strength'
      : hasRepeater && metrics.includes('holdTotal') ? 'holdTotal'
      : metrics.includes('hold') ? 'hold'
      : metrics.includes('reps') ? 'reps'
      : metrics[0] || 'reps';
    return {
      name, category: rows[0].category, entries: rows.length,
      sessions: new Set(rows.map(keyFor)).size,
      defaultMetric, metrics,
      firstDate: rows.map(row => row.date).sort()[0],
      latestDate: rows.map(row => row.date).sort().at(-1),
      hasSides: rows.some(row => row.side === 'Left' || row.side === 'Right'),
      isPullup: rows.some(row => row.is_pullup),
    };
  }).sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.name.localeCompare(b.name));
}

/** Analyze one exercise while retaining every filtered source row for inspection. */
export function analyze(records = [], inputOptions = {}) {
  const options = normalizeOptions(inputOptions);
  const sourceRows = records.filter(row =>
    (!options.exercise || row.exercise === options.exercise) &&
    row.date >= options.from && row.date <= options.to &&
    (options.side === 'all' || row.side === options.side)
  ).sort(chronological);
  const peers = recordPeers(records);
  const rows = sourceRows.map(row => enrichRow(row, options, peers.get(recordGroup(row))));
  const groups = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const aggregate = options.metric === 'volume' || options.metric === 'holdTotal';
  const sessions = [...groups.entries()].map(([key, sets]) => {
    const eligible = sets.filter(row => row.metricEligible);
    const bestSet = eligible.length ? eligible.reduce((best, row) => row.metricValue >= best.metricValue ? row : best) : null;
    const value = eligible.length ? aggregate ? sum(eligible.map(row => row.metricValue)) : average(eligible, 'metricValue') : null;
    return {
      key, date: sets[0].date, session: sets[0].session, value,
      recordId: null,
      reps: aggregate ? null : average(eligible, 'reps'),
      load: aggregate ? null : average(eligible, 'displayLoad'),
      bestSet, sets, workingSets: sets.filter(row => row.included), eligibleSets: eligible,
      averagingUnits: sum(eligible.map(row => row.averageUnits)),
      aggregation: aggregate ? 'total' : 'average',
      workingExcludedCount: sets.filter(row => !row.included).length,
      failedCount: sets.filter(row => row.isFailed).length,
      eligibleCount: eligible.length,
      excludedCount: sets.length - eligible.length,
      includedCount: sets.filter(row => row.included).length,
      partial: sets.some(row => row.included && !row.metricEligible),
    };
  }).sort(chronological);
  const series = sessions.filter(session => finite(session.value));
  const first = series[0] || null;
  const latest = series.at(-1) || null;
  const best = series.length ? series.reduce((maximum, point) => point.value >= maximum.value ? point : maximum) : null;
  const changePct = series.length > 1 && first && latest && first.value > 0 ? (latest.value / first.value - 1) * 100 : null;
  const includedRows = rows.filter(row => row.included);
  const notes = [];
  const unknownLoads = includedRows.filter(row => !finite(options.metric === 'load' ? row.displayLoad : row.effectiveLoad) && !(row.is_pullup && !finite(options.bodyweight) && finite(row.load_lb))).length;
  if (options.invalidBodyweight) notes.push('Enter a bodyweight between 1 and 1,000 lb in Chart settings. No default bodyweight was used.');
  if (!finite(options.bodyweight) && rows.some(row => row.is_pullup)) notes.push('Bodyweight is not set. Enter it in Chart settings for pull-up total load, strength and volume. Reps and recorded added load remain available.');
  if (options.metric === 'strength') notes.push('Estimated strength is a comparison tool, not a measured maximum. Effort, technique and equipment were not standardized.');
  if (unknownLoads && ['strength', 'load', 'volume'].includes(options.metric)) notes.push(`${unknownLoads} recorded ${unknownLoads === 1 ? 'entry has' : 'entries have'} no known pound load; no conversion was invented.`);
  if (rows.some(ambiguousLoadRole)) notes.push('The machine setting may supply resistance or assistance. These entries are not used for strength or volume estimates.');
  if (options.metric === 'strength' && rows.some(row => finite(row.reps) && !Number.isInteger(row.reps))) notes.push('Half-reps remain in the source details and are excluded from the strength estimate.');
  if (rows.some(row => finite(row.additional_reps) && row.additional_reps > 0)) notes.push('Additional reps remain separately labelled in the details and are excluded from plotted metrics.');
  if (sessions.some(session => session.partial)) notes.push(`Some workout ${aggregate ? 'totals' : 'averages'} include only working sets with usable values for this metric; inspect the details for exclusions.`);
  if (rows.some(row => !row.included)) notes.push('Only completed working sets contribute to graphs and fits. Warm-ups, failed or unclear attempts, and explicitly labelled practice/cool-down sets remain in the log.');
  if (rows.some(row => /assumed|interpreted|inferred/i.test(row.notes || ''))) notes.push('Existing unit and exercise assumptions are retained in each set’s notes.');
  if (!series.length) notes.unshift(rows.length ? 'No records meet the current metric and filters. Try another metric or adjust the filters.' : 'No entries match this exercise, date range and side.');
  const scatter = includedRows.filter(row => finite(row.reps) && row.reps > 0 && finite(row.displayLoad) && !ambiguousLoadRole(row)).map(row => ({
    recordId: row.record_id, date: row.date, session: row.session,
    reps: row.reps, load: row.displayLoad, strengthEstimate: row.strengthEstimate,
    eligibilityReason: row.eligibilityReason, set: row.set, isWarmup: row.isWarmup,
  }));
  return {
    rows, series, sessions, scatter,
    stats: {
      entryCount: rows.length,
      includedEntryCount: includedRows.length,
      sessionCount: sessions.length,
      plottedSessions: series.length,
      first, latest, best, changePct,
      totalReps: sum(includedRows.filter(row => finite(row.reps)).map(row => row.reps)),
      knownLoadCount: includedRows.filter(row => finite(row.effectiveLoad)).length,
      excludedCount: rows.filter(row => !row.metricEligible).length,
      warmupCount: rows.filter(row => row.isWarmup).length,
      failedCount: rows.filter(row => row.isFailed).length,
      nonWorkingCount: rows.filter(row => !row.included).length,
    },
    metric: describeMetric(options, rows, series.length > 0),
    notes,
    options,
  };
}
