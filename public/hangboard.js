import { HANGBOARD_PROTOCOLS, normalizeHangboardWorkout, summarizeHangboardWorkout, formatHangboardPattern, upgradeHangboardWorkout, splitHangboardCycle, mergeHangboardCycle } from './hangboard-model.js';
import { getTrainingToday } from './exercise-archive.js';
import { summarizeMaxHangs } from './hangboard-analytics-model.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clone=value=>JSON.parse(JSON.stringify(value));
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const n=value=>new Intl.NumberFormat('en-CA',{maximumFractionDigits:3}).format(value);
const num=value=>value===''||value==null?null:Number(value);
const dateLabel=value=>new Intl.DateTimeFormat('en-CA',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(value+'T12:00:00Z'));
const protocolInfo=id=>HANGBOARD_PROTOCOLS.find(p=>p.id===id);
const HANDS=[['unspecified','Not recorded'],['both','Both hands'],['left','Left hand'],['right','Right hand']];
const LOADS=[['bodyweight','Bodyweight'],['added','Added weight'],['assisted','Assistance'],['absolute','Recorded load (no-hang)'],['unknown','Not recorded']];
const RESULTS=[['unknown','Not recorded'],['completed','Completed'],['partial','Partial'],['failed','Failed']];
function uuid(){if(crypto.randomUUID)return crypto.randomUUID();const b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const s=[...b].map(v=>v.toString(16).padStart(2,'0')).join('');return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;}
const seconds=value=>finite(value)?n(value)+' s':'Not recorded';
const duration=value=>!finite(value)?'Not recorded':value<60?n(value)+' s':[Math.floor(value/60)+' min',value%60?n(value%60)+' s':''].filter(Boolean).join(' ');
const durationParts=value=>{if(!finite(value))return {minutes:'',seconds:''};const remainder=value%60,rounded=Number(remainder.toFixed(9));return {minutes:String(Math.floor(value/60)),seconds:String(rounded<60?rounded:remainder)};};
const displayedNote=value=>String(value??'').replace(/\r\n?/g,'\n');
const gripLabel=set=>[set.grip||'Grip / hold not recorded',finite(set.edgeMm)?n(set.edgeMm)+' mm':''].filter(Boolean).join(' · ');
const loadLabel=set=>set.loadMode==='bodyweight'?'Bodyweight':set.loadMode==='added'?finite(set.loadLb)?'+'+n(set.loadLb)+' lb added':'Added weight not recorded':set.loadMode==='assisted'?finite(set.loadLb)?n(set.loadLb)+' lb assistance':'Assistance not recorded':set.loadMode==='absolute'?finite(set.loadLb)?n(set.loadLb)+' lb recorded':'Load not recorded':'Load not recorded';
const pattern=(set,protocol)=>set.segments?.every(s=>finite(s.seconds)&&finite(s.count))?formatHangboardPattern(set,protocol):protocol==='repeaters'?'Enter actual hangs and seconds':'Enter actual hold duration';
const optional='<span class="hang-optional">optional</span>';
const setKind=set=>set.isWarmup?'Warm-up':set.status==='unknown'?'Working set':RESULTS.find(([value])=>value===set.status)?.[1]||'Working set';

