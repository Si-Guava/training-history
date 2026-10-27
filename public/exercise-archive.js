/** Exercise visibility is based on the full saved history, never chart filters. */
const TRAINING_TIME_ZONE = 'America/Toronto';
const leapYear = year => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
const daysInMonth = (year, month) => [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
const pad = value => String(value).padStart(2, '0');

function dateParts(value) {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return {year, month, day};
}

/** One consistent training day across devices, including around UTC midnight. */
export function getTrainingToday(date = new Date(), timeZone = TRAINING_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year:'numeric', month:'2-digit', day:'2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year.padStart(4, '0')}-${values.month}-${values.day}`;
}

/** Calendar-year anniversary, clamping February 29 to February 28 if needed. */
export function oneYearBefore(today = getTrainingToday()) {
  const parts = dateParts(today);
  if (!parts || parts.year < 2) throw new RangeError('Choose a complete, valid training date.');
  const year = parts.year - 1;
  const day = Math.min(parts.day, daysInMonth(year, parts.month));
  return `${String(year).padStart(4, '0')}-${pad(parts.month)}-${pad(day)}`;
}

/**
 * Pass buildCatalog(allUndeletedRecords), not a date-filtered chart catalog.
 * Exactly one year ago is still active: only strictly older dates are archived.
 * Returned items preserve their original identity and category ordering.
 */
export function splitCatalog(catalog = [], today = getTrainingToday()) {
  const cutoff = oneYearBefore(today);
  const active = [], archived = [];
  for (const exercise of catalog) {
    const recent = dateParts(exercise.latestDate) && exercise.latestDate >= cutoff;
    (recent ? active : archived).push(exercise);
  }
  return {active, archived, cutoff};
}

/** Select a visible exercise when a previously selected exercise is hidden. */
export function chooseLibraryExercise(currentName, partition, showArchived = false) {
  const visible = showArchived ? [...partition.active, ...partition.archived] : partition.active;
  if (visible.some(exercise => exercise.name === currentName)) return currentName;
  const recent = [...visible].sort((a, b) =>
    String(b.latestDate || '').localeCompare(String(a.latestDate || '')) || a.name.localeCompare(b.name)
  )[0];
  return recent?.name || null;
}
