import { normalizePlan, planSummary, PLAN_STATUSES, PLAN_STATUS_LABELS } from './plan-model.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const localDate=(date=new Date())=>[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
const toDate=value=>new Date(value+'T12:00:00');
const dateLabel=value=>new Intl.DateTimeFormat('en-CA',{weekday:'long',day:'numeric',month:'long',year:'numeric'}).format(toDate(value));
const monthLabel=value=>new Intl.DateTimeFormat('en-CA',{month:'long',year:'numeric'}).format(toDate(value+'-01'));
const clone=value=>JSON.parse(JSON.stringify(value));
function uuid(){if(crypto.randomUUID)return crypto.randomUUID();const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const s=[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;}
const target=()=>({id:uuid(),exercise:'',target:'',status:'planned',comment:''});

export function createCalendar({host,getRecords=()=>[],getCatalog=()=>[],isHistoryReady=()=>true,onLogExercise=()=>{},onInspectDate=()=>{},announce=()=>{}}) {
  let plans=[],loaded=false,loading=false,revision=0,selected=localDate(),month=selected.slice(0,7),draft=null,saving=false,deleted=null,deletePending=null,notice='',noticeError=false;
  const q=selector=>host.querySelector(selector);
  host.innerHTML=`
    <div class="calendar-heading"><div><span class="eyebrow">PLAN • TRAIN • REFLECT</span><h2>Workout calendar</h2><p>Set a target, log the work, then note how it went.</p></div><button type="button" class="button button-primary" data-cal-new>+ Plan workout</button></div>
    <div class="calendar-status" role="status"><span data-cal-status>Loading your plans…</span><button type="button" class="text-button" data-cal-retry hidden>Retry</button></div>
    <div class="calendar-notice" role="status" hidden><span data-cal-notice></span><button type="button" class="text-button" data-cal-undo hidden>Undo delete</button><button type="button" class="calendar-icon-button" data-cal-dismiss aria-label="Dismiss calendar message">×</button></div>
    <div class="calendar-layout"><section class="calendar-month-panel" aria-label="Monthly workout calendar"><div class="calendar-month-nav"><div class="calendar-month-name"><h3 data-cal-month></h3><label class="calendar-jump-label">Jump to month<input type="month" data-cal-jump aria-label="Jump to calendar month"></label></div><div class="calendar-nav-buttons"><button type="button" class="calendar-icon-button" data-cal-prev aria-label="Previous month">‹</button><button type="button" class="calendar-today" data-cal-today>Today</button><button type="button" class="calendar-icon-button" data-cal-next aria-label="Next month">›</button></div></div><div class="calendar-weekdays" aria-hidden="true">${['MON','TUE','WED','THU','FRI','SAT','SUN'].map(d=>'<span>'+d+'</span>').join('')}</div><div class="calendar-grid" data-cal-grid role="group" aria-label="Choose a day"></div><div class="calendar-legend"><span><i class="calendar-dot calendar-dot-plan"></i>Planned</span><span><i class="calendar-dot calendar-dot-reviewed"></i>Reviewed</span><span><i class="calendar-dot calendar-dot-logged"></i>Workout logged</span></div><p class="calendar-month-summary" data-cal-summary></p></section><section class="calendar-day-panel" aria-label="Selected day's workouts"><div data-cal-day></div></section></div>
    <dialog class="calendar-dialog" aria-labelledby="calendar-editor-title"><form data-cal-form><div class="calendar-dialog-head"><div><span class="eyebrow">YOUR NEXT SESSION</span><h2 id="calendar-editor-title">Plan a workout</h2><p>Write targets in your own terms. Review each one after training.</p></div><button type="button" class="calendar-icon-button" data-cal-close aria-label="Close workout plan">×</button></div><fieldset class="calendar-form-fields"><div class="calendar-plan-basics"><label>Workout title<input name="title" maxlength="120" required placeholder="e.g. Pull + hangboard"></label><label>Date<input type="date" name="date" required></label></div><div class="calendar-targets-head"><h3>Targets & results</h3><span>Only you mark a target as hit</span></div><div data-cal-targets></div><button type="button" class="button button-outline calendar-add-target" data-cal-add>+ Add target</button><label class="calendar-notes-label">Workout notes<textarea name="notes" maxlength="4000" rows="3" placeholder="What helped? What would you change next time?"></textarea></label><datalist id="calendar-exercise-options"></datalist></fieldset><div class="calendar-form-error" role="alert" hidden><span data-cal-form-error></span><button type="button" class="text-button" data-cal-reload hidden>Reload latest plan</button></div><div class="calendar-dialog-footer"><span data-cal-save-hint>Targets and comments are saved with your site.</span><div><button type="button" class="button button-outline" data-cal-cancel>Cancel</button><button type="submit" class="button button-primary" data-cal-save>Save plan</button></div></div></form></dialog>`;
  const dialog=q('dialog'),form=q('[data-cal-form]');
  function recordsByDay(){const days=new Map();for(const row of getRecords()){if(!days.has(row.date))days.set(row.date,[]);days.get(row.date).push(row);}return days;}
  function setStatus(message,error=false){q('[data-cal-status]').textContent=message;q('[data-cal-retry]').hidden=!error;q('.calendar-status').classList.toggle('calendar-error',error);}
  function showNotice(message,error=false){notice=message;noticeError=error;q('[data-cal-notice]').textContent=message;q('.calendar-notice').hidden=!message;q('.calendar-notice').classList.toggle('calendar-error',error);q('[data-cal-undo]').hidden=!deleted;q('[data-cal-undo]').disabled=false;announce(message);}
  function putPlan(plan){plans=[...plans.filter(p=>p.id!==plan.id),plan];}
  function render(){
    const days=recordsByDay(),today=localDate(),first=toDate(month+'-01'),start=new Date(first);start.setDate(1-((first.getDay()+6)%7));
    const final=new Date(first.getFullYear(),first.getMonth()+1,0,12);const cellCount=Math.ceil((((first.getDay()+6)%7)+final.getDate())/7)*7;
    q('[data-cal-month]').textContent=monthLabel(month);q('[data-cal-jump]').value=month;
    const cells=[];
    for(let i=0;i<cellCount;i++){
      const date=new Date(start);date.setDate(start.getDate()+i);const key=localDate(date),dayPlans=plans.filter(p=>p.date===key),rows=days.get(key)||[],reviewed=dayPlans.filter(p=>planSummary(p).reviewed===p.targets.length).length;
      const label=dateLabel(key)+`, ${dayPlans.length} planned workout${dayPlans.length===1?'':'s'}, ${rows.length} logged record${rows.length===1?'':'s'}`;
      cells.push(`<button type="button" class="calendar-day${key.slice(0,7)!==month?' calendar-outside':''}${key===selected?' calendar-selected':''}${key===today?' calendar-current':''}" data-cal-date="${key}" aria-label="${esc(label)}" aria-pressed="${key===selected}" ${key===today?'aria-current="date"':''}><span class="calendar-day-number">${date.getDate()}</span><span class="calendar-day-events">${dayPlans.length?`<span class="calendar-event-label${reviewed===dayPlans.length?' calendar-event-reviewed':''}">${esc(dayPlans[0].title)}</span>${dayPlans.length>1?`<span class="calendar-more-plans">+${dayPlans.length-1} more</span>`:''}`:''}${rows.length?`<span class="calendar-logged-label">${rows.length} record${rows.length===1?'':'s'} logged</span>`:''}</span><span class="calendar-day-dots" aria-hidden="true">${dayPlans.length>reviewed?'<i class="calendar-dot calendar-dot-plan"></i>':''}${reviewed?'<i class="calendar-dot calendar-dot-reviewed"></i>':''}${rows.length?'<i class="calendar-dot calendar-dot-logged"></i>':''}</span></button>`);
    }
    q('[data-cal-grid]').innerHTML=cells.join('');
    const monthPlans=plans.filter(p=>p.date.startsWith(month)),loggedDays=[...days.keys()].filter(d=>d.startsWith(month)).length;
    q('[data-cal-summary]').textContent=`${monthPlans.length} planned workout${monthPlans.length===1?'':'s'} · ${monthPlans.filter(p=>planSummary(p).reviewed===p.targets.length).length} reviewed · ${loggedDays} day${loggedDays===1?'':'s'} with logged training`;
    const dayPlans=plans.filter(p=>p.date===selected).sort((a,b)=>a.created_at.localeCompare(b.created_at)),rows=days.get(selected)||[],exerciseGroups=new Map();
    rows.forEach(row=>{if(!exerciseGroups.has(row.exercise))exerciseGroups.set(row.exercise,[]);exerciseGroups.get(row.exercise).push(row);});
    q('[data-cal-day]').innerHTML=`<div class="calendar-day-heading"><span class="eyebrow">SELECTED DAY</span><h3>${esc(dateLabel(selected))}</h3><button type="button" class="text-button" data-cal-new-day>+ Plan for this day</button></div><div class="calendar-plans">${dayPlans.length?dayPlans.map(renderPlan).join(''):`<div class="calendar-empty"><span class="calendar-empty-icon" aria-hidden="true">＋</span><strong>${!loaded?'Plans not loaded yet':'No workout planned'}</strong><p>${!loaded?'Load your saved plans to see what is scheduled. You can still create a new plan.':'Add a few targets for this day. You can review them after training.'}</p></div>`}</div><div class="calendar-actual"><div class="calendar-actual-heading"><h4>What you logged</h4><button type="button" class="text-button" data-cal-log>+ Log exercise</button></div>${!isHistoryReady()?'<p class="calendar-help calendar-error">Saved history is not fully loaded yet. The workouts below may be incomplete.</p>':''}${rows.length?`<p class="calendar-help">${rows.length} loaded record${rows.length===1?'':'s'} across ${exerciseGroups.size} exercise${exerciseGroups.size===1?'':'s'}. Review results yourself against the plan.</p><div class="calendar-actual-list">${[...exerciseGroups].map(([name,sets])=>`<button type="button" data-cal-inspect="${esc(name)}"><span><strong>${esc(name)}</strong><small>${esc(actualSummary(sets))}</small></span><span aria-hidden="true">↗</span></button>`).join('')}</div>`:`<p class="calendar-help">${isHistoryReady()?'No saved exercises on this date yet.':'No exercises are loaded for this date yet.'}</p>`}</div>`;
  }
  function actualSummary(rows){
    const timed=rows.filter(r=>Number.isFinite(r.duration_s));
    if(timed.length===rows.length){const holds=timed.reduce((sum,r)=>sum+(r.hold_count||1),0),seconds=timed.reduce((sum,r)=>sum+r.duration_s*(r.hold_count||1),0);return `${holds} hangs / holds · ${new Intl.NumberFormat('en-CA',{maximumFractionDigits:1}).format(seconds)} s active time`;}
    const reps=rows.filter(r=>Number.isFinite(r.reps)).reduce((sum,r)=>sum+r.reps,0);return `${rows.length} sets${reps?' · '+reps+' recorded reps':''}`;
  }
  function renderPlan(plan){
    const summary=planSummary(plan),reviewed=summary.reviewed===summary.total;
    return `<article class="calendar-plan-card"><div class="calendar-plan-card-head"><h4>${esc(plan.title)}</h4><span class="calendar-plan-badge${reviewed?' calendar-reviewed':''}">${esc(summary.label)}</span></div><ul class="calendar-target-list">${plan.targets.map(t=>`<li><span class="calendar-target-status calendar-status-${t.status}" title="${esc(PLAN_STATUS_LABELS[t.status])}" aria-label="${esc(PLAN_STATUS_LABELS[t.status])}">${{planned:'○',hit:'✓',partial:'◐',missed:'×',skipped:'–'}[t.status]}</span><div><strong>${esc(t.exercise)}</strong><p>${esc(t.target)}</p>${t.status!=='planned'?`<span class="calendar-result-label">${esc(PLAN_STATUS_LABELS[t.status])}</span>`:''}${t.comment?`<blockquote>${esc(t.comment)}</blockquote>`:''}</div></li>`).join('')}</ul>${plan.notes?`<div class="calendar-plan-notes"><span>Workout notes</span><p>${esc(plan.notes)}</p></div>`:''}<div class="calendar-plan-actions"><button type="button" class="button button-outline" data-cal-edit="${plan.id}">${summary.reviewed?'Edit / review':'Review targets'}</button><button type="button" class="text-button" data-cal-log-plan="${plan.id}">Log actual</button><button type="button" class="calendar-delete-link" data-cal-delete="${plan.id}" aria-label="Delete ${esc(plan.title)}">Delete</button></div>${deletePending===plan.id?`<div class="calendar-delete-confirm"><p>Delete this plan and its reviews?</p><button type="button" class="calendar-danger-button" data-cal-confirm-delete="${plan.id}">Delete plan</button><button type="button" class="text-button" data-cal-keep>Keep plan</button></div>`:''}</article>`;
  }
  async function request(method,payload,query=''){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
    try{const response=await fetch('/api/plans'+query,{method,cache:'no-store',headers:{Accept:'application/json',...(payload?{'Content-Type':'application/json'}:{})},...(payload?{body:JSON.stringify(payload)}:{}),signal:controller.signal});let body;try{body=await response.json();}catch{throw new Error('The response could not be read. Keep your draft open and retry.');}if(!response.ok){const error=new Error(body.error||'The change could not be saved. Please retry.');error.conflict=body.conflict||response.status===409;throw error;}return body;}catch(error){if(error.name==='AbortError')throw new Error('The request timed out. Retry to confirm the change; it will not duplicate a plan.');throw error;}finally{clearTimeout(timer);}
  }
  async function load(){
    if(loading)return;loading=true;const started=revision;setStatus('Loading saved plans…');
    try{const body=await request('GET');if(!Array.isArray(body.plans))throw new Error('Your saved plans could not be read.');if(started!==revision)return;plans=body.plans;loaded=true;setStatus('Plans and reviews are up to date.');render();}
    catch(error){setStatus('Couldn’t load saved plans. Your draft and logged workout history are still available.',true);}
    finally{loading=false;if(started!==revision)load();}
  }
  function selectDate(date,focus=false){selected=date;month=date.slice(0,7);deletePending=null;render();if(focus)q(`[data-cal-date="${date}"]`)?.focus();}
  function readDraft(){if(!draft)return;draft.title=form.elements.title.value;draft.date=form.elements.date.value;draft.notes=form.elements.notes.value;draft.targets=[...q('[data-cal-targets]').children].map(el=>({id:el.dataset.targetId,exercise:el.querySelector('[data-field="exercise"]').value,target:el.querySelector('[data-field="target"]').value,status:el.querySelector('[data-field="status"]').value,comment:el.querySelector('[data-field="comment"]').value}));}
  function renderTargets(){q('[data-cal-targets]').innerHTML=draft.targets.map((item,index)=>`<section class="calendar-target-editor" data-target-id="${item.id}"><div class="calendar-target-editor-head"><strong>Target ${index+1}</strong><button type="button" class="calendar-remove-target" data-cal-remove="${item.id}" ${draft.targets.length<2?'disabled':''}>Remove</button></div><label>Exercise or activity<input data-field="exercise" list="calendar-exercise-options" maxlength="120" required placeholder="e.g. Pull-up or Hangboard" value="${esc(item.exercise)}"></label><label>Target<textarea data-field="target" maxlength="1000" rows="2" required placeholder="e.g. 3 sets of 8 at 50 lb, or 3 rounds × 6 hangs at 7s on / 3s off">${esc(item.target)}</textarea></label><div class="calendar-review-fields"><label>Result<select data-field="status">${PLAN_STATUSES.map(status=>`<option value="${status}" ${item.status===status?'selected':''}>${PLAN_STATUS_LABELS[status]}</option>`).join('')}</select></label><label>What happened? <span class="calendar-optional">Optional</span><textarea data-field="comment" maxlength="2000" rows="2" placeholder="e.g. First two sets hit; last set stopped at 6 reps.">${esc(item.comment)}</textarea></label></div></section>`).join('');q('[data-cal-add]').disabled=draft.targets.length>=30;}
  function showFormError(message,conflict=false){q('[data-cal-form-error]').textContent=message+(conflict?' Your draft stays open. Reloading replaces it with the saved version.':'');q('.calendar-form-error').hidden=!message;q('[data-cal-reload]').hidden=!conflict||!draft?.revision;}
  function openEditor(plan=null){
    draft=plan?clone(plan):{id:uuid(),date:selected,title:'',targets:[target()],notes:''};
    q('#calendar-editor-title').textContent=plan?'Edit plan & review targets':'Plan a workout';
    form.elements.title.value=draft.title;form.elements.date.value=draft.date;form.elements.notes.value=draft.notes;
    q('#calendar-exercise-options').innerHTML=getCatalog().map(item=>`<option value="${esc(item.name)}"></option>`).join('');
    showFormError('');renderTargets();q('[data-cal-save]').textContent=plan?'Save changes':'Save plan';dialog.showModal();
    if(plan)q('[data-cal-targets] select')?.focus();else form.elements.title.focus();
  }
  function setSaving(value){saving=value;form.querySelector('fieldset').disabled=value;q('[data-cal-save]').disabled=value;q('[data-cal-cancel]').disabled=value;q('[data-cal-close]').disabled=value;q('[data-cal-save]').textContent=value?'Saving…':draft?.revision?'Save changes':'Save plan';}
  function closeEditor(){if(saving)return;dialog.close();draft=null;}
  async function save(event){
    event.preventDefault();if(saving)return;readDraft();showFormError('');
    let payload;try{const {canonicalPayload,...value}=normalizePlan(draft);payload={...value,...(draft.revision?{revision:draft.revision}:{})};}catch(error){showFormError(error.message);return;}
    setSaving(true);
    try{const body=await request(draft.revision?'PUT':'POST',payload);if(!body.plan)throw new Error('The saved plan could not be confirmed. Please retry.');revision++;putPlan(body.plan);selected=body.plan.date;month=selected.slice(0,7);dialog.close();draft=null;render();setStatus('Plans and reviews are up to date.');showNotice('Workout plan saved.');load();}
    catch(error){showFormError(error.message,error.conflict);}
    finally{setSaving(false);}
  }
  async function deletePlan(id){
    const plan=plans.find(p=>p.id===id);if(!plan)return;
    const button=q(`[data-cal-confirm-delete="${id}"]`);if(button){button.disabled=true;button.textContent='Deleting…';}
    try{const body=await request('DELETE',null,'?id='+encodeURIComponent(id)+'&revision='+plan.revision);revision++;plans=plans.filter(p=>p.id!==id);deleted={id,revision:body.revision};deletePending=null;render();showNotice('Plan deleted.');load();}
    catch(error){showNotice(error.message,true);if(button){button.disabled=false;button.textContent='Delete plan';}}
  }
  async function undoDelete(){
    if(!deleted)return;const pending={...deleted};q('[data-cal-undo]').disabled=true;
    try{const body=await request('PATCH',{...pending,action:'restore'});revision++;putPlan(body.plan);deleted=null;selectDate(body.plan.date);showNotice('Plan restored.');load();}
    catch(error){showNotice(error.message,true);}
  }
  host.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button||button.disabled)return;
    if(button.hasAttribute('data-cal-new')||button.hasAttribute('data-cal-new-day'))openEditor();
    else if(button.dataset.calDate)selectDate(button.dataset.calDate);
    else if(button.hasAttribute('data-cal-prev')||button.hasAttribute('data-cal-next')){const date=toDate(month+'-01');date.setMonth(date.getMonth()+(button.hasAttribute('data-cal-prev')?-1:1));month=localDate(date).slice(0,7);render();}
    else if(button.hasAttribute('data-cal-today'))selectDate(localDate());
    else if(button.hasAttribute('data-cal-retry'))load();
    else if(button.dataset.calEdit)openEditor(plans.find(p=>p.id===button.dataset.calEdit));
    else if(button.dataset.calDelete){deletePending=button.dataset.calDelete;render();q('[data-cal-confirm-delete]')?.focus();}
    else if(button.dataset.calConfirmDelete)deletePlan(button.dataset.calConfirmDelete);
    else if(button.hasAttribute('data-cal-keep')){deletePending=null;render();}
    else if(button.hasAttribute('data-cal-undo'))undoDelete();
    else if(button.hasAttribute('data-cal-dismiss')){deleted=null;showNotice('');}
    else if(button.hasAttribute('data-cal-log'))onLogExercise('',selected);
    else if(button.dataset.calLogPlan){const plan=plans.find(p=>p.id===button.dataset.calLogPlan);onLogExercise(plan?.targets[0]?.exercise||'',selected);}
    else if(button.dataset.calInspect)onInspectDate(selected,button.dataset.calInspect);
    else if(button.hasAttribute('data-cal-close')||button.hasAttribute('data-cal-cancel'))closeEditor();
    else if(button.hasAttribute('data-cal-add')){readDraft();if(draft.targets.length>=30)return;draft.targets.push(target());renderTargets();q('[data-cal-targets] section:last-child input')?.focus();}
    else if(button.dataset.calRemove){readDraft();draft.targets=draft.targets.filter(t=>t.id!==button.dataset.calRemove);renderTargets();}
    else if(button.hasAttribute('data-cal-reload'))reloadDraft();
  });
  async function reloadDraft(){
    const id=draft?.id;if(!id)return;q('[data-cal-reload]').disabled=true;
    try{const body=await request('GET'),latest=body.plans?.find(p=>p.id===id);if(!latest)throw new Error('This plan was deleted. Your draft remains open so you can copy any notes.');plans=body.plans;loaded=true;draft=clone(latest);form.elements.title.value=draft.title;form.elements.date.value=draft.date;form.elements.notes.value=draft.notes;renderTargets();showFormError('');render();announce('Latest saved plan loaded.');}catch(error){showFormError(error.message,true);}finally{q('[data-cal-reload]').disabled=false;}
  }
  q('[data-cal-jump]').addEventListener('change',event=>{if(/^\d{4}-\d{2}$/.test(event.target.value)){month=event.target.value;render();}});
  q('[data-cal-grid]').addEventListener('keydown',event=>{const current=event.target.closest('[data-cal-date]');if(!current)return;const offset={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7}[event.key];if(!offset)return;event.preventDefault();const date=toDate(current.dataset.calDate);date.setDate(date.getDate()+offset);selectDate(localDate(date),true);});
  form.addEventListener('submit',save);
  dialog.addEventListener('cancel',event=>{event.preventDefault();closeEditor();});
  render();
  return {load,refreshRecords:render,activate(){render();if(!loaded&&!loading)load();},getPlans:()=>clone(plans)};
}
