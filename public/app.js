import { buildCatalog, analyze, DEFAULT_BODYWEIGHT } from './analytics.js';
import { createEntryForm } from './entry-form.js';
import { createChartWorkspace } from './chart-workspace.js';
import { createSurfaceWorkspace } from './surface-view.js';
import { getTrainingToday, splitCatalog, chooseLibraryExercise } from './exercise-archive.js';
import { createDeletionManager } from './deletion-manager.js';
import { createCalendar } from './calendar.js';
import { createClimbingTracker } from './climbing.js';
import { createHangboardTracker } from './hangboard.js';
import { describeHoldRecord, renderRepeaterSummary as renderRepeaterRounds } from './repeater-display.js';

const data = window.TRAINING_DATA;
const originalRecords = data?.records || [];
let savedEntries = [];
let deletions = [];
let allRecords = [...originalRecords];
let records = [...originalRecords];
let catalog = buildCatalog(records);
let byName = new Map(catalog.map(item => [item.name, item]));
let libraryPartition=splitCatalog(catalog,getTrainingToday());
const $ = id => document.getElementById(id);
const finite = n => typeof n === 'number' && Number.isFinite(n);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = (n, digits = 1) => finite(n) ? new Intl.NumberFormat('en-CA', {maximumFractionDigits:digits}).format(n) : '—';
const dateFmt = new Intl.DateTimeFormat('en-CA', {day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});
const dateShort = new Intl.DateTimeFormat('en-CA', {month:'short',year:'2-digit',timeZone:'UTC'});
const dateDay = new Intl.DateTimeFormat('en-CA', {month:'short',day:'numeric',timeZone:'UTC'});
const dateLabel = d => d ? dateFmt.format(new Date(d + 'T12:00:00Z')) : 'No eligible session';
const time = d => new Date(d + 'T12:00:00Z').getTime();
const sessionKey = row => row.date + '__' + row.session;
const metricLabels = {strength:'Strength estimate',load:'Load',reps:'Reps',volume:'Volume',hold:'Hold duration',holdTotal:'Total hold time',setting:'Stack setting'};
const categoryLabels = {Pull:'Pulling',Push:'Pushing',Legs:'Legs',Arms:'Arms',Shoulders:'Shoulders',Core:'Core',Grip:'Grip',Other:'Other'};
const defaults = {exercise:'',metric:'strength',from:'',to:'',method:'epley',bodyweight:DEFAULT_BODYWEIGHT,repCap:10,includeWarmups:false,loadBasis:'total',minReps:0,side:'all',period:'all',pointsMode:'sessions',lineMode:'connect',fitWeight:'sets',fitSmoothing:.55,surfaceFit:'smooth',surfaceSmoothing:.55,surfaceAxis:'auto',view:'history',showArchived:false};
let saved = {};
try { saved = JSON.parse(localStorage.getItem('training-history-fresh-start-view') || '{}'); } catch {}
let state = {...defaults,...saved};
state.showArchived=state.showArchived===true;
// Migrate prior per-set and warm-up display preferences to working-set workout averages.
state.pointsMode='sessions';
state.includeWarmups=false;
if(!['connect','bestFit','quadratic','smooth'].includes(state.lineMode))state.lineMode='connect';
if(!['sets','sessions','volume'].includes(state.fitWeight))state.fitWeight='sets';
if(!['none','plane','quadratic','smooth'].includes(state.surfaceFit))state.surfaceFit='smooth';
if(!['auto','reps','hold'].includes(state.surfaceAxis))state.surfaceAxis='auto';
for(const key of ['fitSmoothing','surfaceSmoothing'])state[key]=finite(Number(state[key]))?Math.max(.2,Math.min(1,Number(state[key]))):.55;
if(!['history','calendar','climbing','kilter','hangboard'].includes(state.view))state.view='history';
if (!byName.has(state.exercise)) state.exercise = catalog[0]?.name || '';
if (!byName.get(state.exercise)?.metrics.includes(state.metric)) state.metric = byName.get(state.exercise)?.defaultMetric || 'reps';
state.bodyweight = state.bodyweight !== null && state.bodyweight !== '' && finite(Number(state.bodyweight)) && Number(state.bodyweight) >= 1 && Number(state.bodyweight) <= 1000 ? Number(state.bodyweight) : DEFAULT_BODYWEIGHT;
const hasBodyweight = () => finite(state.bodyweight) && state.bodyweight >= 1 && state.bodyweight <= 1000;
let current = null;
let selectedSession = '';
let rowLimit = 25;
let search = '';
let category = 'all';
let sortOrder = 'newest';
let resizeTimer;
let userChoseExercise = false;
let toastAction = null;
let deletionManager;
let calendar;
let climbingTracker;
let kilterTracker;
let hangboardTracker;
let chartWorkspace;
let surfaceWorkspace;
let entryForm;
let loadingEntries = false;
let entryRevision = 0;
let archiveLoaded = false;

