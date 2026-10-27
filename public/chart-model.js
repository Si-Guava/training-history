/** Pure plotting model. Session statistics remain in analytics.js. */
import { applyObservationWeights, fitTrend } from './fit-engine.js';
const finite = value => typeof value === 'number' && Number.isFinite(value);
const DAY = 86400000;
const dateTime = date => Date.parse(`${date}T12:00:00Z`);
const sessionKey = row => `${row.date}__${row.session}`;
const sum = values => values.reduce((total, value) => total + value, 0);
export const SET_COLORS = ['#c5ee88','#83cbed','#c0a4f4','#f0b476','#ed9bb8','#73d5c4','#e7d47e','#9daff0'];
export function setColor(ordinal) {
  const index = Math.max(0, Math.floor(Number(ordinal) || 1) - 1);
  return SET_COLORS[index] || `hsl(${Math.round((index * 137.508 + 72) % 360)} 64% 73%)`;
}

/** Weighted least squares against elapsed calendar days. Duplicates retain their own weight. */
export function linearBestFit(points = []) {
  const valid = points.filter(point => finite(point.value) && finite(dateTime(point.date)) && (point.weight === undefined || finite(point.weight) && point.weight > 0));
  if (valid.length < 2) return null;
  const start = Math.min(...valid.map(point => dateTime(point.date)));
  const end = Math.max(...valid.map(point => dateTime(point.date)));
  if (start === end) return null;
  const xs = valid.map(point => (dateTime(point.date) - start) / DAY);
  const ys = valid.map(point => point.value);
  const weights = valid.map(point => point.weight ?? 1), totalWeight = sum(weights);
  const meanX = sum(xs.map((x,i)=>x*weights[i])) / totalWeight;
  const meanY = sum(ys.map((y,i)=>y*weights[i])) / totalWeight;
  const xx = sum(xs.map((x,i) => weights[i]*(x - meanX) ** 2));
  if (xx <= 0) return null;
  const slope = sum(xs.map((x, i) => weights[i]*(x - meanX) * (ys[i] - meanY))) / xx;
  const intercept = meanY - slope * meanX;
  const residual = sum(xs.map((x, i) => weights[i]*(ys[i] - (intercept + slope * x)) ** 2));
  const total = sum(ys.map((value,i) => weights[i]*(value - meanY) ** 2));
  return {
    count: valid.length,
    start, end,
    slopePerDay: slope,
    intercept,
    startValue: intercept,
    endValue: intercept + slope * (end - start) / DAY,
    rSquared: total > 0 ? Math.max(0, Math.min(1, 1 - residual / total)) : 1,
  };
}

/** Training exposure, distinct from measurement precision or physiological stimulus. */
export function getObservationWorkload(row) {
  const timed=finite(row.duration_s)&&row.duration_s>0;
  const units=timed&&finite(row.hold_count)&&row.hold_count>0?row.hold_count:1;
  const volumeKind=timed?'hold':finite(row.reps)&&row.reps>0?'reps':null;
  const notes=[row.notes,row.resistance_setup,row.original_variation,row.set_type].filter(Boolean).join(' ');
  const ambiguous=/\bUAP\b|machine dip/i.test(row.exercise||'')||/resistance or assistance|resistance\/assistance|load role unclear/i.test(row.resistance_setup||'');
  const unclear=typeof row.completedRepsUnclear==='boolean'?row.completedRepsUnclear:/completed[^.]*unclear|unclear[^.]*completed|failure notation/i.test(notes);
  const volume=!ambiguous&&!unclear&&finite(row.effectiveLoad)&&row.effectiveLoad>0&&volumeKind
    ?row.effectiveLoad*(timed?row.duration_s*units:row.reps):null;
  return {units,volume,volumeKind};
}

