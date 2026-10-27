import { buildChartModel, resolveChartDomains, positionChartPoints } from './chart-model.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const number = (value, digits = 1) => finite(value) ? new Intl.NumberFormat('en-CA', {maximumFractionDigits:digits}).format(value) : '—';
const fullDate = new Intl.DateTimeFormat('en-CA', {day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});
const monthDate = new Intl.DateTimeFormat('en-CA', {month:'short',year:'2-digit',timeZone:'UTC'});
const dayDate = new Intl.DateTimeFormat('en-CA', {month:'short',day:'numeric',timeZone:'UTC'});
const timestamp = date => Date.parse(date + 'T12:00:00Z');
const dateLabel = date => fullDate.format(new Date(timestamp(date)));
const controllers = new WeakMap();

function niceTicks(min, max, count = 4) {
  if (min === max) { min -= Math.max(2, Math.abs(min) * .15); max += Math.max(2, Math.abs(max) * .15); }
  const rough = (max - min) / count;
  const power = 10 ** Math.floor(Math.log10(rough || 1));
  const normalized = rough / power;
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10) * power;
  const lower = Math.floor(min / step) * step;
  const upper = Math.ceil(max / step) * step;
  const ticks = [];
  for (let value = lower; value <= upper + step * .01 && ticks.length < 12; value += step) ticks.push(Math.abs(value) < step / 100 ? 0 : value);
  return ticks;
}

function metricLabel(value, metric, unit, digits = ['volume', 'holdTotal'].includes(metric) ? 0 : 1) {
  return (digits === null ? String(value) : number(value, digits)) + (unit && unit !== 'setting' ? ' ' + unit : unit === 'setting' ? ' setting' : '');
}

/** Hit-test displayed marker centers without merging the underlying observations. */
export function nearbyPointIndexes(positions, index, radius = 8) {
  const center = positions[index];
  if (!center) return [];
  return positions.flatMap((point, candidate) => Math.hypot(point.x - center.x, point.y - center.y) <= radius ? [candidate] : []);
}

/** Resolve the nearest center instead of whichever transparent SVG hitbox paints last. */
export function nearestPointIndex(positions, point, fallback = 0) {
  if (!finite(point?.x) || !finite(point?.y) || !positions.length) return fallback;
  let closest = fallback;
  let distance = Infinity;
  positions.forEach((position, index) => {
    const next = Math.hypot(position.x - point.x, position.y - point.y);
    if (next < distance) {distance = next; closest = index;}
  });
  return closest;
}

function distinctPrecision(values) {
  const unique = [...new Set(values)];
  for (let digits = 3; digits <= 10; digits++) {
    if (new Set(unique.map(value => number(value, digits))).size === unique.length) return digits;
  }
  return null;
}

function rowBreakdown(row, metric, unit, mode, detailDigits) {
  const tags = [row.side, row.round ? 'round ' + row.round : ''].filter(Boolean);
  let detail;
  if (finite(row.duration_s)) {
    detail = number(row.hold_count || 1, 0) + ' × ' + number(row.duration_s) + ' s holds';
    if (finite(row.rest_s)) detail += ' / ' + number(row.rest_s) + ' s rest';
    else if (finite(row.rest_between_holds_s)) detail += ' / ' + number(row.rest_between_holds_s) + ' s rest';
    if (finite(row.round_rest_s)) detail += ' · ' + number(row.round_rest_s) + ' s between rounds';
    if (finite(row.displayLoad)) detail += ' · ' + number(row.displayLoad, 2) + ' lb';
    if (metric === 'holdTotal' && row.metricEligible) detail += ' · ' + number(row.metricValue) + ' s work';
  } else if (finite(row.displayLoad)) {
    detail = number(row.displayLoad, 2) + ' lb' + (finite(row.reps) ? ' × ' + number(row.reps) + ' reps' : '');
  } else if (finite(row.stack_setting)) {
    detail = 'Setting ' + number(row.stack_setting) + (finite(row.reps) ? ' × ' + number(row.reps) + ' reps' : '');
  } else {
    detail = finite(row.reps) ? number(row.reps) + ' reps' : 'Recorded set';
  }
  if (metric === 'strength' && finite(row.metricValue)) detail += ' · est. ' + metricLabel(row.metricValue, metric, unit, detailDigits);
  if (metric === 'volume' && finite(row.metricValue)) detail += ' · ' + metricLabel(row.metricValue, metric, unit, detailDigits);
  return '<li><span class="progress-set-name">Set ' + escapeHtml(row.set ?? '—') + (tags.length ? '<small>' + escapeHtml(tags.join(' · ')) + '</small>' : '') + '</span><span class="progress-set-detail">' + escapeHtml(detail) + '</span></li>';
}


