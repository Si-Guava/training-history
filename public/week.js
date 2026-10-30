import { TRAINING_TYPES, MUSCLE_GROUPS, localDate, weekStart, shiftDate, buildWeekSummary } from './week-model.js';
import { formatMaxGrade } from './climbing-analytics-model.js';
import { summarizeMaxHangs } from './hangboard-analytics-model.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const number = value => new Intl.NumberFormat('en-CA', {maximumFractionDigits:1}).format(Number(value) || 0);
const typeInfo = id => TRAINING_TYPES.find(type => type.id === id);
const asDate = date => new Date(date + 'T12:00:00Z');
const formatDate = (date, options = {}) => new Intl.DateTimeFormat('en-CA', {month:'short', day:'numeric', timeZone:'UTC', ...options}).format(asDate(date));
const rangeLabel = (start, year = false) => formatDate(start, year ? {year:'numeric'} : {}) + ' – ' + formatDate(shiftDate(start, 6), year ? {year:'numeric'} : {});
const statuses = {planned:'Planned', hit:'Completed target', partial:'Partly completed', missed:'Missed target', skipped:'Skipped'};
const statusSymbols = {planned:'○', hit:'✓', partial:'◐', missed:'×', skipped:'–'};
const countLabel = (count, singular, plural = singular + 's') => number(count) + ' ' + (count === 1 ? singular : plural);
const hangSessionDetail = session => {
  const sets = countLabel(session.scoredHolds, 'set'), seconds = number(session.totalSeconds) + ' s total';
  const sameDuration = session.holds?.length && session.holds.every(hold => hold.seconds === session.holds[0].seconds);
  if (Number.isFinite(session.loadLb)) return number(session.loadLb) + ' lb × ' + (sameDuration ? sets + ' × ' + number(session.holds[0].seconds) + ' s' : seconds + ' across ' + sets);
  return sets + ' · ' + seconds + ' · ' + number(session.minLoadLb) + '–' + number(session.maxLoadLb) + ' lb, summed per set';
};
const storageKey = 'training-my-week-preferences';

