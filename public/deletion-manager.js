const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dateLabel=date=>new Intl.DateTimeFormat('en-CA',{dateStyle:'medium',timeZone:'UTC'}).format(new Date(date+'T12:00:00Z'));
function uuid(){if(crypto.randomUUID)return crypto.randomUUID();const a=crypto.getRandomValues(new Uint8Array(16));a[6]=(a[6]&15)|64;a[8]=(a[8]&63)|128;const h=[...a].map(v=>v.toString(16).padStart(2,'0')).join('');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);}

export function createDeletionManager({getAllRecords,getDeletions,isReady,onDeleted,onRestored,onNotify}){
  const dialog=document.createElement('dialog');dialog.className='manage-dialog';dialog.setAttribute('aria-labelledby','manage-title');document.body.append(dialog);
  let mode='delete',pending=null,busy=false,returnFocus=null;
  const retryIds=new Map();
  function close(){if(!busy){dialog.close();returnFocus?.focus?.();}}
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault()});
  dialog.addEventListener('click',event=>{if(event.target===dialog)close()});
  async function request(url,options){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
    try{const response=await fetch(url,{...options,signal:controller.signal,headers:{Accept:'application/json',...(options?.headers||{})}});const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error||'The change could not be saved.'),{status:response.status});return data;}finally{clearTimeout(timer)}
  }
  function show(){returnFocus=document.activeElement;if(!dialog.open)dialog.showModal();}
  function setError(message){const error=dialog.querySelector('.manage-error');if(error){error.textContent=message;error.hidden=false;}}
  function setBusy(value){busy=value;dialog.querySelectorAll('button').forEach(button=>button.disabled=value);}
  function describe(rows){const names=[...new Set(rows.map(row=>row.exercise))],dates=[...new Set(rows.map(row=>row.date))];return (names.length===1?names[0]:names.length+' exercises')+' · '+(dates.length===1?dateLabel(dates[0]):dates.length+' dates');}
  async function submitDeletion(operation,showError=true){
    if(!isReady()){onNotify('Wait for your saved history to load before deleting entries.');return false;}
    try{
      const result=await request('/api/record-deletions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(operation)});
      onDeleted(result.deletion);retryIds.delete(operation.recordIds.slice().sort().join('|'));
      onNotify(operation.recordIds.length+' '+(operation.recordIds.length===1?'entry deleted.':'entries deleted.'),{label:'Undo delete',run:()=>restore(result.deletion)});
      return true;
    }catch(error){if(error.status===409||error.status===404)retryIds.delete(operation.recordIds.slice().sort().join('|'));const message=error.name==='AbortError'?'The deletion could not be confirmed yet. Retry safely.':error.message;if(showError)setError(message);else onNotify(message,[404,409].includes(error.status)?null:{label:'Retry',run:()=>submitDeletion(operation,false)});return false;}
  }
  async function deleteRows(rows,{confirm=true}={}){
    if(!isReady()){onNotify('Wait for your saved history to load before deleting entries.');return;}
    const unique=[...new Map(rows.map(row=>[row.record_id,row])).values()];if(!unique.length)return;
    const recordIds=unique.map(row=>row.record_id),key=recordIds.slice().sort().join('|');
    const id=retryIds.get(key)||uuid();retryIds.set(key,id);pending={id,recordIds};
    if(!confirm){await submitDeletion(pending,false);return;}
    mode='delete';
    dialog.innerHTML='<div class="manage-header"><div><span class="eyebrow">MANAGE HISTORY</span><h2 id="manage-title">Delete '+unique.length+' '+(unique.length===1?'entry':'entries')+'?</h2></div><button type="button" class="manage-close" aria-label="Close">×</button></div><p class="manage-description">'+escapeHtml(describe(unique))+'</p><p class="manage-help">These sets will be removed from your charts, session log and CSV exports. You can restore them from Deleted entries.</p><p class="manage-error" role="alert" hidden></p><div class="manage-actions"><button class="button button-outline" data-cancel>Cancel</button><button class="button button-danger" data-confirm>Delete '+(unique.length===1?'entry':unique.length+' entries')+'</button></div>';
    dialog.querySelector('.manage-close').onclick=close;dialog.querySelector('[data-cancel]').onclick=close;
    dialog.querySelector('[data-confirm]').onclick=async()=>{setBusy(true);const ok=await submitDeletion(pending);setBusy(false);if(ok)close();};show();
  }
  async function restore(deletion){
    try{
      await request('/api/record-deletions?id='+encodeURIComponent(deletion.id),{method:'DELETE'});
      onRestored(deletion);onNotify('Deletion undone. Your history has been updated.');
      if(dialog.open&&mode==='trash')renderTrash();
      return true;
    }catch(error){const message=error.name==='AbortError'?'The restore could not be confirmed yet. Retry safely.':error.message;if(dialog.open&&mode==='trash')setError(message);else onNotify(message,{label:'Retry restore',run:()=>restore(deletion)});return false;}
  }
  function renderTrash(){
    const lookup=new Map(getAllRecords().map(row=>[row.record_id,row]));
    const deletions=getDeletions();
    dialog.innerHTML='<div class="manage-header"><div><span class="eyebrow">MANAGE HISTORY</span><h2 id="manage-title">Deleted entries</h2></div><button class="manage-close" aria-label="Close">×</button></div><p class="manage-help">Restore a deletion to include those sets in your history again.</p><div class="deleted-list">'+(deletions.length?deletions.map(deletion=>{
      const rows=deletion.recordIds.map(id=>lookup.get(id)).filter(Boolean);return '<div class="deleted-item"><div><strong>'+escapeHtml(rows.length?describe(rows):'Saved workout entries')+'</strong><span>'+deletion.recordIds.length+' '+(deletion.recordIds.length===1?'entry':'entries')+' · deleted '+escapeHtml(new Intl.DateTimeFormat('en-CA',{dateStyle:'medium',timeStyle:'short'}).format(new Date(deletion.created_at)))+'</span></div><button class="button button-outline" data-restore="'+escapeHtml(deletion.id)+'">Restore</button></div>';
    }).join(''):'<div class="empty-state"><strong>No deleted entries</strong><span>Deleted sets will appear here until you restore them.</span></div>')+'</div><p class="manage-error" role="alert" hidden></p>';
    dialog.querySelector('.manage-close').onclick=close;dialog.querySelectorAll('[data-restore]').forEach(button=>button.onclick=async()=>{setBusy(true);await restore(deletions.find(item=>item.id===button.dataset.restore));setBusy(false)});
  }
  function openTrash(){if(!isReady()){onNotify('Wait for your saved history to load before managing deleted entries.');return;}mode='trash';renderTrash();show();}
  return {deleteRows,restore,openTrash};
}