/** Conservative display policy: expose unsupported polynomial excursions instead of clipping them. */
export function protectDescriptiveFit(fit, observedValues, quantity='values') {
  if(!fit?.available)return fit;
  const observed=observedValues.filter(finite);
  const predicted=(fit.vertices?.length?fit.vertices.map(point=>point.z):(fit.samples||[]).map(point=>point.y)).filter(finite);
  if(!observed.length||!predicted.length)return fit;
  const lo=Math.min(...observed),hi=Math.max(...observed),minimum=Math.min(...predicted),maximum=Math.max(...predicted);
  const tolerance=1e-8*Math.max(1,Math.abs(lo),Math.abs(hi));
  let reason='';
  if(fit.method==='quadratic'&&(minimum<lo-tolerance||maximum>hi+tolerance))reason='This quadratic fit extends outside the recorded '+quantity+' range. Choose the smooth local average to keep the fitted values within that range.';
  else if(lo>=0&&minimum < -tolerance)reason='This fit would imply negative '+quantity+' despite nonnegative records. Choose the smooth local average.';
  return reason?{...fit,available:false,reason,samples:[],vertices:[],triangles:[],predict:()=>null,rangeGuard:true}:fit;
}

/** Only contributing completed working sets belong in a plotted workout breakdown. */
function contributingRows(session) {
  return (session.sets || []).filter(row => row.metricEligible && finite(row.metricValue) && row.included !== false && !row.isWarmup && !row.isFailed);
}

function chronological(a, b) {
  return a.date.localeCompare(b.date) ||
    (Number(a.session) - Number(b.session)) || a.order - b.order;
}

/** One observation per workout. Its value is independent of the chosen fit weighting. */
function workoutPoints(analysis) {
  const metric = analysis.metric?.key || analysis.options?.metric || 'load';
  return (analysis.series || []).filter(session => finite(session.value)).flatMap((session, order) => {
    const rows = contributingRows(session);
    if (!rows.length) return [];
    const workloads = rows.map(getObservationWorkload);
    const units = sum(rows.map((row,index) => ['strength','reps'].includes(metric) ? 1 : finite(row.averageUnits) && row.averageUnits > 0 ? row.averageUnits : workloads[index].units));
    const knownWorkloads = workloads.filter(work => finite(work.volume) && work.volume > 0);
    const exclusions = new Map();
    for (const row of (session.sets || []).filter(row => !rows.includes(row))) {
      const reason = row.workingExclusionReason || row.eligibilityReason || 'No usable value for this metric';
      exclusions.set(reason, (exclusions.get(reason) || 0) + 1);
    }
    return [{
      id:session.key, key:session.key, date:session.date, session:session.session,
      value:session.value, rows, units,
      volume:knownWorkloads.length ? sum(knownWorkloads.map(work => work.volume)) : null,
      volumeKinds:[...new Set(knownWorkloads.map(work => work.volumeKind))],
      workloadExcludedCount:workloads.length-knownWorkloads.length,
      eligibleCount:rows.length, excludedCount:(session.sets || []).length-rows.length,
      exclusions:[...exclusions].map(([reason,count]) => ({reason,count})),
      partial:Boolean(session.partial), ordinal:null, color:SET_COLORS[0], order,
    }];
  }).sort(chronological);
}

