import { normalizeEntry } from './entry-model.js';
import { formatSeconds } from './repeater-display.js';

const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const categories={Pull:'Pulling',Push:'Pushing',Legs:'Legs',Arms:'Arms',Shoulders:'Shoulders',Core:'Core',Grip:'Grip',Other:'Other'};
const modeLabels={weight:'Weight in pounds',dumbbell:'Weight per dumbbell',pullup:'Pull-up: bodyweight + added',bodyweight:'Bodyweight / no known load',stack:'Numbered machine setting',band:'Band resistance'};
const localToday=()=>{const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')};
const numeric=value=>value===''||value===undefined?undefined:Number(value);
const isRepeaterName=name=>/repeaters?|hangboard|no[- ]?hang/i.test(name||'');
const entryUuid=()=>{
  if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
  const bytes=crypto.getRandomValues(new Uint8Array(16));
  bytes[6]=(bytes[6]&0x0f)|0x40;bytes[8]=(bytes[8]&0x3f)|0x80;
  const hex=[...bytes].map(value=>value.toString(16).padStart(2,'0')).join('');
  return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
};

export function createEntryForm({getRecords,getCatalog,onSaved}) {
  const dialog=document.createElement('dialog');
  dialog.className='entry-dialog';dialog.id='entry-dialog';dialog.setAttribute('aria-labelledby','entry-dialog-title');
  dialog.innerHTML=`<form id="entry-form" novalidate>
    <div class="entry-dialog-head"><div><div class="eyebrow">ADD TO YOUR HISTORY</div><h2 id="entry-dialog-title">Log exercise</h2><p>Record what you completed and see it in your charts.</p></div><button type="button" id="close-entry" class="entry-close" aria-label="Close exercise entry">×</button></div>
    <fieldset id="entry-fields"><div class="entry-basics">
      <label class="entry-exercise-field">Exercise<select id="entry-exercise" required></select></label>
      <label>Date<input id="entry-date" type="date" required></label>
      <label id="entry-name-field" class="entry-exercise-field" hidden>New exercise name<input id="entry-name" type="text" maxlength="120" autocomplete="off" placeholder="e.g. Hangboard repeaters"></label>
      <label id="entry-category-field">Category<select id="entry-category">${Object.entries(categories).map(([v,label])=>`<option value="${v}">${label}</option>`).join('')}</select></label>
      <label>Track<select id="entry-tracking"><option value="reps">Repetitions</option><option value="timed">Single timed holds</option><option value="repeaters">Hangboard / no-hang repeaters</option></select></label>
      <label class="entry-mode-field">Load type<select id="entry-load-mode">${Object.entries(modeLabels).map(([v,label])=>`<option value="${v}">${label}</option>`).join('')}</select></label>
      <label id="entry-setup-field" class="entry-exercise-field" hidden>Band / setup label<input id="entry-setup" type="text" maxlength="200" placeholder="e.g. Red resistance band"></label>
    </div><p class="entry-mode-hint" id="entry-mode-hint"></p>
    <section id="entry-repeater-guide" class="repeater-guide" hidden aria-label="Repeater structure">
      <div class="repeater-guide-title">One round = a sequence of hang → rest → hang</div>
      <p>Enter the hangs you completed in each round. Log left and right hands separately when they differ; use the same round number for both. If a round includes shorter hangs, add different-duration hangs to that same round. Rest does not count toward active hang time.</p>
      <label>Rest between rounds (seconds) <span>optional</span><input id="entry-round-rest" type="number" min="0" max="86400" step="any" inputmode="decimal" placeholder="e.g. 120"></label>
    </section>
    <div class="entry-sets-heading"><h3 id="entry-sets-title">Sets</h3><span id="entry-set-count">3 sets</span></div>
    <div id="entry-sets"></div>
    <div class="entry-set-actions"><button type="button" id="add-entry-set" class="button button-outline">+ Add set</button><button type="button" id="repeat-entry-set" class="text-button">Repeat last set</button></div>
    <div id="entry-protocol-preview" class="repeater-preview" aria-live="polite" hidden></div>
    <label class="entry-notes-label">Notes <span>optional</span><textarea id="entry-notes" rows="2" maxlength="2000" placeholder="Technique, equipment, or anything worth remembering…"></textarea></label>
    </fieldset>
    <p id="entry-error" class="entry-error" role="alert" hidden></p>
    <div class="entry-dialog-footer"><p>Weights are recorded in lb. Your entry is saved with this site.</p><div><button type="button" id="cancel-entry" class="button button-outline">Close</button><button type="submit" id="save-entry" class="button button-primary">Save exercise</button></div></div>
  </form>`;
  document.body.append(dialog);
  const $=id=>dialog.querySelector('#'+id);
  let rows=[],draft=false,saving=false,requestId='',lastFocus=null;

  function catalogByName(name){return getCatalog().find(item=>item.name.toLowerCase()===String(name).trim().toLowerCase())}
  function populateExercises(selected) {
    $('entry-exercise').innerHTML='<option value="__new__">＋ Create a new exercise</option>'+Object.entries(categories).map(([category,label])=>{
      const items=getCatalog().filter(item=>item.category===category);
      return items.length?'<optgroup label="'+label+'">'+items.map(item=>'<option value="'+escapeHtml(item.name)+'">'+escapeHtml(item.name)+'</option>').join('')+'</optgroup>':'';
    }).join('');
    $('entry-exercise').value=catalogByName(selected)?.name||'__new__';
  }
  function captureRows() {
    rows=[...$('entry-sets').querySelectorAll('[data-entry-set]')].map((el,index)=>{
      const next={...rows[index]};
      for(const input of el.querySelectorAll('[data-key]'))next[input.dataset.key]=input.type==='checkbox'?input.checked:input.value;
      return next;
    });
  }
  function selectedMeta(){return catalogByName($('entry-exercise').value)}
  function defaultRow(load='',round=1){return {load,reps:'',duration_s:'',hold_count:'',rest_s:'',round:String(round),side:'',warmup:false,notes:''}}
  function inferMode(exercise) {
    const history=getRecords().filter(row=>row.exercise===exercise).sort((a,b)=>b.date.localeCompare(a.date));
    const last=history.find(row=>!row.is_warmup&&!/warm.?up/i.test(row.set_type||''))||history[0];
    if(!last)return {mode:isRepeaterName(exercise)?'bodyweight':'weight',tracking:isRepeaterName(exercise)?'repeaters':'reps',load:''};
    const mode=last.load_mode||(last.is_pullup?'pullup':/per dumbbell/i.test(last.load_basis||'')?'dumbbell':typeof last.stack_setting==='number'?'stack':(/band/i.test(exercise)||/band/i.test(last.resistance_setup||''))&&last.load_lb===null?'band':typeof last.load_lb==='number'?'weight':'bodyweight');
    const repeater=isRepeaterName(exercise)||history.some(row=>row.tracking==='repeaters'||/repeater/i.test(row.set_type||''));
    return {mode,tracking:repeater?'repeaters':typeof last.duration_s==='number'?'timed':'reps',load:mode==='pullup'?'0':mode==='stack'?String(last.stack_setting??''):String(last.load_lb??''),setup:mode==='band'?(last.resistance_setup||''):''};
  }
  function applyExercise(resetRows=true) {
    const isNew=$('entry-exercise').value==='__new__',meta=selectedMeta();
    $('entry-name-field').hidden=!isNew;$('entry-name').required=isNew;
    $('entry-category').disabled=!isNew;if(meta)$('entry-category').value=meta.category;
    const defaults=isNew?{mode:'weight',tracking:'reps',load:''}:inferMode(meta.name);
    $('entry-load-mode').value=defaults.mode;$('entry-tracking').value=defaults.tracking;$('entry-setup').value=defaults.setup||'';
    [...$('entry-load-mode').options].forEach(option=>option.disabled=!!meta?.isPullup&&option.value!=='pullup');
    if(resetRows){rows=Array.from({length:defaults.tracking==='reps'?3:1},(_,index)=>defaultRow(defaults.load,index+1));$('entry-round-rest').value='';}
    renderSets();
  }
  function renderSets() {
    const mode=$('entry-load-mode').value,tracking=$('entry-tracking').value,repeater=tracking==='repeaters',timed=tracking!=='reps',withLoad=!['bodyweight','band'].includes(mode);
    const loadLabel=mode==='pullup'?'Added weight (lb)':mode==='dumbbell'?'Per dumbbell (lb)':mode==='stack'?'Stack setting':'Weight (lb)';
    $('entry-setup-field').hidden=mode!=='band';$('entry-setup').required=mode==='band';
    $('entry-repeater-guide').hidden=!repeater;$('entry-round-rest').disabled=!repeater;
    const hints={weight:'Enter the total equipment or external load for each set.',dumbbell:'Enter the weight of one dumbbell. The dashboard keeps that convention.',pullup:'Enter added weight only; use 0 for bodyweight pull-ups. Set your bodyweight in Chart settings for total-load and strength estimates.',bodyweight:'Track your reps or hangs. No pound value will be assumed.',stack:'Enter the numbered setting on the machine. It will stay a setting, without a pound conversion.',band:'Describe the band or setup above. Its resistance will not be converted to pounds.'};
    $('entry-mode-hint').textContent=hints[mode]+(tracking==='timed'?' Each row records one completed hold. For repeated hangs and rests, choose repeaters above.':'');
    $('entry-sets-title').textContent=repeater?'Rounds':tracking==='timed'?'Holds':'Sets';
    $('add-entry-set').textContent=repeater?'+ Add round':tracking==='timed'?'+ Add hold':'+ Add set';
    $('repeat-entry-set').textContent=repeater?'Repeat last round':tracking==='timed'?'Repeat last hold':'Repeat last set';
    const noun=repeater?'Round':tracking==='timed'?'Hold':'Set';
    $('entry-sets').innerHTML=rows.map((row,index)=>{
      const input=(key,label,options={})=>`<label>${label}<input data-key="${key}" aria-label="${noun} ${index+1} ${label}" type="number" min="${options.min??0}" max="${options.max??10000}" step="${options.step??'any'}" inputmode="${options.step===1?'numeric':'decimal'}" value="${escapeHtml(row[key]??'')}" ${options.placeholder?`placeholder="${escapeHtml(options.placeholder)}"`:''} ${options.required===false?'':'required'}></label>`;
      return `<div class="entry-set${repeater?' entry-repeater-round':''}" data-entry-set="${index}"><div class="entry-set-head"><strong>${noun} ${repeater?escapeHtml(row.round||index+1):index+1}${repeater&&row.side?' · '+escapeHtml(row.side):''}</strong><button type="button" class="entry-remove" data-remove-set="${index}" aria-label="Remove ${noun.toLowerCase()} ${index+1}" ${rows.length===1?'disabled':''}>Remove</button></div><div class="entry-set-fields">
      ${repeater?input('round','Round number',{min:1,max:1000,step:1}):''}
      ${withLoad?input('load',loadLabel):''}
      ${timed?input('duration_s',repeater?'Hang (seconds)':'Hold (seconds)',{min:0.01,max:86400,placeholder:repeater?'e.g. 7':''}):input('reps','Reps',{min:0.01})}
      ${repeater?input('hold_count','Hangs this round',{min:1,max:1000,step:1,placeholder:'e.g. 6'})+input('rest_s','Rest between hangs (s)',{max:86400,required:false,placeholder:'e.g. 3'}):''}
      <label>Side<select data-key="side" aria-label="${noun} ${index+1} side"><option value="" ${!row.side?'selected':''}>${repeater?'Both hands together':'Both / not specified'}</option><option value="Left" ${row.side==='Left'?'selected':''}>Left</option><option value="Right" ${row.side==='Right'?'selected':''}>Right</option></select></label>
    </div>${repeater?`<p class="repeater-round-summary" data-round-summary="${index}"></p><label class="repeater-round-notes">Round notes <span>optional</span><input data-key="notes" type="text" maxlength="1000" aria-label="Round ${index+1} notes" value="${escapeHtml(row.notes||'')}" placeholder="e.g. Edge size, grip, or technique…"></label><button type="button" class="text-button repeater-add-part" data-add-part="${index}" ${rows.length>=50?'disabled':''}>+ Add different-duration hangs</button>`:''}<label class="entry-warmup"><input data-key="warmup" type="checkbox" ${row.warmup?'checked':''}>Warm-up ${noun.toLowerCase()}</label></div>`;
    }).join('');
    $('entry-set-count').textContent=rows.length+' '+(repeater?(rows.length===1?'round entry':'round entries'):tracking==='timed'?(rows.length===1?'hold':'holds'):(rows.length===1?'set':'sets'));
    $('add-entry-set').disabled=rows.length>=50;
    const repeatCount=repeater?rows.filter(row=>row.round===rows.at(-1)?.round).length:1;
    $('repeat-entry-set').disabled=rows.length+repeatCount>50;
    updatePreview();
  }
  function updatePreview() {
    const repeater=$('entry-tracking').value==='repeaters';$('entry-protocol-preview').hidden=!repeater;if(!repeater)return;
    captureRows();
    const complete=rows.filter(row=>Number(row.duration_s)>0&&Number.isInteger(Number(row.hold_count))&&Number(row.hold_count)>0);
    for(const [index,row] of rows.entries()){
      const card=$('entry-sets').children[index],out=card?.querySelector('[data-round-summary]');
      if(card)card.querySelector('.entry-set-head strong').textContent='Round '+(row.round||index+1)+(row.side?' · '+row.side:'');
      if(out)out.textContent=complete.includes(row)?`${Number(row.hold_count)} hangs × ${Number(row.duration_s)} s = ${formatSeconds(Number(row.hold_count)*Number(row.duration_s))} active${row.rest_s!==''?' · '+Number(row.rest_s)+' s rest between hangs':' · rest not recorded'}`:'Enter hang duration and the number of completed hangs.';
    }
    if(complete.length!==rows.length){$('entry-protocol-preview').textContent='Your protocol summary will appear here when every round has a hang duration and count.';return;}
    const same=new Set(rows.map(row=>row.round)).size===rows.length&&rows.every(row=>row.duration_s===rows[0].duration_s&&row.hold_count===rows[0].hold_count&&row.rest_s===rows[0].rest_s&&row.side===rows[0].side);
    const active=rows.reduce((total,row)=>total+Number(row.duration_s)*Number(row.hold_count),0),hangs=rows.reduce((total,row)=>total+Number(row.hold_count),0);
    const rounds=new Set(rows.map(row=>row.round||'')).size;
    let summary=same?`${rows.length} ${rows.length===1?'round':'rounds'} × ${Number(rows[0].hold_count)} hangs · ${Number(rows[0].duration_s)} s on / ${rows[0].rest_s!==''?Number(rows[0].rest_s)+' s off':'rest not recorded'}`:`${rounds} ${rounds===1?'round':'rounds'} · ${hangs} completed hangs across ${rows.length} ${rows.length===1?'entry':'entries'}`;
    if($('entry-round-rest').value!=='')summary+=' · '+formatSeconds(Number($('entry-round-rest').value))+' between rounds';
    const side=same&&rows[0].side?' · '+rows[0].side+' hand':'';
    $('entry-protocol-preview').innerHTML='<strong>'+escapeHtml(summary+side)+'</strong><span>'+escapeHtml(formatSeconds(active))+' active hang time · rest excluded</span>';
  }
  function setError(message){$('entry-error').textContent=message;$('entry-error').hidden=!message;}
  function reset(exercise,options={}) {
    requestId=entryUuid();draft=false;populateExercises(exercise);
    $('entry-date').value=options.date||localToday();$('entry-name').value='';$('entry-notes').value='';$('entry-category').value='Other';
    setError('');applyExercise();
    if(exercise&&!catalogByName(exercise)&&exercise!=='__new__'){$('entry-name').value=exercise;if(isRepeaterName(exercise)){$('entry-category').value='Grip';$('entry-tracking').value='repeaters';$('entry-load-mode').value='bodyweight';rows=[defaultRow()];renderSets();}}
  }
  function close(){if(saving)return;dialog.close();lastFocus?.focus();}
  function readPayload() {
    captureRows();
    const tracking=$('entry-tracking').value,loadMode=$('entry-load-mode').value,timed=tracking!=='reps',repeater=tracking==='repeaters';
    return {id:requestId,date:$('entry-date').value,exercise:$('entry-exercise').value==='__new__'?$('entry-name').value:$('entry-exercise').value,category:$('entry-category').value,tracking,loadMode,setupLabel:$('entry-setup').value,notes:$('entry-notes').value,sets:rows.map(row=>({reps:tracking==='reps'?numeric(row.reps):undefined,duration_s:timed?numeric(row.duration_s):undefined,hold_count:repeater?numeric(row.hold_count):tracking==='timed'?1:undefined,...(repeater?{round:numeric(row.round),rest_s:numeric(row.rest_s),round_rest_s:numeric($('entry-round-rest').value),notes:row.notes||''}:{}),load:!['bodyweight','band'].includes(loadMode)?numeric(row.load):undefined,warmup:row.warmup,side:row.side||null}))};
  }
  async function save(event) {
    event.preventDefault();if(saving)return;setError('');if(!$('entry-form').reportValidity())return;
    let payload;
    try {payload=readPayload();normalizeEntry(payload,{catalog:getCatalog(),dateSessions:Object.fromEntries(getRecords().map(r=>[r.date,r.session]))});}
    catch(error){setError(error.message||'Check the details of your entry.');return;}
    saving=true;$('entry-fields').disabled=true;$('save-entry').disabled=true;$('close-entry').disabled=true;$('cancel-entry').disabled=true;$('save-entry').textContent='Saving…';
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
    try {
      const response=await fetch('/api/workouts',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(payload),signal:controller.signal});
      let body;try{body=await response.json()}catch{throw new Error('The site did not return a save confirmation. Retry to check the same entry.');}
      if(!response.ok)throw new Error(typeof body.error==='string'?body.error:body.error?.message||body.message||'This entry could not be saved. Please try again.');
      if(!body.entry?.id||!Array.isArray(body.entry.records))throw new Error('The site did not return a save confirmation. Retry to check the same entry.');
      onSaved(body.entry);draft=false;dialog.close();lastFocus?.focus();
    } catch(error){draft=true;setError(error.name==='AbortError'?'The save took too long to confirm. Your draft is still here. Retry safely to check this same entry.':error.message||'Couldn’t reach the site. Your draft is still here; please retry.');}
    finally{clearTimeout(timer);saving=false;$('entry-fields').disabled=false;$('entry-category').disabled=$('entry-exercise').value!=='__new__';$('save-entry').disabled=false;$('close-entry').disabled=false;$('cancel-entry').disabled=false;$('save-entry').textContent='Save exercise';}
  }
  $('entry-form').addEventListener('submit',save);
  $('close-entry').addEventListener('click',close);$('cancel-entry').addEventListener('click',close);
  dialog.addEventListener('cancel',event=>{if(saving)event.preventDefault()});dialog.addEventListener('close',()=>{if(!saving)lastFocus?.focus()});
  $('entry-form').addEventListener('input',()=>{draft=true;setError('');updatePreview()});
  $('entry-form').addEventListener('change',()=>{draft=true;setError('');updatePreview()});
  $('entry-exercise').addEventListener('change',()=>applyExercise());
  $('entry-name').addEventListener('change',()=>{const match=catalogByName($('entry-name').value);if(match){$('entry-exercise').value=match.name;applyExercise(false)}else if(isRepeaterName($('entry-name').value)&&$('entry-tracking').value==='reps'){captureRows();$('entry-category').value='Grip';$('entry-tracking').value='repeaters';$('entry-load-mode').value='bodyweight';rows=[defaultRow()];renderSets();}});
  for(const id of ['entry-tracking','entry-load-mode'])$(id).addEventListener('change',()=>{captureRows();renderSets()});
  function nextRound(){return Math.max(0,...rows.map(row=>Number(row.round)||0))+1}
  $('add-entry-set').addEventListener('click',()=>{captureRows();if(rows.length>=50)return;rows.push(defaultRow(rows.at(-1)?.load??'',nextRound()));draft=true;renderSets();$('entry-sets').lastElementChild.querySelector('input')?.focus()});
  $('repeat-entry-set').addEventListener('click',()=>{captureRows();const repeater=$('entry-tracking').value==='repeaters',copies=repeater?rows.filter(row=>row.round===rows.at(-1)?.round):[rows.at(-1)],round=String(nextRound());if(rows.length+copies.length>50)return;rows.push(...copies.map(row=>({...row,round})));draft=true;renderSets()});
  $('entry-sets').addEventListener('click',event=>{const part=event.target.closest('[data-add-part]');if(part){captureRows();if(rows.length>=50)return;const index=Number(part.dataset.addPart);rows.splice(index+1,0,{...rows[index],duration_s:'',hold_count:'',notes:''});draft=true;renderSets();$('entry-sets').children[index+1]?.querySelector('[data-key=duration_s]')?.focus();return;}const button=event.target.closest('[data-remove-set]');if(!button||rows.length===1)return;captureRows();rows.splice(Number(button.dataset.removeSet),1);draft=true;renderSets()});
  return {open(exercise,options={}){if(!draft)reset(exercise,options);lastFocus=document.activeElement;if(!dialog.open)dialog.showModal();if(draft&&options.date&&$('entry-date').value!==options.date)setError('Your unfinished draft is still open. Finish it, or update its date to log the selected calendar day.');$('entry-exercise').focus();}};
}
