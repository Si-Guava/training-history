import { renderProgressionChart } from './progression-chart.js';
import { clampViewport, panViewport, zoomViewport, viewportZoom, MAX_CHART_ZOOM } from './chart-viewport.js';

const bounded = (value, min, max) => Math.max(min, Math.min(max, value));
let instanceCount = 0;

/** Adds reversible expansion and presentation-only zoom to the existing chart. */
export function createChartWorkspace({panel, host, tooltipEl}) {
  let options = null, model = null, view = null, signature = '', expanded = false;
  let frame = 0, gesture = null, suppressClickUntil = 0, clearGestureTimer = 0;
  let placeholder = null, tooltipPlaceholder = null, returnFocus = null, bodyOverflow = '', savedScroll = null;
  const pointers = new Map();
  const abort = new AbortController();
  const listen = (target, name, handler, extra = {}) => target.addEventListener(name, handler, {...extra, signal:abort.signal});
  const suffix = ++instanceCount;
  const dialog = document.createElement('dialog');
  dialog.className = 'chart-workspace-dialog';
  dialog.setAttribute('aria-labelledby', 'chart-workspace-title-' + suffix);
  dialog.innerHTML = '<header class="chart-workspace-heading"><div><span class="eyebrow">EXPANDED GRAPH</span><h2 id="chart-workspace-title-' + suffix + '">Training progress</h2></div><button type="button" class="chart-workspace-close" aria-label="Close expanded graph"><span aria-hidden="true">×</span><span>Close</span></button></header>';
  const dialogTitle = dialog.querySelector('h2');
  document.body.append(dialog);

  const expand = document.createElement('button');
  expand.type = 'button';
  expand.className = 'button button-outline chart-expand-button';
  expand.setAttribute('aria-haspopup', 'dialog');
  expand.innerHTML = '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4M3 3l5 5m9-5-5 5M3 17l5-5m9 5-5-5"/></svg><span>Expand graph</span>';
  const sectionHeader = panel.querySelector('.section-header');
  const headerActions = document.createElement('div');
  headerActions.className = 'chart-header-actions';
  const badge = sectionHeader?.querySelector('.small-badge');
  if (badge) headerActions.append(badge);
  headerActions.append(expand);
  sectionHeader?.append(headerActions);

  const navigation = document.createElement('div');
  navigation.className = 'chart-navigation';
  navigation.innerHTML = '<div class="chart-zoom-controls" role="group" aria-label="Graph zoom"><button type="button" class="chart-zoom-button" data-chart-zoom="out" aria-label="Zoom out" title="Zoom out">−</button><span class="chart-zoom-status">Full view</span><button type="button" class="chart-zoom-button" data-chart-zoom="in" aria-label="Zoom in" title="Zoom in">+</button><button type="button" class="chart-reset-button" data-chart-reset>Reset view</button></div><span class="chart-navigation-help">Expand for scroll or pinch zoom</span>';
  host.before(navigation);
  const zoomIn = navigation.querySelector('[data-chart-zoom="in"]');
  const zoomOut = navigation.querySelector('[data-chart-zoom="out"]');
  const resetButton = navigation.querySelector('[data-chart-reset]');
  const zoomStatus = navigation.querySelector('.chart-zoom-status');
  const help = navigation.querySelector('.chart-navigation-help');
  help.id = 'chart-navigation-help-' + suffix;
  const originalTabIndex = host.getAttribute('tabindex');
  const originalDescription = host.getAttribute('aria-describedby');
  host.tabIndex = 0;
  host.setAttribute('aria-describedby', [originalDescription,help.id].filter(Boolean).join(' '));
  host.setAttribute('aria-keyshortcuts', '+ - 0 ArrowLeft ArrowRight ArrowUp ArrowDown');
  host.classList.add('chart-navigable');

  function inputSignature(input) {
    const state = input.state || {}, a = input.analysis || {};
    return JSON.stringify([state.exercise,state.metric,state.from,state.to,state.method,state.repCap,state.bodyweight,state.loadBasis,state.minReps,state.side,state.includeWarmups,state.pointsMode,state.lineMode,state.fitWeight,state.fitSmoothing,
      (a.rows || []).map(row => [row.record_id,row.date,row.metricValue,row.metricEligible])]);
  }
  function updateControls() {
    const available = Boolean(model?.fullDomain && model?.plotRect);
    const zoom = available ? viewportZoom(view || model.viewDomain, model.fullDomain) : 1;
    const isZoomed = zoom > 1.001;
    zoomIn.disabled = !available || zoom >= MAX_CHART_ZOOM - .001;
    zoomOut.disabled = !available || !isZoomed;
    resetButton.disabled = !available || !isZoomed;
    zoomStatus.textContent = !isZoomed ? 'Full view' : Math.round(zoom * 100).toLocaleString('en-CA') + '%';
    help.textContent = !available ? 'Zoom is available when this view has recorded points' : expanded ? 'Scroll or pinch to zoom · drag to pan' : isZoomed ? 'Drag to pan · expand for scroll or pinch zoom' : 'Expand for scroll or pinch zoom';
    host.classList.toggle('chart-is-zoomed', isZoomed);
    host.style.touchAction = expanded || isZoomed ? 'none' : 'pan-y';
    expand.hidden = expanded;
  }
  function draw() {
    if (!options) return model;
    model = renderProgressionChart({...options, host, tooltipEl, viewDomain:view, onSelectSession:key => {
      if (expanded) close(false);
      options.onSelectSession?.(key);
    }});
    view = model?.viewDomain ? {...model.viewDomain} : null;
    dialogTitle.textContent = options.state?.exercise || 'Training progress';
    updateControls();
    return model;
  }
  function render(input) {
    const next = inputSignature(input);
    if (signature !== next) {view = null; resetGesture(); signature = next;}
    options = input;
    return draw();
  }
  function scheduleDraw() {
    if (!frame) frame = requestAnimationFrame(() => {frame = 0; draw();});
  }
  function applyView(next, immediate = false) {
    if (!model?.fullDomain) return;
    view = clampViewport(next, model.fullDomain);
    tooltipEl.hidden = true;
    if (immediate) {if (frame) cancelAnimationFrame(frame); frame = 0; draw();}
    else scheduleDraw();
  }
  function zoom(factor, anchor = {x:.5,y:.5}, immediate = false) {
    if (!model?.fullDomain) return;
    applyView(zoomViewport(view || model.viewDomain, model.fullDomain, factor, anchor), immediate);
  }
  function reset() {resetGesture(); if (model?.fullDomain) applyView(model.fullDomain, true);}
  function open() {
    if (expanded) return;
    tooltipEl.hidden = true;
    returnFocus = document.activeElement;
    savedScroll = {left:window.scrollX, top:window.scrollY};
    placeholder = document.createElement('div');
    placeholder.className = 'chart-workspace-placeholder';
    placeholder.style.height = panel.getBoundingClientRect().height + 'px';
    placeholder.setAttribute('aria-hidden', 'true');
    panel.before(placeholder);
    tooltipPlaceholder = document.createComment('chart tooltip home');
    tooltipEl.before(tooltipPlaceholder);
    dialog.append(panel, tooltipEl);
    bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    expanded = true;
    panel.classList.add('chart-workspace-expanded');
    dialog.showModal();
    draw();
    dialog.querySelector('.chart-workspace-close').focus({preventScroll:true});
  }
  function close(redraw = true) {
    if (!expanded) return;
    resetGesture();
    tooltipEl.hidden = true;
    expanded = false;
    dialog.close();
    placeholder?.replaceWith(panel); placeholder = null;
    tooltipPlaceholder?.replaceWith(tooltipEl); tooltipPlaceholder = null;
    panel.classList.remove('chart-workspace-expanded');
    document.body.style.overflow = bodyOverflow;
    if (redraw) draw(); else updateControls();
    if (savedScroll) window.scrollTo({...savedScroll,behavior:'instant'});
    returnFocus?.focus?.({preventScroll:true});
    savedScroll = null;
  }
  function plotPoint(clientX, clientY) {
    if (!model?.plotRect) return null;
    const svg = host.querySelector('svg.progress-chart');
    if (!svg) return null;
    let local;
    const matrix = svg.getScreenCTM?.();
    if (matrix) {
      const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
      if (!determinant) return null;
      const px = clientX - matrix.e, py = clientY - matrix.f;
      local = {x:(matrix.d * px - matrix.c * py) / determinant,y:(matrix.a * py - matrix.b * px) / determinant};
    } else {
      const rect = svg.getBoundingClientRect();
      local = {x:(clientX - rect.left) / rect.width * model.width,y:(clientY - rect.top) / rect.height * model.height};
    }
    const plot = model.plotRect;
    return {x:local.x,y:local.y,fx:(local.x - plot.left) / plot.width,fy:1 - (local.y - plot.top) / plot.height,
      inside:local.x >= plot.left && local.x <= plot.left + plot.width && local.y >= plot.top && local.y <= plot.top + plot.height};
  }
  function pixelDelta(from, to) {
    const first = plotPoint(from.x, from.y), last = plotPoint(to.x, to.y);
    return first && last ? {x:last.fx - first.fx,y:last.fy - first.fy} : {x:0,y:0};
  }
  function beginGesture() {
    clearTimeout(clearGestureTimer);
    const list = [...pointers.values()];
    if (!list.length || !model?.fullDomain) {gesture = null; return;}
    if (list.length > 1 && expanded) {
      const center = {x:(list[0].x + list[1].x) / 2,y:(list[0].y + list[1].y) / 2};
      const point = plotPoint(center.x,center.y);
      gesture = {type:'pinch',view:{...(view || model.viewDomain)},distance:Math.max(1,Math.hypot(list[0].x-list[1].x,list[0].y-list[1].y)),center,anchor:{x:bounded(point?.fx ?? .5,0,1),y:bounded(point?.fy ?? .5,0,1)},active:true};
      host.dataset.interacting = 'true'; tooltipEl.hidden = true;
      for (const pointerId of pointers.keys()) {try {host.setPointerCapture(pointerId);} catch {}}
    } else gesture = {type:'pan',view:{...(view || model.viewDomain)},start:{...list[0]},active:false};
  }
  function resetGesture() {
    clearTimeout(clearGestureTimer);
    for (const id of pointers.keys()) {try {if (host.hasPointerCapture(id)) host.releasePointerCapture(id);} catch {}}
    pointers.clear(); gesture = null;
    delete host.dataset.interacting;
    host.classList.remove('chart-is-panning');
  }
  function pointerDown(event) {
    if (event.button !== 0 || !model?.fullDomain || !plotPoint(event.clientX,event.clientY)?.inside) return;
    if (event.pointerType === 'touch' && !expanded && viewportZoom(view,model.fullDomain) <= 1.001) return;
    pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
    beginGesture();
    if (gesture?.type === 'pinch') {event.preventDefault();event.stopPropagation();}
  }
  function pointerMove(event) {
    if (!pointers.has(event.pointerId) || !gesture || !model?.fullDomain) return;
    pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if (gesture.type === 'pinch') {
      const list = [...pointers.values()]; if (list.length < 2) return;
      const center = {x:(list[0].x+list[1].x)/2,y:(list[0].y+list[1].y)/2};
      const distance = Math.max(1,Math.hypot(list[0].x-list[1].x,list[0].y-list[1].y));
      const zoomed = zoomViewport(gesture.view,model.fullDomain,distance / gesture.distance,gesture.anchor);
      const delta = pixelDelta(gesture.center,center);
      applyView(panViewport(zoomed,model.fullDomain,-delta.x,-delta.y));
    } else {
      if (viewportZoom(gesture.view,model.fullDomain) <= 1.001) return;
      const current = pointers.get(event.pointerId);
      if (!gesture.active && Math.hypot(current.x-gesture.start.x,current.y-gesture.start.y) < 5) return;
      gesture.active = true;
      const delta = pixelDelta(gesture.start,current);
      applyView(panViewport(gesture.view,model.fullDomain,-delta.x,-delta.y));
      try {host.setPointerCapture(event.pointerId);} catch {}
    }
    host.dataset.interacting = 'true'; host.classList.add('chart-is-panning'); tooltipEl.hidden = true;
    event.preventDefault(); event.stopPropagation();
  }
  function pointerEnd(event) {
    if (!pointers.has(event.pointerId)) return;
    const moved = gesture?.active;
    pointers.delete(event.pointerId);
    try {if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);} catch {}
    if (moved) {suppressClickUntil = performance.now() + 400;event.preventDefault();event.stopPropagation();}
    if (pointers.size) beginGesture();
    else {
      gesture = null; host.classList.remove('chart-is-panning');
      clearTimeout(clearGestureTimer);
      clearGestureTimer = setTimeout(() => {delete host.dataset.interacting;}, moved ? 100 : 0);
    }
  }
  listen(expand,'click',open);
  listen(dialog.querySelector('.chart-workspace-close'),'click',() => close());
  listen(dialog,'cancel',event => {event.preventDefault(); close();});
  listen(dialog,'click',event => {if (event.target === dialog) close();});
  listen(zoomIn,'click',() => zoom(1.5,undefined,true));
  listen(zoomOut,'click',() => zoom(1/1.5,undefined,true));
  listen(resetButton,'click',reset);
  listen(host,'pointerdown',pointerDown,{capture:true});
  listen(host,'pointermove',pointerMove,{capture:true});
  listen(window,'pointerup',pointerEnd,{capture:true});
  listen(window,'pointercancel',pointerEnd,{capture:true});
  listen(host,'click',event => {if (performance.now() < suppressClickUntil) {event.preventDefault();event.stopImmediatePropagation();}},{capture:true});
  listen(host,'wheel',event => {
    if (!expanded || !model?.fullDomain) return;
    const point = plotPoint(event.clientX,event.clientY); if (!point?.inside) return;
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 300 : 1);
    zoom(Math.exp(-bounded(delta,-300,300)*.002),{x:point.fx,y:point.fy});
  },{passive:false});
  listen(host,'keydown',event => {
    if (event.target !== host || !model?.fullDomain) return;
    const pan = {ArrowLeft:[-.1,0],ArrowRight:[.1,0],ArrowUp:[0,.1],ArrowDown:[0,-.1]}[event.key];
    if (event.key === '+' || event.key === '=') {event.preventDefault();zoom(1.5,undefined,true);}
    else if (event.key === '-') {event.preventDefault();zoom(1/1.5,undefined,true);}
    else if (event.key === '0' || event.key === 'Home') {event.preventDefault();reset();}
    else if (pan) {event.preventDefault();applyView(panViewport(view,model.fullDomain,...pan),true);}
  });
  return {render,close,isExpanded:() => expanded,destroy() {
    close(); resetGesture(); abort.abort(); if (frame) cancelAnimationFrame(frame);
    dialog.remove();navigation.remove();expand.remove();
    if (badge && headerActions.parentNode) headerActions.before(badge);headerActions.remove();
    host.classList.remove('chart-navigable','chart-is-zoomed');host.style.removeProperty('touch-action');host.removeAttribute('aria-keyshortcuts');
    if (originalTabIndex === null) host.removeAttribute('tabindex');else host.setAttribute('tabindex',originalTabIndex);
    if (originalDescription === null) host.removeAttribute('aria-describedby');else host.setAttribute('aria-describedby',originalDescription);
  }};
}