/** Fit the displayed workout averages; set counts and workload control influence only. */
export function buildTrendData(analysis, input = {}) {
  const metric = analysis.metric?.key || analysis.options?.metric || 'load';
  const aggregate = metric === 'volume' || metric === 'holdTotal';
  const mode = ['sets','sessions','volume'].includes(input.fitWeight) ? input.fitWeight : 'sets';
  const points = workoutPoints(analysis);
  const raw = points.map(point => ({x:dateTime(point.date),y:point.value,date:point.date,value:point.value,sessionKey:point.key,units:point.units,volume:point.volume,volumeKinds:point.volumeKinds}));
  if (aggregate) {
    const observations = raw.map(point => ({...point,weight:1,units:1}));
    return {observations,mode:'sessions',requestedMode:mode,aggregate,excluded:0,reason:'',weightNote:'Each working-set workout total is fitted once, with equal weight per workout.'};
  }
  const kinds = new Set(points.flatMap(point => point.volumeKinds));
  if (mode === 'volume' && kinds.size > 1) return {observations:[],mode,aggregate,excluded:raw.length,reason:'This view mixes repetitions and timed holds. Choose set or session weighting to avoid combining different workload units.',weightNote:'Volume weighting cannot mix lb·reps and lb·seconds.'};
  const observations = applyObservationWeights(raw, mode);
  const excluded = raw.length-observations.length;
  const timed = kinds.has('hold') || points.some(point => point.rows.some(row => finite(row.duration_s) && row.duration_s > 0));
  const weightNote = mode === 'sessions' ? 'Each workout average has equal influence.'
    : mode === 'volume' ? 'Workout averages are weighted by their known total '+(kinds.has('hold') ? 'load × active hold time (lb·s)' : 'load × base reps (lb·reps)')+'.'+(excluded ? ' '+excluded+' workouts without positive known workload are excluded from the fit.' : '')
    : timed ? 'Workout averages are weighted by their contributing set or completed-hang count.' : 'Workout averages are weighted by their contributing working-set count.';
  return {observations,mode,aggregate,excluded,reason:observations.length ? '' : mode === 'volume' ? 'No positive known workload is available for volume weighting. Choose set or session weighting.' : 'No eligible working-set workout averages in this view.',weightNote};
}

function plotDescription(analysis, aggregate, sameDayWorkouts) {
  const description=analysis.metric?.description || '';
  const explainsExclusions=/warm[-\s]?ups?[^.]*failed[^.]*exclud/i.test(description);
  return [description,
    explainsExclusions?'':'Warm-ups and failed sets are excluded.',
    sameDayWorkouts ? 'Separate workouts on the same date are slightly spaced; their recorded dates and values stay unchanged.' : '',
    'Hover or tap a point for the contributing working-set breakdown.'
  ].filter(Boolean).join(' ');
}

/** Compare the endpoints of the exact displayed line, independently of the viewport. */
export function compareChartTrend(model) {
  const fitted = model.lineMode !== 'connect';
  const result = {
    basis:fitted ? 'fitted' : 'recorded',
    label:fitted ? model.fitLabel || 'Selected fit' : 'Point-to-point',
    available:false,changePct:null,startDate:null,endDate:null,
    startValue:null,endValue:null,absoluteDelta:null,reason:null,
  };
  let enough = true;
  if (fitted) {
    const trend = model.trend;
    if (!trend?.available) {
      result.reason = trend?.reason || 'The selected curve is unavailable for this date range.';
      return result;
    }
    const validTime = value => finite(value) && Math.abs(value) <= 8640000000000000;
    result.startDate = validTime(trend.start) ? new Date(trend.start).toISOString().slice(0,10) : null;
    result.endDate = validTime(trend.end) ? new Date(trend.end).toISOString().slice(0,10) : null;
    if (!result.startDate || !result.endDate || typeof trend.predict !== 'function') {
      result.reason = 'The selected curve does not provide usable endpoints.';
      return result;
    }
    const first = trend.predict(trend.start), last = trend.predict(trend.end);
    const fitTolerance = 16 * Number.EPSILON * Math.max(finite(first) ? Math.abs(first) : 0,finite(last) ? Math.abs(last) : 0);
    result.startValue = finite(first) ? Math.abs(first) <= fitTolerance ? 0 : first : null;
    result.endValue = finite(last) ? Math.abs(last) <= fitTolerance ? 0 : last : null;
    enough = trend.end > trend.start;
  } else {
    const points = model.points || [], first = points[0], last = points.at(-1);
    result.startDate = first?.date || null;
    result.endDate = last?.date || null;
    result.startValue = finite(first?.value) ? (Object.is(first.value,-0) ? 0 : first.value) : null;
    result.endValue = finite(last?.value) ? (Object.is(last.value,-0) ? 0 : last.value) : null;
    enough = points.length >= 2;
  }
  if (!finite(result.startValue) || !finite(result.endValue)) {
    result.reason = enough ? 'Both endpoints need a finite value to calculate a change.' : 'At least two recorded workouts are needed to compare.';
    return result;
  }
  // Only arithmetic noise is treated as zero; preserve small recorded baselines.
  const tolerance = 16 * Number.EPSILON * Math.max(Math.abs(result.startValue),Math.abs(result.endValue));
  const delta = result.endValue-result.startValue;
  result.absoluteDelta = finite(delta) ? Math.abs(delta) <= tolerance ? 0 : delta : null;
  if (!enough) {
    result.reason = fitted ? 'The selected curve needs at least two different dates to compare.' : 'At least two recorded workouts are needed to compare.';
    return result;
  }
  if (result.startValue <= 0) {
    result.reason = result.startValue === 0 ? 'Percentage change is undefined from a zero starting value.' : 'Percentage change is not shown for a negative starting value.';
    return result;
  }
  if (!finite(result.absoluteDelta)) {
    result.reason = 'The endpoint difference is too large to calculate reliably.';
    return result;
  }
  const percentage = result.absoluteDelta / result.startValue * 100;
  if (!finite(percentage)) {
    result.reason = 'Percentage change could not be calculated reliably from these endpoints.';
    return result;
  }
  result.changePct = Math.abs(percentage) <= 1e-10 ? 0 : percentage;
  result.available = true;
  return result;
}