/** Hangboard history is stored separately from strength and climbing records. */
export function createHangboardTracker({host,announce=()=>{},onSaved=()=>{}}){
  let filter='all';try{filter=localStorage.getItem('training-hangboard-protocol')||'all';}catch{}
  if(filter!=='all'&&!protocolInfo(filter))filter='all';
  let dateFilter='',search='',showDeleted=false,workouts=[],deletedWorkouts=[];
  let loaded=false,loading=false,loadPromise=null,writeRevision=0,actionPending=false,lastDeleted=null,loadFailed=false;
  let scoreMeasurement='hang',scoreCondition='',scoreConditionLabel='';
  let draft=null,dirty=false,saving=false,initialFocus=null;
  const bulkRestDrafts=new Map();
  const abort=new AbortController(),events={signal:abort.signal},q=selector=>host.querySelector(selector);
  const persist=()=>{try{localStorage.setItem('training-hangboard-protocol',filter);}catch{}};
  host.classList.add('hangboard-tracker');
  host.innerHTML=`
    <header class="hang-heading"><div><span class="eyebrow">FINGER TRAINING</span><h2>Hangboard</h2><p>Keep the grip, load and hang / rest pattern together, cycle by cycle.</p></div><button type="button" class="button hang-primary" data-hang-new disabled>＋ New workout</button></header>
    <section class="hang-protocol-panel" aria-label="Hangboard protocols"><div class="hang-protocol-filter" role="group" aria-label="Filter hangboard protocol"><button type="button" data-hang-protocol="all">All workouts</button>${HANGBOARD_PROTOCOLS.map(p=>`<button type="button" data-hang-protocol="${p.id}">${esc(p.label)}</button>`).join('')}</div><div class="hang-protocol-explainer"><p><strong>Repeaters</strong><span>Short hangs grouped into sets and cycles, with each rest recorded separately.</span></p><p><strong>Max hangs</strong><span>One measured hold per set, with rest before the next set.</span></p></div></section>
    <div class="hang-status" role="status"><span data-hang-status>Load your saved hangboard workouts to begin.</span><button type="button" class="text-button" data-hang-retry hidden>Retry</button></div>
    <div class="hang-notice" role="status" hidden><span data-hang-notice></span><button type="button" class="text-button" data-hang-undo hidden>Undo delete</button><button type="button" class="hang-icon-button" data-hang-dismiss aria-label="Dismiss hangboard message">×</button></div>
    <div class="hang-history-heading"><div><span class="eyebrow">WORKOUT HISTORY</span><h3 data-hang-history-title>All workouts</h3><p data-hang-history-count></p></div><button type="button" class="text-button" data-hang-toggle-deleted aria-pressed="false">Deleted workouts</button></div>
    <div class="hang-filters"><label>Date<input type="date" data-hang-filter-date aria-label="Filter hangboard date"></label><label>Find a workout or grip<input type="search" data-hang-search placeholder="Grip, hold, location or notes…"></label><button type="button" class="text-button" data-hang-clear>Clear filters</button></div>
    <section class="hang-analytics" data-hang-analytics aria-labelledby="hang-analytics-title"></section>
    <div class="hang-workout-list" data-hang-workouts></div>
    <dialog class="hang-dialog" aria-labelledby="hangboard-editor-title"><form class="hang-editor-form" data-hang-form>
      <header class="hang-dialog-heading"><div><span class="eyebrow">HANGBOARD WORKOUT</span><h2 id="hangboard-editor-title">New workout</h2><p data-hang-editor-subtitle>Choose a protocol, then record each grip and set.</p></div><button type="button" class="hang-icon-button" data-hang-close aria-label="Close hangboard workout">×</button></header>
      <div class="hang-form-scroll"><fieldset class="hang-form-content">
        <div class="hang-basics"><label>Date<input type="date" data-hang-work-field="date" required></label><label>Protocol<select data-hang-work-field="protocol">${HANGBOARD_PROTOCOLS.map(p=>`<option value="${p.id}">${esc(p.label)}</option>`).join('')}</select></label><label>Workout name ${optional}<input data-hang-work-field="title" maxlength="120" placeholder="e.g. Evening finger session"></label><label>Board / location ${optional}<input data-hang-work-field="location" maxlength="160" list="hangboard-location-options" placeholder="e.g. Home board"></label></div>
        <p class="hang-protocol-lock" data-hang-protocol-lock></p><datalist id="hangboard-location-options"></datalist><datalist id="hangboard-grip-options"></datalist>
        <details class="hang-session-details"><summary>Bodyweight & workout notes <span>optional</span></summary><div><label>Bodyweight for this workout <span class="hang-unit">lb</span><input type="number" data-hang-work-field="bodyweightLb" min="0.001" max="1000" step="any" placeholder="Leave blank if unknown"><small data-hang-bodyweight-help>Stored with this workout; no bodyweight is assumed.</small></label><label>Workout notes<textarea data-hang-work-field="notes" maxlength="4000" rows="3" placeholder="Session focus, how it felt, anything to remember…"></textarea></label></div></details>
        <section class="hang-set-section" aria-label="Hangboard sets"><div class="hang-set-heading"><div><h3 data-hang-set-title>Repeater sets</h3><p data-hang-set-help></p></div><span data-hang-set-count>0 sets</span></div><div data-hang-sets></div><div class="hang-add-actions"><button type="button" class="button button-outline hang-add-set" data-hang-add-set data-hang-global-add>＋ Add set</button><button type="button" class="button button-outline hang-add-set" data-hang-add-cycle>＋ Add cycle</button></div></section>
      </fieldset></div>
      <div class="hang-form-error" role="alert" hidden><span data-hang-form-error></span><button type="button" class="text-button" data-hang-reload-draft hidden>Reload latest workout</button></div>
      <footer class="hang-dialog-footer"><span data-hang-save-hint>Rest is recorded separately from active hang time.</span><div><button type="button" class="button button-outline" data-hang-cancel>Cancel</button><button type="submit" class="button hang-primary" data-hang-save>Save workout</button></div></footer>
    </form></dialog>`;
  const dialog=q('.hang-dialog'),form=q('[data-hang-form]');
  function focusBack(){if(initialFocus?.isConnected&&!initialFocus.closest('[hidden]'))initialFocus.focus();else q('[data-hang-new]')?.focus();}
  function setStatus(message,error=false){q('[data-hang-status]').textContent=message;q('[data-hang-retry]').hidden=!error;q('.hang-status').classList.toggle('hang-error',error);host.querySelectorAll('[data-hang-new]').forEach(b=>b.disabled=!loaded||loading||actionPending);}
  function notice(message,error=false){q('[data-hang-notice]').textContent=message;q('.hang-notice').hidden=!message;q('.hang-notice').classList.toggle('hang-error',error);q('[data-hang-undo]').hidden=!lastDeleted;q('[data-hang-undo]').disabled=actionPending;announce(message);}
  function filtered(rows){return rows.filter(w=>(filter==='all'||w.protocol===filter)&&(!dateFilter||w.date===dateFilter)&&(!search||[w.title,w.location,w.notes,...w.sets.flatMap(s=>[s.grip,s.setup,s.notes])].join(' ').toLocaleLowerCase().includes(search.toLocaleLowerCase()))).sort((a,b)=>b.date.localeCompare(a.date)||String(b.created_at).localeCompare(String(a.created_at)));}
  function render(){
    host.querySelectorAll('[data-hang-protocol]').forEach(b=>{const selected=b.dataset.hangProtocol===filter;b.setAttribute('aria-pressed',String(selected));b.classList.toggle('active',selected);});
    const source=showDeleted?deletedWorkouts:workouts,rows=filtered(source),total=source.filter(w=>filter==='all'||w.protocol===filter).length;
    q('[data-hang-history-title]').textContent=(showDeleted?'Deleted · ':'')+(protocolInfo(filter)?.label||'All workouts');
    q('[data-hang-history-count]').textContent=loaded?`${rows.length} of ${total} ${total===1?'workout':'workouts'}${showDeleted?' · recoverable':' saved'}`:'Your saved history will appear here.';
    q('[data-hang-toggle-deleted]').textContent=showDeleted?'Back to workouts':`Deleted workouts${deletedWorkouts.length?' ('+deletedWorkouts.length+')':''}`;q('[data-hang-toggle-deleted]').setAttribute('aria-pressed',String(showDeleted));
    q('[data-hang-filter-date]').value=dateFilter;q('[data-hang-search]').value=search;
    renderAnalytics(rows);
    q('[data-hang-workouts]').innerHTML=rows.length?rows.map(renderWorkout).join(''):`<div class="hang-empty"><span class="hang-empty-symbol" aria-hidden="true">▥</span><h3>${!loaded?'Your hangboard history':showDeleted?'No deleted workouts':source.length?'No matching workouts':'Your first '+(protocolInfo(filter)?.label.toLowerCase()||'hangboard')+' workout'}</h3><p>${!loaded?'Load your saved history to start logging.':showDeleted?'Deleted hangboard workouts can be restored here.':source.length?'Try another protocol, date or search.':'Create a dated workout, choose Repeaters or Max hangs, then add your sets. You can also save an empty workout and fill it in later.'}</p>${loaded&&!showDeleted&&!source.length?'<button type="button" class="button hang-primary" data-hang-new>＋ Create workout</button>':''}</div>`;
    host.querySelectorAll('[data-hang-new]').forEach(b=>b.disabled=!loaded||loading||actionPending);
  }
  function renderAnalytics(rows){
    const panel=q('[data-hang-analytics]');panel.hidden=showDeleted||filter==='repeaters';
    if(panel.hidden)return;
    const available=summarizeMaxHangs(rows,{measurement:scoreMeasurement});
    const selectedCondition=available.conditions.find(condition=>condition.key===scoreCondition);
    if(selectedCondition)scoreConditionLabel=selectedCondition.label;
    const noMatchingSetup=!!scoreCondition&&!selectedCondition;
    const conditionOptions=noMatchingSetup?[{key:scoreCondition,label:(scoreConditionLabel||'Selected setup')+' — no matching holds'},...available.conditions]:available.conditions;
    const summary=scoreCondition?summarizeMaxHangs(rows,{measurement:scoreMeasurement,conditionKey:scoreCondition}):available,best=summary.best;
    const label=scoreMeasurement==='no_hang'?'No-hang score':'Max hang score';
    const reasons=[
      ['missing_bodyweight','missing workout bodyweight'],['not_completed','result not marked Completed'],
      ['unknown_load','load not recorded'],['invalid_load','load cannot be scored'],
      ['invalid_duration','single-hold duration missing or invalid'],['warmup','warm-up'],['unknown_warmup','warm-up status not recorded'],
    ].filter(([key])=>summary.excluded[key]).map(([key,label])=>`${n(summary.excluded[key])} ${label}`);
    const loadText=best?`${n(best.loadLb)} lb × ${n(best.seconds)} s`:'';
    const detail=best?best.loadMode==='added'?`${n(best.bodyweightLb)} lb bodyweight + ${n(best.addedWeightLb)} lb added`:best.loadMode==='assisted'?`${n(best.bodyweightLb)} lb bodyweight − ${n(best.assistanceLb)} lb assistance`:best.loadMode==='absolute'?'Recorded no-hang load':`${n(best.bodyweightLb)} lb recorded bodyweight`:'';
    panel.innerHTML=`<header class="hang-analytics-heading"><div><span class="eyebrow">MAX-HANG ANALYTICS</span><h3 id="hang-analytics-title">Load and time, together</h3><p>Follows the date and search filters above. Repeaters are excluded.</p></div><div class="hang-analytics-controls"><label>Measurement<select data-hang-score-measurement aria-label="Hangboard analytics measurement"><option value="hang" ${scoreMeasurement==='hang'?'selected':''}>Max hangs</option><option value="no_hang" ${scoreMeasurement==='no_hang'?'selected':''}>No-hang loads · separate</option></select></label><label>Compare a recorded setup<select data-hang-score-condition aria-label="Max hang analytics setup"><option value="">All recorded setups</option>${conditionOptions.map(condition=>`<option value="${esc(condition.key)}" ${condition.key===scoreCondition?'selected':''}>${esc(condition.label)}</option>`).join('')}</select></label></div></header>
      ${loadFailed?`<p class="hang-score-warning">${loaded?'The latest refresh failed. These are the last successfully loaded records; use Retry above.':'Saved max hangs are unavailable. Use Retry above to load them.'}</p>`:''}
      <div class="hang-score-summary"><div class="hang-score-card"><span>${label}</span><strong>${loaded&&best?n(best.score):'—'} <small>lb·s</small></strong><p>Best single completed working hold${best?' · '+esc(dateLabel(best.date)):''}</p></div><div class="hang-score-breakdown"><strong>${loaded&&best?esc(loadText):loaded?noMatchingSetup?'No holds for the selected setup':'No score available yet':'Loading saved max hangs…'}</strong><p>${loaded&&best?esc(detail):noMatchingSetup?'Your setup selection is retained. Change the date or search filters, or choose All recorded setups.':'Record actual hold time, known load and a Completed result. Bodyweight hangs also need bodyweight saved with that workout.'}</p>${best?`<p>${esc(best.conditionLabel)}</p>`:''}</div></div>
      <p class="hang-score-method">Score = supported load in lb × actual hold seconds. This is a descriptive load–time score; it does not estimate maximal strength. Higher load and longer time both raise it. Compare the same grip, edge, hands and setup. Current profile weight is never substituted for missing workout bodyweight.</p>
      ${summary.mixedConditions?'<p class="hang-score-warning">Multiple recorded setups are visible. Choose one setup for a consistent series; the overall best score alone does not establish improvement.</p>':''}
      ${summary.conditionsIncomplete?'<p class="hang-score-warning">Some scored holds lack grip, edge, hands or board/location details. Matching missing details does not establish the same setup.</p>':''}
      ${reasons.length?`<p class="hang-score-exclusions">Excluded from this score: ${esc(reasons.join(' · '))}.</p>`:''}
      <div class="hang-score-trend"><h4>Best score by workout and setup</h4><p>Each point is one workout’s best scored hold for its recorded setup.${summary.mixedConditions?' Different setups remain separate points.':''}</p>${renderScoreTrend(summary)}</div>`;
  }
  function renderScoreTrend(summary){
    const rows=summary.byWorkout;
    if(!loaded||!rows.length)return '<div class="hang-score-empty">No scored holds in this view. Missing information stays unknown, rather than appearing as zero.</div>';
    const width=760,height=220,left=72,right=22,top=24,bottom=42;
    const first=Date.parse(rows[0].date+'T12:00:00Z'),last=Date.parse(rows.at(-1).date+'T12:00:00Z');
    const maximum=Math.max(...rows.map(row=>row.score))*1.12;
    const x=row=>first===last?(width+left-right)/2:left+(Date.parse(row.date+'T12:00:00Z')-first)/(last-first)*(width-left-right);
    const y=row=>height-bottom-row.score/maximum*(height-top-bottom);
    const number=value=>Number(value.toFixed(2));
    const guides=[0,.25,.5,.75,1].map(fraction=>{const value=maximum*fraction,yy=number(height-bottom-fraction*(height-top-bottom));return `<line x1="${left}" x2="${width-right}" y1="${yy}" y2="${yy}" class="hang-score-grid"/><text x="${left-10}" y="${yy+4}" text-anchor="end">${n(Math.round(value))}</text>`;}).join('');
    const line=!summary.mixedConditions&&!summary.conditionsIncomplete&&rows.length>1?`<polyline points="${rows.map(row=>`${number(x(row))},${number(y(row))}`).join(' ')}" class="hang-score-line"/>`:'';
    const dots=rows.map(row=>`<circle cx="${number(x(row))}" cy="${number(y(row))}" r="5" class="hang-score-dot"><title>${esc(dateLabel(row.date)+' · '+n(row.score)+' lb·s · '+n(row.best.loadLb)+' lb × '+n(row.best.seconds)+' s · '+row.conditionLabel)}</title></circle>`).join('');
    const dates=`<text x="${left}" y="${height-12}" text-anchor="start">${esc(dateLabel(rows[0].date))}</text>${first!==last?`<text x="${width-right}" y="${height-12}" text-anchor="end">${esc(dateLabel(rows.at(-1).date))}</text>`:''}`;
    return `<div class="hang-score-chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Best recorded max-hang score by workout; exact values and setups are available in the table below."><text x="${left}" y="14">lb·s</text>${guides}${line}${dots}${dates}</svg></div><details class="hang-score-table"><summary>View exact scores and setups (${rows.length})</summary><div><table><caption class="sr-only">Max-hang scores by workout and recorded setup</caption><thead><tr><th>Date</th><th>Score · lb·s</th><th>Supported load</th><th>Held time</th><th>Recorded setup</th></tr></thead><tbody>${[...rows].reverse().map(row=>`<tr><td>${esc(dateLabel(row.date))}</td><td>${n(row.score)}</td><td>${n(row.best.loadLb)} lb</td><td>${n(row.best.seconds)} s</td><td>${esc(row.conditionLabel)}</td></tr>`).join('')}</tbody></table></div></details>`;
  }
  function renderSet(s,index,protocol,{lastInCycle=false}={}){
    const active=s.segments.reduce((sum,part)=>sum+part.count*part.seconds,0),result=RESULTS.find(([v])=>v===s.status)?.[1]||'Not recorded';
    const target=finite(s.targetHangSeconds)||finite(s.targetHangs)?[finite(s.targetHangs)?n(s.targetHangs)+' hangs':'',finite(s.targetHangSeconds)?n(s.targetHangSeconds)+' s each':''].filter(Boolean).join(' · '):'Not recorded';
    const rest=protocol==='repeaters'?`Rest between hangs: ${seconds(s.restBetweenHangsSeconds)}${lastInCycle?'':' · Before next set: '+duration(s.restAfterSetSeconds)}`:n(active)+' s active hang time';
    return `<details class="hang-record"><summary><span class="hang-record-number">${index+1}</span><span class="hang-record-grip"><strong>${esc(gripLabel(s))}</strong><small>${esc(loadLabel(s))}${s.hand!=='unspecified'?' · '+esc(HANDS.find(([v])=>v===s.hand)?.[1]||s.hand):''}${s.isWarmup?' · Warm-up':''}</small></span><span class="hang-record-pattern"><strong>${esc(formatHangboardPattern(s,protocol))}</strong><small>${esc(rest)}</small></span></summary><div class="hang-record-details"><dl><div><dt>Active hang time</dt><dd>${n(active)} s</dd></div>${protocol==='repeaters'&&lastInCycle?'':`<div><dt>${protocol==='repeaters'?'Rest before next set':'Rest after set'}</dt><dd>${esc(duration(s.restAfterSetSeconds))}</dd></div>`}<div><dt>Target</dt><dd>${esc(target)}</dd></div><div><dt>Result</dt><dd>${esc(result)}</dd></div><div><dt>Effort</dt><dd>${finite(s.effort)?n(s.effort)+' / 10':'Not recorded'}</dd></div>${s.setup?`<div><dt>Setup</dt><dd>${esc(s.setup)}</dd></div>`:''}</dl>${s.notes?`<p class="hang-record-notes">${esc(s.notes)}</p>`:''}</div></details>`;
  }
  function renderCycles(w){
    if(!w.cycles.length)return '<p class="hang-help">Use “Edit / add sets” to start a cycle for this workout.</p>';
    const sets=new Map(w.sets.map((set,index)=>[set.id,{set,index}]));
    return w.cycles.map((cycle,index)=>{
      const next=index<w.cycles.length-1;
      return `<section class="hang-record-cycle"><header class="hang-record-cycle-heading"><h4>Cycle ${index+1}</h4><span>${cycle.setIds.length} ${cycle.setIds.length===1?'set':'sets'}</span></header>${cycle.setIds.length?cycle.setIds.map((id,i)=>{const {set,index:setIndex}=sets.get(id);return renderSet(set,setIndex,w.protocol,{lastInCycle:i===cycle.setIds.length-1});}).join(''):'<p class="hang-help hang-cycle-empty-history">No sets recorded in this cycle.</p>'}${next||finite(cycle.restAfterCycleSeconds)?`<div class="hang-cycle-recovery ${next?'':'hang-cycle-final'}"><span>${next?'Rest before cycle '+(index+2):'Recovery after final cycle'}</span><strong>${esc(duration(cycle.restAfterCycleSeconds))}</strong>${next?'':'<small>After the workout</small>'}</div>`:''}</section>`;
    }).join('');
  }
  function renderWorkout(original,index){
    const w=upgradeHangboardWorkout(original),summary=summarizeHangboardWorkout(w),label=protocolInfo(w.protocol)?.label||'Hangboard',title=w.title||label;
    const count=(w.protocol==='repeaters'?w.cycles.length+' '+(w.cycles.length===1?'cycle':'cycles')+' · ':'')+summary.setCount+' '+(summary.setCount===1?'set':'sets');
    const maxScore=w.protocol==='max_hangs'?summarizeMaxHangs([w]).best:null;
    const receipt=w.protocol==='max_hangs'?`<strong>${maxScore?n(maxScore.score)+' lb·s':'—'}</strong><span>Max hang score</span><span>${maxScore?n(maxScore.loadLb)+' lb × '+n(maxScore.seconds)+' s':'No eligible scored hold'}</span>`:`<strong>${count}</strong><span>${n(summary.hangCount)} recorded ${summary.hangCount===1?'hang':'hangs'}</span><span><b>${n(summary.activeSeconds)} s</b> recorded active time</span>`;
    if(showDeleted)return `<article class="hang-workout-card hang-deleted-card"><div><span class="hang-workout-date">${esc(dateLabel(w.date))}</span><h3>${esc(title)}</h3><p>${esc(label)} · ${count} · ${n(summary.activeSeconds)} s active</p></div><button type="button" class="button button-outline" data-hang-restore="${esc(w.id)}" ${actionPending?'disabled':''}>Restore workout</button></article>`;
    return `<article class="hang-workout-card" data-hang-workout-id="${esc(w.id)}"><header class="hang-workout-heading"><div><span class="hang-workout-date">${esc(dateLabel(w.date))}</span><h3>${esc(title)}</h3><div class="hang-workout-meta"><span class="hang-protocol-badge">${esc(label)}</span>${w.location?`<span>${esc(w.location)}</span>`:''}${w.source?`<span class="hang-source-badge">Moved from ${esc(w.source.exercise||'strength history')}</span>`:''}</div></div><div class="hang-workout-receipt">${receipt}</div></header>${w.notes?`<p class="hang-workout-notes">${esc(w.notes)}</p>`:''}${finite(w.bodyweightLb)?`<p class="hang-workout-bodyweight">Recorded bodyweight: ${n(w.bodyweightLb)} lb</p>`:''}<details class="hang-workout-sets" ${index===0?'open':''}><summary>${w.protocol==='repeaters'?'Cycles, sets & hold details':summary.setCount?'Sets & hold details':'No sets added yet'}<span aria-hidden="true">＋</span></summary><div>${w.protocol==='repeaters'?renderCycles(w):w.sets.length?w.sets.map((s,i)=>renderSet(s,i,w.protocol)).join(''):'<p class="hang-help">Use “Edit / add sets” to begin logging this workout.</p>'}</div></details><footer class="hang-workout-actions"><button type="button" class="button button-outline" data-hang-edit="${esc(w.id)}" ${actionPending?'disabled':''}>Edit / add sets</button><button type="button" class="text-button hang-danger-link" data-hang-delete="${esc(w.id)}" ${actionPending?'disabled':''}>Delete workout</button></footer><div class="hang-delete-confirm" data-hang-delete-confirm="${esc(w.id)}" hidden><p>Delete this workout and its sets? It will remain recoverable in Deleted workouts.</p><button type="button" class="button hang-danger" data-hang-confirm-delete="${esc(w.id)}">Delete workout</button><button type="button" class="text-button" data-hang-keep="${esc(w.id)}">Keep workout</button></div></article>`;
  }
  async function request(method,payload,query=''){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);
    try{const response=await fetch('/api/hangboard-workouts'+query,{method,cache:'no-store',headers:{Accept:'application/json',...(payload?{'Content-Type':'application/json'}:{})},...(payload?{body:JSON.stringify(payload)}:{}),signal:controller.signal});let body;try{body=await response.json();}catch{throw new Error('The saved-workout response could not be read. Keep your draft open and retry.');}if(!response.ok){const error=new Error(body.error||'The change could not be confirmed. Please retry.');error.conflict=response.status===409||body.conflict;error.field=body.field;throw error;}return body;}catch(error){if(error.name==='AbortError')throw new Error('The request timed out. Keep your draft open and retry; the same workout will not be added twice.');if(error instanceof TypeError)throw new Error('Couldn’t connect to your saved hangboard workouts. Keep your draft open and retry.');throw error;}finally{clearTimeout(timer);}
  }
  async function load(){
    if(loading)return loadPromise;loading=true;const started=writeRevision;setStatus('Loading saved hangboard workouts…');
    loadPromise=(async()=>{try{const body=await request('GET');if(!Array.isArray(body.workouts)||!Array.isArray(body.deletedWorkouts))throw new Error('Your saved hangboard history could not be read.');if(started!==writeRevision)return;workouts=body.workouts;deletedWorkouts=body.deletedWorkouts;loaded=true;loadFailed=false;setStatus('Saved workouts are up to date.');render();}catch(error){loadFailed=true;setStatus(error.message,true);render();}finally{loading=false;host.querySelectorAll('[data-hang-new]').forEach(b=>b.disabled=!loaded||actionPending);if(started!==writeRevision)load();}})();return loadPromise;
  }
  function putWorkout(workout){workouts=workouts.filter(w=>w.id!==workout.id);deletedWorkouts=deletedWorkouts.filter(w=>w.id!==workout.id);(workout.deleted_at?deletedWorkouts:workouts).push(workout);}
  function setFormError(message,conflict=false,field=''){
    q('[data-hang-form-error]').textContent=message+(conflict?' Your draft is still open. Reloading replaces it with the saved version.':'');q('.hang-form-error').hidden=!message;q('[data-hang-reload-draft]').hidden=!conflict||!draft?.id;
    let input;
    if(field){
      const setMatch=/^sets\[(\d+)\](?:\.segments\[(\d+)\])?\.([A-Za-z]+)$/.exec(field),cycleMatch=/^cycles\[(\d+)\]/.exec(field);
      if(setMatch){
        const set=draft?.sets[Number(setMatch[1])];
        if(set){const selector=`[data-hang-set-id="${set.id}"] `+(setMatch[2]!==undefined?`[data-hang-segment-id="${set.segments[Number(setMatch[2])]?.id}"] [data-hang-segment-field="${setMatch[3]}"]`:`[data-hang-set-field="${setMatch[3]}"]`);input=q(selector);}
      }else if(cycleMatch){const cycle=draft?.cycles[Number(cycleMatch[1])];if(cycle)input=q(`[data-hang-cycle-id="${cycle.id}"] [data-hang-cycle-rest="minutes"]`);}
      else if(field==='cycles')input=q('[data-hang-add-cycle]');
      else if(/^[A-Za-z]+$/.test(field))input=q(`[data-hang-work-field="${field}"]`);
    }
    if(input){for(let p=input.parentElement;p&&p!==form;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;input.focus();}
  }
  function fillBasics(){
    for(const key of ['date','title','location','notes','bodyweightLb','protocol'])q(`[data-hang-work-field="${key}"]`).value=draft[key]??'';
    const locations=[...new Set(workouts.map(w=>w.location).filter(Boolean))].sort((a,b)=>a.localeCompare(b));q('#hangboard-location-options').innerHTML=locations.map(v=>`<option value="${esc(v)}"></option>`).join('');
    const grips=[...new Set(['Open crimp','Half crimp','Three-finger drag','Full crimp','Sloper','Pinch',...workouts.flatMap(w=>w.sets.map(s=>s.grip)).filter(Boolean)])];q('#hangboard-grip-options').innerHTML=grips.map(v=>`<option value="${esc(v)}"></option>`).join('');
    q('.hang-session-details').open=draft.protocol==='max_hangs'||!!draft.notes||finite(draft.bodyweightLb);
    updateProtocol();
  }
  function protocolLocked(){return !!draft.revision||draft.sets.length>0||draft.protocol==='repeaters'&&(draft.cycles.length>1||draft.cycles.some(c=>finite(c.restAfterCycleSeconds)));}
  function updateProtocol(){
    const repeaters=draft.protocol==='repeaters',locked=protocolLocked();
    q('[data-hang-bodyweight-help]').textContent=repeaters?'Stored with this workout; no bodyweight is assumed.':'For a max-hang score, record your bodyweight on this date and mark the hold Completed. No bodyweight is assumed.';
    q('[data-hang-work-field="protocol"]').disabled=locked;
    q('[data-hang-protocol-lock]').textContent=draft.revision?'This workout keeps its saved protocol. Create another workout to log a different protocol.':locked?'Remove sets, extra cycles and any recorded cycle recovery before changing this workout’s protocol.':repeaters?'A cycle groups sets together. Keep rest between hangs, between sets and between cycles separate.':'Each set is one hold. Record the actual hold duration, load and rest after the hold.';
    q('[data-hang-editor-subtitle]').textContent=repeaters?'Organize sets into cycles, with each kind of rest recorded separately.':'Record each hold, its load and recovery.';
    q('[data-hang-set-title]').textContent=repeaters?'Repeater cycles':'Max-hang sets';
    q('[data-hang-set-help]').textContent=repeaters?'Add sets to each cycle. Start a new cycle at any existing set, or add an empty cycle below.':'One set per hold. Targets and actual held time are recorded separately.';
    q('[data-hang-global-add]').hidden=repeaters;q('[data-hang-add-cycle]').hidden=!repeaters;
    q('[data-hang-add-cycle]').disabled=repeaters&&draft.cycles.length>=100;
  }
  async function openNew(options={}){if(dialog.open||saving||actionPending)return;if(!loaded){await load();if(!loaded){notice('Load your saved hangboard history before starting a workout.',true);return;}}if(dialog.open||saving||actionPending)return;openEditor(null,options);}
  function newCycle(){return {id:uuid(),setIds:[],restAfterCycleSeconds:null};}
  function openEditor(workout=null,options={}){
    if(dialog.open||saving||actionPending||!loaded)return;
    initialFocus=document.activeElement;
    const protocol=['repeaters','max_hangs'].includes(options.protocol)?options.protocol:filter==='all'?'repeaters':filter;
    draft=workout?upgradeHangboardWorkout(clone(workout)):{id:uuid(),date:options.date||getTrainingToday(),protocol,title:'',location:'',notes:'',bodyweightLb:null,sets:[],cycles:protocol==='repeaters'?[newCycle()]:[]};
    dirty=false;bulkRestDrafts.clear();q('[data-hang-sets]').innerHTML='';fillBasics();q('#hangboard-editor-title').textContent=workout?'Edit workout':'New workout';q('[data-hang-save]').textContent=workout?'Save changes':'Save workout';q('[data-hang-save-hint]').textContent='Rest is recorded separately from active hang time.';setFormError('');renderSets();dialog.showModal();q('[data-hang-work-field="date"]').focus();
  }
  function readCycleRest(el,previous){
    const minutes=el.querySelector('[data-hang-cycle-rest="minutes"]').value,seconds=el.querySelector('[data-hang-cycle-rest="seconds"]').value;
    if(minutes===''&&seconds==='')return null;
    const original=durationParts(previous);
    if(minutes===original.minutes&&seconds===original.seconds)return previous;
    return Number(minutes||0)*60+Number(seconds||0);
  }
  function readDraft(){
    if(!draft)return;
    for(const key of ['date','title','location','notes']){const value=q(`[data-hang-work-field="${key}"]`).value;if(key!=='notes'||value!==displayedNote(draft.notes))draft[key]=value;}
    draft.bodyweightLb=num(q('[data-hang-work-field="bodyweightLb"]').value);
    const previous=new Map(draft.sets.map(s=>[s.id,s]));
    draft.sets=[...q('[data-hang-sets]').querySelectorAll('[data-hang-set-id]')].map(el=>{
      const set={...previous.get(el.dataset.hangSetId)},v=key=>el.querySelector(`[data-hang-set-field="${key}"]`)?.value;
      for(const key of ['grip','hand','loadMode','setup','status','notes']){const value=v(key);if(key!=='notes'||value!==displayedNote(set.notes))set[key]=value;}
      for(const key of ['edgeMm','targetHangSeconds','restAfterSetSeconds','effort'])set[key]=num(v(key));
      set.loadLb=['added','assisted','absolute'].includes(set.loadMode)?num(v('loadLb')):null;set.isWarmup=el.querySelector('[data-hang-set-field="isWarmup"]').checked;
      set.targetHangs=draft.protocol==='repeaters'?num(v('targetHangs')):null;set.restBetweenHangsSeconds=draft.protocol==='repeaters'?num(v('restBetweenHangsSeconds')):null;
      set.segments=[...el.querySelectorAll('[data-hang-segment-id]')].map(segment=>({id:segment.dataset.hangSegmentId,seconds:num(segment.querySelector('[data-hang-segment-field="seconds"]').value),count:draft.protocol==='repeaters'?num(segment.querySelector('[data-hang-segment-field="count"]').value):1}));return set;
    });
    if(draft.protocol==='repeaters'){
      const cycles=new Map(draft.cycles.map(c=>[c.id,c]));
      draft.cycles=[...q('[data-hang-sets]').querySelectorAll('[data-hang-cycle-id]')].map(el=>{
        const cycle={...cycles.get(el.dataset.hangCycleId)};
        cycle.setIds=[...el.querySelectorAll('[data-hang-set-id]')].map(set=>set.dataset.hangSetId);
        cycle.restAfterCycleSeconds=readCycleRest(el,cycle.restAfterCycleSeconds);
        return cycle;
      });
    }
  }
  function newSet(){return {id:uuid(),grip:'',edgeMm:null,hand:'unspecified',loadMode:'bodyweight',loadLb:null,setup:'',isWarmup:false,status:'unknown',targetHangs:null,targetHangSeconds:null,restBetweenHangsSeconds:null,restAfterSetSeconds:null,segments:[{id:uuid(),seconds:null,count:draft.protocol==='repeaters'?null:1}],effort:null,notes:''};}
  function captureBulkRests(){
    q('[data-hang-sets]').querySelectorAll('[data-hang-bulk-rest]').forEach(el=>{
      if(el.dataset.edited==='true'&&draft.cycles.some(c=>c.id===el.dataset.hangBulkRest))bulkRestDrafts.set(el.dataset.hangBulkRest,{value:el.querySelector('[data-hang-bulk-value]').value,unit:el.querySelector('[data-hang-bulk-unit]').value});
    });
  }
  function cycleBulkRest(cycle){
    const pending=cycle.setIds.length>1?bulkRestDrafts.get(cycle.id):null;if(pending)return {...pending,edited:true};
    const rests=cycle.setIds.slice(0,-1).map(id=>draft.sets.find(s=>s.id===id)?.restAfterSetSeconds);
    const uniform=rests.length&&rests.every(value=>value===rests[0]);
    const value=uniform&&finite(rests[0])?rests[0]:null,unit=value!==null&&value%60!==0?'seconds':'minutes';
    return {value:value===null?'':String(value/(unit==='minutes'?60:1)),unit,edited:false,mixed:rests.length>0&&!uniform};
  }
  function renderCycleEditor(cycle,index,markup){
    const next=index<draft.cycles.length-1,parts=durationParts(cycle.restAfterCycleSeconds),bulk=cycleBulkRest(cycle),hasIntervals=cycle.setIds.length>1;
    return `<section class="hang-cycle-editor" data-hang-cycle-id="${cycle.id}" aria-label="Cycle ${index+1}">
      <header class="hang-cycle-editor-heading"><div><span class="eyebrow">REPEATER CYCLE</span><h4>Cycle ${index+1} <span>${cycle.setIds.length} ${cycle.setIds.length===1?'set':'sets'}</span></h4></div><div class="hang-cycle-actions">${index?`<button type="button" class="text-button" data-hang-merge-cycle="${cycle.id}">Merge with previous</button>`:''}${cycle.setIds.length===0?`<button type="button" class="text-button hang-danger-link" data-hang-remove-cycle="${cycle.id}">Remove empty cycle</button>`:''}</div></header>
      <div class="hang-cycle-rest-controls">
        <div class="hang-bulk-rest" data-hang-bulk-rest="${cycle.id}" data-edited="${bulk.edited}"><div class="hang-cycle-control-label">Rest between sets</div><div class="hang-bulk-fields"><label>Duration<input type="number" min="0" step="any" data-hang-bulk-value value="${esc(bulk.value)}" placeholder="${bulk.mixed?'Mixed values':'Not recorded'}" aria-label="Cycle ${index+1} rest between sets duration" ${hasIntervals?'':'disabled'}></label><label>Unit<select data-hang-bulk-unit data-previous-unit="${bulk.unit}" aria-label="Cycle ${index+1} rest between sets unit" ${hasIntervals?'':'disabled'}><option value="minutes" ${bulk.unit==='minutes'?'selected':''}>Minutes</option><option value="seconds" ${bulk.unit==='seconds'?'selected':''}>Seconds</option></select></label><button type="button" class="button button-outline" data-hang-apply-rest="${cycle.id}" ${hasIntervals?'':'disabled'}>Apply to sets</button></div><p class="hang-help">${hasIntervals?'Apply updates '+(cycle.setIds.length-1)+' '+(cycle.setIds.length===2?'interval':'intervals')+' before the next set in this cycle. Leave blank and apply to clear '+(cycle.setIds.length===2?'it':'them')+'.':'Add at least two sets to record rest between them.'}</p><div class="hang-bulk-pending" data-hang-bulk-pending ${bulk.edited?'':'hidden'}><span>Not applied yet</span><button type="button" class="text-button" data-hang-reset-rest="${cycle.id}">Reset</button></div></div>
        <div class="hang-cycle-rest"><div class="hang-cycle-control-label">${next?'Rest before cycle '+(index+2):'Recovery after final cycle'} ${optional}</div><div class="hang-duration-fields"><label>Minutes<input type="number" min="0" max="1440" step="1" data-hang-cycle-rest="minutes" value="${esc(parts.minutes)}" placeholder="—" aria-label="Cycle ${index+1} recovery minutes"></label><label>Seconds<input type="number" min="0" max="59.999999999" step="any" data-hang-cycle-rest="seconds" value="${esc(parts.seconds)}" placeholder="—" aria-label="Cycle ${index+1} recovery seconds"></label></div><p class="hang-help">${next?'After this cycle’s final set, before the next cycle starts.':'The workout ends here. This optional recovery is not between cycles.'} Leave both fields blank if not recorded.</p></div>
      </div>
      <div class="hang-cycle-sets">${cycle.setIds.length?cycle.setIds.map(id=>markup.get(id)).join(''):'<div class="hang-empty-sets"><strong>No sets in this cycle</strong><p>Add a set below, or leave the cycle empty for now.</p></div>'}</div>
      <button type="button" class="button button-outline hang-cycle-add-set" data-hang-add-set data-hang-set-cycle="${cycle.id}" ${draft.sets.length>=100?'disabled':''}>＋ Add set to cycle ${index+1}</button>
    </section>`;
  }
  function renderSets(openId=''){
    if(!draft)return;captureBulkRests();const repeaters=draft.protocol==='repeaters',open=new Set([...q('[data-hang-sets]').querySelectorAll('.hang-set-editor[open]')].map(el=>el.dataset.hangSetId)),extras=new Set([...q('[data-hang-sets]').querySelectorAll('.hang-set-extras[open]')].map(el=>el.closest('[data-hang-set-id]').dataset.hangSetId));if(openId)open.add(openId);
    q('[data-hang-set-count]').textContent=(repeaters?draft.cycles.length+' '+(draft.cycles.length===1?'cycle':'cycles')+' · ':'')+draft.sets.length+' / 100 sets';q('[data-hang-global-add]').disabled=draft.sets.length>=100;
    const memberships=new Map();
    if(repeaters)draft.cycles.forEach(cycle=>cycle.setIds.forEach((id,index)=>memberships.set(id,{cycle,index,last:index===cycle.setIds.length-1})));
    const markup=new Map(draft.sets.map((s,index)=>{
      const membership=memberships.get(s.id),lastInCycle=repeaters&&membership?.last;
      const input=(key,label,attrs='',value=s[key]??'')=>`<label>${label}<input data-hang-set-field="${key}" aria-label="Set ${index+1} ${label.replace(/<[^>]*>/g,'')}" value="${esc(value)}" ${attrs}></label>`;
      const select=(key,label,options)=>`<label>${label}<select data-hang-set-field="${key}" aria-label="Set ${index+1} ${label}">${options.map(([value,text])=>`<option value="${value}" ${s[key]===value?'selected':''}>${esc(text)}</option>`).join('')}</select></label>`;
      const loadVisible=['added','assisted','absolute'].includes(s.loadMode);
      return [s.id,`<details class="hang-set-editor" data-hang-set-id="${s.id}" ${open.has(s.id)?'open':''}><summary><span class="hang-set-number">${index+1}</span><span><strong data-hang-set-summary-grip>${esc(gripLabel(s))}</strong><small data-hang-set-summary-pattern>${esc(pattern(s,draft.protocol))} · ${esc(loadLabel(s))}</small></span><span class="hang-set-summary-kind" data-hang-set-summary-kind>${esc(setKind(s))}</span></summary><div class="hang-set-fields">
        <div class="hang-grip-fields">${input('grip','Grip / hold','maxlength="120" list="hangboard-grip-options" placeholder="e.g. Half crimp"')}${input('edgeMm','Edge <span class="hang-unit">mm</span> '+optional,'type="number" min="0.001" max="200" step="any" placeholder="e.g. 20"')}${select('hand','Hands',HANDS)}</div>
        <div class="hang-load-fields">${select('loadMode','Load',LOADS)}<div data-hang-load-amount ${loadVisible?'':'hidden'}>${input('loadLb','<span data-hang-load-label>'+loadAmountLabel(s.loadMode)+'</span> <span class="hang-unit">lb</span>','type="number" min="0" max="10000" step="any"'+(loadVisible?' required':''))}</div></div>
        <section class="hang-pattern-editor" aria-label="Set ${index+1} recorded hangs"><div class="hang-pattern-heading"><h4>${repeaters?'Actual hangs':'Actual hold'}</h4><span data-hang-live-pattern>${esc(pattern(s,draft.protocol))}</span></div><div class="hang-segments">${s.segments.map((segment,j)=>`<div class="hang-segment" data-hang-segment-id="${segment.id}">${repeaters?`<label>${j?'Additional hangs':'Hangs recorded'}<input type="number" min="0" max="1000" step="1" required data-hang-segment-field="count" aria-label="Set ${index+1} component ${j+1} hang count" value="${esc(segment.count??'')}" placeholder="e.g. 6"></label><span class="hang-times" aria-hidden="true">×</span>`:''}<label>${repeaters?'Seconds per hang':'Seconds held'}<input type="number" min="0" max="86400" step="any" required data-hang-segment-field="seconds" aria-label="Set ${index+1} component ${j+1} seconds" value="${esc(segment.seconds??'')}" placeholder="${repeaters?'e.g. 7':'Actual duration'}"></label>${repeaters&&s.segments.length>1?`<button type="button" class="hang-icon-button" data-hang-remove-component="${segment.id}" data-hang-component-set="${s.id}" aria-label="Remove component ${j+1} from set ${index+1}">×</button>`:''}</div>`).join('')}</div>${repeaters?`<button type="button" class="text-button hang-component-button" data-hang-add-component="${s.id}" ${s.segments.length>=20?'disabled':''}>＋ Add a different-duration hang</button><small class="hang-pattern-help">For example, record five full hangs and one shorter hang as two components.</small>`:''}</section>
        <div class="hang-rest-fields">${repeaters?input('restBetweenHangsSeconds','Rest between hangs <span class="hang-unit">seconds</span>','type="number" min="0" max="86400" step="any" placeholder="Not recorded"'):''}${lastInCycle?'<p class="hang-last-set-rest"><strong>Final set in this cycle</strong><span>Cycle recovery is recorded above, separately from rest between sets.</span></p>':input('restAfterSetSeconds',(repeaters?'Rest before next set':'Rest after this set')+' <span class="hang-unit">seconds</span>','type="number" min="0" max="86400" step="any" placeholder="Not recorded"')}</div>
        <details class="hang-set-extras" ${extras.has(s.id)?'open':''}><summary>Targets, result & notes <span>optional</span></summary><div class="hang-extra-fields"><p class="hang-help">Targets describe what you aimed for. Actual hangs above describe what you recorded.</p><div class="hang-target-fields">${repeaters?input('targetHangs','Target hangs','type="number" min="1" max="1000" step="1" placeholder="Not recorded"'):''}${input('targetHangSeconds','Target hold <span class="hang-unit">seconds</span>','type="number" min="0.001" max="86400" step="any" placeholder="Not recorded"')}</div><div class="hang-outcome-fields">${select('status','Result',RESULTS)}${input('effort','Effort / 10','type="number" min="1" max="10" step="0.5" placeholder="1–10"')}</div><label class="hang-checkbox"><input type="checkbox" data-hang-set-field="isWarmup" aria-label="Set ${index+1} warm-up" ${s.isWarmup?'checked':''}>Warm-up set</label>${input('setup','Setup / assistance details','maxlength="200" placeholder="e.g. Foot support or pulley setup"')}<label>Set notes<textarea data-hang-set-field="notes" aria-label="Set ${index+1} notes" maxlength="2000" rows="3" placeholder="Hold details, shorter hangs, how it felt…">${esc(s.notes)}</textarea></label></div></details>
        <div class="hang-set-actions">${repeaters&&membership?.index>0?`<button type="button" class="text-button" data-hang-split-cycle="${membership.cycle.id}" data-hang-split-at="${s.id}" ${draft.cycles.length>=100?'disabled':''}>Start new cycle here</button>`:''}<button type="button" class="text-button" data-hang-duplicate="${s.id}" ${draft.sets.length>=100?'disabled':''}>Duplicate set</button><button type="button" class="text-button hang-danger-link" data-hang-remove-set="${s.id}">Remove set</button></div>
      </div></details>`];
    }));
    q('[data-hang-sets]').innerHTML=repeaters?(draft.cycles.length?draft.cycles.map((cycle,index)=>renderCycleEditor(cycle,index,markup)).join(''):'<div class="hang-empty-sets"><strong>No cycles yet</strong><p>Add a cycle below to start recording sets.</p></div>'):draft.sets.length?[...markup.values()].join(''):'<div class="hang-empty-sets"><strong>No sets yet</strong><p>Add your first set, or save this dated workout and fill it in later.</p></div>';
    for(const set of draft.sets)q(`[data-hang-set-id="${set.id}"] [data-hang-set-field="notes"]`).value=set.notes??'';
    updateProtocol();
  }
  function draftHint(message){q('[data-hang-save-hint]').textContent=message;announce(message);}
  function orderSets(){const sets=new Map(draft.sets.map(s=>[s.id,s]));draft.sets=draft.cycles.flatMap(c=>c.setIds.map(id=>sets.get(id)));}
  function addSet(cycleId){
    readDraft();if(draft.sets.length>=100)return;
    const cycle=draft.protocol==='repeaters'?draft.cycles.find(c=>c.id===cycleId):null;
    if(draft.protocol==='repeaters'&&!cycle)return;
    const set=newSet();draft.sets.push(set);if(cycle){cycle.setIds.push(set.id);orderSets();}
    dirty=true;setFormError('');renderSets(set.id);q(`[data-hang-set-id="${set.id}"] [data-hang-set-field="grip"]`).focus();
  }
  function duplicateSet(id){
    readDraft();if(draft.sets.length>=100)return;
    const existing=draft.sets.find(s=>s.id===id);if(!existing)return;
    const copy={...clone(existing),id:uuid(),segments:existing.segments.map(s=>({...s,id:uuid()}))};draft.sets.push(copy);
    if(draft.protocol==='repeaters'){
      const cycle=draft.cycles.find(c=>c.setIds.includes(id)),index=cycle.setIds.indexOf(id);
      cycle.setIds.splice(index+1,0,copy.id);if(index===cycle.setIds.length-2)copy.restAfterSetSeconds=null;
      orderSets();
    }
    dirty=true;setFormError('');renderSets(copy.id);draftHint('Set copied. Review its actual hangs, rest and result before saving.');q(`[data-hang-set-id="${copy.id}"] [data-hang-segment-field="seconds"]`).focus();
  }
  function removeSet(id){
    readDraft();let removedRest=false,cycle;
    if(draft.protocol==='repeaters'){
      cycle=draft.cycles.find(c=>c.setIds.includes(id));if(!cycle)return;
      const pending=q(`[data-hang-bulk-rest="${cycle.id}"][data-edited="true"] [data-hang-bulk-value]`);
      if(pending){setFormError('Apply or reset the pending rest between sets before removing a set from this cycle.');pending.focus();return;}
      const index=cycle.setIds.indexOf(id);
      if(index===cycle.setIds.length-1&&index>0){const previous=draft.sets.find(s=>s.id===cycle.setIds[index-1]);removedRest=finite(previous.restAfterSetSeconds);previous.restAfterSetSeconds=null;}
      cycle.setIds.splice(index,1);
    }
    draft.sets=draft.sets.filter(s=>s.id!==id);dirty=true;setFormError('');renderSets();
    if(removedRest)draftHint('Set removed with the rest interval that led to it. Cycle recovery is unchanged.');
    else draftHint('Set removed from this draft. Save to keep the change.');
    (cycle?q(`[data-hang-set-cycle="${cycle.id}"]`):q('[data-hang-global-add]'))?.focus();
  }
  function addCycle(){
    readDraft();if(draft.protocol!=='repeaters'||draft.cycles.length>=100)return;
    const cycle=newCycle();draft.cycles.push(cycle);dirty=true;setFormError('');renderSets();q(`[data-hang-set-cycle="${cycle.id}"]`).focus();
  }
  function removeCycle(id){
    readDraft();const cycle=draft.cycles.find(c=>c.id===id);if(!cycle||cycle.setIds.length)return;
    draft.cycles=draft.cycles.filter(c=>c.id!==id);bulkRestDrafts.delete(id);dirty=true;setFormError('');renderSets();draftHint(finite(cycle.restAfterCycleSeconds)?'Empty cycle and its recorded recovery removed from this draft.':'Empty cycle removed from this draft.');q('[data-hang-add-cycle]').focus();
  }
  function changeCycle(action,cycleId,setId){
    readDraft();setFormError('');
    const index=draft.cycles.findIndex(c=>c.id===cycleId),affected=action==='merge'?draft.cycles.slice(index-1,index+1):[draft.cycles[index]];
    const pending=affected.map(c=>q(`[data-hang-bulk-rest="${c.id}"][data-edited="true"] [data-hang-bulk-value]:not(:disabled)`)).find(Boolean);
    if(pending){setFormError('Apply or reset the pending rest between sets before reorganizing this cycle.');pending.focus();return;}
    try{
      draft=action==='split'?splitHangboardCycle(draft,cycleId,setId,{idFactory:uuid}):mergeHangboardCycle(draft,cycleId);
      dirty=true;renderSets(setId||'');
      draftHint(action==='split'?'New cycle started here. The boundary rest moved to cycle recovery.':'Cycles merged. Their boundary recovery is now rest before the next set.');
      if(setId)q(`[data-hang-set-id="${setId}"] > summary`)?.focus();
    }catch(error){setFormError(error.message,false,error.field);}
  }
  function applyRest(id){
    const el=q(`[data-hang-bulk-rest="${id}"]`),input=el?.querySelector('[data-hang-bulk-value]');if(!input||input.disabled)return;
    if(!input.checkValidity()){input.reportValidity();return;}
    const amount=num(input.value),rest=amount===null?null:amount*(el.querySelector('[data-hang-bulk-unit]').value==='minutes'?60:1);
    if(rest!==null&&(!finite(rest)||rest<0||rest>86400)){setFormError('Rest between sets must be from 0 to 1,440 minutes (24 hours).');input.focus();return;}
    readDraft();const cycle=draft.cycles.find(c=>c.id===id);if(!cycle)return;
    const ids=new Set(cycle.setIds.slice(0,-1));draft.sets.forEach(set=>{if(ids.has(set.id))set.restAfterSetSeconds=rest;});
    el.dataset.edited='false';bulkRestDrafts.delete(id);dirty=true;setFormError('');renderSets();
    draftHint(rest===null?'Rest between sets cleared for this cycle. Cycle recovery is unchanged.':duration(rest)+' rest applied between sets in this cycle. Cycle recovery is unchanged.');q(`[data-hang-apply-rest="${id}"]`).focus();
  }
  function resetRest(id){
    readDraft();const el=q(`[data-hang-bulk-rest="${id}"]`);if(el)el.dataset.edited='false';bulkRestDrafts.delete(id);renderSets();draftHint('Pending rest change reset to the recorded set rests.');q(`[data-hang-apply-rest="${id}"]`)?.focus();
  }
  function loadAmountLabel(mode){return mode==='added'?'Added weight':mode==='assisted'?'Assistance':'Recorded load';}
  function updateSetSummary(el){
    if(!el)return;const v=key=>el.querySelector(`[data-hang-set-field="${key}"]`)?.value,set={grip:v('grip'),edgeMm:num(v('edgeMm')),loadMode:v('loadMode'),loadLb:num(v('loadLb')),status:v('status'),isWarmup:el.querySelector('[data-hang-set-field="isWarmup"]').checked,segments:[...el.querySelectorAll('[data-hang-segment-id]')].map(s=>({seconds:num(s.querySelector('[data-hang-segment-field="seconds"]').value),count:draft.protocol==='repeaters'?num(s.querySelector('[data-hang-segment-field="count"]').value):1}))};
    el.querySelector('[data-hang-set-summary-grip]').textContent=gripLabel(set);el.querySelector('[data-hang-set-summary-pattern]').textContent=pattern(set,draft.protocol)+' · '+loadLabel(set);el.querySelector('[data-hang-live-pattern]').textContent=pattern(set,draft.protocol);el.querySelector('[data-hang-set-summary-kind]').textContent=setKind(set);
  }
  function closeEditor(){if(saving)return;if(dirty&&!window.confirm('Discard unsaved changes to this hangboard workout?'))return;dirty=false;draft=null;dialog.close();focusBack();}
  function setSaving(value){saving=value;q('.hang-form-content').disabled=value;q('[data-hang-save]').disabled=value||!loaded;q('[data-hang-cancel]').disabled=value;q('[data-hang-close]').disabled=value;q('[data-hang-reload-draft]').disabled=value;q('[data-hang-save]').textContent=value?'Saving…':draft?.revision?'Save changes':'Save workout';}
  async function save(event){event.preventDefault();if(saving||!loaded)return;readDraft();setFormError('');const pending=q('[data-hang-bulk-rest][data-edited="true"] [data-hang-bulk-value]:not(:disabled)');if(pending){setFormError('Apply the pending rest between sets before saving, or use Reset to keep the current intervals.');pending.focus();return;}let payload;try{const {canonicalPayload,...normalized}=normalizeHangboardWorkout(draft);payload={...normalized,...(draft.revision?{revision:draft.revision}:{})};}catch(error){setFormError(error.message,false,error.field);return;}setSaving(true);
    try{const body=await request(draft.revision?'PUT':'POST',payload);if(!body.workout?.id||!body.workout.revision)throw new Error('The save could not be confirmed. Keep your draft open and retry.');writeRevision++;putWorkout(body.workout);filter=body.workout.protocol;dateFilter='';search='';showDeleted=false;persist();dirty=false;draft=null;dialog.close();render();setStatus('Saved workouts are up to date.');notice('Hangboard workout saved.');onSaved(body.workout);focusBack();load();}catch(error){setFormError(error.message,error.conflict,error.field);}finally{setSaving(false);}}
  async function reloadDraft(){if(!draft||saving||!window.confirm('Replace your unsaved changes with the latest saved workout?'))return;const id=draft.id;q('[data-hang-reload-draft]').disabled=true;try{const body=await request('GET'),latest=body.workouts?.find(w=>w.id===id);if(!latest)throw new Error('This workout is no longer active. Your draft remains open so you can keep its notes.');workouts=body.workouts;deletedWorkouts=body.deletedWorkouts||[];loaded=true;draft=upgradeHangboardWorkout(clone(latest));dirty=false;bulkRestDrafts.clear();q('[data-hang-sets]').innerHTML='';fillBasics();renderSets();setFormError('');q('[data-hang-save]').textContent='Save changes';q('#hangboard-editor-title').textContent='Edit workout';render();announce('Latest saved hangboard workout loaded.');}catch(error){setFormError(error.message,true);}finally{q('[data-hang-reload-draft]').disabled=false;}}
  async function deleteWorkout(id){if(actionPending)return;const workout=workouts.find(w=>w.id===id);if(!workout)return;actionPending=true;render();try{const body=await request('DELETE',null,'?id='+encodeURIComponent(id)+'&revision='+workout.revision);if(!body.ok||!body.revision||!body.deleted_at)throw new Error('The deletion could not be confirmed. Please retry.');writeRevision++;putWorkout({...workout,revision:body.revision,deleted_at:body.deleted_at});lastDeleted={id,revision:body.revision};notice('Workout deleted. Undo this or restore it from Deleted workouts.');}catch(error){notice(error.message,true);}finally{actionPending=false;render();q('[data-hang-undo]').disabled=false;load();}}
  async function restoreWorkout(id=lastDeleted?.id){if(actionPending||!id)return;const workout=deletedWorkouts.find(w=>w.id===id),revision=workout?.revision??lastDeleted?.revision;if(!revision)return;actionPending=true;render();q('[data-hang-undo]').disabled=true;try{const body=await request('PATCH',{action:'restore',id,revision});if(!body.workout?.id||!body.workout.revision)throw new Error('Restoring this workout could not be confirmed. Please retry.');writeRevision++;putWorkout(body.workout);if(lastDeleted?.id===id)lastDeleted=null;notice('Workout restored.');onSaved(body.workout);}catch(error){notice(error.message,true);}finally{actionPending=false;render();q('[data-hang-undo]').disabled=false;load();}}
  host.addEventListener('click',event=>{
    const b=event.target.closest('button');if(!b||b.disabled||!host.contains(b))return;
    if(b.hasAttribute('data-hang-new'))openNew();
    else if(b.dataset.hangProtocol){filter=b.dataset.hangProtocol;persist();render();}
    else if(b.hasAttribute('data-hang-retry'))load();
    else if(b.hasAttribute('data-hang-toggle-deleted')){showDeleted=!showDeleted;render();}
    else if(b.hasAttribute('data-hang-clear')){dateFilter='';search='';render();}
    else if(b.dataset.hangEdit)openEditor(workouts.find(w=>w.id===b.dataset.hangEdit));
    else if(b.dataset.hangDelete)q(`[data-hang-delete-confirm="${b.dataset.hangDelete}"]`).hidden=false;
    else if(b.dataset.hangKeep)q(`[data-hang-delete-confirm="${b.dataset.hangKeep}"]`).hidden=true;
    else if(b.dataset.hangConfirmDelete)deleteWorkout(b.dataset.hangConfirmDelete);
    else if(b.dataset.hangRestore)restoreWorkout(b.dataset.hangRestore);
    else if(b.hasAttribute('data-hang-undo'))restoreWorkout();
    else if(b.hasAttribute('data-hang-dismiss')){lastDeleted=null;notice('');}
    else if(b.hasAttribute('data-hang-close')||b.hasAttribute('data-hang-cancel'))closeEditor();
    else if(b.hasAttribute('data-hang-add-cycle'))addCycle();
    else if(b.hasAttribute('data-hang-add-set'))addSet(b.dataset.hangSetCycle);
    else if(b.dataset.hangDuplicate)duplicateSet(b.dataset.hangDuplicate);
    else if(b.dataset.hangRemoveSet)removeSet(b.dataset.hangRemoveSet);
    else if(b.dataset.hangRemoveCycle)removeCycle(b.dataset.hangRemoveCycle);
    else if(b.dataset.hangSplitCycle)changeCycle('split',b.dataset.hangSplitCycle,b.dataset.hangSplitAt);
    else if(b.dataset.hangMergeCycle)changeCycle('merge',b.dataset.hangMergeCycle);
    else if(b.dataset.hangApplyRest)applyRest(b.dataset.hangApplyRest);
    else if(b.dataset.hangResetRest)resetRest(b.dataset.hangResetRest);
    else if(b.dataset.hangAddComponent){readDraft();const s=draft.sets.find(s=>s.id===b.dataset.hangAddComponent);if(!s||s.segments.length>=20)return;const part={id:uuid(),seconds:null,count:null};s.segments.push(part);dirty=true;renderSets(s.id);q(`[data-hang-segment-id="${part.id}"] [data-hang-segment-field="count"]`).focus();}
    else if(b.dataset.hangRemoveComponent){readDraft();const s=draft.sets.find(s=>s.id===b.dataset.hangComponentSet);if(!s||s.segments.length<=1)return;s.segments=s.segments.filter(part=>part.id!==b.dataset.hangRemoveComponent);dirty=true;renderSets(s.id);}
    else if(b.hasAttribute('data-hang-reload-draft'))reloadDraft();
  },events);
  q('[data-hang-filter-date]').addEventListener('change',event=>{dateFilter=event.target.value;render();},events);
  q('[data-hang-search]').addEventListener('input',event=>{search=event.target.value;render();},events);
  q('[data-hang-analytics]').addEventListener('change',event=>{
    if(event.target.matches('[data-hang-score-measurement]')){scoreMeasurement=event.target.value;scoreCondition='';scoreConditionLabel='';render();}
    else if(event.target.matches('[data-hang-score-condition]')){scoreCondition=event.target.value;if(!scoreCondition)scoreConditionLabel='';render();}
  },events);
  q('[data-hang-work-field="protocol"]').addEventListener('change',event=>{
    if(!draft)return;readDraft();if(protocolLocked()){event.target.value=draft.protocol;updateProtocol();return;}
    draft.protocol=event.target.value;draft.cycles=draft.protocol==='repeaters'?[newCycle()]:[];q('.hang-session-details').open=draft.protocol==='max_hangs'||!!draft.notes||finite(draft.bodyweightLb);bulkRestDrafts.clear();dirty=true;renderSets();
  },events);
  form.addEventListener('input',event=>{
    if(!draft)return;
    if(event.target.matches('[data-hang-bulk-value]')){
      const el=event.target.closest('[data-hang-bulk-rest]');el.dataset.edited='true';el.querySelector('[data-hang-bulk-pending]').hidden=false;dirty=true;return;
    }
    if(!event.target.matches('[data-hang-work-field],[data-hang-set-field],[data-hang-segment-field],[data-hang-cycle-rest]'))return;
    dirty=true;if(event.target.matches('[data-hang-cycle-rest]')){readDraft();updateProtocol();}
    updateSetSummary(event.target.closest('[data-hang-set-id]'));
  },events);
  form.addEventListener('change',event=>{
    if(!draft)return;
    if(event.target.matches('[data-hang-bulk-unit]')){
      const el=event.target.closest('[data-hang-bulk-rest]'),input=el.querySelector('[data-hang-bulk-value]'),before=event.target.dataset.previousUnit||'minutes',after=event.target.value;
      if(input.value!=='')input.value=String(Number(input.value)*(before==='minutes'?60:1)/(after==='minutes'?60:1));
      event.target.dataset.previousUnit=after;if(el.dataset.edited==='true')dirty=true;return;
    }
    if(!event.target.matches('[data-hang-work-field],[data-hang-set-field],[data-hang-segment-field],[data-hang-cycle-rest]'))return;
    dirty=true;if(event.target.matches('[data-hang-cycle-rest]')){readDraft();updateProtocol();}
    if(event.target.matches('[data-hang-set-field="loadMode"]')){
      const el=event.target.closest('[data-hang-set-id]'),visible=['added','assisted','absolute'].includes(event.target.value),amount=el.querySelector('[data-hang-load-amount]'),input=el.querySelector('[data-hang-set-field="loadLb"]');amount.hidden=!visible;input.required=visible;if(!visible)input.value='';el.querySelector('[data-hang-load-label]').textContent=loadAmountLabel(event.target.value);input.setAttribute('aria-label','Set '+([...q('[data-hang-sets]').querySelectorAll('[data-hang-set-id]')].indexOf(el)+1)+' '+loadAmountLabel(event.target.value)+' lb');
    }
    updateSetSummary(event.target.closest('[data-hang-set-id]'));
  },events);
  form.addEventListener('invalid',event=>{for(let p=event.target.parentElement;p&&p!==form;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;},{...events,capture:true});
  form.addEventListener('submit',save,events);dialog.addEventListener('cancel',event=>{event.preventDefault();closeEditor();},events);
  window.addEventListener('beforeunload',event=>{if(dialog.open&&dirty){event.preventDefault();event.returnValue='';}},events);
  render();
  return {load,activate(){render();return load();},openNew,destroy(){abort.abort();dialog.close();host.innerHTML='';host.classList.remove('hangboard-tracker');}};
}
