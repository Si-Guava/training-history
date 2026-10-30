import { GRADE_SYSTEMS, categoryInfo, normalizeClimbingWorkout, buildClimbCatalog, formatClimbGrade, climbNameKey, searchClimbCatalog, buildClimbAttemptTotals, climbAttemptTotalsFor } from './climbing-model.js';
import { getTrainingToday } from './exercise-archive.js';
import { createClimbingAnalytics } from './climbing-analytics.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clone = value => JSON.parse(JSON.stringify(value));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const number = value => new Intl.NumberFormat('en-CA', {maximumFractionDigits:2}).format(value);
const countLabel = (value,singular,plural=singular+'s') => number(value)+' '+(value===1?singular:plural);
const dateLabel = value => new Intl.DateTimeFormat('en-CA', {day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(value+'T12:00:00Z'));
const blankNumber = value => value === '' || value == null ? null : Number(value);
const normalizeVenue = value => String(value || '').trim().toLocaleLowerCase();
const displayedNote = value => String(value ?? '').replace(/\r\n?/g,'\n');
function uuid(){if(crypto.randomUUID)return crypto.randomUUID();const b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const s=[...b].map(v=>v.toString(16).padStart(2,'0')).join('');return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;}
function restLabel(seconds){if(!finite(seconds))return 'Not recorded';const mins=Math.floor(seconds/60),secs=seconds%60;return mins ? `${mins} min${secs?' '+secs+' s':''}` : `${secs} s`;}
const TAG_SUGGESTIONS = ['Slab','Overhang','Crimps','Slopers','Pinches','Dynamic','Technical','Endurance'];

/** Independent climbing/Kilter views; all workout records are saved through D1. */
export function createClimbingTracker({host,kind='climbing',announce=()=>{},onSaved=()=>{}}){
  const board=kind==='kilter',prefix=board?'kilter':'climbing',storageKey='training-'+prefix+'-preferences';
  let preferences={category:board?'kilter':'indoor_boulder',venue:'',includeOlder:false};
  try{preferences={...preferences,...JSON.parse(localStorage.getItem(storageKey)||'{}')};}catch{}
  if(!categoryInfo(preferences.category)||(board?preferences.category!=='kilter':preferences.category==='kilter'))preferences.category=board?'kilter':'indoor_boulder';
  let category=preferences.category,venueFilter=String(preferences.venue||''),dateFilter='',search='',showDeleted=false;
  let workouts=[],deletedWorkouts=[],loaded=false,loading=false,loadFailed=false,loadPromise=null,writeRevision=0,actionPending=false,lastDeleted=null;
  let totalsSource=null,attemptTotals=new Map();
  let draft=null,dirty=false,saving=false,initialFocus=null,pickerItems=[],pickerQuery='';
  let nameSuggestions=null,ignoreNameFocus=null;
  const freshBlankAttempts=new Set(),editedAttemptNumbers=new Set();
  const abort=new AbortController(),events={signal:abort.signal};
  const q=selector=>host.querySelector(selector);
  const currentInfo=()=>categoryInfo(category);
  const savePreferences=()=>{try{localStorage.setItem(storageKey,JSON.stringify({category,venue:venueFilter,includeOlder:preferences.includeOlder===true}));}catch{}};
  host.classList.add('climbing-tracker');host.dataset.kind=kind;
  host.innerHTML=`
    <div class="climb-heading"><div><span class="eyebrow">${board?'BOARD SESSIONS':'ON THE WALL'}</span><h2>${board?'Kilter board':'Climbing workouts'}</h2><p>${board?'Your board problems, angles and attempts, in their own history.':'Keep the climbs, attempts and details that make each session yours.'}</p></div><button type="button" class="button climb-primary" data-climb-new disabled>＋ New workout</button></div>
    ${board?'':`<section class="climb-category-panel" aria-label="Climbing category"><div class="climb-category-choice"><span class="climb-control-label">Where</span><div class="climb-segmented" role="group" aria-label="Climbing environment"><button type="button" data-climb-environment="indoor">Indoor</button><button type="button" data-climb-environment="outdoor">Outdoor</button></div></div><div class="climb-category-choice"><span class="climb-control-label">Style</span><div class="climb-segmented" role="group" aria-label="Climbing discipline"><button type="button" data-climb-discipline="boulder">Boulder</button><button type="button" data-climb-discipline="lead">Lead</button><button type="button" data-climb-discipline="toprope">Top rope</button></div></div><div class="climb-category-caption"><strong data-climb-category-label></strong><span>A separate history and climb library</span></div></section>`}
    <div class="climb-status" role="status"><span data-climb-status>Load your saved workouts to begin.</span><button type="button" class="text-button" data-climb-retry hidden>Retry</button></div>
    <div class="climb-notice" role="status" hidden><span data-climb-notice></span><button type="button" class="text-button" data-climb-undo hidden>Undo delete</button><button type="button" class="climb-icon-button" data-climb-dismiss aria-label="Dismiss climbing message">×</button></div>
    <div class="climb-filters"><label><span data-climb-venue-label>Gym / crag</span><select data-climb-filter-venue aria-label="Filter climbing location"><option value="">All locations</option></select></label><label>Date<input type="date" data-climb-filter-date aria-label="Filter climbing workout date"></label><label class="climb-search-label">Find a workout or climb<input type="search" data-climb-search placeholder="Name, grade, tag or notes…"></label><button type="button" class="text-button" data-climb-clear-filters>Clear filters</button></div>
    <div data-climb-analytics></div>
    <div class="climb-history-toolbar"><div><span class="eyebrow">SESSION HISTORY</span><h3 data-climb-history-heading></h3><p data-climb-history-count></p></div><button type="button" class="text-button" data-climb-toggle-deleted aria-pressed="false">Deleted workouts</button></div>
    <div class="climb-workout-list" data-climb-workouts></div>
    <dialog class="climb-dialog" aria-labelledby="${prefix}-editor-title"><form class="climb-editor-form" data-climb-form>
      <header class="climb-dialog-heading"><div><span class="eyebrow" data-climb-editor-category></span><h2 id="${prefix}-editor-title">New workout</h2><p>Record a session now and add or edit attempts whenever you need.</p></div><button type="button" class="climb-icon-button" data-climb-close aria-label="Close climbing workout">×</button></header>
      <div class="climb-form-scroll"><fieldset class="climb-form-content"><div class="climb-workout-basics"><label>Date<input type="date" data-work-field="date" required></label><label><span data-climb-form-venue-label>Gym / crag</span><input data-work-field="venue" list="${prefix}-venue-options" maxlength="160" placeholder="e.g. Your gym or crag"></label><label class="climb-title-field">Workout name <span class="climb-optional">optional</span><input data-work-field="title" maxlength="120" placeholder="e.g. Evening projects"></label>${board?'<label>Default angle for new attempts <span class="climb-optional">°</span><input type="number" data-work-field="defaultAngle" min="0" max="90" step="any" placeholder="e.g. 40"><small>Each attempt keeps its own angle.</small></label>':''}</div><datalist id="${prefix}-venue-options"></datalist>
      <p class="climb-form-context" data-climb-form-context></p>
      <div class="climb-attempts-heading"><h3>Climbs & attempts</h3><span data-climb-attempt-count></span></div><div data-climb-attempts></div>
      <section class="climb-add-panel" aria-label="Add a climb"><div class="climb-add-heading"><div><h3>Add a climb</h3><p>Reuse a saved climb or give a new one its own name.</p></div><button type="button" class="button button-outline" data-climb-add-new>＋ New climb</button></div><label class="climb-picker-search">Search saved climbs<input type="search" data-climb-picker-search placeholder="Type a name — case and punctuation don’t matter" autocomplete="off"></label><div class="climb-picker-row"><label><span data-climb-picker-label>Recent climbs</span><select data-climb-picker><option value="">Choose a climb…</option></select></label><button type="button" class="button climb-secondary" data-climb-add-existing disabled>Add attempt</button></div><div class="climb-picker-footer"><label class="climb-checkbox"><input type="checkbox" data-climb-older>Show older climbs</label><span data-climb-picker-caption role="status"></span></div></section>
      <label class="climb-workout-notes">Workout notes <span class="climb-optional">optional</span><textarea data-work-field="notes" maxlength="4000" rows="3" placeholder="How did the session feel? Anything to remember next time?"></textarea></label>
      </fieldset></div><div class="climb-form-error" role="alert" hidden><span data-climb-form-error></span><button type="button" class="text-button" data-climb-reload-draft hidden>Reload latest workout</button></div>
      <footer class="climb-dialog-footer"><span data-climb-save-hint>Workouts are saved with your site.</span><div><button type="button" class="button button-outline" data-climb-cancel>Cancel</button><button type="submit" class="button climb-primary" data-climb-save>Save workout</button></div></footer>
    </form></dialog>`;
  const dialog=q('.climb-dialog'),form=q('[data-climb-form]');
  const analytics=createClimbingAnalytics({host:q('[data-climb-analytics]'),kind});

  function allAttemptTotals(){
    // Cache by the complete active-workout snapshot, never by visible filters or picker scope.
    if(totalsSource!==workouts){attemptTotals=buildClimbAttemptTotals(workouts);totalsSource=workouts;}
    return attemptTotals;
  }
  function lifetimeLabel(totals){return countLabel(totals.attempts,'total attempt')+' · '+countLabel(totals.sessions,'session');}
  function categoryRows(rows=workouts){return rows.filter(workout=>workout.category===category);}
  function venues(rows=workouts,cat=category){const map=new Map();for(const w of rows.filter(w=>w.category===cat).sort((a,b)=>String(b.date).localeCompare(String(a.date))))if(w.venue&&!map.has(normalizeVenue(w.venue)))map.set(normalizeVenue(w.venue),w.venue);return [...map.values()].sort((a,b)=>a.localeCompare(b));}
  function setStatus(message,error=false){q('[data-climb-status]').textContent=message;q('[data-climb-retry]').hidden=!error;q('.climb-status').classList.toggle('climb-error',error);q('[data-climb-new]').disabled=!loaded||loading||actionPending;}
  function notice(message,error=false){q('[data-climb-notice]').textContent=message;q('.climb-notice').hidden=!message;q('.climb-notice').classList.toggle('climb-error',error);q('[data-climb-undo]').hidden=!lastDeleted;q('[data-climb-undo]').disabled=actionPending;announce(message);}
  function filterRows(rows){const nameQuery=climbNameKey(search);return categoryRows(rows).filter(w=>(!venueFilter||normalizeVenue(w.venue)===normalizeVenue(venueFilter))&&(!dateFilter||w.date===dateFilter)&&(!search||[w.title,w.venue,w.notes,...(w.attempts||[]).flatMap(a=>[a.name,a.notes,a.gradeMin,a.gradeMax,...(a.tags||[])])].join(' ').toLocaleLowerCase().includes(search.toLocaleLowerCase())||!nameQuery||(w.attempts||[]).some(a=>climbNameKey(a.name).includes(nameQuery)))).sort((a,b)=>b.date.localeCompare(a.date)||String(b.created_at).localeCompare(String(a.created_at)));}
  function render(){
    const info=currentInfo();
    if(!board){q('[data-climb-category-label]').textContent=info.label;host.querySelectorAll('[data-climb-environment]').forEach(b=>{const active=b.dataset.climbEnvironment===info.environment;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});host.querySelectorAll('[data-climb-discipline]').forEach(b=>{const active=b.dataset.climbDiscipline===info.discipline;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});}
    q('[data-climb-history-heading]').textContent=(showDeleted?'Deleted · ':'')+info.label;
    const source=showDeleted?deletedWorkouts:workouts,rows=filterRows(source),all=categoryRows(source);
    q('[data-climb-history-count]').textContent=loaded?`${rows.length} of ${all.length} ${all.length===1?'workout':'workouts'}${showDeleted?' · recoverable':' saved'}`:'Your saved history will appear here.';
    const availableVenues=venues([...workouts,...deletedWorkouts]);if(venueFilter&&!availableVenues.some(v=>normalizeVenue(v)===normalizeVenue(venueFilter)))availableVenues.push(venueFilter);
    q('[data-climb-filter-venue]').innerHTML='<option value="">All locations</option>'+availableVenues.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join('');q('[data-climb-filter-venue]').value=venueFilter;
    q('[data-climb-venue-label]').textContent=board?'Gym / board location':info.environment==='outdoor'?'Crag':'Gym';
    q('[data-climb-filter-date]').value=dateFilter;q('[data-climb-search]').value=search;
    q('[data-climb-toggle-deleted]').textContent=showDeleted?'Back to workouts':`Deleted workouts${categoryRows(deletedWorkouts).length?' ('+categoryRows(deletedWorkouts).length+')':''}`;
    q('[data-climb-toggle-deleted]').setAttribute('aria-pressed',String(showDeleted));
    q('[data-climb-new]').disabled=!loaded||loading||actionPending;
    q('[data-climb-analytics]').hidden=showDeleted;
    if(!showDeleted)analytics.update({workouts:filterRows(workouts),category,loaded,loading,failed:loadFailed,dateFilter,venueFilter,search});
    q('[data-climb-workouts]').innerHTML=rows.length?rows.map(renderWorkout).join(''):`<div class="climb-empty"><span class="climb-empty-mark" aria-hidden="true">${board?'◇':'↗'}</span><h3>${!loaded?'Your climbing history':showDeleted?'No deleted workouts':all.length?'No matching workouts':'Your first '+info.label.toLowerCase()+' session'}</h3><p>${!loaded?'Load your saved workouts to start logging.':showDeleted?'Deleted workouts can be restored here.':all.length?'Try another date, location or search.':'Create a dated workout, then add your climbs and attempts. This category has its own saved history.'}</p>${loaded&&!showDeleted&&!all.length?'<button type="button" class="button climb-primary" data-climb-new>＋ Create workout</button>':''}</div>`;
  }
  function renderAttempt(a,index,workoutCategory){
    const totals=climbAttemptTotalsFor(allAttemptTotals(),workoutCategory,a.climbId,a.angle);
    const lifetime=board?`${lifetimeLabel(totals)} · all angles<span>${countLabel(totals.angleAttempts??0,'attempt')} at ${number(a.angle)}°</span>`:lifetimeLabel(totals);
    return `<details class="climb-record"><summary><span class="climb-record-index">${index+1}</span><span class="climb-record-name"><strong>${esc(a.name||'Unnamed climb')}</strong><small>Session attempt ${a.attemptNumber}${board?' · '+number(a.angle)+'°':''}</small><small class="climb-record-lifetime">${lifetime}</small></span><span class="climb-grade-pill">${esc(formatClimbGrade(a))}</span><span class="climb-result ${a.completed?'climb-finished':'climb-unfinished'}">${a.completed?'Finished':'Not finished'}</span></summary><div class="climb-record-content">${a.tags?.length?`<div class="climb-tags">${a.tags.map(t=>`<span>${esc(t)}</span>`).join('')}</div>`:''}<dl class="climb-record-facts"><div><dt>Effort</dt><dd>${finite(a.effort)?number(a.effort)+' / 10':'Not recorded'}</dd></div><div><dt>Rest before</dt><dd>${esc(restLabel(a.restSeconds))}</dd></div><div><dt>Grade system</dt><dd>${esc(GRADE_SYSTEMS.find(s=>s.id===a.gradeSystem)?.label||a.gradeSystem)}</dd></div>${board?`<div><dt>Wall angle</dt><dd>${number(a.angle)}°</dd></div><div><dt>Lifetime at this angle</dt><dd>${countLabel(totals.angleAttempts??0,'attempt')} · ${countLabel(totals.angleSessions??0,'session')}</dd></div>`:''}</dl>${a.notes?`<p class="climb-record-notes">${esc(a.notes)}</p>`:''}</div></details>`;
  }
  function renderWorkout(w,index){
    const attempts=w.attempts||[],finished=attempts.filter(a=>a.completed).length,title=w.title||w.venue||categoryInfo(w.category)?.label||'Climbing workout';
    if(showDeleted)return `<article class="climb-workout-card climb-deleted-card"><div><span class="climb-workout-date">${esc(dateLabel(w.date))}</span><h3>${esc(title)}</h3><p>${esc(w.venue||'Location not recorded')} · ${attempts.length} logged ${attempts.length===1?'entry':'entries'}</p></div><button type="button" class="button button-outline" data-climb-restore="${esc(w.id)}" ${actionPending?'disabled':''}>Restore workout</button></article>`;
    return `<article class="climb-workout-card" data-workout-card="${esc(w.id)}"><header class="climb-workout-card-heading"><div><span class="climb-workout-date">${esc(dateLabel(w.date))}</span><h3>${esc(title)}</h3><p>${esc(w.venue||'Location not recorded')}${board&&finite(w.defaultAngle)?' · default '+number(w.defaultAngle)+'°':''}</p></div><span class="climb-workout-receipt">${attempts.length} logged ${attempts.length===1?'entry':'entries'}<small>${finished} finished</small></span></header>${w.notes?`<p class="climb-workout-saved-notes">${esc(w.notes)}</p>`:''}<details class="climb-workout-attempts" ${index===0?'open':''}><summary>${attempts.length?'Climbs & attempts':'No climbs added yet'}<span aria-hidden="true">＋</span></summary><div>${attempts.length?attempts.map((a,i)=>renderAttempt(a,i,w.category)).join(''):'<p class="climb-help">Use “Edit / add climbs” to begin logging this workout.</p>'}</div></details><footer class="climb-workout-actions"><button type="button" class="button button-outline" data-climb-edit="${esc(w.id)}" ${actionPending?'disabled':''}>Edit / add climbs</button><button type="button" class="text-button climb-delete-link" data-climb-delete="${esc(w.id)}" ${actionPending?'disabled':''}>Delete workout</button></footer><div class="climb-delete-confirm" data-delete-confirm="${esc(w.id)}" hidden><p>Delete this workout and its attempts? You can restore it from Deleted workouts.</p><button type="button" class="button climb-danger" data-climb-confirm-delete="${esc(w.id)}">Delete workout</button><button type="button" class="text-button" data-climb-keep="${esc(w.id)}">Keep workout</button></div></article>`;
  }
  async function request(method,payload,query=''){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);
    try{const response=await fetch('/api/climbing-workouts'+query,{method,cache:'no-store',headers:{Accept:'application/json',...(payload?{'Content-Type':'application/json'}:{})},...(payload?{body:JSON.stringify(payload)}:{}),signal:controller.signal});let body;try{body=await response.json();}catch{throw new Error('The saved-workout response could not be read. Keep your changes open and retry.');}if(!response.ok){const error=new Error(body.error||'This change could not be confirmed. Please retry.');error.conflict=response.status===409||body.conflict;error.field=body.field;throw error;}return body;}catch(error){if(error.name==='AbortError')throw new Error('The request timed out. Keep your draft open and retry; the same workout will not be added twice.');if(error instanceof TypeError)throw new Error('Couldn’t connect to saved workouts. Keep your draft open and retry.');throw error;}finally{clearTimeout(timer);}
  }
  async function load(){
    if(loading)return loadPromise;loading=true;const started=writeRevision;setStatus('Loading saved climbing workouts…');render();
    loadPromise=(async()=>{try{const body=await request('GET');if(!Array.isArray(body.workouts)||!Array.isArray(body.deletedWorkouts))throw new Error('Your saved climbing workouts could not be read.');if(started!==writeRevision)return;workouts=body.workouts;deletedWorkouts=body.deletedWorkouts;loaded=true;loadFailed=false;setStatus('Saved workouts are up to date.');}catch(error){loadFailed=true;setStatus(error.message,true);}finally{loading=false;render();q('[data-climb-new]').disabled=!loaded||actionPending;if(started!==writeRevision)load();}})();return loadPromise;
  }
  function putWorkout(workout){workouts=workouts.filter(w=>w.id!==workout.id);deletedWorkouts=deletedWorkouts.filter(w=>w.id!==workout.id);(workout.deleted_at?deletedWorkouts:workouts).push(workout);}
  function switchCategory(next){if(!categoryInfo(next)||(board?next!=='kilter':next==='kilter'))return;category=next;venueFilter='';showDeleted=false;savePreferences();render();announce(categoryInfo(category).label+' selected.');}
  function setFormError(message,conflict=false,field=''){
    q('[data-climb-form-error]').textContent=message+(conflict?' Your draft is still open. Reloading replaces it with the saved version.':'');q('.climb-form-error').hidden=!message;q('[data-climb-reload-draft]').hidden=!conflict||!draft?.id;
    if(field){const match=/^attempts\[(\d+)\]\.([A-Za-z]+)$/.exec(field);let input;if(match){const item=draft?.attempts[Number(match[1])],key=match[2]==='restSeconds'?'restMinutes':match[2];if(item)input=q(`[data-attempt-id="${item.id}"] [data-attempt-field="${key}"]`);}else if(/^[A-Za-z]+$/.test(field))input=q(`[data-work-field="${field}"]`);if(input){const details=input.closest('details');if(details)details.open=true;input.focus();}}
  }
  function availableClimbs(){return buildClimbCatalog(workouts,{category:draft.category,referenceDate:getTrainingToday(),includeOlder:preferences.includeOlder===true,venue:draft.venue||''});}
  function climbContext(item,angle=null){
    const chosenAngle=board?(angle??draft.defaultAngle??item.angle??null):null;
    const variant=board?(item.variants||[]).find(v=>v.angle===chosenAngle):null;
    const grade=board?(variant||(item.angle===chosenAngle?item:null)):item;
    const totals=climbAttemptTotalsFor(allAttemptTotals(),item.category||draft.category,item.climbId,chosenAngle);
    const lifetime=countLabel(totals.attempts,'total attempt')+(board?' (all angles)'+(finite(chosenAngle)?' · '+countLabel(totals.angleAttempts??0,'attempt')+' at '+number(chosenAngle)+'°':''):'');
    return {angle:chosenAngle,grade,details:[grade?formatClimbGrade(grade):'Grade not recorded',board&&finite(chosenAngle)?number(chosenAngle)+'°':'',lifetime,item.venue||'Location not recorded','Last logged '+dateLabel(variant?.lastLoggedDate||item.lastLoggedDate)].filter(Boolean).join(' · ')};
  }
  function renderPicker(){
    if(!draft)return;
    const catalog=availableClimbs(),selected=q('[data-climb-picker]').value;
    pickerItems=searchClimbCatalog(catalog,pickerQuery);
    q('[data-climb-picker]').innerHTML='<option value="">'+(pickerItems.length?'Choose a saved climb…':climbNameKey(pickerQuery)?'No saved climbs match this search':'No '+(preferences.includeOlder?'saved':'recent')+' climbs at this location')+'</option>'+pickerItems.map(item=>`<option value="${esc(item.climbId)}">${esc((item.name||'Unnamed climb')+' · '+climbContext(item).details)}</option>`).join('');
    if(pickerItems.some(item=>item.climbId===selected))q('[data-climb-picker]').value=selected;
    q('[data-climb-older]').checked=preferences.includeOlder===true;
    q('[data-climb-picker-label]').textContent=preferences.includeOlder?'All saved climbs':'Recent climbs';
    q('[data-climb-add-existing]').disabled=!q('[data-climb-picker]').value||draft.attempts.length>=100;
    q('[data-climb-add-new]').disabled=draft.attempts.length>=100;
    q('[data-climb-picker-caption]').textContent=(preferences.includeOlder?'All saved dates':'Logged in the last 30 days')+' · '+pickerItems.length+(climbNameKey(pickerQuery)?' of '+catalog.length:'')+' '+(catalog.length===1?'climb':'climbs')+(draft.venue?' at this location':'');
  }
  function closeNameSuggestions(){
    if(!nameSuggestions)return;
    const input=q(`[data-attempt-id="${nameSuggestions.attemptId}"] [data-attempt-field="name"]`),popover=q(`[data-climb-name-popover="${nameSuggestions.attemptId}"]`);
    if(input){input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');}
    if(popover)popover.hidden=true;
    nameSuggestions=null;
  }
  function focusNameSilently(input){
    if(document.activeElement!==input){ignoreNameFocus=input.closest('[data-attempt-id]').dataset.attemptId;input.focus({preventScroll:true});}
  }
  function renderNameSuggestions(input,{browse=false}={}){
    if(!draft||saving||!input?.isConnected)return;
    readDraft();
    const attemptId=input.closest('[data-attempt-id]').dataset.attemptId,row=draft.attempts.find(a=>a.id===attemptId);
    if(!row)return;
    if(nameSuggestions?.attemptId!==attemptId)closeNameSuggestions();
    const catalog=availableClimbs(),query=browse?'':input.value,items=searchClimbCatalog(catalog,query),popover=q(`[data-climb-name-popover="${attemptId}"]`);
    nameSuggestions={attemptId,items,activeIndex:-1,browse};
    const listId=`${prefix}-saved-climbs-${attemptId}`;
    popover.innerHTML=`<div class="climb-name-popover-heading"><span>Saved climbs · ${preferences.includeOlder?'all dates':'last 30 days'}</span><button type="button" class="climb-name-close" data-climb-close-suggestions aria-label="Close saved climb suggestions">×</button></div><div class="climb-name-list" id="${listId}" role="listbox" aria-label="Saved climbs for attempt ${draft.attempts.indexOf(row)+1}">${items.map((item,index)=>`<button type="button" class="climb-name-option" role="option" id="${listId}-${index}" aria-selected="false" tabindex="-1" data-climb-name-option="${index}"><strong>${esc(item.name||'Unnamed climb')}</strong><span>${esc(climbContext(item,row.angle).details)}</span></button>`).join('')}</div>${items.length?'':`<p class="climb-name-empty">${climbNameKey(query)?'No matching saved climbs.':'No saved climbs in this selection.'} Keep the typed name to log a new climb.</p>`}<div class="climb-name-popover-footer"><span role="status">${items.length} ${items.length===1?'match':'matches'}${draft.venue?' at this location':''}</span><button type="button" class="text-button" data-climb-suggestions-older>${preferences.includeOlder?'Recent climbs only':'Show older climbs'}</button></div>`;
    popover.hidden=false;input.setAttribute('aria-expanded','true');input.removeAttribute('aria-activedescendant');
  }
  function highlightNameSuggestion(index){
    if(!nameSuggestions?.items.length)return;
    nameSuggestions.activeIndex=(index+nameSuggestions.items.length)%nameSuggestions.items.length;
    const input=q(`[data-attempt-id="${nameSuggestions.attemptId}"] [data-attempt-field="name"]`),popover=q(`[data-climb-name-popover="${nameSuggestions.attemptId}"]`);
    popover.querySelectorAll('[data-climb-name-option]').forEach((option,i)=>option.setAttribute('aria-selected',String(i===nameSuggestions.activeIndex)));
    const option=popover.querySelector(`[data-climb-name-option="${nameSuggestions.activeIndex}"]`);
    input.setAttribute('aria-activedescendant',option.id);option.scrollIntoView({block:'nearest'});
  }
  function selectNameSuggestion(index){
    if(!nameSuggestions||saving)return;
    const {attemptId,items}=nameSuggestions,item=items[index];if(!item)return;
    readDraft();const row=draft.attempts.find(a=>a.id===attemptId);if(!row)return;
    // Selection is explicit: matching text alone never changes a climb identity.
    const {angle,grade}=climbContext(item,row.angle),changedIdentity=row.climbId!==item.climbId||row.angle!==angle;
    row.climbId=item.climbId;row.name=item.name||'';row.tags=[...(item.tags||[])];
    row.angle=angle;row.gradeSystem=grade?.gradeSystem||defaultGradeSystem();row.gradeMin=grade?.gradeMin||'';row.gradeMax=grade?.gradeMax||'';
    if(changedIdentity&&freshBlankAttempts.has(row.id)&&!editedAttemptNumbers.has(row.id))row.attemptNumber=attemptNumber(row.climbId,row.angle,row.id);
    if(!draft.venue&&item.venue){draft.venue=item.venue;q('[data-work-field="venue"]').value=item.venue;}
    const el=q(`[data-attempt-id="${row.id}"]`);
    for(const key of ['name','gradeSystem','gradeMin','gradeMax','attemptNumber','angle']){const field=el.querySelector(`[data-attempt-field="${key}"]`);if(field)field.value=row[key]??'';}
    el.querySelector('[data-attempt-field="tags"]').value=row.tags.join(', ');
    el.querySelectorAll('[data-climb-tag]').forEach(button=>button.setAttribute('aria-pressed',String(row.tags.some(tag=>tag.toLocaleLowerCase()===button.dataset.climbTag.toLocaleLowerCase()))));
    if(board)el.querySelector('.climb-angle-help').textContent=grade?'The saved grade for this angle has been filled in. You can edit it.':'This angle has no saved grade. Enter its grade above.';
    dirty=true;closeNameSuggestions();updateAttemptSummary(el);renderPicker();
    q('[data-climb-save-hint]').textContent='Saved climb selected. Review its grade and tags; your attempt details are kept.';
    announce((item.name||'Unnamed climb')+' selected from saved climbs.');focusNameSilently(el.querySelector('[data-attempt-field="name"]'));
  }
  function fillBasics(){
    for(const key of ['date','venue','title','notes','defaultAngle']){const input=q(`[data-work-field="${key}"]`);if(input)input.value=draft[key]??'';}
    const info=categoryInfo(draft.category);q('[data-climb-editor-category]').textContent=info.label.toUpperCase();q('[data-climb-form-venue-label]').textContent=board?'Gym / board location':info.environment==='outdoor'?'Crag':'Gym';
    q('[data-climb-form-context]').textContent=info.label+' · The category and location apply to every climb in this workout.';
    q(`#${prefix}-venue-options`).innerHTML=venues(workouts,draft.category).map(v=>`<option value="${esc(v)}"></option>`).join('');
  }
  async function openNew(options={}){
    if(dialog.open||saving||actionPending)return;
    if(!loaded){await load();if(!loaded){notice('Load your saved climbing workouts before starting a new one.',true);return;}}
    if(dialog.open||saving||actionPending)return;
    if(categoryInfo(options.category)&&!board&&options.category!=='kilter'&&options.category!==category)switchCategory(options.category);
    openEditor(null,options);
  }
  function openEditor(workout=null,options={}){
    if(saving||actionPending||!loaded||dialog.open)return;initialFocus=document.activeElement;
    const recent=categoryRows().sort((a,b)=>b.date.localeCompare(a.date))[0];
    draft=workout?clone(workout):{id:uuid(),date:options.date||getTrainingToday(),category,venue:venueFilter||recent?.venue||'',title:options.title||'',notes:'',defaultAngle:board?(recent?.defaultAngle??null):null,attempts:[]};
    dirty=false;pickerQuery='';q('[data-climb-picker-search]').value='';closeNameSuggestions();freshBlankAttempts.clear();editedAttemptNumbers.clear();fillBasics();q('[data-climb-save-hint]').textContent='Workouts are saved with your site.';q(`#${prefix}-editor-title`).textContent=workout?'Edit workout':'New workout';q('[data-climb-save]').textContent=workout?'Save changes':'Save workout';setFormError('');renderAttempts();renderPicker();dialog.showModal();q('[data-work-field="date"]').focus();
  }
  function readDraft(){
    if(!draft)return;for(const key of ['date','venue','title','notes']){const value=q(`[data-work-field="${key}"]`).value;if(key!=='notes'||value!==displayedNote(draft.notes))draft[key]=value;}
    draft.defaultAngle=board?blankNumber(q('[data-work-field="defaultAngle"]').value):null;
    const prior=new Map(draft.attempts.map(a=>[a.id,a]));
    draft.attempts=[...q('[data-climb-attempts]').querySelectorAll('[data-attempt-id]')].map(el=>{
      const row={...prior.get(el.dataset.attemptId)},v=key=>el.querySelector(`[data-attempt-field="${key}"]`).value;
      row.name=v('name');row.gradeSystem=v('gradeSystem');row.gradeMin=v('gradeMin');row.gradeMax=v('gradeMax');row.attemptNumber=blankNumber(v('attemptNumber'));row.completed=v('completed')==='yes'?true:v('completed')==='no'?false:null;
      row.effort=blankNumber(v('effort'));const restInput=v('restMinutes'),minutes=blankNumber(restInput);if(restInput!==(finite(row.restSeconds)?String(row.restSeconds/60):''))row.restSeconds=minutes===null?null:Math.round(minutes*60);row.tags=v('tags').split(',').map(t=>t.trim()).filter(Boolean);if(v('notes')!==displayedNote(row.notes))row.notes=v('notes');row.angle=board?blankNumber(v('angle')):null;return row;
    });
  }
  function defaultGradeSystem(){return categoryInfo(draft.category).discipline==='boulder'?'v':'yds';}
  function attemptNumber(climbId,angle,excludeId=null){return Math.max(0,...draft.attempts.filter(a=>a.id!==excludeId&&a.climbId===climbId&&(!board||a.angle===angle)).map(a=>finite(a.attemptNumber)?a.attemptNumber:0))+1;}
  function newAttempt(item=null){
    const angle=board?(draft.defaultAngle??item?.angle??null):null,variant=board&&item?(item.variants||[]).find(v=>v.angle===angle):null;
    const gradeSource=board&&item?(variant||(item.angle===angle?item:null)):item;
    const climbId=item?.climbId||uuid();return {id:uuid(),climbId,name:item?.name||'',tags:[...(item?.tags||[])],gradeSystem:gradeSource?.gradeSystem||defaultGradeSystem(),gradeMin:gradeSource?.gradeMin||'',gradeMax:gradeSource?.gradeMax||'',attemptNumber:attemptNumber(climbId,angle),completed:null,restSeconds:null,effort:null,notes:'',angle};
  }
  function renderAttempts(openId=''){
    if(!draft)return;closeNameSuggestions();const openIds=new Set([...q('[data-climb-attempts]').querySelectorAll('details[open]')].map(el=>el.dataset.attemptId));if(openId)openIds.add(openId);
    q('[data-climb-attempt-count]').textContent=`${draft.attempts.length} / 100 logged entries`;
    q('[data-climb-attempts]').innerHTML=draft.attempts.length?draft.attempts.map((a,index)=>{
      const input=(key,label,attrs='',value=a[key]??'')=>`<label>${label}<input data-attempt-field="${key}" aria-label="Attempt ${index+1} ${label.replace(/<[^>]*>/g,'')}" value="${esc(value)}" ${attrs}></label>`;
      return `<details class="climb-attempt-editor" data-attempt-id="${a.id}" ${openIds.has(a.id)?'open':''}><summary><span class="climb-attempt-number">${index+1}</span><span><strong data-attempt-summary-name>${esc(a.name||'New climb')}</strong><small data-attempt-summary-meta>Session attempt ${a.attemptNumber||1} · ${esc(formatClimbGrade(a))}${board&&finite(a.angle)?' · '+number(a.angle)+'°':''}</small></span><span class="climb-editor-result" data-attempt-summary-result>${a.completed===true?'Finished':a.completed===false?'Not finished':'Result needed'}</span></summary><div class="climb-attempt-fields"><div class="climb-name-picker">${input('name','Climb name <span class="climb-optional">optional</span>',`maxlength="160" placeholder="Type a new or saved climb name" autocomplete="off" role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded="false" aria-controls="${prefix}-saved-climbs-${a.id}"`)}<button type="button" class="climb-name-browse" data-climb-browse-names="${a.id}" aria-label="Browse saved climbs for attempt ${index+1}">⌄</button><div class="climb-name-popover" data-climb-name-popover="${a.id}" hidden><div id="${prefix}-saved-climbs-${a.id}" role="listbox" aria-label="Saved climbs"></div></div></div>
      <div class="climb-grade-fields"><label>Grade system<select data-attempt-field="gradeSystem" aria-label="Attempt ${index+1} grade system">${GRADE_SYSTEMS.map(system=>`<option value="${system.id}" ${a.gradeSystem===system.id?'selected':''}>${esc(system.label)}</option>`).join('')}</select></label>${input('gradeMin','Grade / from','maxlength="40" placeholder="e.g. V5 or 5.11a"')}${input('gradeMax','Range to <span class="climb-optional">optional</span>','maxlength="40" placeholder="e.g. V7 or 5.11c"')}</div>
      <div class="climb-attempt-measures">${input('attemptNumber','Attempt # in workout','type="number" min="1" max="9999" step="1" required')}<label>Result<select data-attempt-field="completed" aria-label="Attempt ${index+1} result" required><option value="">Choose result</option><option value="yes" ${a.completed===true?'selected':''}>Finished</option><option value="no" ${a.completed===false?'selected':''}>Not finished</option></select></label>${input('effort','Effort / 10 <span class="climb-optional">optional</span>','type="number" min="1" max="10" step="0.5" placeholder="1–10"')}</div>
      <p class="climb-attempt-count-help">Numbers restart each workout. Lifetime totals add the highest attempt number for each climb${board?' at each angle':''} in every workout.</p>
      <div class="climb-rest-angle">${input('restMinutes','Rest before this attempt <span class="climb-optional">minutes</span>','type="number" min="0" max="1440" step="any" placeholder="e.g. 2.5"',finite(a.restSeconds)?String(a.restSeconds/60):'')}${board?input('angle','Wall angle <span class="climb-optional">°</span>','type="number" min="0" max="90" step="any" required placeholder="e.g. 40"'):''}</div>${board?'<p class="climb-angle-help" role="status">Grades belong to this angle. Changing the angle uses its saved grade, or clears the grade for you to enter.</p>':''}
      <label>Climb tags <span class="climb-optional">comma-separated</span><input data-attempt-field="tags" aria-label="Attempt ${index+1} tags" maxlength="700" value="${esc((a.tags||[]).join(', '))}" placeholder="e.g. crimps, overhang, technical"></label><div class="climb-tag-suggestions" aria-label="Suggested tags">${TAG_SUGGESTIONS.map(tag=>`<button type="button" data-climb-tag="${tag}" data-climb-tag-attempt="${a.id}" aria-pressed="${(a.tags||[]).some(t=>t.toLocaleLowerCase()===tag.toLocaleLowerCase())}">${tag}</button>`).join('')}</div><label>Attempt notes <span class="climb-optional">optional</span><textarea data-attempt-field="notes" aria-label="Attempt ${index+1} notes" maxlength="2000" rows="2" placeholder="Beta, crux, holds, what changed…">${esc(a.notes||'')}</textarea></label><div class="climb-attempt-actions"><button type="button" class="text-button" data-climb-repeat="${a.id}" ${draft.attempts.length>=100?'disabled':''}>＋ Another attempt on this climb</button><button type="button" class="text-button climb-delete-link" data-climb-remove="${a.id}">Remove attempt</button></div></div></details>`;
    }).join(''):'<div class="climb-empty-attempts"><strong>No attempts yet</strong><p>Add a new climb or choose one from your recent history. You can also save this empty workout and fill it in later.</p></div>';
    for(const row of draft.attempts)q(`[data-attempt-id="${row.id}"] [data-attempt-field="notes"]`).value=row.notes??'';
    q('[data-climb-add-new]').disabled=draft.attempts.length>=100;q('[data-climb-add-existing]').disabled=!q('[data-climb-picker]').value||draft.attempts.length>=100;
  }
  function updateAttemptSummary(el){if(!el)return;const v=key=>el.querySelector(`[data-attempt-field="${key}"]`)?.value;el.querySelector('[data-attempt-summary-name]').textContent=v('name')||'New climb';el.querySelector('[data-attempt-summary-meta]').textContent='Session attempt '+(v('attemptNumber')||1)+' · '+formatClimbGrade({gradeSystem:v('gradeSystem'),gradeMin:v('gradeMin'),gradeMax:v('gradeMax')})+(board&&v('angle')!==''?' · '+v('angle')+'°':'');el.querySelector('[data-attempt-summary-result]').textContent=v('completed')==='yes'?'Finished':v('completed')==='no'?'Not finished':'Result needed';}
  function addAttempt(item=null){readDraft();if(draft.attempts.length>=100)return;if(item&&!draft.venue&&item.venue){draft.venue=item.venue;q('[data-work-field="venue"]').value=item.venue;}const row=newAttempt(item);draft.attempts.push(row);if(!item)freshBlankAttempts.add(row.id);dirty=true;renderAttempts(row.id);renderPicker();q(`[data-attempt-id="${row.id}"] [data-attempt-field="${item?'completed':'name'}"]`)?.focus();}
  function closeEditor(){if(saving)return;if(dirty&&!window.confirm('Discard unsaved changes to this climbing workout?'))return;dirty=false;closeNameSuggestions();draft=null;dialog.close();(initialFocus?.isConnected&&!initialFocus.closest('[hidden]')?initialFocus:q('[data-climb-new]'))?.focus();}
  function setSaving(value){saving=value;if(value)closeNameSuggestions();q('.climb-form-content').disabled=value;q('[data-climb-save]').disabled=value||!loaded;q('[data-climb-cancel]').disabled=value;q('[data-climb-close]').disabled=value;q('[data-climb-save]').textContent=value?'Saving…':draft?.revision?'Save changes':'Save workout';}
  async function save(event){event.preventDefault();if(saving||!loaded)return;readDraft();setFormError('');let payload;try{const {canonicalPayload,...normalized}=normalizeClimbingWorkout(draft);payload={...normalized,...(draft.revision?{revision:draft.revision}:{})};}catch(error){setFormError(error.message,false,error.field);return;}setSaving(true);
    try{const body=await request(draft.revision?'PUT':'POST',payload);if(!body.workout?.id||!body.workout.revision)throw new Error('The save could not be confirmed. Keep your draft open and retry.');writeRevision++;putWorkout(body.workout);category=body.workout.category;venueFilter='';dateFilter='';search='';showDeleted=false;savePreferences();dirty=false;closeNameSuggestions();draft=null;dialog.close();render();setStatus('Saved workouts are up to date.');notice('Climbing workout saved.');onSaved(body.workout);(initialFocus?.isConnected&&!initialFocus.closest('[hidden]')?initialFocus:q('[data-climb-new]'))?.focus();load();}catch(error){setFormError(error.message,error.conflict,error.field);}finally{setSaving(false);}}
  async function reloadDraft(){if(!draft||saving||!window.confirm('Replace your unsaved changes with the latest saved workout?'))return;const id=draft.id;q('[data-climb-reload-draft]').disabled=true;try{const body=await request('GET'),latest=body.workouts?.find(w=>w.id===id);if(!latest)throw new Error('This workout is no longer active. Your draft remains open so you can keep its notes.');workouts=body.workouts;deletedWorkouts=body.deletedWorkouts||[];loaded=true;draft=clone(latest);dirty=false;freshBlankAttempts.clear();editedAttemptNumbers.clear();fillBasics();renderAttempts();renderPicker();setFormError('');render();announce('Latest saved climbing workout loaded.');}catch(error){setFormError(error.message,true);}finally{q('[data-climb-reload-draft]').disabled=false;}}
  async function deleteWorkout(id){if(actionPending)return;const workout=workouts.find(w=>w.id===id);if(!workout)return;actionPending=true;render();try{const body=await request('DELETE',null,'?id='+encodeURIComponent(id)+'&revision='+workout.revision);writeRevision++;putWorkout({...workout,revision:body.revision,deleted_at:body.deleted_at||new Date().toISOString()});lastDeleted={id,revision:body.revision};notice('Workout deleted. You can undo this or restore it from Deleted workouts.');}catch(error){notice(error.message,true);}finally{actionPending=false;render();q('[data-climb-undo]').disabled=false;load();}}
  async function restoreWorkout(id=lastDeleted?.id){if(actionPending||!id)return;const workout=deletedWorkouts.find(w=>w.id===id),revision=workout?.revision??lastDeleted?.revision;if(!revision)return;actionPending=true;render();q('[data-climb-undo]').disabled=true;try{const body=await request('PATCH',{id,revision,action:'restore'});if(!body.workout)throw new Error('Restoring this workout could not be confirmed. Please retry.');writeRevision++;putWorkout(body.workout);if(lastDeleted?.id===id)lastDeleted=null;notice('Workout restored.');onSaved(body.workout);}catch(error){notice(error.message,true);}finally{actionPending=false;render();q('[data-climb-undo]').disabled=false;load();}}

  host.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button||button.disabled||!host.contains(button))return;
    if(button.hasAttribute('data-climb-new'))openNew();
    else if(button.dataset.climbEnvironment)switchCategory(button.dataset.climbEnvironment+'_'+currentInfo().discipline);
    else if(button.dataset.climbDiscipline)switchCategory(currentInfo().environment+'_'+button.dataset.climbDiscipline);
    else if(button.hasAttribute('data-climb-retry'))load();
    else if(button.hasAttribute('data-climb-toggle-deleted')){showDeleted=!showDeleted;render();}
    else if(button.hasAttribute('data-climb-clear-filters')){venueFilter='';dateFilter='';search='';savePreferences();render();}
    else if(button.dataset.climbEdit)openEditor(workouts.find(w=>w.id===button.dataset.climbEdit));
    else if(button.dataset.climbDelete){q(`[data-delete-confirm="${button.dataset.climbDelete}"]`).hidden=false;}
    else if(button.dataset.climbKeep){q(`[data-delete-confirm="${button.dataset.climbKeep}"]`).hidden=true;}
    else if(button.dataset.climbConfirmDelete)deleteWorkout(button.dataset.climbConfirmDelete);
    else if(button.dataset.climbRestore)restoreWorkout(button.dataset.climbRestore);
    else if(button.hasAttribute('data-climb-undo'))restoreWorkout();
    else if(button.hasAttribute('data-climb-dismiss')){lastDeleted=null;notice('');}
    else if(button.hasAttribute('data-climb-close')||button.hasAttribute('data-climb-cancel'))closeEditor();
    else if(button.dataset.climbBrowseNames){
      const input=q(`[data-attempt-id="${button.dataset.climbBrowseNames}"] [data-attempt-field="name"]`);
      if(nameSuggestions?.attemptId===button.dataset.climbBrowseNames&&nameSuggestions.browse){closeNameSuggestions();focusNameSilently(input);}
      else{focusNameSilently(input);renderNameSuggestions(input,{browse:true});}
    }
    else if(button.hasAttribute('data-climb-name-option'))selectNameSuggestion(Number(button.dataset.climbNameOption));
    else if(button.hasAttribute('data-climb-close-suggestions')){const input=button.closest('[data-attempt-id]').querySelector('[data-attempt-field="name"]');closeNameSuggestions();focusNameSilently(input);}
    else if(button.hasAttribute('data-climb-suggestions-older')){
      const input=button.closest('[data-attempt-id]').querySelector('[data-attempt-field="name"]'),browse=nameSuggestions?.browse;
      readDraft();preferences.includeOlder=!preferences.includeOlder;savePreferences();renderPicker();focusNameSilently(input);renderNameSuggestions(input,{browse});
    }
    else if(button.hasAttribute('data-climb-add-new'))addAttempt();
    else if(button.hasAttribute('data-climb-add-existing')){const item=pickerItems.find(c=>c.climbId===q('[data-climb-picker]').value);if(item)addAttempt(item);}
    else if(button.dataset.climbRepeat){readDraft();if(draft.attempts.length>=100)return;const previous=draft.attempts.find(a=>a.id===button.dataset.climbRepeat);if(!previous)return;const a={...clone(previous),id:uuid(),attemptNumber:attemptNumber(previous.climbId,previous.angle),completed:null,restSeconds:null,effort:null,notes:''};draft.attempts.splice(draft.attempts.indexOf(previous)+1,0,a);dirty=true;renderAttempts(a.id);renderPicker();q(`[data-attempt-id="${a.id}"] [data-attempt-field="completed"]`).focus();}
    else if(button.dataset.climbRemove){readDraft();draft.attempts=draft.attempts.filter(a=>a.id!==button.dataset.climbRemove);freshBlankAttempts.delete(button.dataset.climbRemove);editedAttemptNumbers.delete(button.dataset.climbRemove);dirty=true;renderAttempts();renderPicker();}
    else if(button.dataset.climbTag){const el=q(`[data-attempt-id="${button.dataset.climbTagAttempt}"]`),input=el.querySelector('[data-attempt-field="tags"]'),tags=input.value.split(',').map(t=>t.trim()).filter(Boolean),found=tags.findIndex(t=>t.toLocaleLowerCase()===button.dataset.climbTag.toLocaleLowerCase());if(found>=0)tags.splice(found,1);else tags.push(button.dataset.climbTag);input.value=tags.join(', ');button.setAttribute('aria-pressed',String(found<0));dirty=true;}
    else if(button.hasAttribute('data-climb-reload-draft'))reloadDraft();
  },events);
  q('[data-climb-filter-venue]').addEventListener('change',event=>{venueFilter=event.target.value;savePreferences();render();},events);
  q('[data-climb-filter-date]').addEventListener('change',event=>{dateFilter=event.target.value;render();},events);
  q('[data-climb-search]').addEventListener('input',event=>{search=event.target.value;const start=event.target.selectionStart,end=event.target.selectionEnd;render();q('[data-climb-search]').focus();q('[data-climb-search]').setSelectionRange(start,end);},events);
  q('[data-climb-picker-search]').addEventListener('input',event=>{readDraft();pickerQuery=event.target.value;renderPicker();},events);
  q('[data-climb-picker-search]').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();q('[data-climb-picker]').focus();}},events);
  q('[data-climb-picker]').addEventListener('change',()=>{q('[data-climb-add-existing]').disabled=!q('[data-climb-picker]').value||draft.attempts.length>=100;},events);
  q('[data-climb-older]').addEventListener('change',event=>{readDraft();preferences.includeOlder=event.target.checked;savePreferences();renderPicker();},events);
  q('[data-work-field="venue"]').addEventListener('change',()=>{readDraft();closeNameSuggestions();renderPicker();},events);
  form.addEventListener('focusin',event=>{
    if(!event.target.matches('[data-attempt-field="name"]'))return;
    const id=event.target.closest('[data-attempt-id]').dataset.attemptId;
    if(ignoreNameFocus===id){ignoreNameFocus=null;return;}
    renderNameSuggestions(event.target);
  },events);
  form.addEventListener('focusout',event=>{
    const picker=event.target.closest('.climb-name-picker');if(!picker)return;
    queueMicrotask(()=>{if(nameSuggestions&&picker.closest('[data-attempt-id]')?.dataset.attemptId===nameSuggestions.attemptId&&!picker.contains(document.activeElement))closeNameSuggestions();});
  },events);
  form.addEventListener('pointerdown',event=>{
    const option=event.target.closest('[data-climb-name-option]');
    if(option&&event.pointerType==='mouse')event.preventDefault();
    if(nameSuggestions){const picker=q(`[data-attempt-id="${nameSuggestions.attemptId}"] .climb-name-picker`);if(!picker?.contains(event.target))closeNameSuggestions();}
  },events);
  form.addEventListener('keydown',event=>{
    if(event.isComposing)return;
    const id=event.target.closest('[data-attempt-id]')?.dataset.attemptId;
    if(event.key==='Escape'&&nameSuggestions?.attemptId===id){event.preventDefault();event.stopPropagation();const input=q(`[data-attempt-id="${id}"] [data-attempt-field="name"]`);closeNameSuggestions();focusNameSilently(input);return;}
    if(!event.target.matches('[data-attempt-field="name"]'))return;
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();if(nameSuggestions?.attemptId!==id)renderNameSuggestions(event.target);
      if(nameSuggestions?.items.length)highlightNameSuggestion(nameSuggestions.activeIndex+(event.key==='ArrowDown'?1:nameSuggestions.activeIndex<0?0:-1));
    }else if(event.key==='Enter'&&nameSuggestions?.attemptId===id){
      event.preventDefault();if(nameSuggestions.activeIndex>=0)selectNameSuggestion(nameSuggestions.activeIndex);else announce('Use the arrow keys to choose a saved climb, or press Escape to keep the name you typed.');
    }else if(event.key==='Tab')closeNameSuggestions();
  },events);
  form.addEventListener('input',event=>{
    if(!event.target.matches('[data-work-field],[data-attempt-field]'))return;
    dirty=true;
    if(event.target.matches('[data-attempt-field="attemptNumber"]'))editedAttemptNumbers.add(event.target.closest('[data-attempt-id]').dataset.attemptId);
    updateAttemptSummary(event.target.closest('[data-attempt-id]'));
    if(event.target.matches('[data-attempt-field="name"]'))renderNameSuggestions(event.target);
  },events);
  form.addEventListener('change',event=>{
    if(!draft||!event.target.matches('[data-work-field],[data-attempt-field]'))return;
    if(event.target.matches('[data-work-field="defaultAngle"]')){readDraft();renderPicker();}
    if(event.target.matches('[data-attempt-field="attemptNumber"]'))editedAttemptNumbers.add(event.target.closest('[data-attempt-id]').dataset.attemptId);
    if(event.target.matches('[data-attempt-field="angle"]')){
      const el=event.target.closest('[data-attempt-id]'),id=el.dataset.attemptId,previousAngle=draft.attempts.find(a=>a.id===id)?.angle;
      readDraft();const row=draft.attempts.find(a=>a.id===id);
      if(previousAngle!==row.angle){
        const catalog=buildClimbCatalog(workouts,{category:draft.category,referenceDate:getTrainingToday(),includeOlder:true}),item=catalog.find(c=>c.climbId===row.climbId);
        const variant=[...draft.attempts].reverse().find(a=>a.id!==id&&a.climbId===row.climbId&&a.angle===row.angle&&a.gradeMin)||(item?.variants||[]).find(v=>v.angle===row.angle);
        // An initial angle gives a new grade context; it must not erase freshly entered text.
        if(finite(previousAngle)||!row.gradeMin){
          row.gradeSystem=variant?.gradeSystem||row.gradeSystem;row.gradeMin=variant?.gradeMin||'';row.gradeMax=variant?.gradeMax||'';
          el.querySelector('[data-attempt-field="gradeSystem"]').value=row.gradeSystem;el.querySelector('[data-attempt-field="gradeMin"]').value=row.gradeMin;el.querySelector('[data-attempt-field="gradeMax"]').value=row.gradeMax;
          el.querySelector('.climb-angle-help').textContent=variant?'The recorded grade for this angle has been filled in. You can edit it.':finite(previousAngle)?'This angle has no saved grade. Enter its grade above.':'Grades belong to this angle. You can enter a grade above.';
        }
      }
      updateAttemptSummary(el);
    }
    dirty=true;
  },events);
  form.addEventListener('invalid',event=>{const details=event.target.closest('details');if(details)details.open=true;}, {...events,capture:true});
  form.addEventListener('submit',save,events);dialog.addEventListener('cancel',event=>{event.preventDefault();closeEditor();},events);
  window.addEventListener('beforeunload',event=>{if(dialog.open&&dirty){event.preventDefault();event.returnValue='';}},events);
  render();
  return {load,activate(){render();return load();},openNew,destroy(){abort.abort();analytics.destroy();dialog.close();host.innerHTML='';host.classList.remove('climbing-tracker');}};
}