/** Each workout appears once, with its complete contributing working-set breakdown. */
export function buildChartModel(analysis, input = {}) {
  const metric = analysis.metric?.key || analysis.options?.metric || 'load';
  const aggregate = metric === 'volume' || metric === 'holdTotal';
  const pointsMode = 'sessions';
  const lineMode = ['bestFit','quadratic','smooth'].includes(input.lineMode) ? input.lineMode : 'connect';
  const points = workoutPoints(analysis);
  const datePoints = new Map();
  for (const point of points) {
    if (!datePoints.has(point.date)) datePoints.set(point.date, []);
    datePoints.get(point.date).push(point);
  }
  for (const dated of datePoints.values()) dated.forEach((point,index) => {
    point.dateOrder = index;
    point.dateCount = dated.length;
  });
  const groups = points.map(point => ({date:point.date,value:point.value,points:[point],rows:point.rows,sessionKeys:[point.key],partial:point.partial,color:point.color,ordinal:null}));
  const trendData = buildTrendData(analysis, input);
  const fit = linearBestFit(trendData.observations);
  const method = lineMode === 'quadratic' ? 'quadratic' : lineMode === 'smooth' ? 'smooth' : 'linear';
  const candidate = trendData.reason ? {available:false,reason:trendData.reason,samples:[],method} : fitTrend(trendData.observations,{method,smoothing:input.fitSmoothing ?? .55});
  const trend = protectDescriptiveFit(candidate,trendData.observations.map(point => point.y),metric === 'load' || metric === 'strength' ? 'load' : 'values');
  const fitLabel = {linear:'Linear best fit',quadratic:'Quadratic curve',smooth:'Smooth local average'}[method];
  const lineNote = lineMode !== 'connect'
    ? trend.available ? `${fitLabel} · ${trendData.weightNote} Fits use the displayed workout ${aggregate ? 'totals' : 'averages'} and actual recorded dates.` : `${fitLabel}: ${trend.reason || 'Not enough workouts for this fit.'}`
    : `Point-to-point · connects working-set workout ${aggregate ? 'totals' : 'averages'} in date order`;
  const contributingCount = sum(points.map(point => point.rows.length));
  const timed = points.length > 0 && points.every(point => point.rows.every(row => finite(row.duration_s) && row.duration_s > 0));
  const model = {
    metric,aggregate,pointsMode,lineMode,points,groups,fit,trend,trendData,fitLabel,
    title:analysis.metric?.label || (aggregate ? 'Workout totals' : 'Workout averages'),
    description:plotDescription(analysis,aggregate,[...datePoints.values()].some(dated => dated.length > 1)),
    countLabel:`${points.length} workout ${aggregate ? points.length === 1 ? 'total' : 'totals' : points.length === 1 ? 'average' : 'averages'} · ${contributingCount} ${timed ? 'hold components' : contributingCount === 1 ? 'working set' : 'working sets'}`,
    lineNote,
  };
  return {...model,comparison:compareChartTrend(model)};
}

