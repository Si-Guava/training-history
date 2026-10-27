/** Presentation of timed rounds without inventing missing durations, rests or sides. */
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const number=value=>new Intl.NumberFormat('en-CA',{maximumFractionDigits:2}).format(value);

export function formatSeconds(value) {
  if(!finite(value))return '—';
  if(value>=60&&Number.isInteger(value)&&value%60===0)return number(value/60)+' min';
  return number(value)+' s';
}
export function isRepeaterRecord(row) {
  return finite(row?.duration_s)&&(row.tracking==='repeaters'||/repeater/i.test(row.set_type||'')||finite(row.round)||(finite(row.hold_count)&&row.hold_count>1));
}
function recordedRest(row) {
  if(finite(row.rest_s)&&row.rest_s>=0)return {seconds:row.rest_s,source:'entered'};
  // This exact archive note explicitly applies 3 seconds only to round 1.
  if(row.round===1&&/3-second rest is noted with the first round; later-round rests are not repeated/i.test(row.notes||''))return {seconds:3,source:'source note'};
  return {seconds:null,source:null};
}
export function describeHoldRecord(row) {
  if(!finite(row?.duration_s))return null;
  const hangs=finite(row.hold_count)&&row.hold_count>0?row.hold_count:1;
  const repeater=isRepeaterRecord(row),rest=recordedRest(row);
  const primary=repeater?`${number(hangs)} ${hangs===1?'hang':'hangs'} × ${number(row.duration_s)} s`:`${number(row.duration_s)} s hold`;
  const activeSeconds=hangs*row.duration_s;
  const details=[`${formatSeconds(activeSeconds)} active`];
  if(repeater){details.push(finite(rest.seconds)?`${number(rest.seconds)} s rest${rest.source==='source note'?' (source note)':''}`:'rest not recorded');if(finite(row.round_rest_s))details.push(`${formatSeconds(row.round_rest_s)} between rounds`);}
  return {primary,secondary:details.join(' · '),activeSeconds,hangs,seconds:row.duration_s,isRepeater:repeater,round:finite(row.round)?row.round:null,side:row.side||null,restSeconds:rest.seconds,roundRestSeconds:finite(row.round_rest_s)?row.round_rest_s:null};
}

/**
 * Groups only explicitly matching date/exercise/session/round/side/entry IDs.
 * Missing round numbers remain separate. Different durations within a historical
 * round become a readable pattern, e.g. "4 × 7 s + 1 × 5 s + 1 × 3 s".
 */
export function groupRepeaterRounds(records=[]) {
  const groups=new Map();
  for(const row of records){
    if(!isRepeaterRecord(row))continue;
    const round=finite(row.round)?row.round:null;
    const key=JSON.stringify([row.date,row.exercise,row.session,row.entry_id||'archive',round??row.record_id,row.side||null]);
    if(!groups.has(key))groups.set(key,{key,date:row.date,exercise:row.exercise,session:row.session,entryId:row.entry_id||null,round,side:row.side||null,records:[]});
    groups.get(key).records.push(row);
  }
  return [...groups.values()].sort((a,b)=>String(a.date).localeCompare(String(b.date))||String(a.exercise).localeCompare(String(b.exercise))||Number(a.session)-Number(b.session)||String(a.entryId).localeCompare(String(b.entryId))||Number(a.round)-Number(b.round)||String(a.side).localeCompare(String(b.side))).map(group=>{
    const components=group.records.map(row=>({recordId:row.record_id,hangs:finite(row.hold_count)&&row.hold_count>0?row.hold_count:1,seconds:row.duration_s,load:finite(row.load_lb)?row.load_lb:null,rest:recordedRest(row),roundRest:finite(row.round_rest_s)?row.round_rest_s:null}));
    const hangCount=components.reduce((sum,item)=>sum+item.hangs,0),activeSeconds=components.reduce((sum,item)=>sum+item.hangs*item.seconds,0);
    const pattern=components.map(item=>number(item.hangs)+' × '+number(item.seconds)+' s').join(' + ');
    const rests=[...new Set(components.map(item=>item.rest.seconds))];
    const betweenRounds=[...new Set(components.map(item=>item.roundRest))];
    const knownRests=rests.filter(finite);
    const restLabel=knownRests.length===0?'Rest between hangs not recorded':rests.length===1?`${number(rests[0])} s rest between hangs${components.some(item=>item.rest.source==='source note')?' (source note)':''}`:rests.includes(null)?'Rest partly recorded; see set details':'Rest varies; see set details';
    const roundRestLabel=betweenRounds.length===1&&finite(betweenRounds[0])?`${formatSeconds(betweenRounds[0])} between rounds`:'Rest between rounds not recorded';
    const loads=[...new Set(components.map(item=>item.load))];
    const loadLabel=loads.length===1&&finite(loads[0])?`${number(loads[0])} lb`:loads.some(finite)?'Load varies':'No pound load recorded';
    const title=(group.round!==null?'Round '+number(group.round):'Round not recorded')+' · '+(group.side?group.side+' hand':group.entryId?'Both hands together / unspecified':'Side not recorded');
    return {...group,components,hangCount,activeSeconds,pattern,restLabel,roundRestLabel,loadLabel,title,summary:`${pattern} · ${formatSeconds(activeSeconds)} active`};
  });
}