function persist() { try { localStorage.setItem('training-history-fresh-start-view', JSON.stringify(state)); } catch {} }
function announce(message) { $('announcement').textContent = message; }
function setText(id, text) { $(id).textContent = text; }
function unitLabel() { return current?.metric?.unit || ''; }
function unitShort(unit) { return unit === 'lb·reps' ? 'lb·reps' : unit === 'setting' ? '' : unit; }
function formatMetric(value, withUnit = true) {
  if (!finite(value)) return '—';
  const unit = unitShort(unitLabel());
  const digits = ['volume','holdTotal'].includes(state.metric) ? 0 : 1;
  return number(value, digits) + (withUnit && unit ? ' ' + unit : '');
}
function statMarkup(point) {
  if (!point || !finite(point.value)) return '—';
  return number(point.value, ['volume','holdTotal'].includes(state.metric) ? 0 : 1) + (unitShort(unitLabel()) ? '<small>' + escapeHtml(unitShort(unitLabel())) + '</small>' : '');
}
function pointDescription(point) {
  if (!point) return '';
  let text = dateLabel(point.date);
  if (finite(point.reps) && finite(point.load)) text += ' · ' + number(point.load, 2) + ' lb × ' + number(point.reps);
  if (point.partial) text += ' · partial total';
  return text;
}
function libraryCatalog(){return state.showArchived?[...libraryPartition.active,...libraryPartition.archived]:libraryPartition.active;}
function populateLibrary() {
  const choices=libraryCatalog();
  const categories=[...new Set(choices.map(item=>item.category))];
  if(category!=='all'&&!categories.includes(category))category='all';
  $('category-filter').innerHTML='<option value="all">All categories</option>'+categories.map(c=>'<option value="'+escapeHtml(c)+'">'+escapeHtml(categoryLabels[c]||c)+'</option>').join('');
  const activeGroups=[...new Set(libraryPartition.active.map(item=>item.category))];
  $('mobile-exercise').innerHTML=activeGroups.map(c=>'<optgroup label="'+escapeHtml(categoryLabels[c]||c)+'">'+libraryPartition.active.filter(item=>item.category===c).map(item=>'<option value="'+escapeHtml(item.name)+'">'+escapeHtml(item.name)+'</option>').join('')+'</optgroup>').join('')+(state.showArchived&&libraryPartition.archived.length?'<optgroup label="Archived exercises">'+libraryPartition.archived.map(item=>'<option value="'+escapeHtml(item.name)+'">'+escapeHtml(item.name)+'</option>').join('')+'</optgroup>':'')||'<option value="">'+(catalog.length?'No recent exercises':'Log an exercise to begin')+'</option>';
  $('mobile-exercise').disabled=!choices.length;
  document.querySelector('.mobile-library').hidden=!catalog.length;
  document.querySelector('.archive-toggle-mobile').hidden=!catalog.length;
  $('mobile-exercise').value=state.exercise||'';
  $('category-filter').value=category;
  document.querySelectorAll('[data-show-archived]').forEach(input=>{input.checked=state.showArchived;input.disabled=!libraryPartition.archived.length;});
  document.querySelectorAll('[data-archive-count]').forEach(element=>{element.textContent='('+libraryPartition.archived.length+')';});
  setText('exercise-total',choices.length);
  $('library-empty').hidden=Boolean(state.exercise);
  $('exercise-workspace').hidden=!state.exercise;
  $('reveal-archive').hidden=!libraryPartition.archived.length;
  setText('library-empty-title',catalog.length?'No recent exercises':'Start your training log');
  setText('library-empty-description',catalog.length?'Browse your archived exercises or log a workout to bring an exercise back.':'Log strength sets, climbing sessions or hangboard training. Your charts and exercise library will grow as you train.');
  $('empty-log-options').hidden=Boolean(catalog.length);
  $('open-deleted-empty').hidden=!deletions.length;
  renderLibrary();
}
function renderLibrary() {
  const matches=item=>(category==='all'||item.category===category)&&item.name.toLowerCase().includes(search);
  const recent=libraryPartition.active.filter(matches),older=libraryPartition.archived.filter(matches);
  const buttons=(items,archived=false)=>{
    let group='';
    return items.map(item=>{
      const heading=item.category!==group?'<div class="exercise-group-title">'+escapeHtml(categoryLabels[item.category]||item.category)+'</div>':'';group=item.category;
      return heading+'<button class="exercise-button'+(item.name===state.exercise?' active':'')+'" data-exercise="'+escapeHtml(item.name)+'" aria-current="'+(item.name===state.exercise?'true':'false')+'"><span>'+escapeHtml(item.name)+(archived?'<small class="archive-exercise-label">Last logged '+escapeHtml(dateLabel(item.latestDate))+'</small>':'')+'</span><span>'+item.entries+'</span></button>';
    }).join('');
  };
  let html=buttons(recent);
  if(state.showArchived&&older.length)html+='<section class="archived-exercises" aria-label="Archived exercises"><div class="archive-section-heading">Archived exercises <span>'+older.length+'</span></div><p class="archive-section-note">Last logged more than a year ago.</p>'+buttons(older,true)+'</section>';
  if(!html)html='<p class="no-exercises">'+(search?'No matching recent exercises.':libraryPartition.active.length?'No exercises in this category.':catalog.length?'No exercises logged in the past year.':'Your exercises will appear here after you log a workout.')+'</p>';
  if(!state.showArchived&&older.length)html+='<button type="button" class="archive-reveal-button" data-reveal-archive>'+(search?'Show '+older.length+' archived '+(older.length===1?'match':'matches'):'Browse '+libraryPartition.archived.length+' archived exercises')+' →</button>';
  $('exercise-list').innerHTML=html;
  $('exercise-list').querySelectorAll('[data-exercise]').forEach(button=>button.addEventListener('click',()=>chooseExercise(button.dataset.exercise)));
  $('exercise-list').querySelector('[data-reveal-archive]')?.addEventListener('click',()=>setArchiveVisibility(true));
}
function setArchiveVisibility(show){
  state.showArchived=Boolean(show);
  const previous=state.exercise;
  state.exercise=chooseLibraryExercise(state.exercise,libraryPartition,state.showArchived);
  if(previous!==state.exercise){state.metric=byName.get(state.exercise)?.defaultMetric||'reps';selectedSession='';state.side='all';rowLimit=25;}
  populateLibrary();render();
  announce(state.showArchived?'Archived exercises are shown.':'Showing exercises logged within the past year.');
}
function chooseExercise(name) {
  if (!byName.has(name)) return;
  userChoseExercise = true;
  showView('history');
  state.exercise = name;
  if(libraryPartition.archived.some(item=>item.name===name)){state.showArchived=true;populateLibrary();}
  const item = byName.get(name);
  if (!item.metrics.includes(state.metric)) state.metric = item.defaultMetric;
  state.side = 'all';
  selectedSession = '';
  rowLimit = 25;
  render();
  announce(name + ' selected. ' + current.stats.sessionCount + ' recorded sessions.');
}
function syncControls() {
  $('mobile-exercise').value = state.exercise;
  $('date-from').value = state.from;
  $('date-to').value = state.to;
  $('method').value = state.method;
  $('rep-cap').value = String(state.repCap);
  if (document.activeElement !== $('bodyweight') && $('settings-error').hidden) $('bodyweight').value = hasBodyweight() ? state.bodyweight.toFixed(2) : '';
  $('load-basis').value = state.loadBasis;
  $('side-filter').value = state.side;
  $('min-reps').value = String(state.minReps);
  $('line-mode').value = state.lineMode;
  $('fit-weight').value=state.fitWeight;
  $('fit-smoothing').value=String(Math.round(state.fitSmoothing*100));
  $('fit-smoothing-value').textContent=Math.round(state.fitSmoothing*100)+'%';
  $('fit-weight-control').hidden=state.lineMode==='connect';
  $('fit-smoothing-control').hidden=state.lineMode!=='smooth';
  const aggregate=['volume','holdTotal'].includes(state.metric);
  $('fit-weight').disabled=aggregate;
  if(aggregate)$('fit-weight').value='sessions';
  setText('plot-summary-mode',aggregate?'Workout totals':'Workout averages');
  $('date-shortcuts').querySelectorAll('button').forEach(button => {
    const active = button.dataset.period === state.period;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}
function render() {
  hideTooltip();
  current = analyze(state.exercise?records:[], state);
  if (selectedSession && !current.sessions.some(s => s.key === selectedSession)) selectedSession = '';
  syncControls();
  persist();
  renderLibrary();
  const item = byName.get(state.exercise) || {category:'Other',metrics:[],defaultMetric:'reps'};
  const pullup = current.rows.some(r => r.is_pullup);
  $('bodyweight-notice').hidden = !pullup || hasBodyweight();
  setText('category-label', (categoryLabels[item.category] || item.category).toUpperCase());
  setText('exercise-title', state.exercise || 'No exercises yet');
  let description = pullup ? 'Bodyweight and added load, brought together in one history.' : current.rows.some(r => /Per dumbbell/i.test(r.load_basis || '')) ? 'Loads are per dumbbell. Compare your recorded sessions over time.' : item.defaultMetric === 'holdTotal' ? 'Your rounds, hangs, rest intervals and active hang time in one view.' : 'Your recorded sessions, organized into one exercise history.';
  setText('exercise-description', description);
  setText('session-count', current.stats.sessionCount);
  setText('entry-count', current.stats.entryCount);
  $('first-value').innerHTML = statMarkup(current.stats.first);
  $('latest-value').innerHTML = statMarkup(current.stats.latest);
  $('best-value').innerHTML = statMarkup(current.stats.best);
  setText('first-detail', dateLabel(current.stats.first?.date));
  setText('latest-detail', dateLabel(current.stats.latest?.date));
  setText('best-detail', dateLabel(current.stats.best?.date));
  setText('chart-title', current.metric.label);
  let badge = state.metric === 'strength' ? (state.method === 'epley' ? 'Epley' : 'Brzycki') + ' · 1–' + state.repCap + ' reps' : state.metric === 'setting' ? 'Numbered setting · no lb conversion' : pullup && ['load','strength'].includes(state.metric) ? state.loadBasis === 'total' ? 'Bodyweight + added' : 'Added weight' : unitLabel() || 'Recorded values';
  setText('metric-badge', badge);
  $('metric-tabs').innerHTML = item.metrics.map(metric => '<button class="metric-tab' + (metric === state.metric ? ' active' : '') + '" data-metric="' + metric + '" aria-pressed="' + (metric === state.metric) + '">' + escapeHtml(metricLabels[metric] || metric) + '</button>').join('');
  $('metric-tabs').querySelectorAll('button').forEach(button => button.addEventListener('click', () => { state.metric = button.dataset.metric; selectedSession = ''; rowLimit = 25; render(); }));
  $('min-reps-control').hidden = state.metric !== 'load';
  setText('chart-description', current.metric.description || '');
  setText('plotted-count', current.series.length + ' plotted / ' + current.sessions.length + ' logged sessions');
  setText('settings-summary', (state.method === 'epley' ? 'Epley' : 'Brzycki') + (hasBodyweight() ? ' · bodyweight ' + number(state.bodyweight,2) + ' lb' : ' · bodyweight not set'));
  $('session-select').innerHTML = '<option value="">All recorded sessions</option>' + current.sessions.map(session => '<option value="' + escapeHtml(session.key) + '">' + dateLabel(session.date) + ' · ' + session.sets.length + ' records' + (finite(session.value) ? ' · ' + formatMetric(session.value) : ' · no plotted value') + '</option>').join('');
  $('session-select').value = selectedSession;
  $('clear-session').hidden = !selectedSession;
  renderProgression();
  renderSurface();
  renderContext();
  renderRecords();
  window.__trainingDashboard = {getState:() => ({...state,selectedSession}), getAnalysis:() => current};
}
function hideTooltip() { $('chart-tooltip').hidden = true; }
function selectSession(key, scroll = false) {
  selectedSession = selectedSession === key ? '' : key;
  rowLimit = 25;
  $('session-select').value = selectedSession;
  $('clear-session').hidden = !selectedSession;
  renderProgression();
  renderSurface();
  renderRecords();
  const session = current.sessions.find(s => s.key === selectedSession);
  announce(session ? dateLabel(session.date) + ': ' + session.sets.length + ' source records shown.' : 'All sessions shown.');
  if (scroll) $('records').scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',block:'start'});
}
function renderChangeSummary(model) {
  const comparison = model.comparison;
  const fitted = comparison.basis === 'fitted';
  const change = comparison.available ? comparison.changePct : null;
  setText('change-label', fitted ? 'FITTED CHANGE' : 'FIRST → LATEST');
  setText('change-value', finite(change) ? (change > 0 ? '+' : '') + number(change,1) + '%' : '—');
  $('change-value').className = 'stat-value' + (finite(change) && change > 0 ? ' positive' : finite(change) && change < 0 ? ' negative' : '');
  setText('change-detail', comparison.available ? comparison.label : comparison.reason || 'No comparison available for this range.');
  const endpoints = finite(comparison.startValue) && finite(comparison.endValue);
  $('change-endpoints').hidden = !endpoints;
  setText('change-endpoints', endpoints ? (fitted ? 'Fit: ' : '') + formatMetric(comparison.startValue) + ' → ' + formatMetric(comparison.endValue) : '');
  const dates = Boolean(comparison.startDate && comparison.endDate);
  $('change-range').hidden = !dates;
  setText('change-range', dates ? dateLabel(comparison.startDate) + ' → ' + dateLabel(comparison.endDate) : '');
}
function renderProgression() {
  if(!chartWorkspace)return;
  const model=chartWorkspace.render({analysis:current,state,selectedSession,onSelectSession:key=>selectSession(key,true)});
  renderChangeSummary(model);
  setText('chart-title',model.title);
  setText('chart-description',model.description);
  setText('plotted-count',model.countLabel);
  setText('line-note',model.lineNote);
  setText('summary-basis','Points and recorded-value cards use working-set workout '+(model.aggregate?'totals.':'averages.')+' '+(model.comparison.basis==='fitted'?'Fitted change compares the selected curve at its first and last fitted dates.':'First → latest compares the first and last plotted workouts.'));
}
function renderSurface(){
  if(!surfaceWorkspace)return;
  const loadAnalysis=analyze(state.exercise?records:[],{...state,metric:'load',minReps:0});
  surfaceWorkspace.render({analysis:loadAnalysis,state,selectedSession});
}
function renderContext() {
  const content=[];
  const add=(icon,title,body)=>content.push('<div class="context-item"><span class="context-icon" aria-hidden="true">'+icon+'</span><div><strong>'+escapeHtml(title)+'</strong><p>'+escapeHtml(body)+'</p></div></div>');
  if(current.rows.some(r=>r.is_pullup)) add('+',hasBodyweight()?'Bodyweight for these charts':'Bodyweight not set',hasBodyweight()?number(state.bodyweight,2)+' lb is used throughout. '+(state.metric==='volume'?'Volume uses bodyweight plus added load.':state.loadBasis==='total'?'Load and strength estimates include bodyweight plus added load.':'Load and strength estimates show added weight or its estimated equivalent.'):'Enter your bodyweight in Chart settings to calculate total load, strength estimates and volume. Reps and added-load views remain available.');
  else if(current.rows.some(r=>/Per dumbbell/i.test(r.load_basis||''))) add('1','Per dumbbell','Each listed load is for one dumbbell. The original unit and equipment assumptions remain in the set details.');
  else if(current.rows.some(r=>finite(r.hold_count))) add('×','Rounds, hangs and rest','Each round shows its hang pattern and active time. Rest is shown only where recorded, and is excluded from active hang time.');
  else if(current.rows.some(r=>finite(r.stack_setting))) add('#','Stack settings stay distinct','Numbered settings have no known pound conversion. Use Stack setting or Reps to explore what was recorded.');
  else add('•','Your workout details','Dates, reps, loads and notes remain available in the session log below.');
  if(state.metric==='strength') add('≈','A rep-adjusted comparison','Each workout averages its eligible set-by-set strength estimates. '+current.series.length+' workouts qualify; '+current.stats.excludedCount+' records are excluded and remain in the log.');
  else if(state.metric==='volume') add('∑','Known-load volume','Volume sums base reps × known load. Session totals may be partial when a weight is missing; inspect the selected session.');
  else add('↗',state.lineMode!=='connect'?'A fitted workout trend':'Workout averages over time',state.lineMode!=='connect'?'The fit follows the plotted workout averages with your chosen weighting. Volume and hold-time totals are fitted once per workout. Curves describe recorded training, not maximum capacity or future workouts.':'The solid line connects one point per workout. Hover, focus or tap a point to inspect the working sets behind its value.');
  add('✓','Working sets only','Warm-ups, failed attempts, practice and cool-down sets are excluded from graph values and fits. Their original entries remain in the session log.');
  const usefulNote=current.notes.find(note=>/unknown|assumption|assistance|Half-reps|Additional reps|no known/i.test(note));
  if(usefulNote) add('i','Context matters',usefulNote);
  $('context-content').innerHTML=content.join('');
}
function visibleRows() {
  let rows=current.rows.filter(row=>!selectedSession||sessionKey(row)===selectedSession);
  rows=[...rows].sort((a,b)=>{const direction=sortOrder==='newest'?-1:1;return direction*a.date.localeCompare(b.date)||direction*(a.session-b.session)||((a.source_type==='manual'||b.source_type==='manual')?(Number(a.set)-Number(b.set)):(a.source_row-b.source_row))});
  return rows;
}
function renderRecords() {
  const rows=visibleRows(), shown=rows.slice(0,rowLimit);
  const pullup=current.rows.some(r=>r.is_pullup);
  const session=current.sessions.find(s=>s.key===selectedSession);
  setText('records-title',session?'Session · '+dateLabel(session.date):'Session log');
  setText('records-count',rows.length+' records'+(session?' selected':''));
  setText('log-load-label',pullup?'Added load (lb)':'Load (lb)');
  $('records-body').innerHTML=shown.map(row=>{
    const hold=finite(row.duration_s)?describeHoldRecord(row):null;
    const reps=hold?escapeHtml(hold.primary)+'<span class="cell-sub">'+escapeHtml(hold.secondary)+'</span>':finite(row.reps)?number(row.reps):'—';
    const extra=finite(row.additional_reps)?'<span class="cell-sub">+ '+number(row.additional_reps)+' '+escapeHtml(row.additional_type||'extra reps')+'</span>':'';
    const side=[row.side,row.round?'round '+row.round:null].filter(Boolean).join(' · ');
    const load=finite(row.load_lb)?number(row.load_lb,2):finite(row.stack_setting)?'Setting '+number(row.stack_setting):'—';
    const loadSub=finite(row.stack_setting)?'mass unknown':row.is_pullup?(finite(row.effectiveLoad)?'total '+number(row.effectiveLoad,2)+' lb':'bodyweight not set'):/Per dumbbell/i.test(row.load_basis||'')?'per dumbbell':!finite(row.load_lb)?'no known lb load':'';
    const type=row.isWarmup?'Warm-up':row.set_type||'Work';
    const reason=row.eligibilityReason;
    const notes=[
      row.source_type==='manual' ? '<p><b>Added on site</b>'+(row.created_at?' · '+escapeHtml(new Intl.DateTimeFormat('en-CA',{dateStyle:'medium',timeStyle:'short'}).format(new Date(row.created_at))):'')+'</p><p class="record-id">'+escapeHtml(row.record_id)+'</p>' : '<p><b>'+escapeHtml(row.record_id)+'</b> · Source row '+row.source_row+'</p>',
      row.resistance_setup?'<p><b>Setup:</b> '+escapeHtml(row.resistance_setup)+'</p>':'',
      row.notes?'<p>'+escapeHtml(row.notes)+'</p>':'',
      reason?'<p><b>Chart:</b> '+escapeHtml(reason)+'</p>':finite(row.strengthEstimate)?'<p><b>Estimated strength:</b> '+number(row.strengthEstimate,2)+' lb</p>':'',
      row.date_basis?'<p><b>Date basis:</b> '+escapeHtml(row.date_basis)+'</p>':'',
      row.source_photo?'<p><b>Source:</b> '+escapeHtml(row.source_photo)+'</p>':''
    ].join('');
    return '<tr><td><button class="date-link" data-session="'+escapeHtml(sessionKey(row))+'">'+dateLabel(row.date)+'</button><span class="cell-sub">'+(row.source_type==='manual'?'Added on site':'Session '+row.session)+'</span></td><td>'+escapeHtml(row.set)+'<span class="cell-sub">'+escapeHtml(side)+'</span></td><td>'+reps+extra+'</td><td>'+load+'<span class="cell-sub">'+escapeHtml(loadSub)+'</span></td><td><span class="record-type'+(row.isWarmup?' warmup':'')+'">'+escapeHtml(type)+'</span></td><td><details class="row-details"><summary>'+escapeHtml(reason?'Notes & chart eligibility':'Set details')+'</summary><div>'+notes+'</div></details></td><td class="record-actions-cell"><button class="delete-record" data-delete-record="'+escapeHtml(row.record_id)+'" aria-label="Delete set '+escapeHtml(row.set)+' from '+escapeHtml(dateLabel(row.date))+'"'+(archiveLoaded?'':' disabled')+'>Delete</button></td></tr>';
  }).join('');
  $('records-body').querySelectorAll('[data-session]').forEach(button=>button.addEventListener('click',()=>selectSession(button.dataset.session)));
  $('records-body').querySelectorAll('[data-delete-record]').forEach(button=>button.addEventListener('click',()=>{const row=records.find(item=>item.record_id===button.dataset.deleteRecord);if(row)deletionManager.deleteRows([row]);}));
  $('delete-session').hidden=!session;
  $('delete-session').disabled=!archiveLoaded;
  $('open-deleted').disabled=!archiveLoaded;
  $('open-deleted-empty').disabled=!archiveLoaded;
  setText('open-deleted','Deleted entries'+(deletions.length?' ('+new Set(deletions.flatMap(item=>item.recordIds)).size+')':''));
  renderRepeaterSummary(rows);
  $('log-empty').hidden=rows.length>0;
  $('show-more').hidden=rows.length<=rowLimit;
  setText('table-status',rows.length?'Showing '+Math.min(rowLimit,rows.length)+' of '+rows.length+' records. Warm-ups, failed sets and extra reps remain visible here.':'No workout records in this view.');
}
function exportCsv(all = false) {
  if(!archiveLoaded){announce('Load your saved history before exporting records.');return;}
  const rows=all ? records.map(row=>({...row,effectiveLoad:row.is_pullup?(hasBodyweight()&&finite(row.load_lb)?state.bodyweight+row.load_lb:null):row.load_lb,source_type:row.source_type||'transcribed'})).sort((a,b)=>a.date.localeCompare(b.date)||a.exercise.localeCompare(b.exercise)||(a.set-b.set)) : visibleRows();
  const columns=[['Date','date'],['Session','session'],['Exercise','exercise'],['Category','category'],['Set','set'],['Reps','reps'],['Load or added load (lb)','load_lb'],['Total effective load (lb)','effectiveLoad'],['Stack setting','stack_setting'],['Extra reps','additional_reps'],['Extra type','additional_type'],['Hold (s)','duration_s'],['Hold count','hold_count'],['Rest between hangs (s)','rest_s'],['Rest between rounds (s)','round_rest_s'],['Tracking','tracking'],['Side','side'],['Round','round'],['Set type','set_type'],['Resistance / setup','resistance_setup'],['Notes','notes'],['Chart eligibility','eligibilityReason'],['Record ID','record_id'],['Entry ID','entry_id'],['Source type','source_type'],['Added at','created_at'],['Source row','source_row'],['Date basis','date_basis'],['Source photo','source_photo']];
  const csvCell=value=>{let str=String(value??'');if(typeof value==='string'&&/^[=+\-@]/.test(str))str="'"+str;return '"'+str.replace(/"/g,'""')+'"'};
  const csv='\uFEFF'+columns.map(c=>csvCell(c[0])).join(',')+'\r\n'+rows.map(row=>columns.map(c=>csvCell(row[c[1]])).join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'}));
  const link=document.createElement('a');link.href=url;link.download=all?'training-complete-history.csv':'training-'+(state.exercise||'empty-history').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')+'.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  announce(rows.length+' records exported.');
}
function rebuildArchive(preferredExercise = null, revealPreferred = false) {
  const nextSet = new Map();
  originalRecords.forEach(row=>{const key=row.date+'__'+row.exercise;nextSet.set(key,Math.max(nextSet.get(key)||0,Number(row.set)||0))});
  const added=savedEntries.slice().sort((a,b)=>(a.created_at||'').localeCompare(b.created_at||'')||a.id.localeCompare(b.id)).flatMap(entry=>(entry.records||[]).map(row=>{
    const key=row.date+'__'+row.exercise, set=(nextSet.get(key)||0)+1;
    nextSet.set(key,set);
    return {...row,set,entry_id:entry.id,source_type:'manual',load_mode:row.load_mode||entry.loadMode,created_at:row.created_at||entry.created_at};
  }));
  allRecords=[...originalRecords,...added];
  const deletedIds=new Set(deletions.flatMap(item=>item.recordIds));
  records=allRecords.filter(row=>!deletedIds.has(row.record_id));
  catalog=buildCatalog(records);
  libraryPartition=splitCatalog(catalog,getTrainingToday());
  byName=new Map(catalog.map(item=>[item.name,item]));
  if(category!=='all'&&!catalog.some(item=>item.category===category))category='all';
  const dates=records.map(r=>r.date).filter(Boolean).sort();
  defaults.from=dates[0]||getTrainingToday();
  defaults.to=dates.at(-1)||getTrainingToday();
  if(state.period==='all'){state.from=defaults.from;state.to=defaults.to;}
  if(preferredExercise&&byName.has(preferredExercise)){state.exercise=preferredExercise;if(revealPreferred&&libraryPartition.archived.some(item=>item.name===preferredExercise))state.showArchived=true;}
  state.exercise=chooseLibraryExercise(state.exercise,libraryPartition,state.showArchived);
  if(!byName.get(state.exercise)?.metrics.includes(state.metric)) state.metric=byName.get(state.exercise)?.defaultMetric||'reps';
  const years=[...new Set(dates.map(d=>d.slice(0,4)))];
  $('date-shortcuts').innerHTML='<button data-period="all" aria-pressed="false">All time</button>'+years.map(year=>'<button data-period="'+year+'" aria-pressed="false">'+year+'</button>').join('');
  const sessions=new Set(records.map(sessionKey)).size;
  setText('archive-count',number(records.length,0)+' records · '+sessions+' sessions');
  const rangeFmt=new Intl.DateTimeFormat('en-CA',{month:'short',year:'numeric',timeZone:'UTC'});
  setText('archive-range',dates.length?rangeFmt.format(new Date(defaults.from+'T12:00:00Z')).toUpperCase()+' — '+rangeFmt.format(new Date(defaults.to+'T12:00:00Z')).toUpperCase():'No workouts yet');
  setText('archive-footer',records.length?number(records.length,0)+' strength records across '+catalog.length+' exercises':'Your training history begins with your first workout.');
  populateLibrary();
  calendar?.refreshRecords();
}
function setSavedStatus(message, failed = false, busy = false) {
  setText('saved-status-text',message);
  $('saved-status').classList.toggle('failed',failed);
  $('saved-status').classList.toggle('loading',busy);
  $('retry-entries').hidden=!failed;
  $('retry-entries').disabled=busy;
}
async function loadEntries(initial = false) {
  if(loadingEntries)return;
  loadingEntries=true;
  const revision=entryRevision,controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
  setSavedStatus('Loading saved history…',false,true);
  try {
    const responses=await Promise.all(['/api/workouts','/api/record-deletions'].map(url=>fetch(url,{cache:'no-store',headers:{Accept:'application/json'},signal:controller.signal})));
    if(responses.some(response=>!response.ok))throw new Error('Could not load your saved history.');
    const [body,removed]=await Promise.all(responses.map(response=>response.json()));
    if(!Array.isArray(body.entries)||!Array.isArray(removed.deletions))throw new Error('The history response was incomplete.');
    if(revision!==entryRevision)return;
    savedEntries=body.entries;
    deletions=removed.deletions;
    archiveLoaded=true;
    $('export-all').disabled=false;
    $('export-csv').disabled=false;
    $('export-all').title='Download your complete active workout history';
    rebuildArchive(initial&&!userChoseExercise?saved.exercise:null);
    render();
    setSavedStatus(records.length?'Saved history up to date · '+records.length+' active records':'Ready to log · no strength records yet');
  } catch(error) {
    if(revision===entryRevision)setSavedStatus(archiveLoaded?'Couldn’t refresh saved history. Showing the last loaded version.':'Couldn’t load your saved history. Retry to show your records; export and deletion are paused until loading succeeds.',true);
  } finally {clearTimeout(timer);loadingEntries=false;if(revision!==entryRevision)loadEntries();}
}
function showSaveToast(message, action = null) {
  toastAction=action;
  setText('save-toast-message',message);
  $('undo-entry').hidden=!action;
  $('undo-entry').textContent=action?.label||'Undo';
  $('undo-entry').disabled=false;
  $('save-toast').hidden=false;
  announce(message);
}
function handleEntrySaved(entry) {
  entryRevision++;
  savedEntries=[...savedEntries.filter(e=>e.id!==entry.id),entry];
  state.period='all';state.side='all';state.minReps=0;
  search='';category='all';$('exercise-search').value='';
  selectedSession='';rowLimit=25;userChoseExercise=true;
  rebuildArchive(entry.exercise,true);
  state.metric=byName.get(entry.exercise)?.defaultMetric||'reps';
  render();
  setSavedStatus('Saved · '+dateLabel(entry.date));
  showSaveToast(entry.tracking==='repeaters'?'Repeater workout saved for '+entry.exercise+'.':entry.records.length+' '+(entry.records.length===1?'set':'sets')+' saved for '+entry.exercise+'.',{label:'Undo save',run:()=>deletionManager.deleteRows(entry.records,{confirm:false})});
  loadEntries();
}
function updateDeletion(deletion,restore=false){
  entryRevision++;
  deletions=deletions.filter(item=>item.id!==deletion.id);
  if(!restore)deletions.push(deletion);
  selectedSession='';rebuildArchive();render();
  setSavedStatus('Saved history up to date.');
  loadEntries();
}
async function runToastAction(){
  if(!toastAction)return;
  const action=toastAction;$('undo-entry').disabled=true;
  try{await action.run()}finally{if(toastAction===action)$('undo-entry').disabled=false;}
}
function showView(view){
  state.view=['history','calendar','climbing','kilter','hangboard'].includes(view)?view:'history';
  const climbingView=['climbing','kilter','hangboard'].includes(state.view);
  for(const name of ['history','calendar','climbing','kilter','hangboard'])$(name+'-view').hidden=state.view!==name;
  $('export-csv').hidden=state.view!=='history';
  $('saved-status').hidden=climbingView;
  $('archive-range').hidden=climbingView;
  document.querySelector('.page-footer').hidden=climbingView;
  document.querySelector('.app-shell').classList.toggle('climbing-layout',climbingView);
  setText('header-entry-label',state.view==='hangboard'?'New hangboard workout':state.view==='kilter'?'New Kilter workout':state.view==='climbing'?'New climbing workout':'Log exercise');
  document.querySelectorAll('[data-view]').forEach(button=>{const active=button.dataset.view===state.view;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;});
  if(state.view!=='history'){chartWorkspace?.close();surfaceWorkspace?.close();}
  if(state.view==='calendar')calendar?.activate();
  else if(state.view==='climbing')climbingTracker?.activate();
  else if(state.view==='kilter')kilterTracker?.activate();
  else if(state.view==='hangboard')hangboardTracker?.activate();
  else {if(current){renderProgression();renderSurface();}if(archiveLoaded)loadEntries();}
  persist();
}
function inspectCalendarDay(date,exercise){
  if(exercise&&byName.has(exercise)){userChoseExercise=true;state.exercise=exercise;if(libraryPartition.archived.some(item=>item.name===exercise))state.showArchived=true;populateLibrary();}
  const item=byName.get(state.exercise);
  if(item&&!item.metrics.includes(state.metric))state.metric=item.defaultMetric;
  state.from=date;state.to=date;state.period='custom';state.side='all';selectedSession='';rowLimit=50;
  showView('history');render();$('records').scrollIntoView({block:'start',behavior:'smooth'});
}
function renderRepeaterSummary(rows){renderRepeaterRounds($('repeater-summary'),rows,{dateLabel});}
function applyDateInputs() {
  const from=$('date-from').value||defaults.from,to=$('date-to').value||defaults.to;
  $('date-error').hidden=from<=to;
  if(from>to)return;
  state.from=from;state.to=to;state.period='custom';selectedSession='';rowLimit=25;render();
}
function bindEvents() {
  $('export-csv').disabled=!archiveLoaded;
  document.querySelectorAll('[data-show-archived]').forEach(input=>input.addEventListener('change',event=>setArchiveVisibility(event.target.checked)));
  $('reveal-archive').addEventListener('click',()=>setArchiveVisibility(true));
  $('exercise-search').addEventListener('input',event=>{search=event.target.value.trim().toLowerCase();renderLibrary()});
  $('category-filter').addEventListener('change',event=>{category=event.target.value;renderLibrary()});
  $('mobile-exercise').addEventListener('change',event=>chooseExercise(event.target.value));
  $('date-shortcuts').addEventListener('click',event=>{const button=event.target.closest('[data-period]');if(!button)return;const p=button.dataset.period;state.period=p;state.from=p==='all'?defaults.from:p+'-01-01';state.to=p==='all'?defaults.to:p+'-12-31';$('date-error').hidden=true;selectedSession='';rowLimit=25;render()});
  $('date-from').addEventListener('change',applyDateInputs);$('date-to').addEventListener('change',applyDateInputs);
  for(const [id,key,transform] of [['line-mode','lineMode',v=>v],['fit-weight','fitWeight',v=>v],['method','method',v=>v],['rep-cap','repCap',Number],['load-basis','loadBasis',v=>v],['min-reps','minReps',Number],['side-filter','side',v=>v]]){
    $(id).addEventListener('change',event=>{state[key]=transform(event.target.value);selectedSession='';rowLimit=25;render()});
  }
  $('fit-smoothing').addEventListener('input',event=>{state.fitSmoothing=Number(event.target.value)/100;syncControls();persist();renderProgression();});
  const updateBodyweight = event=>{const raw=event.target.value.trim(),value=Number(raw),valid=raw===''||Number.isFinite(value)&&value>=1&&value<=1000;$('settings-error').hidden=valid;if(!valid)return;state.bodyweight=raw===''?null:value;render()};
  $('set-bodyweight').addEventListener('click',()=>{$('chart-settings').open=true;$('chart-settings').scrollIntoView({block:'nearest',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});$('bodyweight').focus();});
  $('bodyweight').addEventListener('input',updateBodyweight);
  $('bodyweight').addEventListener('change',updateBodyweight);
  $('reset-settings').addEventListener('click',()=>{for(const key of ['method','bodyweight','repCap','includeWarmups','loadBasis','minReps','side','pointsMode','lineMode','fitWeight','fitSmoothing','surfaceFit','surfaceSmoothing','surfaceAxis'])state[key]=defaults[key];$('settings-error').hidden=true;selectedSession='';render()});
  $('session-select').addEventListener('change',event=>{selectedSession=event.target.value;rowLimit=25;$('clear-session').hidden=!selectedSession;renderProgression();renderSurface();renderRecords()});
  $('clear-session').addEventListener('click',()=>{selectedSession='';$('session-select').value='';$('clear-session').hidden=true;rowLimit=25;renderProgression();renderSurface();renderRecords()});
  $('sort-order').addEventListener('change',event=>{sortOrder=event.target.value;renderRecords()});
  $('show-more').addEventListener('click',()=>{rowLimit+=25;renderRecords()});
  $('export-csv').addEventListener('click',()=>exportCsv(false));
  $('export-all').addEventListener('click',()=>exportCsv(true));
  $('open-entry').addEventListener('click',()=>{if(state.view==='climbing')climbingTracker.openNew();else if(state.view==='kilter')kilterTracker.openNew();else if(state.view==='hangboard')hangboardTracker.openNew();else entryForm.open(state.exercise);});
  document.querySelectorAll('[data-empty-log]').forEach(button=>button.addEventListener('click',()=>{const view=button.dataset.emptyLog;showView(view);if(view==='history')entryForm.open('');else if(view==='climbing')climbingTracker.openNew();else if(view==='kilter')kilterTracker.openNew();else if(view==='hangboard')hangboardTracker.openNew();}));
  $('empty-calendar').addEventListener('click',()=>showView('calendar'));
  $('retry-entries').addEventListener('click',()=>loadEntries());
  $('dismiss-toast').addEventListener('click',()=>{$('save-toast').hidden=true});
  $('undo-entry').addEventListener('click',runToastAction);
  $('open-deleted').addEventListener('click',()=>deletionManager.openTrash());
  $('open-deleted-empty').addEventListener('click',()=>deletionManager.openTrash());
  $('delete-session').addEventListener('click',()=>deletionManager.deleteRows(records.filter(row=>row.exercise===state.exercise&&sessionKey(row)===selectedSession)));
  const viewTabs=Array.from(document.querySelectorAll('[data-view]'));
  viewTabs.forEach((button,index)=>{button.addEventListener('click',()=>showView(button.dataset.view));button.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?viewTabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+viewTabs.length)%viewTabs.length;showView(viewTabs[next].dataset.view);viewTabs[next].focus();});});
  window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{renderProgression();hideTooltip()},100)});
  window.addEventListener('scroll',hideTooltip,{passive:true});
  document.addEventListener('keydown',event=>{if(event.key==='Escape')hideTooltip()});
}
rebuildArchive();
chartWorkspace=createChartWorkspace({panel:$('progression-panel'),host:$('main-chart'),tooltipEl:$('chart-tooltip')});
surfaceWorkspace=createSurfaceWorkspace({host:$('surface-panel'),onStateChange:patch=>{Object.assign(state,patch);syncControls();persist();renderProgression();renderSurface();},onInspectSession:key=>selectSession(key,true)});
entryForm=createEntryForm({getRecords:()=>records,getCatalog:()=>catalog,onSaved:handleEntrySaved});
deletionManager=createDeletionManager({getAllRecords:()=>allRecords,getDeletions:()=>deletions,isReady:()=>archiveLoaded,onDeleted:deletion=>updateDeletion(deletion),onRestored:deletion=>updateDeletion(deletion,true),onNotify:showSaveToast});
calendar=createCalendar({host:$('calendar-view'),getRecords:()=>records,getCatalog:()=>catalog,isHistoryReady:()=>archiveLoaded,onLogExercise:(name,date)=>entryForm.open(name||state.exercise,{date}),onInspectDate:inspectCalendarDay,announce});
climbingTracker=createClimbingTracker({host:$('climbing-view'),kind:'climbing',announce});
kilterTracker=createClimbingTracker({host:$('kilter-view'),kind:'kilter',announce});
hangboardTracker=createHangboardTracker({host:$('hangboard-view'),announce});
bindEvents();
render();
showView(state.view);
loadEntries(true);
calendar.load();