/** Domains describe workout averages and fitted values, not the hidden individual-set spread. */
export function resolveChartDomains(model, requested = null) {
  const points = model.points || [];
  if (!points.length) return {fullDomain:null,viewDomain:null};
  const times = points.map(point => dateTime(point.date));
  const first = Math.min(...times), last = Math.max(...times), span = last-first;
  const xPad = span > 0 ? Math.max(DAY / 10,span*.055) : DAY*3;
  const values = points.map(point=>point.value);
  if(model.lineMode!=='connect'&&model.trend?.available){
    values.push(...model.trend.samples.map(point=>point.y).filter(finite));
    values.push(...(model.trendData?.observations||[]).map(point=>point.y).filter(finite));
  }
  const low = Math.min(...values),high = Math.max(...values),range = high-low || Math.abs(high)*.15 || 4;
  const fullDomain = {xMin:first-xPad,xMax:last+xPad,yMin:low>=0?Math.max(0,low-range*.13):low-range*.13,yMax:high+range*.18};
  const viewDomain = {...fullDomain};
  for (const axis of ['x','y']) {
    const lo=axis+'Min',hi=axis+'Max';
    if (!finite(requested?.[lo]) || !finite(requested?.[hi]) || requested[hi]<=requested[lo]) continue;
    const extent=fullDomain[hi]-fullDomain[lo],minimum=extent/1024;
    const size=Math.min(extent,Math.max(minimum,requested[hi]-requested[lo]));
    const middle=(requested[lo]+requested[hi])/2;
    viewDomain[lo]=Math.max(fullDomain[lo],Math.min(fullDomain[hi]-size,middle-size/2));
    viewDomain[hi]=viewDomain[lo]+size;
  }
  return {fullDomain,viewDomain};
}

/** Pixel offsets separate different workouts on the same date without changing timestamps. */
export function positionChartPoints(model, domain, plotRect) {
  if (!domain || !plotRect) return [];
  const x = value=>plotRect.left+(value-domain.xMin)/(domain.xMax-domain.xMin)*plotRect.width;
  const y = value=>plotRect.top+(domain.yMax-value)/(domain.yMax-domain.yMin)*plotRect.height;
  const margin=6;
  return model.points.map((point,index)=>{
    const time=dateTime(point.date),base=x(time);
    const count=point.dateCount||1;
    const spread=Math.min((count-1)*10,Math.max(0,plotRect.width-margin*2));
    const spacing=count>1?spread/(count-1):10;
    const radius=Math.max(1.6,Math.min(4.4,(spacing-1.4)/2));
    const insideX=time>=domain.xMin&&time<=domain.xMax;
    const center=insideX&&count>1?Math.max(plotRect.left+margin+spread/2,Math.min(plotRect.left+plotRect.width-margin-spread/2,base)):base;
    const offset=count>1?(point.dateOrder/(count-1)-.5)*spread:0;
    const px=center+offset,py=y(point.value);
    return {index,x:px,y:py,radius,sourceTime:time,offset:px-base,visible:insideX&&point.value>=domain.yMin&&point.value<=domain.yMax&&px>=plotRect.left&&px<=plotRect.left+plotRect.width};
  });
}
