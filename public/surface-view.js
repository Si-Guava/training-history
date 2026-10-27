import { buildSurfaceModel, surfaceDomains, projectSurfacePoint, spreadCoincidentPoint, pickProjectedPoint } from './surface-model.js';

const finite=Number.isFinite;
const bounded=(value,min,max)=>Math.max(min,Math.min(max,value));
const number=(value,digits=1)=>new Intl.NumberFormat('en-CA',{maximumFractionDigits:digits}).format(value);
const dateLabel=value=>new Intl.DateTimeFormat('en-CA',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(value));
const shortDate=value=>new Intl.DateTimeFormat('en-CA',{month:'short',year:'2-digit',timeZone:'UTC'}).format(new Date(value));
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const freshCamera=()=>({yaw:-.55,pitch:.55,zoom:1,panX:0,panY:0});
let workspaceCount=0;

/** A lightweight, genuine 3D orthographic scene with depth-sorted surface triangles. */
export function createSurfaceWorkspace({host,onStateChange=()=>{},onInspectSession=()=>{}}) {
  const id=++workspaceCount;
  let model=null,domains=null,options=null,camera=freshCamera(),signature='',frame=0,selectedId='',hoverId='',screens=[];
  let expanded=false,placeholder=null,returnFocus=null,oldOverflow='',savedScroll=null;
  let gesture=null,moved=false,pinned=false,viewSize={width:0,height:0};
  const pointers=new Map(),abort=new AbortController();
  const listen=(target,type,handler,extra={})=>target.addEventListener(type,handler,{...extra,signal:abort.signal});
  host.classList.add('surface-panel');
  host.innerHTML=`<div class="section-header surface-header"><div><span class="eyebrow">EXPLORE IN 3D</span><h3>Training surface</h3><p class="surface-subtitle">See the average working-set load and reps for each workout together.</p></div><button type="button" class="button button-outline surface-expand" aria-haspopup="dialog">↗ Expand 3D</button></div>
    <div class="surface-controls"><label>Surface<select data-surface-fit><option value="smooth">Smoothed surface</option><option value="quadratic">Curved quadratic surface</option><option value="plane">Linear plane</option><option value="none">Workout averages only</option></select></label><label>Fit influence<select data-surface-weight><option value="sets">Sets / completed hangs</option><option value="sessions">Equal sessions</option><option value="volume">Training exposure</option></select></label><label class="surface-axis-control" hidden>Second axis<select data-surface-axis><option value="reps">Average reps per set</option><option value="hold">Average seconds per hold</option></select></label><label class="surface-smoothing">Smoothing <span data-surface-smooth-label></span><input data-surface-smooth type="range" min="20" max="100" step="5" aria-label="3D surface smoothing"></label></div>
    <div class="surface-view-controls"><div class="surface-camera-buttons" role="group" aria-label="3D camera"><button type="button" data-camera="left" aria-label="Rotate 3D left" title="Rotate left">↶</button><button type="button" data-camera="right" aria-label="Rotate 3D right" title="Rotate right">↷</button><button type="button" data-camera="up" aria-label="Tilt 3D up" title="Tilt up">↑</button><button type="button" data-camera="down" aria-label="Tilt 3D down" title="Tilt down">↓</button><span class="surface-control-divider"></span><button type="button" data-camera="out" aria-label="Zoom 3D out">−</button><span class="surface-camera-zoom">100%</span><button type="button" data-camera="in" aria-label="Zoom 3D in">+</button><button type="button" class="surface-reset" data-camera="reset">Reset view</button></div><span class="surface-interaction-hint">Drag to rotate · pinch to zoom</span></div>
    <div class="surface-legend"><span><i class="surface-dot-key"></i> Dots = workout averages</span><span><i class="surface-mesh-key"></i> Surface = fitted average load</span><span class="surface-count"></span></div>
    <div class="surface-stage"><canvas class="surface-canvas" tabindex="0" role="img" aria-label="Rotatable training graph" aria-describedby="surface-description-${id}" aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown + - Home"><span>Use the workout selector below to inspect the working sets behind each average.</span></canvas><div class="surface-empty" hidden></div><div class="surface-point-details" hidden></div></div>
    <p class="surface-status" id="surface-description-${id}" aria-live="polite"></p><p class="surface-weight-note"></p><div class="surface-inspector"><label>Inspect a workout<select class="surface-set-select"><option value="">Choose a workout…</option></select></label><button type="button" class="text-button surface-inspect-session" disabled>Open session →</button></div>
    <details class="surface-method"><summary>How to read this surface</summary><p>Each dot is one workout: date, average reps per set (or seconds per hold), and average load in pounds. Only completed working sets contribute. Repeater averages weight each component by its completed-hang count. Hover or select a dot to see every contributing set. If two workouts share the same coordinates, their dots are slightly separated for selection; the averages and dates remain exact.</p><p>The surface fits these workout averages with your chosen influence setting; that setting changes the fit, not the dot averages. It is not a maximum-strength prediction. Fits stay within the observed date–average-rep region; gaps between workouts are interpolated. A flat surface can be correct when the workout-average loads are equal.</p><p>Drag to rotate. Use the camera buttons or arrow keys for precise rotation, +/− to zoom, and Home to reset. Shift-drag pans on desktop. Mouse-wheel zoom is enabled in the expanded view or while the canvas has focus.</p></details>`;
  const q=selector=>host.querySelector(selector),canvas=q('canvas'),stage=q('.surface-stage'),details=q('.surface-point-details'),empty=q('.surface-empty');
  const fitControl=q('[data-surface-fit]'),weightControl=q('[data-surface-weight]'),axisControl=q('[data-surface-axis]'),smoothControl=q('[data-surface-smooth]'),setSelect=q('.surface-set-select'),inspectButton=q('.surface-inspect-session');
  const dialog=document.createElement('dialog');dialog.className='surface-dialog';dialog.setAttribute('aria-labelledby',`surface-dialog-title-${id}`);
  dialog.innerHTML=`<header class="surface-dialog-header"><div><span class="eyebrow">EXPANDED 3D GRAPH</span><h2 id="surface-dialog-title-${id}">Training surface</h2></div><button type="button" class="surface-close" aria-label="Close expanded 3D graph">× <span>Close</span></button></header>`;
  document.body.append(dialog);
  const ctx=canvas.getContext('2d');

  function geometrySignature(input) {
    const s=input.state||{};
    return JSON.stringify([s.exercise,s.from,s.to,s.includeWarmups,s.side,s.loadBasis,s.bodyweight,s.surfaceAxis,(input.analysis?.rows||[]).map(row=>[row.record_id,row.date,row.session,row.reps,row.duration_s,row.hold_count,row.displayLoad,row.included,row.metricEligible])]);
  }
  function refreshControls() {
    fitControl.value=model.method;weightControl.value=model.weightMode;axisControl.value=model.axis;
    q('.surface-axis-control').hidden=!(model.hasReps&&model.hasHolds);
    q('.surface-smoothing').hidden=model.method!=='smooth';smoothControl.value=String(Math.round(model.smoothing*100));
    q('[data-surface-smooth-label]').textContent=Math.round(model.smoothing*100)+'%';
    q('.surface-subtitle').textContent='Date × '+(model.axis==='hold'?'average seconds per hold':'average reps per set')+' × average working load';
    q('.surface-count').textContent=model.countLabel;
    q('.surface-weight-note').textContent=[model.weightNote,model.unitNote,model.fitExcluded?`${model.fitExcluded} workout ${model.fitExcluded===1?'average has':'averages have'} no positive known exposure weight; ${model.fitExcluded===1?'it remains':'they remain'} visible as ${model.fitExcluded===1?'a dot':'dots'}.`:''].filter(Boolean).join(' ');
    const status=!model.points.length?model.emptyReason:model.method==='none'?model.surface.reason:model.surface.available?[model.surface.label+' within the observed date–'+(model.axis==='hold'?'duration':'rep')+' region.',model.constantLoad?'All workout-average loads are equal, so the fitted load surface is flat.':'Height shows fitted average working load, not maximum strength.',model.excludedCount?`${model.excludedCount} ${model.excludedCount===1?'record is':'records are'} excluded by the working-set, known-load or ${model.axis==='hold'?'hold':'rep'} criteria.`:''].filter(Boolean).join(' '):'Workout averages are shown. '+model.surface.reason;
    q('.surface-status').textContent=status;
    host.dataset.surfaceAvailable=String(model.surface.available);host.dataset.surfacePoints=String(model.points.length);host.dataset.surfaceMethod=model.method;
    canvas.setAttribute('aria-label',`${options.state?.exercise||'Exercise'}: rotatable date, ${model.axisLabel.toLowerCase()} and load graph. ${model.countLabel}. ${status}`);
    setSelect.innerHTML='<option value="">Choose a workout…</option>'+model.points.map(point=>`<option value="${escapeHtml(point.id)}">${escapeHtml(dateLabel(point.x)+(point.dateCount>1?' · workout '+(point.dateOrder+1)+' of '+point.dateCount:'')+' · avg '+number(point.z)+' lb · '+number(point.y)+' '+(model.axis==='hold'?'s / hold':'reps / set'))}</option>`).join('');
    if(!model.points.some(point=>point.id===selectedId)){selectedId='';pinned=false;}
    setSelect.value=selectedId;inspectButton.disabled=!selectedId;
    empty.hidden=Boolean(model.points.length);empty.textContent=model.emptyReason;
    q('.surface-expand').hidden=expanded;
    q('.surface-camera-zoom').textContent=Math.round(camera.zoom*100)+'%';
    q('[data-camera="out"]').disabled=camera.zoom<=.601||!model.points.length;
    q('[data-camera="in"]').disabled=camera.zoom>=3.999||!model.points.length;
    q('.surface-inspector').hidden=!model.points.length;
  }
  function render(input) {
    const next=geometrySignature(input);
    if(signature!==next){camera=freshCamera();selectedId='';hoverId='';pinned=false;signature=next;resetPointers();}
    options=input;model=buildSurfaceModel(input.analysis,input.state);domains=surfaceDomains(model);
    dialog.querySelector('h2').textContent=input.state?.exercise||'Training surface';refreshControls();draw();return model;
  }
  function line(a,b,color='#4a5c45',width=1) {ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke();}
  function text(label,p,color='#99ab8c',align='center',size=10) {ctx.font=`${size}px Inter,system-ui,sans-serif`;ctx.textAlign=align;ctx.textBaseline='middle';ctx.fillStyle=color;ctx.fillText(label,p.x,p.y);}
  function project(point) {return projectSurfacePoint(point,domains,camera,viewSize.width,viewSize.height);}
  function draw() {
    if(!model||!ctx)return;
    const width=stage.clientWidth,height=stage.clientHeight;
    if(width<20||height<20)return;
    viewSize={width,height};const ratio=Math.min(2,window.devicePixelRatio||1);
    if(canvas.width!==Math.round(width*ratio)||canvas.height!==Math.round(height*ratio)){canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);}
    ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,width,height);screens=[];
    if(!domains){details.hidden=true;return;}
    const {x,y,z}=domains,base={x:x.min,y:y.min,z:z.min};
    const grid=[];
    for(let i=0;i<=4;i++){const t=i/4;grid.push([{x:x.min+(x.max-x.min)*t,y:y.min,z:z.min},{x:x.min+(x.max-x.min)*t,y:y.max,z:z.min}]);grid.push([{x:x.min,y:y.min+(y.max-y.min)*t,z:z.min},{x:x.max,y:y.min+(y.max-y.min)*t,z:z.min}]);}
    grid.forEach(([a,b])=>line(project(a),project(b),'#2c3929',.7));
    const primitives=[];
    if(model.surface.available){const vertices=model.surface.vertices.map(project);for(const triangle of model.surface.triangles){const source=triangle.map(index=>model.surface.vertices[index]),p=triangle.map(index=>vertices[index]);if(p.some(point=>!point||!finite(point.x)||!finite(point.y)))continue;const avg=source.reduce((v,point)=>v+point.z,0)/3,t=bounded((avg-z.min)/(z.max-z.min),0,1);primitives.push({type:'triangle',depth:p.reduce((v,point)=>v+point.depth,0)/3,p,t});}}
    model.points.forEach(point=>{const projected=spreadCoincidentPoint(point,project(point));screens.push({...projected,point});primitives.push({type:'point',depth:projected.depth,projected,point});});
    primitives.sort((a,b)=>a.depth-b.depth);
    for(const item of primitives){if(item.type==='triangle'){ctx.beginPath();ctx.moveTo(item.p[0].x,item.p[0].y);ctx.lineTo(item.p[1].x,item.p[1].y);ctx.lineTo(item.p[2].x,item.p[2].y);ctx.closePath();ctx.fillStyle=`hsla(${180-item.t*95},44%,${30+item.t*23}%,.39)`;ctx.fill();ctx.strokeStyle='rgba(142,190,132,.11)';ctx.lineWidth=.45;ctx.stroke();}else{const p=item.projected,point=item.point,active=point.id===selectedId||point.id===hoverId,session=point.sessionKey===options.selectedSession;ctx.beginPath();ctx.arc(p.x,p.y,active?6:session?4.8:3.8,0,Math.PI*2);ctx.fillStyle=point.color;ctx.fill();ctx.strokeStyle=active?'#f2f7ed':'#132014';ctx.lineWidth=active?2:1.1;ctx.stroke();}}
    const origin=project(base),endX=project({...base,x:x.max}),endY=project({...base,y:y.max}),endZ=project({...base,z:z.max});
    line(origin,endX,'#88a678',1.25);line(origin,endY,'#738eab',1.25);line(origin,endZ,'#a1b592',1.25);
    const compact=width<500;
    for(let i=0;i<=2;i++){const f=i/2;const xv=x.min+(x.max-x.min)*f,yv=y.min+(y.max-y.min)*f,zv=z.min+(z.max-z.min)*f;
      const xp=project({...base,x:xv}),yp=project({...base,y:yv}),zp=project({...base,z:zv});
      text(shortDate(xv),{x:xp.x,y:xp.y+16},'#93a687','center',compact?9:10);
      if(i>0)text(number(yv,1),{x:yp.x+14,y:yp.y+7},'#9fb1c3','left',compact?9:10);
      text(number(zv,1),{x:zp.x-9,y:zp.y},'#9eaf94','right',compact?9:10);
    }
    text('Date',{x:endX.x,y:endX.y+33},'#bed4ae','center',compact?10:11);
    text(model.axis==='hold'?'Avg hold (s)':'Avg reps',{x:endY.x+10,y:endY.y-13},'#a8c5de','center',compact?10:11);
    text('Avg load (lb)',{x:endZ.x,y:endZ.y-18},'#c7dbb9','center',compact?10:11);
    host.dataset.cameraYaw=camera.yaw.toFixed(3);host.dataset.cameraPitch=camera.pitch.toFixed(3);host.dataset.cameraZoom=camera.zoom.toFixed(3);
    const active=screens.find(item=>item.point.id===(pinned?selectedId:hoverId));
    if(active)showDetails(active);else details.hidden=true;
  }
  function scheduleDraw(){if(!frame)frame=requestAnimationFrame(()=>{frame=0;draw();});}
  function setCamera(patch){Object.assign(camera,patch);camera.pitch=bounded(camera.pitch,-1.2,1.2);camera.zoom=bounded(camera.zoom,.6,4);q('.surface-camera-zoom').textContent=Math.round(camera.zoom*100)+'%';q('[data-camera="out"]').disabled=camera.zoom<=.601;q('[data-camera="in"]').disabled=camera.zoom>=3.999;scheduleDraw();}
  function resetCamera(){camera=freshCamera();hoverId='';refreshControls();scheduleDraw();}
  function hit(clientX,clientY){const rect=canvas.getBoundingClientRect();return pickProjectedPoint(screens,clientX-rect.left,clientY-rect.top);}
  function showDetails(item){
    const point=item.point,held=model.axis==='hold';
    const same=point.duplicateCount>1?'<small>Coincident workout averages are separated on screen; dates and values are unchanged.</small>':'';
    const setBreakdown=point.rows.map(row=>{
      const label=['Set '+(row.set??'—'),row.side,finite(row.round)?'round '+number(row.round,0):''].filter(Boolean).join(' · ');
      const count=finite(row.hold_count)&&row.hold_count>0?row.hold_count:1;
      const load=number(row.displayLoad,2)+' lb';
      const value=held?number(count,0)+' × '+number(row.duration_s,2)+' s at '+load:load+' × '+number(row.reps,2)+' reps';
      const extra=finite(row.additional_reps)&&row.additional_reps>0?'<small>+'+number(row.additional_reps,2)+' additional reps recorded separately</small>':'';
      return `<li><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${extra}</li>`;
    }).join('');
    const excluded=point.excludedCount?`<small>${point.excludedCount} other ${point.excludedCount===1?'record is':'records are'} excluded from this average.</small>`:'';
    details.innerHTML=`<div class="surface-detail-head"><strong>${escapeHtml(dateLabel(point.x))}${point.dateCount>1?' · workout '+(point.dateOrder+1)+' of '+point.dateCount:''}</strong><button type="button" aria-label="Close 3D workout details">×</button></div><div class="surface-detail-value"><i style="background:${escapeHtml(point.color)}"></i>${number(point.z,2)} <span>lb average</span></div><p>${number(point.y,2)} ${held?'s per hold':'reps per set'} on average · ${held?number(point.units,0)+' completed hangs':number(point.eligibleCount,0)+' working '+(point.eligibleCount===1?'set':'sets')}</p><ul class="surface-detail-breakdown" aria-label="Contributing working sets">${setBreakdown}</ul>${excluded}${same}${pinned?'<button type="button" class="surface-detail-inspect">Inspect session →</button>':'<small>Tap to keep details open and scroll the breakdown</small>'}`;
    details.hidden=false;details.classList.toggle('surface-detail-pinned',pinned);details.querySelector('.surface-detail-head button').onclick=clearSelection;
    details.querySelector('.surface-detail-inspect')?.addEventListener('click',inspectSession);
    const box=details.getBoundingClientRect();details.style.left=bounded(item.x+13,8,Math.max(8,viewSize.width-box.width-8))+'px';details.style.top=bounded(item.y-box.height-12,8,Math.max(8,viewSize.height-box.height-8))+'px';
  }
  function selectPoint(id){selectedId=id;hoverId='';pinned=Boolean(id);setSelect.value=id;inspectButton.disabled=!id;draw();}
  function clearSelection(){selectedId='';hoverId='';pinned=false;setSelect.value='';inspectButton.disabled=true;details.hidden=true;scheduleDraw();}
  function inspectSession(){const point=model.points.find(item=>item.id===selectedId);if(!point)return;if(expanded)close();onInspectSession(point.sessionKey);}
  function open(){if(expanded)return;returnFocus=document.activeElement;savedScroll={left:window.scrollX,top:window.scrollY};placeholder=document.createElement('div');placeholder.style.height=host.getBoundingClientRect().height+'px';host.before(placeholder);dialog.append(host);oldOverflow=document.body.style.overflow;document.body.style.overflow='hidden';expanded=true;host.classList.add('surface-expanded');dialog.showModal();q('.surface-expand').hidden=true;draw();dialog.querySelector('.surface-close').focus({preventScroll:true});}
  function close(){if(!expanded)return;resetPointers();expanded=false;dialog.close();placeholder?.replaceWith(host);placeholder=null;host.classList.remove('surface-expanded');document.body.style.overflow=oldOverflow;q('.surface-expand').hidden=false;draw();if(savedScroll)window.scrollTo({...savedScroll,behavior:'instant'});returnFocus?.focus?.({preventScroll:true});savedScroll=null;}
  function local(event){return {x:event.clientX,y:event.clientY};}
  function startGesture(){const list=[...pointers.values()];if(list.length>=2){gesture={mode:'pinch',distance:Math.max(1,Math.hypot(list[0].x-list[1].x,list[0].y-list[1].y)),center:{x:(list[0].x+list[1].x)/2,y:(list[0].y+list[1].y)/2},camera:{...camera}};moved=true;}else if(list.length===1){gesture={mode:'rotate',start:list[0],camera:{...camera}};}}
  function resetPointers(){for(const id of pointers.keys())try{canvas.releasePointerCapture(id);}catch{}pointers.clear();gesture=null;moved=false;canvas.classList.remove('surface-dragging');}
  listen(fitControl,'change',()=>onStateChange({surfaceFit:fitControl.value}));
  listen(weightControl,'change',()=>onStateChange({fitWeight:weightControl.value}));
  listen(axisControl,'change',()=>onStateChange({surfaceAxis:axisControl.value}));
  listen(smoothControl,'input',()=>{q('[data-surface-smooth-label]').textContent=smoothControl.value+'%';});
  listen(smoothControl,'change',()=>onStateChange({surfaceSmoothing:Number(smoothControl.value)/100}));
  listen(setSelect,'change',()=>selectPoint(setSelect.value));listen(inspectButton,'click',inspectSession);
  listen(q('.surface-expand'),'click',open);listen(dialog.querySelector('.surface-close'),'click',close);listen(dialog,'cancel',event=>{event.preventDefault();close();});
  listen(dialog,'click',event=>{if(event.target===dialog)close();});
  host.querySelectorAll('[data-camera]').forEach(button=>listen(button,'click',()=>{const action=button.dataset.camera;if(action==='reset')resetCamera();else if(action==='left'||action==='right')setCamera({yaw:camera.yaw+(action==='left'?-.2:.2)});else if(action==='up'||action==='down')setCamera({pitch:camera.pitch+(action==='up'?.14:-.14)});else setCamera({zoom:camera.zoom*(action==='in'?1.25:.8)});}));
  listen(canvas,'pointerdown',event=>{if(event.button!==0||!model?.points.length)return;canvas.focus({preventScroll:true});pointers.set(event.pointerId,local(event));startGesture();if(event.shiftKey&&gesture)gesture.mode='pan';moved=pointers.size>1;try{canvas.setPointerCapture(event.pointerId);}catch{};});
  listen(canvas,'pointermove',event=>{if(!pointers.has(event.pointerId)){if(event.pointerType!=='touch'&&!pinned){const point=hit(event.clientX,event.clientY);hoverId=point?.point.id||'';scheduleDraw();}return;}
    pointers.set(event.pointerId,local(event));if(!gesture)return;const list=[...pointers.values()];if(gesture.mode==='pinch'&&list.length>=2){const distance=Math.hypot(list[0].x-list[1].x,list[0].y-list[1].y),center={x:(list[0].x+list[1].x)/2,y:(list[0].y+list[1].y)/2};setCamera({zoom:gesture.camera.zoom*distance/gesture.distance,panX:gesture.camera.panX+center.x-gesture.center.x,panY:gesture.camera.panY+center.y-gesture.center.y});moved=true;}else{const dx=event.clientX-gesture.start.x,dy=event.clientY-gesture.start.y;if(Math.hypot(dx,dy)>4)moved=true;if(moved){if(gesture.mode==='pan')setCamera({panX:gesture.camera.panX+dx,panY:gesture.camera.panY+dy});else setCamera({yaw:gesture.camera.yaw+dx*.008,pitch:gesture.camera.pitch+dy*.006});}}
    if(moved){hoverId='';canvas.classList.add('surface-dragging');details.hidden=true;event.preventDefault();}});
  listen(canvas,'pointerup',event=>{if(!pointers.has(event.pointerId))return;const wasMoved=moved;pointers.delete(event.pointerId);try{canvas.releasePointerCapture(event.pointerId);}catch{}if(pointers.size){startGesture();return;}gesture=null;canvas.classList.remove('surface-dragging');if(!wasMoved){const item=hit(event.clientX,event.clientY);selectPoint(item?.point.id===selectedId?'':item?.point.id||'');}moved=false;});
  listen(canvas,'pointercancel',resetPointers);listen(canvas,'pointerleave',()=>{if(!pinned&&!pointers.size){hoverId='';details.hidden=true;scheduleDraw();}});
  listen(canvas,'wheel',event=>{if(!expanded&&document.activeElement!==canvas)return;if(!model?.points.length)return;event.preventDefault();const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?300:1);setCamera({zoom:camera.zoom*Math.exp(-bounded(delta,-250,250)*.002)});},{passive:false});
  listen(canvas,'keydown',event=>{const keys=['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','0','Home','Escape'];if(!keys.includes(event.key))return;event.preventDefault();if(event.key==='Escape'){if(pinned)clearSelection();else if(expanded)close();return;}if(event.key==='0'||event.key==='Home'){resetCamera();return;}if(event.key==='+'||event.key==='=')setCamera({zoom:camera.zoom*1.25});else if(event.key==='-')setCamera({zoom:camera.zoom*.8});else if(event.key==='ArrowLeft'||event.key==='ArrowRight')setCamera({yaw:camera.yaw+(event.key==='ArrowLeft'?-.15:.15)});else setCamera({pitch:camera.pitch+(event.key==='ArrowUp'?.12:-.12)});});
  const resize=new ResizeObserver(scheduleDraw);resize.observe(stage);
  return {render,close,isExpanded:()=>expanded,destroy(){close();abort.abort();resize.disconnect();if(frame)cancelAnimationFrame(frame);dialog.remove();host.innerHTML='';host.classList.remove('surface-panel');}};
}