/** The hover details contain only records that contribute to this workout value. */
export function workoutBreakdownHtml(point, metric, unit, detailDigits) {
  const rows = (point.rows || []).filter(row => row.metricEligible && row.included !== false && !row.isWarmup && !row.isFailed);
  const timed = rows.length > 0 && rows.every(row => finite(row.duration_s) && row.duration_s > 0);
  const countLabel = timed ? rows.length+' hold '+(rows.length === 1 ? 'component' : 'components')+' · '+number(point.units,0)+' completed hangs'
    : rows.length+' contributing working '+(rows.length === 1 ? 'set' : 'sets');
  const exclusions = (point.exclusions || []).map(item => item.count+' '+item.reason).join('; ');
  return '<p class="progress-contributors">'+escapeHtml(countLabel)+'</p><ul class="progress-set-list">'+rows.map(row => rowBreakdown(row,metric,unit,'sessions',detailDigits)).join('')+'</ul>'
    +(point.excludedCount ? '<p class="progress-exclusions">'+escapeHtml(point.excludedCount+' '+(point.excludedCount === 1 ? 'record excluded' : 'records excluded')+(exclusions ? ': '+exclusions : '')+'. See the workout log for source details.')+'</p>' : '');
}

let clipSerial = 0;

/** Render values in a presentation-only viewport; analytics keep their full filtered history. */
export function renderProgressionChart({host,tooltipEl,analysis,state={},selectedSession='',onSelectSession=()=>{},viewDomain=null}) {
  controllers.get(host)?.cleanup();
  const model=buildChartModel(analysis,state);
  const {points,trend,pointsMode,lineMode,metric}=model;
  const unit=analysis.metric?.unit||'';
  const width=Math.max(280,host.clientWidth),height=host.clientHeight||310;
  const domains=resolveChartDomains(model,viewDomain);
  if(!points.length){
    host.innerHTML='<div class="empty-state"><strong>No points for this view</strong><span>'+escapeHtml(analysis.notes?.[0]||'Choose another metric or date range.')+'</span></div>';
    tooltipEl.hidden=true;
    return {...model,...domains,plotRect:null,width,height,visibleCount:0};
  }
  const domain=domains.viewDomain;
  const pad={left:width<420?44:58,right:24,top:width<600?74:55,bottom:43};
  const plotRect={left:pad.left,top:pad.top,width:width-pad.left-pad.right,height:Math.max(100,height-pad.top-pad.bottom)};
  const right=plotRect.left+plotRect.width,bottom=plotRect.top+plotRect.height;
  const x=value=>plotRect.left+(value-domain.xMin)/(domain.xMax-domain.xMin)*plotRect.width;
  const y=value=>plotRect.top+(domain.yMax-value)/(domain.yMax-domain.yMin)*plotRect.height;
  const coordinates=positionChartPoints(model,domain,plotRect);
  const visible=coordinates.filter(point=>point.visible);
  const ticks=niceTicks(domain.yMin,domain.yMax).filter(value=>value>=domain.yMin&&value<=domain.yMax);
  const step=ticks.length>1?Math.abs(ticks[1]-ticks[0]):domain.yMax-domain.yMin;
  const axisDigits=Math.max(0,Math.min(8,1-Math.floor(Math.log10(step||1))));
  const spanDays=(domain.xMax-domain.xMin)/86400000;
  const tickCount=width<450?3:width<700?4:6;
  let xticks;
  if(spanDays<2){
    xticks=[{time:(domain.xMin+domain.xMax)/2,label:dayDate.format(new Date((domain.xMin+domain.xMax)/2))}];
  }else{
    xticks=Array.from({length:tickCount},(_,index)=>{
      const time=domain.xMin+index/(tickCount-1)*(domain.xMax-domain.xMin);
      return {time,label:(spanDays<120?dayDate:monthDate).format(new Date(time))};
    }).filter((tick,index,all)=>index===0||tick.label!==all[index-1].label);
  }
  const lineColor=lineMode==='connect'?'#90a683':lineMode==='smooth'?'#83cbed':lineMode==='quadratic'?'#c0a4f4':'#e5b575';
  const lineLabel=lineMode==='connect'?'Point-to-point':model.fitLabel+(trend.available?'':' · unavailable');
  const colorLegend='<div class="progress-set-legend"><span class="progress-legend-item"><i style="background:#c5ee88"></i>'+(model.aggregate?'Workout total':'Workout average')+'</span></div>';
  const legend='<div class="progress-legend" aria-label="Chart legend">'+colorLegend+'<span class="progress-line-legend"><i style="background:'+lineColor+'"></i>'+lineLabel+'</span></div>';
  const clipId='progress-clip-'+(++clipSerial);
  let svg='<svg class="progress-chart" viewBox="0 0 '+width+' '+height+'" role="group" aria-label="'+escapeHtml(model.title+'. '+model.countLabel+'. Each workout is one point. Select a point for its working-set breakdown.')+'"><defs><clipPath id="'+clipId+'"><rect x="'+plotRect.left+'" y="'+plotRect.top+'" width="'+plotRect.width+'" height="'+plotRect.height+'"/></clipPath></defs>';
  ticks.forEach(value=>{svg+='<line class="plot-grid" x1="'+plotRect.left+'" y1="'+y(value)+'" x2="'+right+'" y2="'+y(value)+'"/><text class="plot-axis" x="'+(plotRect.left-10)+'" y="'+(y(value)+3.5)+'" text-anchor="end">'+number(value,axisDigits)+'</text>';});
  xticks.forEach((tick,index)=>{svg+='<text class="plot-axis" x="'+x(tick.time)+'" y="'+(bottom+27)+'" text-anchor="'+(xticks.length===1?'middle':index===0?'start':index===xticks.length-1?'end':'middle')+'">'+escapeHtml(tick.label)+'</text>';});
  svg+='<text class="plot-label" x="'+plotRect.left+'" y="'+(plotRect.top-12)+'">'+escapeHtml(unit==='setting'?'Stack setting':unit)+'</text>';
  svg+='<g class="progress-data" clip-path="url(#'+clipId+')">';
  if(lineMode==='connect'&&points.length>1){
    const path=coordinates.map((point,index)=>(index?'L':'M')+point.x.toFixed(3)+','+point.y.toFixed(3)).join(' ');
    svg+='<path class="progress-connection" d="'+path+'" fill="none" stroke="'+lineColor+'" stroke-width="1.35" stroke-linejoin="round" opacity=".48"/>';
  }else if(lineMode!=='connect'&&trend.available){
    const curve=trend.samples.filter(point=>finite(point.x)&&finite(point.y)).map((point,index)=>(index?'L':'M')+x(point.x).toFixed(3)+','+y(point.y).toFixed(3)).join(' ');
    svg+='<path class="progress-fit" data-fit-method="'+trend.method+'" d="'+curve+'" fill="none" stroke="'+lineColor+'" stroke-width="2" opacity=".9"/>';
  }
  const coarse=window.matchMedia('(pointer:coarse)').matches;
  visible.forEach(position=>{
    const point=points[position.index],selected=point.key===selectedSession;
    const label=dateLabel(point.date)+': '+(model.aggregate?'workout total, ':'workout average, ')+metricLabel(point.value,metric,unit)+'. '+point.eligibleCount+' contributing working sets. Open breakdown.';
    if(selected)svg+='<circle cx="'+position.x+'" cy="'+position.y+'" r="9" fill="'+escapeHtml(point.color)+'" opacity=".14" pointer-events="none"/>';
    svg+='<g class="chart-point progress-point" data-progress-point="'+position.index+'" role="button" tabindex="0" aria-haspopup="dialog" aria-label="'+escapeHtml(label)+'" aria-pressed="'+selected+'"><circle class="point-hit" cx="'+position.x+'" cy="'+position.y+'" r="'+(coarse?16:9)+'" fill="transparent" pointer-events="all"/><circle class="point-mark" aria-hidden="true" cx="'+position.x+'" cy="'+position.y+'" r="'+position.radius+'" fill="'+escapeHtml(point.color)+'" stroke="#182019" stroke-width="'+Math.min(1.5,position.radius*.32)+'" pointer-events="none"/></g>';
  });
  svg+='</g></svg>';
  host.innerHTML=legend+svg;
  const chartSvg=host.querySelector('svg');
  const screenPositions=()=>{
    const matrix=chartSvg.getScreenCTM?.();
    if(matrix)return visible.map(point=>({x:matrix.a*point.x+matrix.c*point.y+matrix.e,y:matrix.b*point.x+matrix.d*point.y+matrix.f}));
    const box=chartSvg.getBoundingClientRect(),scale=Math.min(box.width/width,box.height/height);
    return visible.map(point=>({x:box.left+(box.width-width*scale)/2+point.x*scale,y:box.top+(box.height-height*scale)/2+point.y*scale}));
  };
  const localIndex=new Map(visible.map((point,index)=>[point.index,index]));
  const resolvePointer=(event,fallback)=>visible[nearestPointIndex(screenPositions(),{x:event.clientX,y:event.clientY},localIndex.get(fallback)||0)]?.index??fallback;
  tooltipEl.classList.add('progress-tooltip');tooltipEl.hidden=true;
  let pinned=false,activeIndex=-1,hideTimer,lastAnchor,suppressNextFocus=false;
  const hide=()=>{clearTimeout(hideTimer);pinned=false;activeIndex=-1;tooltipEl.hidden=true;tooltipEl.classList.remove('is-pinned');tooltipEl.setAttribute('role','status');};
  const restorePointFocus=()=>{if(lastAnchor&&document.activeElement!==lastAnchor){suppressNextFocus=true;lastAnchor.focus();}};
  const positionTooltip=(event,anchor)=>{
    const box=anchor.getBoundingClientRect();
    const px=finite(event?.clientX)&&event.clientX?event.clientX:box.left+box.width/2;
    const py=finite(event?.clientY)&&event.clientY?event.clientY:box.top;
    const tipWidth=tooltipEl.offsetWidth,tipHeight=tooltipEl.offsetHeight;
    let top=py-tipHeight-12;if(top<10)top=Math.min(window.innerHeight-tipHeight-10,py+18);
    tooltipEl.style.left=Math.max(10,Math.min(window.innerWidth-tipWidth-10,px+13))+'px';
    tooltipEl.style.top=Math.max(10,top)+'px';
  };
  const pointEls=new Map([...host.querySelectorAll('[data-progress-point]')].map(element=>[Number(element.dataset.progressPoint),element]));
  const show=(index,event,anchor,pin=false)=>{
    if(host.dataset.interacting==='true')return;
    clearTimeout(hideTimer);if(pinned&&!tooltipEl.hidden&&!pin)return;
    pinned=pin;activeIndex=index;lastAnchor=anchor;
    const point=points[index];
    const nearby=nearbyPointIndexes(screenPositions(),localIndex.get(index),7).map(candidate=>visible[candidate].index).filter(candidate=>candidate!==index);
    const digits=nearby.length?distinctPrecision([point.value,...nearby.map(candidate=>points[candidate].value)]):undefined;
    const heading=(model.aggregate?'Workout total':'Workout average')+(point.dateCount>1?' · workout '+(point.dateOrder+1)+' of '+point.dateCount:'');
    const neighbors=nearby.length?'<details class="progress-neighbors"><summary>Nearby '+'workouts'+' ('+nearby.length+')</summary><div class="progress-nearby-list">'+nearby.map(candidate=>{
      const item=points[candidate];return '<button type="button" class="progress-neighbor" data-nearby-point="'+candidate+'"><i style="background:'+escapeHtml(item.color)+'"></i><span>'+escapeHtml(dateLabel(item.date))+'<small>'+(item.dateCount>1?'Workout '+(item.dateOrder+1)+' of '+item.dateCount:'Workout average')+'</small></span><strong>'+escapeHtml(metricLabel(item.value,metric,unit,digits))+'</strong></button>';
    }).join('')+'</div></details>':'';
    tooltipEl.innerHTML='<div class="progress-tooltip-head"><strong>'+escapeHtml(dateLabel(point.date))+'</strong><button type="button" class="progress-tooltip-close" aria-label="Close workout details">×</button></div><span class="tooltip-value">'+escapeHtml(metricLabel(point.value,metric,unit,digits))+'</span><span class="progress-point-key"><i style="background:'+escapeHtml(point.color)+'"></i>'+escapeHtml(heading)+(point.partial?' · partial total':'')+'</span>'+workoutBreakdownHtml(point,metric,unit,digits)+neighbors+'<div class="progress-tooltip-actions"><button type="button" class="progress-inspect">Inspect workout →</button></div><span class="progress-tooltip-help">'+(pin?'Esc or × to close':'Click or tap to keep these details open')+'</span>';
    tooltipEl.hidden=false;tooltipEl.classList.toggle('is-pinned',pin);tooltipEl.setAttribute('role',pin?'dialog':'status');tooltipEl.setAttribute('aria-label',dateLabel(point.date)+' '+heading);
    tooltipEl.querySelector('.progress-tooltip-close').addEventListener('click',()=>{hide();restorePointFocus();});
    tooltipEl.querySelector('.progress-inspect').addEventListener('click',()=>{hide();onSelectSession(point.key);});
    tooltipEl.querySelectorAll('[data-nearby-point]').forEach(button=>button.addEventListener('click',()=>{const next=Number(button.dataset.nearbyPoint);show(next,null,pointEls.get(next),true);}));
    tooltipEl.querySelector('.progress-neighbors')?.addEventListener('toggle',()=>positionTooltip(event,anchor));
    positionTooltip(event,anchor);
  };
  const scheduleHide=()=>{clearTimeout(hideTimer);if(!pinned)hideTimer=setTimeout(hide,160);};
  const pointList=[...pointEls.values()];
  pointList.forEach((element,listIndex)=>{
    const index=Number(element.dataset.progressPoint);
    element.addEventListener('pointerenter',event=>{if(event.pointerType!=='touch'&&host.dataset.interacting!=='true'){const nearest=resolvePointer(event,index);show(nearest,event,pointEls.get(nearest));}});
    element.addEventListener('pointermove',event=>{if(event.pointerType!=='touch'&&!pinned&&host.dataset.interacting!=='true'){const nearest=resolvePointer(event,index);show(nearest,event,pointEls.get(nearest));}});
    element.addEventListener('pointerleave',scheduleHide);
    element.addEventListener('focus',event=>{if(suppressNextFocus){suppressNextFocus=false;return;}show(index,event,element);});
    element.addEventListener('blur',event=>{if(!tooltipEl.contains(event.relatedTarget))scheduleHide();});
    element.addEventListener('click',event=>{if(host.dataset.interacting==='true')return;const nearest=event.detail===0?index:resolvePointer(event,index);if(pinned&&activeIndex===nearest&&!tooltipEl.hidden)hide();else show(nearest,event,pointEls.get(nearest),true);});
    element.addEventListener('keydown',event=>{
      if(event.key==='Enter'||event.key===' '){event.preventDefault();show(index,event,element,true);tooltipEl.querySelector('.progress-inspect')?.focus();}
      else if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();hide();pointList[Math.max(0,Math.min(pointList.length-1,listIndex+(event.key==='ArrowLeft'?-1:1)))]?.focus();}
      else if(event.key==='Escape')hide();
    });
  });
  const keepTooltip=()=>clearTimeout(hideTimer),leaveTooltip=()=>scheduleHide();
  const outside=event=>{if(pinned&&!tooltipEl.contains(event.target)&&!event.target.closest?.('[data-progress-point]'))hide();};
  const escape=event=>{if(event.key==='Escape'&&!tooltipEl.hidden){event.preventDefault();hide();restorePointFocus();}};
  tooltipEl.addEventListener('pointerenter',keepTooltip);tooltipEl.addEventListener('pointerleave',leaveTooltip);
  document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape,true);
  controllers.set(host,{cleanup(){hide();tooltipEl.removeEventListener('pointerenter',keepTooltip);tooltipEl.removeEventListener('pointerleave',leaveTooltip);document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape,true);}});
  return {...model,...domains,plotRect,width,height,visibleCount:visible.length};
}