/** Read-only weekly view: plans and workout editors retain ownership of every write. */
export function createWeekDashboard({host, getRecords = () => [], getCatalog = () => [], isHistoryReady = () => true, onRefreshHistory = () => {}, onPlanDate = () => {}, onReviewPlan = () => {}, onLogDate = () => {}, announce = () => {}}) {
  let preferences = {};
  try { preferences = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch {}
  const knownTypes = new Set(TRAINING_TYPES.map(type => type.id));
  let types = Array.isArray(preferences.types) ? preferences.types.filter(type => knownTypes.has(type)) : [...knownTypes];
  let start = weekStart(localDate()), selectedDay = localDate(), compareStart = shiftDate(start, -7), compareFollows = true;
  let source = preferences.source === 'planned' ? 'planned' : 'logged';
  let measure = ['strength','climbing','hangboard','exercises'].includes(preferences.measure) ? preferences.measure : 'strength';
  let maxHangCondition = typeof preferences.maxHangCondition === 'string' ? preferences.maxHangCondition : '';
  let selectedMuscle = '', logType = types.find(type => type !== 'other') || 'strength', plans = [], climbingWorkouts = [], hangboardWorkouts = [];
  let loading = false, loadPromise = null, loadedOnce = false, loadErrors = [], destroyed = false;
  const sourceLoaded = {plans:false, climbing:false, hangboard:false};
  const eventController = new AbortController(), requests = new Set();
  const q = selector => host.querySelector(selector);
  const persist = () => { try { localStorage.setItem(storageKey, JSON.stringify({types, source, measure, maxHangCondition})); } catch {} };
  host.classList.add('week-dashboard');
  host.innerHTML = `
    <header class="week-heading"><div><span class="eyebrow">PLAN YOUR WORK. SEE THE BALANCE.</span><h2>My week</h2><p>A Monday-to-Sunday view of what you planned, completed and logged.</p></div><button type="button" class="button button-primary" data-week-plan-current>+ Plan workout</button></header>
    <section class="week-navigation" aria-label="Choose a training week"><div class="week-range"><span class="week-context" data-week-context></span><h3 data-week-range></h3><p data-week-progress-note></p></div><div class="week-navigation-controls"><div class="week-stepper"><button type="button" class="week-icon-button" data-week-prev aria-label="Previous week">‹</button><button type="button" data-week-today>This week</button><button type="button" class="week-icon-button" data-week-next aria-label="Next week">›</button></div><label>Jump to week<input type="date" data-week-jump aria-label="Choose a date in the week to view"></label></div></section>
    <section class="week-filters" aria-label="Include training types"><div class="week-filter-heading"><strong>Include in this view</strong><div><button type="button" class="text-button" data-week-all>All</button><button type="button" class="text-button" data-week-none>None</button></div></div><div class="week-filter-chips">${TRAINING_TYPES.map(type => `<label class="week-filter-chip"><input type="checkbox" data-week-type="${esc(type.id)}" value="${esc(type.id)}"><span>${esc(type.label)}</span></label>`).join('')}</div><p class="week-filter-note" data-week-filter-note>These choices apply to every total, comparison and muscle view below.</p></section>
    <div class="week-load-status" role="status"><span data-week-load-status>Load your saved training to begin.</span><button type="button" class="text-button" data-week-reload>Refresh</button></div>
    <section class="week-stats" aria-label="Weekly training totals" data-week-stats></section>
    <p class="week-count-basis">One planned exercise = one calendar target. Completed targets are those you marked <strong>Hit target</strong>. Logged activities count strength exercise sessions and climbing or hangboard workouts separately from target reviews.</p>
    <section class="week-panel week-performance" aria-labelledby="week-performance-title"><div class="week-section-heading"><div><span class="eyebrow">PERFORMANCE IN CONTEXT</span><h3 id="week-performance-title">Climbing &amp; max hangs</h3><p>Climbs attempted, completed grades, and your best max-hang session score.</p></div><label class="week-hang-filter">Max-hang setup<select data-week-hang-condition aria-label="Max-hang setup for weekly comparisons"><option value="">All recorded setups</option></select></label></div><div class="week-performance-grid" data-week-performance></div><p class="week-help" data-week-performance-note></p></section>
    <section class="week-panel week-schedule" aria-labelledby="week-schedule-title"><div class="week-section-heading"><div><span class="eyebrow">MONDAY THROUGH SUNDAY</span><h3 id="week-schedule-title">Your week at a glance</h3></div><span class="week-legend"><i class="week-key week-key-plan"></i>Planned <i class="week-key week-key-done"></i>Completed</span></div><div class="week-days" data-week-days role="group" aria-label="Choose a training day"></div><div class="week-day-detail" data-week-day-detail></div></section>
    <section class="week-panel" aria-labelledby="week-comparison-title"><div class="week-section-heading"><div><span class="eyebrow">KEEP THE WEEKS IN PERSPECTIVE</span><h3 id="week-comparison-title">Compare weeks</h3><p>Review past work and future plans using the same training filters.</p></div><label class="week-compare-picker">Compare with<input type="date" data-week-compare aria-label="Choose a date in the comparison week"></label></div><div class="week-comparison-tools"><button type="button" class="text-button" data-week-compare-prev>Previous week</button><button type="button" class="text-button" data-week-compare-next>Next week</button><span data-week-comparison-label></span></div><div class="week-comparison-pair" data-week-comparison-pair></div><div class="week-table-scroll"><table class="week-comparison-table"><caption class="sr-only">Selected, comparison and surrounding weeks. Every column uses its own stated unit.</caption><thead><tr><th scope="col">Monday – Sunday</th><th scope="col">Planned<br>exercises</th><th scope="col">Completed<br>targets</th><th scope="col">Planned strength<br>sets</th><th scope="col">Strength<br>working sets</th><th scope="col">Bouldering<br>climbs / best sent</th><th scope="col">Kilter<br>climbs / best sent</th><th scope="col">Max hang<br>score · lb·s</th></tr></thead><tbody data-week-comparison-rows></tbody></table></div><p class="week-help" data-week-comparison-note></p></section>
    <section class="week-panel week-muscle-panel" aria-labelledby="week-muscle-title"><div class="week-section-heading"><div><span class="eyebrow">WHERE THE WORK GOES</span><h3 id="week-muscle-title">Muscle coverage</h3><p>See exercise contributions and places with no mapped exposure.</p></div><div class="week-coverage-controls"><div class="week-segmented" role="group" aria-label="Muscle coverage source"><button type="button" data-week-source="logged">Logged</button><button type="button" data-week-source="planned">Planned</button></div><label>Show<select data-week-measure aria-label="Muscle coverage measure"></select></label></div></div><p class="week-help" data-week-muscle-basis></p><div class="week-muscle-layout"><div class="week-body-panel"><div data-week-body></div><div class="week-body-legend"><span>Less</span><i></i><span>More</span></div><p>Relative within these two weeks.<br>Colour is exposure, not a training score.</p><div class="week-coverage-tally" data-week-coverage-tally></div></div><div class="week-muscle-data"><div class="week-muscle-key"><span><i class="week-key week-key-done"></i>Selected week</span><span><i class="week-key week-key-compare"></i>Comparison week</span></div><div class="week-table-scroll"><table class="week-muscle-table"><caption class="sr-only">Muscle exposure under the selected measure, with primary and secondary contributions separate.</caption><thead><tr><th scope="col">Muscle group</th><th scope="col">Primary</th><th scope="col">Supporting</th><th scope="col">Compare<br>primary</th></tr></thead><tbody data-week-muscle-rows></tbody></table></div><div class="week-muscle-inspect" data-week-muscle-inspect hidden></div></div></div><div class="week-gap-note" data-week-gap-note></div><details class="week-method"><summary>How coverage is estimated & exercise mappings</summary><div><p>Each recognised exercise has an approximate primary and supporting muscle mapping. Primary and supporting contributions stay separate; a compound exercise can appear under several muscles. These counts do not estimate activation, recovery or an optimal weekly dose.</p><p>Strength uses eligible working sets. Climbing uses recorded attempts; max hangs use active seconds from recorded working sets with known load and time. These measures are not converted into equivalent strength sets. Repeaters are excluded from muscle analytics. Planned set totals include only structured set counts you entered in the calendar. Blank set counts remain unknown. “Exercise exposures” count activity blocks and describe coverage, not equivalent workload.</p><p>Climbing maps vary with movement and technique; the generic map is a broad indication. Click a muscle group to see exactly which exercises contributed. A gap means no mapped primary exposure in this saved, filtered view.</p><div data-week-unmapped></div></div></details></section>`;

  function summary(date) {
    return buildWeekSummary({date, today:localDate(), records:getRecords(), plans, climbingWorkouts, hangboardWorkouts, types, maxHangCondition});
  }
  function available(kind) {
    if (!types.length) return true;
    const includes = group => types.some(type => typeInfo(type)?.group === group);
    if (kind === 'plans') return sourceLoaded.plans;
    if (kind === 'strength') return !includes('strength') || isHistoryReady();
    if (kind === 'climbing') return !includes('climbing') || (sourceLoaded.climbing && isHistoryReady());
    if (kind === 'hangboard') return !includes('hangboard') || (sourceLoaded.hangboard && isHistoryReady());
    if (kind === 'climb-performance') return !includes('climbing') || sourceLoaded.climbing;
    if (kind === 'max-hang-performance') return !types.includes('max_hangs') || sourceLoaded.hangboard;
    return isHistoryReady() && available('climbing') && available('hangboard');
  }
  const displayCount = (value, ready = true) => ready ? number(value) : '—';
  function periodLabel(date) {
    const thisWeek = weekStart(localDate());
    return date === thisWeek ? 'Current week · in progress' : date > thisWeek ? 'Future week · planned' : 'Past week';
  }
  function navigate(date) {
    try { start = weekStart(date); } catch { return; }
    selectedDay = localDate() >= start && localDate() <= shiftDate(start, 6) ? localDate() : start;
    if (compareFollows) compareStart = shiftDate(start, -7);
    render();
    announce('Viewing ' + rangeLabel(start, true) + '. ' + types.length + ' training types included.');
  }
  function renderStatus() {
    const errors = [...loadErrors];
    if (!isHistoryReady()) errors.push('Strength history is still loading or could not be fully loaded.');
    q('.week-load-status').classList.toggle('week-load-warning', errors.length > 0);
    q('[data-week-load-status]').textContent = loading ? 'Refreshing saved plans, climbing and hangboard…' : errors.length ? errors.join(' ') + ' Totals may be incomplete; any available data is still shown.' : loadedOnce ? 'Saved plans and training are up to date.' : 'Open My week to load saved plans and training.';
    q('[data-week-reload]').textContent = errors.length ? 'Retry' : 'Refresh';
    q('[data-week-reload]').disabled = loading;
  }
  function renderStats(week) {
    const reviewed = week.completed + week.partial + week.missed + week.skipped;
    const completion = week.planned > 0 ? Math.round(100 * week.completed / week.planned) : null;
    const plansReady = available('plans'), logsReady = available('logged');
    const fields = [
      {label:'Planned exercises', value:week.planned, ready:plansReady, note:week.planned ? countLabel(week.pending, 'target') + ' awaiting review' : start > weekStart(localDate()) ? 'Build your next training week' : 'No targets in the selected filters', style:'planned'},
      {label:'Completed targets', value:week.completed, ready:plansReady, note:week.planned ? `${completion}% of planned targets · ${number(week.partial)} partial` : 'Mark a calendar target “Hit target”', style:'completed'},
      {label:'Logged activities', value:week.loggedExercises, ready:logsReady, note:`${number(week.workingSets)} strength sets · ${number(week.attempts)} climbing attempts`, style:'logged'},
      {label:'Training days', value:week.trainingDays, ready:logsReady, note:week.trainingDays ? 'Distinct days with saved activity' : 'Days with recorded training', style:'days'},
    ];
    q('[data-week-stats]').innerHTML = fields.map(field => `<article class="week-stat week-stat-${field.style}"><span>${esc(field.label)}</span><strong>${displayCount(field.value,field.ready)}${field.style === 'days' ? '<small>/ 7</small>' : ''}</strong><p>${esc(field.ready ? field.note + (loadErrors.length ? ' · last loaded data' : '') : loading || !loadedOnce ? 'Waiting for saved training data…' : 'Data unavailable · use Retry above')}</p>${field.ready && field.style === 'completed' && completion !== null ? `<div class="week-completion-track" role="progressbar" aria-label="Planned targets completed" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${completion}"><i style="width:${completion}%"></i></div>` : ''}</article>`).join('');
    q('[data-week-stats]').setAttribute('aria-label', `${displayCount(week.planned,plansReady)} planned exercises, ${displayCount(week.completed,plansReady)} completed targets, ${displayCount(week.loggedExercises,logsReady)} logged activities, ${displayCount(week.trainingDays,logsReady)} training days.${plansReady ? ' '+reviewed+' targets reviewed.' : ' Plans are not loaded.'}`);
  }
  function renderDays(week) {
    const plansReady = available('plans'), logsReady = available('logged');
    q('[data-week-days]').innerHTML = week.days.map(day => {
      const names = [...new Set([...day.plannedItems, ...day.actualItems].map(item => item.exercise))];
      return `<button type="button" class="week-day${day.date === selectedDay ? ' is-selected' : ''}${day.isToday ? ' is-today' : ''}" data-week-day="${day.date}" aria-pressed="${day.date === selectedDay}" aria-label="${esc(formatDate(day.date,{weekday:'long'}))}: ${displayCount(day.planned,plansReady)} planned, ${displayCount(day.completed,plansReady)} completed, ${displayCount(day.loggedExercises,logsReady)} logged activities" ${day.isToday ? 'aria-current="date"' : ''}><span class="week-day-top"><span>${esc(formatDate(day.date,{weekday:'short'}).split(',')[0])}</span><strong>${asDate(day.date).getUTCDate()}</strong></span><span class="week-day-counts"><span><b>${displayCount(day.planned,plansReady)}</b> planned</span><span><b>${displayCount(day.completed,plansReady)}</b> completed</span></span><span class="week-day-log">${!logsReady ? 'Training not fully loaded' : day.loggedExercises ? countLabel(day.loggedExercises, 'activity', 'activities') + ' logged' : day.isFuture ? 'Future plan' : 'No activity logged'}</span><span class="week-day-preview">${names.length ? names.slice(0,2).map(name => '<span>'+esc(name)+'</span>').join('') + (names.length > 2 ? '<small>+' + (names.length - 2) + ' more</small>' : '') : '<span class="week-day-empty">Open day</span>'}</span></button>`;
    }).join('');
    const day = week.days.find(item => item.date === selectedDay) || week.days[0];
    const actual = day.actualItems;
    q('[data-week-day-detail]').innerHTML = `<div class="week-day-detail-heading"><div><h4>${esc(formatDate(day.date,{weekday:'long',year:'numeric'}))}</h4><p>${types.length ? 'Planned targets and recorded activity under your current filters.' : 'Select a training type above to see this day.'}</p></div><div class="week-day-actions"><button type="button" class="button button-outline" data-week-plan-date="${day.date}">+ Plan</button><label class="sr-only" for="week-log-type">Training type to log</label><select id="week-log-type" data-week-log-type>${TRAINING_TYPES.map(type => `<option value="${esc(type.id)}">${esc(type.label)}</option>`).join('')}</select><button type="button" class="button button-outline" data-week-log-date="${day.date}">+ Log</button></div></div><div class="week-day-columns"><section><div class="week-list-heading"><h5>Planned</h5><span>${displayCount(day.planned,plansReady)} exercise${day.planned === 1 ? '' : 's'}</span></div>${day.plannedItems.length ? `<ul class="week-item-list">${day.plannedItems.map(item => `<li><span class="week-target-symbol week-target-${esc(item.status)}" title="${esc(statuses[item.status] || item.status)}">${statusSymbols[item.status] || '○'}</span><div><strong>${esc(item.exercise)}</strong><small>${esc(typeInfo(item.type)?.label || item.type)}${item.plannedSets != null ? ' · ' + countLabel(item.plannedSets,'planned set') : ''}</small><p>${esc(item.target)}</p>${item.comment ? '<p class="week-item-comment">'+esc(item.comment)+'</p>' : ''}<span class="week-target-label">${esc(statuses[item.status] || item.status)}</span></div><button type="button" class="text-button" data-week-review="${esc(item.planId)}" data-week-review-date="${day.date}">Review</button></li>`).join('')}</ul>` : `<div class="week-empty"><strong>${!plansReady ? 'Plans are not loaded' : types.length ? 'Nothing planned here yet' : 'No training types selected'}</strong><p>${!plansReady ? 'Retry loading before assessing this day’s plan.' : types.length ? 'Add calendar targets to build this day’s plan.' : 'Use All or choose individual training types.'}</p></div>`}</section><section><div class="week-list-heading"><h5>Logged</h5><span>${logsReady ? countLabel(day.loggedExercises,'activity','activities') : 'Incomplete data'}</span></div>${actual.length ? `<ul class="week-item-list week-actual-list">${actual.map(item => `<li><span class="week-log-mark" aria-hidden="true">●</span><div><strong>${esc(item.exercise)}</strong><small>${esc(typeInfo(item.type)?.label || item.type)}</small><p>${esc(actualDescription(item))}</p></div></li>`).join('')}</ul>` : `<div class="week-empty"><strong>${!logsReady ? 'Training is not fully loaded' : day.isFuture ? 'Training is still ahead' : 'No activity logged'}</strong><p>${!logsReady ? 'Retry loading to see all saved activity for this day.' : day.isFuture ? 'Your plan remains separate from completed training.' : 'Log strength, climbing or hangboard work to see it here.'}</p></div>`}</section></div>`;
    q('[data-week-log-type]').value = logType;
  }
  function scoreText(value,ready=true) {return ready && Number.isFinite(value) ? number(value) : '—';}
  function renderPerformance(week) {
    const performance=week.performance, climbReady=available('climb-performance'), hangReady=available('max-hang-performance');
    const conditions=summarizeMaxHangs(hangboardWorkouts).conditions;
    q('[data-week-hang-condition]').innerHTML='<option value="">All recorded setups</option>'+conditions.map(item=>`<option value="${esc(item.key)}">${esc(item.label)}</option>`).join('')+(maxHangCondition&&!conditions.some(item=>item.key===maxHangCondition)?`<option value="${esc(maxHangCondition)}">Saved setup · no matching history loaded</option>`:'');
    q('[data-week-hang-condition]').value=maxHangCondition;
    const climbCard=(label,data,board=false)=>{
      const totals=data.totals;
      return `<article class="week-performance-card${['Lead','Top rope'].includes(label)?' week-performance-rope':''}"><span class="week-performance-label">${esc(label)}</span><strong>${displayCount(totals.distinctClimbs,climbReady)}<small>distinct ${board?'climb / angle variants':'climbs'} attempted</small></strong><p>${climbReady?countLabel(totals.attempts,'attempt')+' · '+countLabel(totals.distinctSentClimbs,board?'climb / angle variant sent':'distinct climb sent',board?'climb / angle variants sent':'distinct climbs sent'):'Climbing data unavailable'}</p><div class="week-performance-grade"><span>Best completed grade</span><b>${climbReady?esc(formatMaxGrade(data)):'—'}</b></div></article>`;
    };
    const hang=performance.maxHangs,best=hang.best;
    let html=climbCard('Bouldering',performance.boulder)+climbCard('Kilter',performance.kilter,true);
    html+=`<article class="week-performance-card week-performance-hang"><span class="week-performance-label">Max hang score</span><strong>${scoreText(hang.score,hangReady)}<small>lb·s · best session this week</small></strong><p>${!hangReady?'Hangboard data unavailable':!types.includes('max_hangs')?'Include Max hangs above to see this score':best?esc(hangSessionDetail(best)):hang.recordedHolds?'Recorded working sets need actual duration and known load to score':'No scored max hangs in this week / setup'}</p>${best&&hangReady?`<div class="week-performance-grade"><span>${esc(formatDate(best.date))} · ${countLabel(best.scoredHolds,'recorded working set')}</span><b>${esc(best.conditionLabel)}</b></div>`:'<div class="week-performance-grade"><span>Recording a max-hang set counts as completing it</span><b>Bodyweight + added load − assistance</b></div>'}</article>`;
    if(performance.lead.totals.distinctClimbs||types.includes('lead')&&!types.some(type=>['boulder','kilter','climbing_4x4'].includes(type)))html+=climbCard('Lead',performance.lead);
    if(performance.toprope.totals.distinctClimbs||types.includes('toprope')&&!types.some(type=>['boulder','kilter','climbing_4x4'].includes(type)))html+=climbCard('Top rope',performance.toprope);
    q('[data-week-performance]').innerHTML=html;
    q('[data-week-performance-note]').textContent='Climbs are distinct saved identities within the week; Kilter angles are separate variants. Attempts include repeat tries across workouts. Best grades require a completed ascent; grade scales and uncertain ranges stay separate. Max hang score adds supported load × actual seconds for every recorded working set in one session, using bodyweight saved with that workout. This card shows the best session this week. Recording the set counts as completing it. A setup selection includes only matching sets. Repeaters and rest time are excluded.'+(hang.mixedConditions?' This week contains multiple hang setups; select one above for a consistent comparison.':hang.conditionsIncomplete?' Some hang setup details are missing; compare scores with their recorded context.':'');
  }
  function actualDescription(item) {
    if (typeInfo(item.type)?.group === 'climbing') return countLabel(item.climbsAttempted||0,'distinct climb') + ' · ' + countLabel(item.attempts,'attempt') + ' · ' + countLabel(item.sends,'recorded send') + (item.climbingAnalytics ? ' · Best sent: '+formatMaxGrade(item.climbingAnalytics) : '');
    if (item.type === 'repeaters') return 'Repeater workout logged · repeater analytics are paused';
    if (typeInfo(item.type)?.group === 'hangboard') {const session=item.maxHangAnalytics?.best;return session ? 'Max hang score '+number(session.score)+' lb·s · '+hangSessionDetail(session) : 'No session score · record working-set duration and load';}
    return countLabel(item.workingSets,'working set');
  }
  function renderComparisons(week, comparison) {
    q('[data-week-compare]').value=compareStart;
    q('[data-week-comparison-label]').textContent='Comparison: '+rangeLabel(compareStart,true);
    const differences=[
      {label:'Planned exercises',selected:week.planned,compared:comparison.planned,ready:available('plans')},
      {label:'Completed targets',selected:week.completed,compared:comparison.completed,ready:available('plans')},
      {label:'Strength working sets',selected:week.workingSets,compared:comparison.workingSets,ready:available('strength')},
      {label:'Bouldering · distinct climbs',selected:week.performance.boulder.totals.distinctClimbs,compared:comparison.performance.boulder.totals.distinctClimbs,ready:available('climb-performance')},
      {label:'Kilter · climb / angle variants',selected:week.performance.kilter.totals.distinctClimbs,compared:comparison.performance.kilter.totals.distinctClimbs,ready:available('climb-performance')},
      {label:'Max hang score · best session · lb·s',selected:week.performance.maxHangs.score,compared:comparison.performance.maxHangs.score,ready:available('max-hang-performance'),hang:true},
    ];
    q('[data-week-comparison-pair]').innerHTML=differences.map(item=>{
      const known=Number.isFinite(item.selected)&&Number.isFinite(item.compared),change=known?item.selected-item.compared:null;
      const a=week.performance.maxHangs.best,b=comparison.performance.maxHangs.best;
      const sameSetup=a&&b&&a.conditionComplete&&b.conditionComplete&&a.conditionKey===b.conditionKey;
      const note=!item.ready?'Awaiting complete data':!known?'No scored result in one or both weeks':item.hang&&!sameSetup?'Different, mixed or unrecorded setups · raw session scores':change===0?(item.hang?'Same session load–time score':'Same count'):(change>0?'+':'−')+number(Math.abs(change))+(item.hang?' lb·s with matching recorded setup':' in selected week');
      return `<div><span>${esc(item.label)}</span><strong>${item.hang?scoreText(item.selected,item.ready):displayCount(item.selected,item.ready)} <small>vs ${item.hang?scoreText(item.compared,item.ready):displayCount(item.compared,item.ready)}</small></strong><p>${esc(note)}</p></div>`;
    }).join('');
    const climbCell=data=>available('climb-performance')?number(data.totals.distinctClimbs)+'<small>'+countLabel(data.totals.attempts,'attempt')+'</small><small class="week-grade-result">'+esc(formatMaxGrade(data))+'</small>':'—';
    const hangCell=data=>!available('max-hang-performance')?'—':data.best?number(data.score)+'<small>Best session · '+esc(hangSessionDetail(data.best))+'</small><small class="week-grade-result">'+esc(data.best.conditionLabel)+'</small>':'—<small>No scored session</small>';
    const dates=[...new Set([-3,-2,-1,0,1,2,3].map(offset=>shiftDate(start,offset*7)).concat(compareStart))].sort();
    q('[data-week-comparison-rows]').innerHTML=dates.map(date=>{
      const item=date===start?week:date===compareStart?comparison:summary(date);
      return `<tr class="${date===start?'week-selected-row':date===compareStart?'week-compared-row':''}"><th scope="row"><button type="button" class="week-table-date" data-week-view="${date}" ${date===start?'aria-current="true"':''}><strong>${esc(rangeLabel(date))}</strong><small>${esc(periodLabel(date))}${date===start?' · selected':date===compareStart?' · comparison':''}</small></button></th><td>${displayCount(item.planned,available('plans'))}</td><td>${displayCount(item.completed,available('plans'))}${available('plans')&&item.partial?'<small>'+number(item.partial)+' partial</small>':''}</td><td>${!available('plans')?'—':item.unknownPlannedSets?(item.plannedSets?number(item.plannedSets)+'+':'—')+'<small>'+number(item.unknownPlannedSets)+' unquantified</small>':number(item.plannedSets)}</td><td>${displayCount(item.workingSets,available('strength'))}</td><td>${climbCell(item.performance.boulder)}</td><td>${climbCell(item.performance.kilter)}</td><td>${hangCell(item.performance.maxHangs)}</td></tr>`;
    }).join('');
    q('[data-week-comparison-note]').textContent=([start,compareStart].includes(weekStart(localDate()))?'The current week is still in progress; its actuals are week-to-date. ':'')+(loadErrors.length?'Some values use last loaded data. ':'')+'Future weeks show plans, not missed targets. Planned strength sets require explicit set counts. Max hang comparisons use each week’s best session: the sum of supported load × actual time across its recorded working sets. More sets or longer holds increase the score. A dash means no scoreable session. Compare matching setups. Grade ranges are shown as recorded and never treated as their upper grade.';
  }

  function coverageChoices() {
    return source === 'planned' ? [{id:'exercises',label:'Planned exercise exposures'},{id:'strength',label:'Planned strength sets'},{id:'climbing',label:'Planned climbing targets'},{id:'hangboard',label:'Planned max-hang targets'}] : [{id:'strength',label:'Strength working sets'},{id:'climbing',label:'Climbing attempts'},{id:'hangboard',label:'Max-hang active seconds'},{id:'exercises',label:'Logged exercise exposures'}];
  }
  function coverageReady() { return available(source === 'planned' ? 'plans' : measure === 'exercises' ? 'logged' : measure === 'climbing' ? 'climb-performance' : measure === 'hangboard' ? 'max-hang-performance' : measure); }
  function unknownSets(week,muscleId,supporting=false) {
    return source === 'planned' && measure === 'strength' ? week.plannedItems.filter(item=>item.type === 'strength' && item.plannedSets == null && item.profile?.[supporting ? 'secondary' : 'primary']?.includes(muscleId)).length : 0;
  }
  function coverageCount(value, unknown) {
    if (!coverageReady()) return '—';
    return unknown ? `${value ? number(value) + '+' : '—'}<small class="week-unknown-count">${countLabel(unknown,'target')} unquantified</small>` : number(value);
  }
  function exposureValue(week, muscle, supporting = false) {
    const field = supporting ? 'secondary' : 'primary';
    if (source === 'planned') {
      if (measure === 'strength') return Number(muscle[supporting ? 'plannedSecondarySets' : 'plannedSets']) || 0;
      if (measure === 'exercises') return Number(muscle[supporting ? 'plannedSecondary' : 'plannedPrimary']) || 0;
      return week.plannedItems.filter(item => (measure === 'hangboard' ? item.type === 'max_hangs' : typeInfo(item.type)?.group === measure) && item.profile?.[field]?.includes(muscle.id)).length;
    }
    if (measure === 'strength') return Number(muscle[supporting ? 'secondarySets' : 'workingSets']) || 0;
    if (measure === 'climbing') return Number(muscle[supporting ? 'secondaryClimbingAttempts' : 'climbingAttempts']) || 0;
    if (measure === 'hangboard') return Number(muscle[supporting ? 'secondaryMaxHangSeconds' : 'maxHangSeconds']) || 0;
    return Number(muscle[supporting ? 'actualSecondary' : 'actualPrimary']) || 0;
  }
  function renderMuscles(week, comparison) {
    const choices = coverageChoices();
    if (!choices.some(item => item.id === measure)) measure = choices[0].id;
    const currentChoice = choices.find(item => item.id === measure);
    q('[data-week-measure]').innerHTML = choices.map(item => `<option value="${item.id}" ${measure === item.id ? 'selected' : ''}>${esc(item.label)}</option>`).join('');
    host.querySelectorAll('[data-week-source]').forEach(button => {button.classList.toggle('is-active', button.dataset.weekSource === source);button.setAttribute('aria-pressed', String(button.dataset.weekSource === source));});
    const secondaryWeek = new Map(comparison.muscles.map(muscle => [muscle.id, muscle]));
    const max = Math.max(1, ...week.muscles.map(muscle => exposureValue(week,muscle)), ...comparison.muscles.map(muscle => exposureValue(comparison,muscle)));
    const ready = coverageReady();
    const unit = measure === 'strength' ? 'sets' : measure === 'climbing' || measure === 'hangboard' ? source === 'planned' ? 'targets' : measure === 'climbing' ? 'attempts' : 'seconds' : 'exposures';
    q('[data-week-muscle-basis]').textContent = (!ready ? 'Coverage is unavailable until the selected training data loads. ' : '') + currentChoice.label + '. Primary and supporting contributions are separate. ' + (source === 'planned' && measure === 'strength' ? 'Only known set counts colour the map; missing counts are marked unquantified, not treated as no planned work.' : measure === 'exercises' ? 'One eligible exercise activity or planned target is one exposure. Repeaters are omitted. This shows coverage, not equivalent training dose.' : measure === 'climbing' ? (source === 'planned' ? 'Each calendar climbing target is one exposure. Several targets may belong to one session.' : 'Each climbing attempt contributes once, including repeat tries. This is a broad movement map, not a measurement of intensity or activation.') : measure === 'hangboard' ? (source === 'planned' ? 'Each calendar max-hang target is one exposure. Repeaters and unspecified hangboard targets are omitted from this measure.' : 'Total actual seconds from recorded max-hang working sets with known load under the selected setup. Recording a set counts as completing it. Repeaters, warm-ups and unknown load or time are omitted; seconds are not converted to strength sets.') : 'Eligible strength working sets only; climbing and hangboard have their own measures.');
    q('[data-week-muscle-rows]').innerHTML = week.muscles.map(muscle => {
      const value = exposureValue(week,muscle), supporting = exposureValue(week,muscle,true), compareValue = exposureValue(comparison,secondaryWeek.get(muscle.id) || muscle);
      return `<tr class="${selectedMuscle === muscle.id ? 'week-muscle-selected' : ''}"><th scope="row"><button type="button" class="week-muscle-name" data-week-muscle="${esc(muscle.id)}" aria-expanded="${selectedMuscle === muscle.id}">${esc(muscle.label)}<span aria-hidden="true">↗</span></button><div class="week-muscle-bars" aria-hidden="true"><i style="width:${ready ? Math.round(value / max * 100) : 0}%"></i><i style="width:${ready ? Math.round(compareValue / max * 100) : 0}%"></i></div></th><td>${coverageCount(value,unknownSets(week,muscle.id))}</td><td>${coverageCount(supporting,unknownSets(week,muscle.id,true))}</td><td>${coverageCount(compareValue,unknownSets(comparison,muscle.id))}</td></tr>`;
    }).join('');
    q('[data-week-body]').innerHTML = bodyMap(week,max,unit);
    const covered = week.muscles.filter(muscle => exposureValue(week,muscle) > 0).length;
    const unquantified = week.muscles.filter(muscle => unknownSets(week,muscle.id));
    q('[data-week-coverage-tally]').innerHTML = `<strong>${displayCount(covered,ready)}<small> / ${MUSCLE_GROUPS.length}</small></strong><span>groups with quantified primary ${esc(unit)}${unquantified.length ? ' · '+countLabel(unquantified.length,'group')+' also has unquantified targets' : ''}</span>`;
    const gaps = week.muscles.filter(muscle => !exposureValue(week,muscle) && !unknownSets(week,muscle.id));
    q('[data-week-gap-note]').innerHTML = !types.length ? '<strong>Choose a training type to inspect muscle coverage.</strong>' : !ready ? '<strong>Coverage is incomplete.</strong> Load the missing training data before assessing gaps.' : gaps.length ? '<strong>No mapped primary '+esc(unit)+' under this measure:</strong> ' + gaps.map(muscle => esc(muscle.label)).join(', ') + '. <span>This reflects the selected measure, filters and saved records.</span>' + (unquantified.length ? ' <span>'+unquantified.map(muscle=>esc(muscle.label)).join(', ')+' have planned strength work with unspecified set counts; those are not treated as gaps.</span>' : '') : '<strong>Every displayed group has mapped primary '+esc(unit)+' or an unquantified planned target.</strong> <span>Exposure alone does not establish adequate workload, recovery or training balance.</span>';
    const missing = week.unmapped.filter(item => source === 'planned' ? item.planned : item.actual);
    const missingSets = source === 'planned' ? week.plannedItems.filter(item => item.type === 'strength' && item.plannedSets == null) : [];
    q('[data-week-unmapped]').innerHTML = `<h4>Unmapped exercises</h4>${!ready ? '<p>Load complete training data to check unmapped exercises.</p>' : missing.length ? '<p>These remain in your totals but cannot contribute to a muscle group yet.</p><ul>'+missing.map(item=>'<li><strong>'+esc(item.exercise)+'</strong> · '+countLabel(source === 'planned' ? item.planned : item.actual,'activity','activities')+'</li>').join('')+'</ul>' : '<p>No unmapped exercises in this week under the current filters.</p>'}${missingSets.length ? '<h4>Planned strength sets not specified</h4><p>'+[...new Set(missingSets.map(item=>item.exercise))].map(esc).join(', ')+'. Add a set count in Calendar & plans to include these in planned set totals.</p>' : ''}`;
    renderMuscleInspection(week,unit);
  }
  function renderMuscleInspection(week,unit) {
    const panel = q('[data-week-muscle-inspect]'), muscle = MUSCLE_GROUPS.find(item => item.id === selectedMuscle);
    if (!muscle) { panel.hidden = true; return; }
    const entries = (source === 'planned' ? week.plannedItems : week.actualItems).filter(item => {
      const group = typeInfo(item.type)?.group;
      const eligible = source === 'planned' ? item.type !== 'repeaters' && (measure !== 'hangboard' || item.type === 'max_hangs') : group !== 'hangboard' || item.maxHangSeconds > 0;
      return eligible && (measure === 'exercises' || group === measure) && (measure !== 'climbing' || source === 'planned' || item.attempts > 0) && (item.profile?.primary?.includes(muscle.id) || item.profile?.secondary?.includes(muscle.id));
    });
    panel.hidden = false;
    panel.innerHTML = `<div><h4>${esc(muscle.label)} · contributions</h4><button type="button" class="week-icon-button" data-week-close-muscle aria-label="Close muscle contributions">×</button></div>${entries.length ? '<ul>'+entries.map(item=>{
      const primary = item.profile.primary.includes(muscle.id);
      let detail = source === 'planned' ? (measure === 'strength' ? item.plannedSets == null ? 'Set count not specified' : countLabel(item.plannedSets,'planned set') : '1 planned exposure') : measure === 'hangboard' ? number(item.maxHangSeconds)+' s across scored max hangs' : actualDescription(item);
      return '<li><strong>'+esc(item.exercise)+'</strong><span>'+esc(formatDate(item.date))+' · '+(primary?'Primary':'Supporting')+'</span><small>'+esc(detail)+'</small></li>';
    }).join('')+'</ul>' : '<p>No mapped contributions under this measure and these filters.</p>'}`;
  }
  function bodyMap(week,max,unit) {
    const values = new Map(week.muscles.map(muscle=>[muscle.id,coverageReady() ? exposureValue(week,muscle) : 0]));
    const shade = id => {const value = values.get(id)||0;return value ? `hsl(84 51% ${28+Math.round(value/max*43)}%)` : '#253026';};
    const part = (id,d) => `<path d="${d}" fill="${shade(id)}" stroke="#111a13" stroke-width="1.8"><title>${esc(MUSCLE_GROUPS.find(m=>m.id===id)?.label||id)}: ${coverageReady() ? number(values.get(id)) + ' known primary ' + unit + (unknownSets(week,id) ? ', with unquantified targets' : '') : 'data unavailable'}</title></path>`;
    return `<svg class="week-body-map" viewBox="0 0 250 340" role="img" aria-label="Front and back body map of ${esc(coverageChoices().find(item=>item.id===measure)?.label||measure)}. Exact counts are in the muscle table."><g transform="translate(7 14)"><text x="54" y="7" text-anchor="middle">FRONT</text><circle cx="54" cy="34" r="15" fill="#303a30"/><path d="M46 49v10l-18 7-12 52-7 51 11 3 16-50 3 49-10 58 7 74 13 1 6-62 6 62 13-1 7-74-10-58 3-49 16 50 11-3-7-51-12-52-18-7V49" fill="#29352a" stroke="#45533f" stroke-width="1.4"/>${part('shoulders','M28 66Q34 61 40 64L35 91 20 92Z M80 66Q74 61 68 64L73 91 88 92Z')}${part('chest','M40 64L53 68 53 96 37 91Z M68 64L55 68 55 96 71 91Z')}${part('biceps','M21 95L34 95 31 119 16 124Z M87 95L74 95 77 119 92 124Z')}${part('forearms','M16 127L29 122 20 163 11 163Z M92 127L79 122 88 163 97 163Z')}${part('core','M39 99L69 99 67 144 56 157 43 145Z')}${part('hip_flexors','M40 147L51 159 48 178 34 177Z M68 147L57 159 60 178 74 177Z')}${part('quadriceps','M35 180L50 181 49 224 36 232 31 223Z M73 180L58 181 59 224 72 232 77 223Z')}${part('calves','M36 239L49 234 46 285 37 285Z M72 239L59 234 62 285 71 285Z')}</g><g transform="translate(137 14)"><text x="54" y="7" text-anchor="middle">BACK</text><circle cx="54" cy="34" r="15" fill="#303a30"/><path d="M46 49v10l-18 7-12 52-7 51 11 3 16-50 3 49-10 58 7 74 13 1 6-62 6 62 13-1 7-74-10-58 3-49 16 50 11-3-7-51-12-52-18-7V49" fill="#29352a" stroke="#45533f" stroke-width="1.4"/>${part('shoulders','M28 66Q34 61 40 64L35 91 20 92Z M80 66Q74 61 68 64L73 91 88 92Z')}${part('upper_back','M41 63L54 55 67 63 69 91 55 107 39 91Z')}${part('lats','M38 94L52 109 51 137 41 131Z M70 94L56 109 57 137 67 131Z')}${part('lower_back','M43 135L53 141 65 135 67 155 41 155Z')}${part('triceps','M21 95L34 95 31 121 16 124Z M87 95L74 95 77 121 92 124Z')}${part('forearms','M16 127L29 124 20 163 11 163Z M92 127L79 124 88 163 97 163Z')}${part('glutes','M40 158L53 158 52 181 34 183Z M68 158L55 158 56 181 74 183Z')}${part('hamstrings','M34 187L51 185 48 227 35 233 31 222Z M74 187L57 185 60 227 73 233 77 222Z')}${part('calves','M36 239L49 234 46 285 37 285Z M72 239L59 234 62 285 71 285Z')}</g></svg>`;
  }
  function render() {
    if (destroyed) return;
    const week = summary(start), comparison = summary(compareStart);
    q('[data-week-range]').textContent = rangeLabel(start,true);
    q('[data-week-context]').textContent = periodLabel(start);
    q('[data-week-progress-note]').textContent = start === weekStart(localDate()) ? 'Week-to-date actuals · full-week plan' : start > weekStart(localDate()) ? 'Look ahead and check the shape of your plan.' : 'Review what was planned and what was recorded.';
    q('[data-week-jump]').value = start;
    host.querySelectorAll('[data-week-type]').forEach(input=>{input.checked=types.includes(input.dataset.weekType);input.closest('label').classList.toggle('is-checked',input.checked);});
    q('[data-week-filter-note]').textContent = types.length ? `${types.length} of ${TRAINING_TYPES.length} training types included. Applies to every total, comparison and muscle view below.` : 'No training types selected. Choose any type or All to see your training.';
    renderStatus();renderStats(week);renderPerformance(week);renderDays(week);renderComparisons(week,comparison);renderMuscles(week,comparison);persist();
  }
  async function readEndpoint(endpoint,key) {
    const controller = new AbortController();requests.add(controller);
    const timer = setTimeout(()=>controller.abort(),20000);
    try {
      const response = await fetch(endpoint,{cache:'no-store',headers:{Accept:'application/json'},signal:controller.signal});
      if (!response.ok) throw new Error('The request could not be completed.');
      const body = await response.json();
      if (!Array.isArray(body[key])) throw new Error('The response did not contain training records.');
      return body[key];
    } finally {clearTimeout(timer);requests.delete(controller);}
  }
  function load() {
    if (destroyed) return Promise.resolve();
    if (loading) return loadPromise;
    loading = true;renderStatus();
    loadPromise = (async()=>{
      const sources = [{id:'plans',label:'Plans',endpoint:'/api/plans',key:'plans'},{id:'climbing',label:'Climbing',endpoint:'/api/climbing-workouts',key:'workouts'},{id:'hangboard',label:'Hangboard',endpoint:'/api/hangboard-workouts',key:'workouts'}];
      const results = await Promise.allSettled([...sources.map(item=>readEndpoint(item.endpoint,item.key)), Promise.resolve().then(()=>onRefreshHistory())]);
      if (destroyed) return;
      loadErrors = [];
      results.slice(0,sources.length).forEach((result,index)=>{
        const item = sources[index];
        if (result.status === 'fulfilled') {
          sourceLoaded[item.id] = true;
          if (item.id === 'plans') plans = result.value;
          else if (item.id === 'climbing') climbingWorkouts = result.value;
          else hangboardWorkouts = result.value;
        } else loadErrors.push(item.label + (sourceLoaded[item.id] ? ' could not be refreshed; showing the last loaded data.' : ' could not be loaded.'));
      });
      if (results[sources.length].status === 'rejected') loadErrors.push('Strength history could not be refreshed.');
      loadedOnce = true;loading = false;render();
    })().finally(()=>{loading=false;});
    return loadPromise;
  }
  host.addEventListener('click',event=>{
    const button = event.target.closest('button');if (!button || button.disabled) return;
    if (button.hasAttribute('data-week-prev')) navigate(shiftDate(start,-7));
    else if (button.hasAttribute('data-week-next')) navigate(shiftDate(start,7));
    else if (button.hasAttribute('data-week-today')) navigate(localDate());
    else if (button.hasAttribute('data-week-all')) {types=[...knownTypes];render();}
    else if (button.hasAttribute('data-week-none')) {types=[];render();}
    else if (button.hasAttribute('data-week-reload')) load();
    else if (button.dataset.weekDay) {selectedDay=button.dataset.weekDay;render();q(`[data-week-day="${selectedDay}"]`)?.focus();}
    else if (button.dataset.weekView) navigate(button.dataset.weekView);
    else if (button.hasAttribute('data-week-compare-prev')) {compareStart=shiftDate(start,-7);compareFollows=true;render();}
    else if (button.hasAttribute('data-week-compare-next')) {compareStart=shiftDate(start,7);compareFollows=false;render();}
    else if (button.hasAttribute('data-week-plan-current')) onPlanDate(selectedDay);
    else if (button.dataset.weekPlanDate) onPlanDate(button.dataset.weekPlanDate);
    else if (button.dataset.weekReview) onReviewPlan(button.dataset.weekReview,button.dataset.weekReviewDate);
    else if (button.dataset.weekLogDate) onLogDate(button.dataset.weekLogDate,logType);
    else if (button.dataset.weekSource) {source=button.dataset.weekSource;render();}
    else if (button.dataset.weekMuscle) {selectedMuscle=selectedMuscle===button.dataset.weekMuscle?'':button.dataset.weekMuscle;render();q(`[data-week-muscle="${button.dataset.weekMuscle}"]`)?.focus();}
    else if (button.hasAttribute('data-week-close-muscle')) {const previous=selectedMuscle;selectedMuscle='';render();q(`[data-week-muscle="${previous}"]`)?.focus();}
  },{signal:eventController.signal});
  host.addEventListener('change',event=>{
    if (event.target.matches('[data-week-type]')) {types=[...host.querySelectorAll('[data-week-type]:checked')].map(input=>input.dataset.weekType);render();}
    else if (event.target.matches('[data-week-jump]') && event.target.value) navigate(event.target.value);
    else if (event.target.matches('[data-week-compare]') && event.target.value) {try{compareStart=weekStart(event.target.value);compareFollows=false;render();}catch{}}
    else if (event.target.matches('[data-week-hang-condition]')) {maxHangCondition=event.target.value;render();}
    else if (event.target.matches('[data-week-log-type]')) {logType=event.target.value;}
    else if (event.target.matches('[data-week-measure]')) {measure=event.target.value;render();}
  },{signal:eventController.signal});
  render();
  return {load,activate(){render();return load();},refreshRecords:render,destroy(){destroyed=true;eventController.abort();for(const controller of requests)controller.abort();host.innerHTML='';host.classList.remove('week-dashboard');}};
}
