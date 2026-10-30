import { summarizeClimbing, formatMaxGrade } from './climbing-analytics-model.js';
import { GRADE_SYSTEMS, categoryInfo } from './climbing-model.js';
import { getTrainingToday } from './exercise-archive.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const num = value => new Intl.NumberFormat('en-CA', {maximumFractionDigits:1}).format(value ?? 0);
const shortDate = value => new Intl.DateTimeFormat('en-CA', {month:'short',day:'numeric',timeZone:'UTC'}).format(new Date(value+'T12:00:00Z'));
const longDate = value => new Intl.DateTimeFormat('en-CA', {month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(value+'T12:00:00Z'));
const scaleLabel = value => GRADE_SYSTEMS.find(scale => scale.id === value)?.label || value || 'Unspecified scale';
const shiftDate = (date,days) => new Date(Date.parse(date+'T12:00:00Z')+days*86400000).toISOString().slice(0,10);
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(Date.parse(value+'T12:00:00Z')) && new Date(value+'T12:00:00Z').toISOString().slice(0,10) === value;
const empty = message => `<div class="climb-analytics-empty">${esc(message)}</div>`;
const legend = items => `<div class="climb-analytics-legend">${items.map(([label,key]) => `<span><i class="ca-key-${key}"></i>${esc(label)}</span>`).join('')}</div>`;
const table = (caption,head,rows) => `<details class="climb-analytics-values"><summary>View values</summary><div class="climb-analytics-table-scroll"><table><caption class="sr-only">${esc(caption)}</caption><thead><tr>${head.map(cell=>`<th scope="col">${esc(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map((cell,index)=>`<${index?'td':'th scope="row"'}>${esc(cell)}</${index?'td':'th'}>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;

function pairedBars(rows,{title,first='Attempted',second='Sent',firstKey='distinctClimbs',secondKey='distinctSentClimbs',label=row=>row.label,description=row=>row.label}={}) {
  if(!rows.length)return empty('No climbs match this selection.');
  const dated=rows.every(row=>validDate(row.date)),periodDays=rows.some(row=>row.end)?7:1;
  const firstDate=dated?Date.parse(rows[0].date+'T12:00:00Z'):0,periodMs=periodDays*86400000;
  const periods=dated?Math.max(1,(Date.parse(rows.at(-1).date+'T12:00:00Z')-firstDate)/periodMs+1):rows.length;
  const width=Math.max(480,Math.min(12000,periods*46+64)),height=230,left=42,right=16,top=22,bottom=48,chartHeight=height-top-bottom;
  const maximum=Math.max(1,...rows.map(row=>Math.max(row[firstKey]||0,row[secondKey]||0))),step=(width-left-right)/periods;
  const ticks=[0,...new Set([Math.ceil(maximum/2),maximum])];
  const grid=ticks.map(value=>{const y=top+chartHeight*(1-value/maximum);return `<line x1="${left}" y1="${y}" x2="${width-right}" y2="${y}" class="ca-grid"/><text x="${left-9}" y="${y+4}" text-anchor="end" class="ca-axis">${esc(num(value))}</text>`;}).join('');
  const bars=rows.map((row,index)=>{
    const position=dated?(Date.parse(row.date+'T12:00:00Z')-firstDate)/periodMs:index;
    const x=left+(position+.5)*step,barWidth=Math.min(13,step*.27),a=row[firstKey]||0,b=row[secondKey]||0;
    const text=`${description(row)}: ${first} ${num(a)}, ${second} ${num(b)}`;
    return `<g tabindex="0" role="img" aria-label="${esc(text)}"><title>${esc(text)}</title><rect x="${x-barWidth-2}" y="${top+chartHeight*(1-a/maximum)}" width="${barWidth}" height="${chartHeight*a/maximum}" rx="3" class="ca-bar-attempted"/><rect x="${x+2}" y="${top+chartHeight*(1-b/maximum)}" width="${barWidth}" height="${chartHeight*b/maximum}" rx="3" class="ca-bar-sent"/><text x="${x}" y="${height-bottom+19}" text-anchor="middle" class="ca-axis">${esc(label(row))}</text></g>`;
  }).join('');
  return `${legend([[first,'attempted'],[second,'sent']])}<div class="climb-analytics-chart-scroll" tabindex="0" role="region" aria-label="${esc(title)}; scroll horizontally when needed"><svg viewBox="0 0 ${width} ${height}" style="min-width:${width}px" role="img" aria-label="${esc(title)}">${grid}${bars}</svg></div>`;
}

function horizontalBars(rows,{title,first='Attempted',second='Sent',firstKey='distinctClimbs',secondKey='distinctSentClimbs',label=row=>row.label}={}) {
  if(!rows.length)return empty('No recorded values in this selection.');
  const maximum=Math.max(1,...rows.map(row=>Math.max(row[firstKey]||0,row[secondKey]||0)));
  return `${legend([[first,'attempted'],[second,'sent']])}<div class="climb-analytics-horizontal" role="list" aria-label="${esc(title)}">${rows.map(row=>{const firstValue=row[firstKey]||0,secondValue=row[secondKey]||0;return `<div class="ca-horizontal-row" role="listitem"><div class="ca-horizontal-label"><span>${esc(label(row))}</span><strong>${num(secondValue)} <small>sent / ${num(firstValue)} tried</small></strong></div><div class="ca-horizontal-tracks" aria-hidden="true"><i class="ca-track-attempted" style="width:${100*firstValue/maximum}%"></i><i class="ca-track-sent" style="width:${100*secondValue/maximum}%"></i></div></div>`;}).join('')}</div>`;
}

function progression(rows,gradeSystem,{bucket,board,allAngles}) {
  if(!gradeSystem)return empty('Choose one grade scale above to see a grade progression. Different scales are kept separate.');
  if(['gym','other'].includes(gradeSystem))return empty('These grade labels have no universal order. The grade distribution keeps your recorded labels without assigning a maximum.');
  const points=rows.map(row=>{
    const best=(row.maxGrades||[]).find(item=>item.gradeSystem===gradeSystem&&finite(item.rank));
    return {date:row.date,rank:best?.rank??null,label:best?.label||'',ranges:(row.maxGrades||[]).filter(item=>item.gradeSystem===gradeSystem).flatMap(item=>item.ranges||[])};
  });
  if(!points.some(point=>point.rank!==null))return empty('No completed climbs with an exact, recognized grade in this selection. Grade ranges remain in the grade breakdown.');
  const ranked=points.filter(point=>point.rank!==null),min=Math.min(...ranked.map(point=>point.rank)),max=Math.max(...ranked.map(point=>point.rank));
  const firstDate=Date.parse(points[0].date+'T12:00:00Z'),lastDate=Date.parse(points.at(-1).date+'T12:00:00Z'),periodMs=(bucket==='week'?7:1)*86400000;
  const periods=Math.max(1,(lastDate-firstDate)/periodMs+1);
  const width=Math.max(540,Math.min(12000,periods*55+100)),height=240,left=67,right=24,top=30,bottom=48,chartHeight=height-top-bottom,span=Math.max(2,max-min),low=min-(span-(max-min))/2;
  const x=index=>left+(lastDate===firstDate?.5:(Date.parse(points[index].date+'T12:00:00Z')-firstDate)/(lastDate-firstDate))*(width-left-right),y=rank=>top+chartHeight*(1-(rank-low)/span);
  const ranks=[...new Map(ranked.map(point=>[point.rank,point.label])).entries()].sort((a,b)=>a[0]-b[0]);
  const ticks=ranks.filter((_,index)=>ranks.length<=6||index===0||index===ranks.length-1||index%Math.ceil(ranks.length/5)===0);
  const grid=ticks.map(([rank,label])=>`<line x1="${left}" y1="${y(rank)}" x2="${width-right}" y2="${y(rank)}" class="ca-grid"/><text x="${left-10}" y="${y(rank)+4}" text-anchor="end" class="ca-axis">${esc(label)}</text>`).join('');
  const dots=points.map((point,index)=>{
    const date=shortDate(point.date),axis=`<text x="${x(index)}" y="${height-bottom+21}" text-anchor="middle" class="ca-axis">${esc(date)}</text>`;
    if(point.rank===null)return axis;
    const previous=points[index-1],consecutive=previous&&(Date.parse(point.date+'T12:00:00Z')-Date.parse(previous.date+'T12:00:00Z'))===periodMs,line=consecutive&&previous?.rank!==null&&previous?.rank!==undefined?`<line x1="${x(index-1)}" y1="${y(previous.rank)}" x2="${x(index)}" y2="${y(point.rank)}" class="ca-grade-line"/>`:'';
    return `${line}<g tabindex="0" role="img" aria-label="${esc(longDate(point.date)+': '+point.label)}"><title>${esc(longDate(point.date)+': '+point.label)}</title><circle cx="${x(index)}" cy="${y(point.rank)}" r="5" class="ca-grade-point"/></g>${axis}`;
  }).join('');
  return `<div class="climb-analytics-chart-scroll" tabindex="0" role="region" aria-label="Best completed grade by ${bucket}"><svg viewBox="0 0 ${width} ${height}" style="min-width:${width}px" role="img" aria-label="Best exact completed ${esc(scaleLabel(gradeSystem))} grade by ${bucket}">${grid}${dots}</svg></div><p class="climb-analytics-footnote">Each point is that ${bucket}’s highest exact completed grade. Ranges and unordered labels are not plotted. Grade steps show an order, not equal differences in difficulty.${board&&allAngles?' Select an angle for a consistent board comparison.':''}</p>${table('Best completed grades',['Date','Best exact grade','Completed ranges'],points.map(point=>[longDate(point.date),point.label||'—',point.ranges.map(range=>range.label).join(', ')||'—']))}`;
}

function outcomeChart(totals) {
  const sends=totals.sends||0,logged=totals.loggedAttempts||0,unrecorded=totals.unrecordedAttempts??Math.max(0,(totals.attempts||0)-logged),unfinished=Math.max(0,logged-sends),total=sends+unfinished+unrecorded;
  if(!total)return empty('Log attempts to see their outcomes.');
  const percentage=logged?100*sends/logged:null;
  return `<div class="climb-analytics-outcome"><div class="ca-outcome-number">${percentage===null?'—':num(percentage)+'%'}<span>of logged attempts completed</span></div><div class="ca-outcome-strip" role="img" aria-label="${num(sends)} completed attempts, ${num(unfinished)} unfinished attempts, ${num(unrecorded)} earlier attempts without an outcome record"><i class="ca-outcome-completed" style="width:${100*sends/total}%"></i><i class="ca-outcome-unfinished" style="width:${100*unfinished/total}%"></i><i class="ca-outcome-unknown" style="width:${100*unrecorded/total}%"></i></div><dl class="ca-outcome-list"><div><dt><i class="ca-key-sent"></i>Completed</dt><dd>${num(sends)}</dd></div><div><dt><i class="ca-key-attempted"></i>Not completed</dt><dd>${num(unfinished)}</dd></div><div><dt><i class="ca-key-unknown"></i>Outcome not recorded</dt><dd>${num(unrecorded)}</dd></div></dl></div><p class="climb-analytics-footnote">Repeated successful ascents count as separate completed attempts. Earlier tries implied by an attempt number are included in total attempts, with their outcomes left unknown.</p>`;
}

/** Read-only analytics for one of the independently scoped climbing trackers. */
export function createClimbingAnalytics({host,kind='climbing'}) {
  const board=kind==='kilter',prefix=board?'kilter-analytics':'climbing-analytics';
  let context={workouts:[],category:board?'kilter':'indoor_boulder',loaded:false,loading:false,failed:false,dateFilter:'',venueFilter:'',search:''};
  let range='all',from='',to='',scale='all',angle='all',bucket='week';
  const abort=new AbortController(),events={signal:abort.signal},q=selector=>host.querySelector(selector);
  host.className='climb-analytics';
  host.innerHTML=`<section aria-labelledby="${prefix}-title"><header class="climb-analytics-heading"><div><span class="eyebrow">YOUR CLIMBING, IN VIEW</span><h3 id="${prefix}-title">${board?'Kilter analytics':'Climbing analytics'}</h3><p data-ca-context></p></div><span class="climb-analytics-badge">${board?'BOARD ONLY':'ONE DISCIPLINE AT A TIME'}</span></header><div class="climb-analytics-controls"><label>Analytics range<select data-ca-range aria-label="${board?'Kilter':'Climbing'} analytics range"><option value="all">All saved dates</option><option value="28">Last 4 weeks</option><option value="84">Last 12 weeks</option><option value="year">This year</option><option value="custom">Custom dates</option></select></label><label>Grade scale<select data-ca-scale aria-label="${board?'Kilter':'Climbing'} analytics grade scale"></select></label>${board?'<label>Board angle<select data-ca-angle aria-label="Kilter analytics board angle"></select></label>':''}<label>Group timeline<select data-ca-bucket aria-label="${board?'Kilter':'Climbing'} analytics timeline grouping"><option value="week">By week</option><option value="day">By day</option></select></label><div class="climb-analytics-custom" data-ca-custom hidden><label>From<input type="date" data-ca-from aria-label="${board?'Kilter':'Climbing'} analytics start date"></label><label>Through<input type="date" data-ca-to aria-label="${board?'Kilter':'Climbing'} analytics end date"></label></div></div><p class="climb-analytics-scope" data-ca-scope></p><div class="climb-analytics-status" data-ca-status role="status" hidden></div><div class="climb-analytics-metrics" data-ca-metrics></div><p class="climb-analytics-metric-note" data-ca-metric-note></p><div class="climb-analytics-grid" data-ca-charts></div><details class="climb-analytics-method"><summary>How these counts work</summary><div><p>A climb counts once in the selected period even if you try it repeatedly. ${board?'Each climb at each board angle is counted separately.':'Saved climb identities stay separate, even when their names match.'} The timeline counts each climb once within each day or week, so its bars can add up to more than the period’s distinct-climb total.</p><p>Attempts use the highest attempt number for each climb in each workout${board?' and angle':''}; attempt numbers are not added together. A successful ascent requires a recorded completed result. Missing earlier outcomes are not assumed to be failures or successes.</p><p>Maximum grades use successful exact grades within one grade scale. Completed ranges are shown as ranges, without treating the upper end as achieved. Grade distributions use the grade recorded on each attempt; a climb with changed grade records can appear in more than one grade bucket. Tags can overlap. Deleted workouts are excluded.</p><p>Category, location, exact date and workout search above apply here. A matching workout contributes all its climbs; use the scale and angle controls to narrow the analytics further.</p></div></details></section>`;

  function selectedDates() {
    if(context.dateFilter)return {from:context.dateFilter,to:context.dateFilter};
    const today=getTrainingToday();
    if(range==='custom')return {from:from||undefined,to:to||undefined};
    if(range==='year')return {from:today.slice(0,4)+'-01-01',to:today};
    if(range==='28'||range==='84')return {from:shiftDate(today,1-Number(range)),to:today};
    return {};
  }
  function chart(id,index,title,caption,content,{wide=false}={}) {
    return `<details class="climb-analytics-card${wide?' ca-card-wide':''}" data-ca-chart="${id}" open><summary><span><small>${esc(index)}</small><strong>${esc(title)}</strong></span><i aria-hidden="true"></i></summary><div class="climb-analytics-card-body"><p class="climb-analytics-caption">${esc(caption)}</p>${content}</div></details>`;
  }
  function render() {
    const scopes=(context.workouts||[]).filter(workout=>workout.category===context.category&&!workout.deleted_at&&!workout.deletedAt);
    const scales=[...new Set(scopes.flatMap(workout=>(workout.attempts||[]).map(attempt=>attempt.gradeSystem).filter(Boolean)))];
    // A narrower parent filter must never silently broaden an explicit scale or angle choice.
    q('[data-ca-scale]').innerHTML='<option value="all">All grade scales</option>'+GRADE_SYSTEMS.filter(item=>scales.includes(item.id)||item.id===scale).map(item=>`<option value="${esc(item.id)}">${esc(item.label)}${scales.includes(item.id)?'':' (no matching climbs)'}</option>`).join('');
    q('[data-ca-scale]').value=scale;
    const angles=[...new Set(scopes.flatMap(workout=>(workout.attempts||[]).map(attempt=>attempt.angle).filter(finite)))].sort((a,b)=>a-b);
    if(board){
      const choices=angle!=='all'&&!angles.includes(Number(angle))?[...angles,Number(angle)].sort((a,b)=>a-b):angles;
      q('[data-ca-angle]').innerHTML='<option value="all">All angles</option>'+choices.map(value=>`<option value="${value}">${num(value)}°${angles.includes(value)?'':' (no matching climbs)'}</option>`).join('');
      q('[data-ca-angle]').value=angle;
    }
    q('[data-ca-range]').value=range;q('[data-ca-range]').disabled=!!context.dateFilter;
    q('[data-ca-bucket]').value=bucket;q('[data-ca-custom]').hidden=range!=='custom'||!!context.dateFilter;
    q('[data-ca-from]').value=from;q('[data-ca-to]').value=to;
    const dates=selectedDates(),invalid=!!((dates.from&&!validDate(dates.from))||(dates.to&&!validDate(dates.to))||(dates.from&&dates.to&&dates.from>dates.to));
    const categoryLabel=categoryInfo(context.category)?.label||'Climbing';
    q('[data-ca-context]').textContent=categoryLabel+' · '+(context.venueFilter||'All locations')+(context.search?' · matching workouts':'');
    q('[data-ca-scope]').textContent=context.dateFilter?'Exact date selected above: '+longDate(context.dateFilter)+'. Clear that date to compare a longer period.':(dates.from?'From '+longDate(dates.from):'All saved dates')+(dates.to?' through '+longDate(dates.to):'')+(scale==='all'?' · all recorded grade scales':' · '+scaleLabel(scale))+(board?' · '+(angle==='all'?'all angles':num(Number(angle))+'°'):'');
    let status='';
    if(!context.loaded)status=context.failed?'Analytics unavailable. Retry loading your saved workouts above.':'Loading saved workouts for analytics…';
    else if(context.failed)status='Couldn’t refresh saved workouts. These charts show the last successfully loaded history; retry above to update them.';
    else if(context.loading)status='Refreshing saved workouts…';
    if(invalid)status='Choose a valid date range with the start on or before the end.';
    q('[data-ca-status]').hidden=!status;q('[data-ca-status]').textContent=status;
    q('[data-ca-status]').classList.toggle('ca-status-error',context.failed||invalid);
    if(!context.loaded||invalid){q('[data-ca-metrics]').innerHTML=['Climbs attempted','Climbs sent','Total attempts','Max grade achieved'].map(label=>metric(label,'—','')).join('');q('[data-ca-metric-note]').textContent='';q('[data-ca-charts]').innerHTML=empty(invalid?'Adjust the dates to see your analytics.':'Your graphs will appear after saved workouts load.');return;}
    const summary=summarizeClimbing(scopes,{category:context.category,...dates,...(scale!=='all'?{gradeSystem:scale}:{}),...(board&&angle!=='all'?{angle:Number(angle)}:{})}),totals=summary.totals;
    const gradeText=(summary.maxGrades||[]).length?formatMaxGrade(summary.maxGrades):'—';
    const currentScales=[...new Set((summary.grades||[]).map(row=>row.gradeSystem))],progressScale=scale!=='all'?scale:currentScales.length===1?currentScales[0]:null;
    q('[data-ca-metrics]').innerHTML=metric('Climbs attempted',num(totals.distinctClimbs),board?'Distinct climb + angle combinations':'Distinct saved climbs')+metric('Climbs sent',num(totals.distinctSentClimbs),num(totals.sends)+' successful '+(totals.sends===1?'ascent':'ascents'))+metric('Total attempts',num(totals.attempts),num(totals.loggedAttempts)+' with recorded outcomes')+metric('Max grade achieved',gradeText,'Completed climbs · grade ranges kept explicit',true);
    q('[data-ca-metric-note]').textContent=(board?'Kilter is kept separate from wall bouldering. ':'')+'Totals describe the current selection. A completed repeat adds an ascent, without adding a new distinct climb.';
    const series=bucket==='day'?summary.daily:summary.weekly,periodName=bucket==='day'?'day':'week';
    const openStates=new Map([...host.querySelectorAll('[data-ca-chart]')].map(el=>[el.dataset.caChart,el.open]));
    const volume=pairedBars(series,{title:'Climbs attempted and sent by '+periodName,label:row=>shortDate(row.date),description:row=>longDate(row.date)+(row.end?' – '+longDate(row.end):'')})+table('Climbs by '+periodName,['Starting','Climbs attempted','Climbs sent','Attempts','Successful ascents'],series.map(row=>[longDate(row.date),num(row.distinctClimbs),num(row.distinctSentClimbs),num(row.attempts),num(row.sends)]));
    const gradeRows=summary.grades||[];
    let gradeContent='';
    if(!gradeRows.length)gradeContent=empty('No recorded grades in this selection.');
    else for(const gradeSystem of currentScales){const rows=gradeRows.filter(row=>row.gradeSystem===gradeSystem);gradeContent+=`<div class="ca-grade-group"><h5>${esc(scaleLabel(gradeSystem))}</h5>${horizontalBars(rows,{title:'Climbs by '+scaleLabel(gradeSystem),label:row=>row.label+(row.isRange?' · range':'')})}</div>`;}
    gradeContent+=gradeRows.length?table('Climbs by grade',['Scale','Recorded grade','Climbs attempted','Climbs sent','Attempts','Successful ascents'],gradeRows.map(row=>[scaleLabel(row.gradeSystem),row.label+(row.isRange?' (range)':''),num(row.distinctClimbs),num(row.distinctSentClimbs),num(row.attempts),num(row.sends)])):'';
    const breakdown=board?(summary.angles||[]):(summary.tags||[]),breakTitle=board?'Climbs by board angle':'Climbs by style / tag';
    const breakdownContent=horizontalBars(breakdown,{title:breakTitle,label:row=>board?num(row.angle)+'°':row.label})+(breakdown.length?table(breakTitle,[board?'Angle':'Tag','Climbs attempted','Climbs sent','Attempts'],breakdown.map(row=>[board?num(row.angle)+'°':row.label,num(row.distinctClimbs),num(row.distinctSentClimbs),num(row.attempts)])):'')+(board?'':`<p class="climb-analytics-footnote">Add tags such as Slab, Overhang, Crimps or Dynamic when logging. A climb can appear under multiple tags.</p>`);
    q('[data-ca-charts]').innerHTML=chart('volume','01 / VOLUME','Climbs over time','Distinct climbs attempted and sent within each '+periodName+'. Gaps are periods without saved attempts.',volume)+chart('grades','02 / GRADE MIX','Climbs completed at each grade','Successful climbs alongside everything you attempted; recorded grade scales stay separate.',gradeContent)+chart('progression','03 / PROGRESSION','Max grade achieved over time','Your highest exact completed grade, with the original scale preserved.',progression(series,progressScale,{bucket:periodName,board,allAngles:angle==='all'}),{wide:true})+chart('outcomes','04 / ATTEMPTS','How your attempts finished','See the outcome of recorded tries and how many earlier tries have no saved outcome.',outcomeChart(totals))+chart('breakdown',board?'05 / BOARD ANGLE':'05 / MOVEMENT',breakTitle,board?'The same climb at two different angles is two different climbing variants.':'Compare the kinds of climbing you are attempting and completing.',breakdownContent);
    for(const el of host.querySelectorAll('[data-ca-chart]'))if(openStates.has(el.dataset.caChart))el.open=openStates.get(el.dataset.caChart);
  }
  function metric(label,value,note,grade=false){return `<article class="climb-analytics-metric${grade?' ca-metric-grade':''}"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></article>`;}
  host.addEventListener('change',event=>{
    const el=event.target;
    if(el.matches('[data-ca-range]'))range=el.value;
    else if(el.matches('[data-ca-scale]'))scale=el.value;
    else if(el.matches('[data-ca-angle]'))angle=el.value;
    else if(el.matches('[data-ca-bucket]'))bucket=el.value;
    else if(el.matches('[data-ca-from]'))from=el.value;
    else if(el.matches('[data-ca-to]'))to=el.value;
    else return;
    render();
  },events);
  render();
  return {update(next){context={...context,...next};render();},destroy(){abort.abort();host.innerHTML='';}};
}