const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
/** Optional DOM renderer. Shows round cards, grouping the original duration parts. */
export function renderRepeaterSummary(host,records=[],options={}) {
  const rounds=groupRepeaterRounds(records);
  host.hidden=rounds.length===0;
  if(!rounds.length){host.innerHTML='';return;}
  const dateLabel=options.dateLabel||((date)=>new Intl.DateTimeFormat('en-CA',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(date+'T12:00:00Z')));
  const active=rounds.reduce((sum,round)=>sum+round.activeSeconds,0),hangs=rounds.reduce((sum,round)=>sum+round.hangCount,0);
  const sessions=new Map();
  for(const round of [...rounds].sort((a,b)=>String(b.date).localeCompare(String(a.date)))){
    const key=round.date+'__'+round.session;
    if(!sessions.has(key))sessions.set(key,[]);
    sessions.get(key).push(round);
  }
  host.innerHTML='<div class="section-header"><div><span class="eyebrow">REPEATER ROUNDS</span><h3>Hang → rest → repeat</h3></div><span class="small-badge">'+escapeHtml(formatSeconds(active))+' recorded hang time</span></div><p class="repeater-summary-intro">'+hangs+' hangs. Read each round as a sequence of completed hangs. Mixed durations stay together; rest is excluded from active time.</p>'+[...sessions.values()].map((items,index)=>{
    const knownRoundCount=new Set(items.filter(item=>item.round!==null).map(item=>String(item.entryId)+'_'+item.round)).size;
    const title=dateLabel(items[0].date)+' · '+(knownRoundCount?knownRoundCount+' '+(knownRoundCount===1?'round':'rounds'):'rounds not specified');
    const sessionActive=items.reduce((sum,item)=>sum+item.activeSeconds,0);
    return '<details class="repeater-session"'+(index===0||sessions.size===1?' open':'')+'><summary><span>'+escapeHtml(title)+'</span><span>'+escapeHtml(formatSeconds(sessionActive))+' active</span></summary><div class="repeater-round-list">'+items.map(item=>'<article class="repeater-round-card"><header><h4>'+escapeHtml(item.title)+'</h4><span>'+escapeHtml(item.loadLabel)+'</span></header><p class="repeater-pattern">'+escapeHtml(item.pattern)+'</p><small>'+item.hangCount+' '+(item.hangCount===1?'hang':'hangs')+' · '+escapeHtml(formatSeconds(item.activeSeconds))+' active</small><small>'+escapeHtml(item.restLabel)+' · '+escapeHtml(item.roundRestLabel)+'</small>'+(item.records.some(row=>row.isWarmup||row.is_warmup)?'<small>Includes recorded warm-up hangs.</small>':'')+'</article>').join('')+'</div></details>';
  }).join('')+(records.some(row=>isRepeaterRecord(row)&&(row.isWarmup||row.is_warmup))?'<p class="repeater-summary-intro">These round cards include warm-ups. Your chart respects its warm-up setting.</p>':'');
}
