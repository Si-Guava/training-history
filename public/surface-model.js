import { applyObservationWeights, fitSurface } from './fit-engine.js';
import { setColor, getObservationWorkload, protectDescriptiveFit } from './chart-model.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const DAY = 86400000;
const sessionKey = row => `${row.date}__${row.session}`;
const ambiguousRole = row => /\bUAP\b|machine dip/i.test(row.exercise || '') || /resistance or assistance|resistance\/assistance|load role unclear/i.test(row.resistance_setup || '');
const chronological = (a,b) => String(a.date).localeCompare(String(b.date)) || Number(a.session)-Number(b.session) || Number(a.set)-Number(b.set) || a.order-b.order;
const sum = values => values.reduce((total,value)=>total+value,0);

/** One working-set mean per workout. Rep and hold axes never mix. */
export function buildSurfaceModel(analysis = {}, state = {}) {
  const rows = (analysis.rows || []).map((row,order)=>({...row,order})).sort(chronological);
  const candidates = rows.filter(row=>row.included && !row.isWarmup && !row.isFailed && row.metricEligible && finite(row.displayLoad) && finite(Date.parse(row.date+'T12:00:00Z')) && !ambiguousRole(row));
  // Missing load (for example, unset pull-up bodyweight) must not change a
  // recorded repetition workout into a hold workout in the empty surface UI.
  const axisRows = candidates.length ? candidates : rows.filter(row=>row.included && !row.isWarmup && !row.isFailed);
  const hasReps = axisRows.some(row=>finite(row.reps)&&row.reps>0);
  const hasHolds = axisRows.some(row=>finite(row.duration_s)&&row.duration_s>0);
  const axis = state.surfaceAxis === 'hold' && hasHolds ? 'hold' : state.surfaceAxis === 'reps' && hasReps ? 'reps' : hasReps ? 'reps' : 'hold';
  const groups = new Map(), allGroups = new Map();
  for(const row of rows){const key=sessionKey(row);if(!allGroups.has(key))allGroups.set(key,[]);allGroups.get(key).push(row);}
  for(const row of candidates){
    const effort=axis==='hold'?row.duration_s:row.reps;
    if(!finite(effort)||effort<=0)continue;
    const key=sessionKey(row);
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(row);
  }
  const points=[...groups.entries()].map(([key,sets],order)=>{
    const contributions=sets.map(row=>{const workload=getObservationWorkload(row);return {row,effort:axis==='hold'?row.duration_s:row.reps,units:axis==='hold'?workload.units:1,volume:workload.volumeKind===(axis==='hold'?'hold':'reps')?workload.volume:null};});
    const units=sum(contributions.map(part=>part.units));
    const volume=sum(contributions.filter(part=>finite(part.volume)&&part.volume>0).map(part=>part.volume));
    return {id:`surface-${key}`,x:Date.parse(sets[0].date+'T12:00:00Z'),
      y:sum(contributions.map(part=>part.effort*part.units))/units,
      z:sum(contributions.map(part=>part.row.displayLoad*part.units))/units,
      date:sets[0].date,sessionKey:key,session:sets[0].session,order,color:setColor(1),
      units,volume:volume>0?volume:null,volumeKind:axis==='hold'?'hold':'reps',rows:sets,
      eligibleCount:sets.length,excludedCount:allGroups.get(key).length-sets.length};
  });
  const byDate=new Map();
  for(const point of points){if(!byDate.has(point.date))byDate.set(point.date,[]);byDate.get(point.date).push(point);}
  for(const dated of byDate.values())dated.forEach((point,index)=>{point.dateOrder=index;point.dateCount=dated.length;});
  const coincident=new Map();
  for(const point of points){const key=JSON.stringify([point.x,point.y,point.z]);if(!coincident.has(key))coincident.set(key,[]);coincident.get(key).push(point);}
  for(const group of coincident.values())group.forEach((point,index)=>{point.duplicateIndex=index;point.duplicateCount=group.length;});
  const weightMode=['sets','sessions','volume'].includes(state.fitWeight)?state.fitWeight:'sets';
  const weighted=applyObservationWeights(points,weightMode);
  const method=['none','plane','quadratic','smooth'].includes(state.surfaceFit)?state.surfaceFit:'smooth';
  const smoothing=finite(Number(state.surfaceSmoothing))?Math.max(.2,Math.min(1,Number(state.surfaceSmoothing))):.55;
  let surface=method==='none'?{available:false,reason:'The surface is hidden. Each dot shows one workout average from completed working sets.',method,label:'Workout averages only',vertices:[],triangles:[]}
    :protectDescriptiveFit(fitSurface(weighted,{method,smoothing,resolution:24}),weighted.map(point=>point.z),'workout-average load');
  if(surface.reason)surface={...surface,reason:surface.reason.replace(/recorded sets/gi,'workout averages')};
  if(method!=='none'&&weightMode==='volume'&&!weighted.length)surface={...surface,available:false,reason:'No positive known workload is available for exposure weighting. Choose set or session weighting.'};
  const values=points.map(point=>point.z),constantLoad=points.length>1&&Math.max(...values)-Math.min(...values)<1e-9;
  const dateCount=new Set(points.map(point=>point.date)).size,sessionCount=points.length;
  const setCount=sum(points.map(point=>point.eligibleCount)),holdCount=axis==='hold'?sum(points.map(point=>point.units)):0;
  const weightNote=weightMode==='sets'?(axis==='hold'?'Fits use workout averages, weighted by the number of completed working hangs in each workout.':'Fits use workout averages, weighted by the number of completed working sets in each workout.')
    :weightMode==='sessions'?'Each workout average has equal influence on the fit.'
    :axis==='hold'?'Workout averages are weighted by each workout’s known load × active hang time (lb·s). Rest is excluded.':'Workout averages are weighted by each workout’s known load × base reps (lb·reps).';
  const fitExcluded=points.length-weighted.length;
  const contributingRows=points.flatMap(point=>point.rows);
  const missingBodyweight=rows.some(row=>row.is_pullup)&&!finite(analysis.options?.bodyweight);
  const unitNote=contributingRows.some(row=>row.is_pullup)?state.loadBasis==='added'?missingBodyweight?'Load shows recorded added weight. Set bodyweight in Chart settings for exposure weighting.':'Load shows added weight; exposure weighting uses bodyweight plus added weight.':'Load includes the selected constant bodyweight.'
    :contributingRows.some(row=>/Per dumbbell/i.test(row.load_basis||''))?'Loads are per dumbbell.':'';
  return {points,weighted,surface,axis,hasReps,hasHolds,method,smoothing,weightMode,dateCount,sessionCount,setCount,holdCount,constantLoad,weightNote,fitExcluded,unitNote,
    axisLabel:axis==='hold'?'Average seconds per hold':'Average reps per set',axisUnit:axis==='hold'?'s':'reps',
    countLabel:`${sessionCount} workout ${sessionCount===1?'average':'averages'} · ${axis==='hold'?holdCount:setCount} ${axis==='hold'?'completed hangs':'working sets'}`,
    excludedCount:rows.length-contributingRows.length,
    emptyReason:missingBodyweight&&state.loadBasis!=='added'?'Set bodyweight in Chart settings to show total pull-up load, or choose Added weight equivalent to view the recorded added load.':'No completed working sets have a known pound load and recorded reps or hold duration in this view. Warm-ups, failed sets, unknown loads and unclear resistance or assistance are excluded; their records remain in the log.'};
}

export function surfaceDomains(model) {
  if (!model.points.length) return null;
  const vertices=model.surface.available?model.surface.vertices:[];
  const xs=model.points.map(point=>point.x),ys=model.points.map(point=>point.y),zs=[...model.points,...vertices].map(point=>point.z);
  const extent=(values,fallback,nonnegative=false,relative=true)=>{const lo=Math.min(...values),hi=Math.max(...values),pad=(hi-lo||(relative?Math.abs(hi)*.2:0)||fallback)*.08;return {min:nonnegative&&lo>=0?Math.max(0,lo-pad):lo-pad,max:hi+pad};};
  return {x:extent(xs,DAY*6,false,false),y:extent(ys,2,true),z:extent(zs,5,true)};
}

/** True orthographic projection of three numeric axes; only coincident marker offsets are cosmetic. */
export function projectSurfacePoint(point,domains,camera,width,height) {
  const normalized={x:((point.x-domains.x.min)/(domains.x.max-domains.x.min)*2-1)*1.3,
    y:((point.y-domains.y.min)/(domains.y.max-domains.y.min)*2-1)*.9,
    z:((point.z-domains.z.min)/(domains.z.max-domains.z.min)*2-1)*.95};
  const yaw=camera.yaw,pitch=camera.pitch,c=Math.cos(yaw),s=Math.sin(yaw);
  const rx=c*normalized.x-s*normalized.y,ry=s*normalized.x+c*normalized.y;
  const screenY=Math.sin(pitch)*ry-Math.cos(pitch)*normalized.z;
  const depth=Math.cos(pitch)*ry+Math.sin(pitch)*normalized.z;
  const scale=Math.max(20,Math.min((width-70)/3.5,(height-95)/3.1))*(camera.zoom||1);
  return {x:width/2+rx*scale+(camera.panX||0),y:height/2+screenY*scale+(camera.panY||0),depth,scale};
}

export function spreadCoincidentPoint(point,projected) {
  const count=point.duplicateCount||1;if(count<2)return {...projected};
  const columns=Math.ceil(Math.sqrt(count)),rows=Math.ceil(count/columns),index=point.duplicateIndex||0;
  return {...projected,x:projected.x+(index%columns-(columns-1)/2)*9,y:projected.y+(Math.floor(index/columns)-(rows-1)/2)*9};
}

/** Prefer the frontmost painted point when multiple 3D points project to the same pixel. */
export function pickProjectedPoint(points,x,y,radius=15) {
  let best=null,distance=radius;
  for(const point of points){const d=Math.hypot(point.x-x,point.y-y);if(d<=radius&&(d<distance-.25||Math.abs(d-distance)<=.25&&(!best||point.depth>best.depth))){distance=d;best=point;}}
  return best;
}
