/** Pure chart navigation math. Coordinates use real dates and metric values. */
export const MAX_CHART_ZOOM = 1024;
const finite = Number.isFinite;
const bound = (value, lower, upper) => Math.max(lower, Math.min(upper, value));

export function validDomain(domain) {
  return Boolean(domain && [domain.xMin, domain.xMax, domain.yMin, domain.yMax].every(finite) && domain.xMax > domain.xMin && domain.yMax > domain.yMin);
}

export function clampViewport(view, full) {
  if (!validDomain(full)) return null;
  if (!validDomain(view)) return {...full};
  const result = {};
  for (const axis of ['x', 'y']) {
    const low = axis + 'Min', high = axis + 'Max';
    const fullSpan = full[high] - full[low];
    const span = bound(view[high] - view[low], fullSpan / MAX_CHART_ZOOM, fullSpan);
    const center = (view[high] + view[low]) / 2;
    result[low] = bound(center - span / 2, full[low], full[high] - span);
    result[high] = result[low] + span;
  }
  return result;
}

export function zoomViewport(view, full, factor, anchor = {x:.5, y:.5}) {
  const current = clampViewport(view, full);
  if (!current || !finite(factor) || factor <= 0) return current;
  const next = {};
  for (const axis of ['x', 'y']) {
    const low = axis + 'Min', high = axis + 'Max';
    const fraction = bound(finite(anchor[axis]) ? anchor[axis] : .5, 0, 1);
    const span = current[high] - current[low];
    const fullSpan = full[high] - full[low];
    const newSpan = bound(span / factor, fullSpan / MAX_CHART_ZOOM, fullSpan);
    const value = current[low] + fraction * span;
    next[low] = value - fraction * newSpan;
    next[high] = next[low] + newSpan;
  }
  return clampViewport(next, full);
}

/** Fractions describe a shift in the currently displayed data range. */
export function panViewport(view, full, xFraction = 0, yFraction = 0) {
  const current = clampViewport(view, full);
  if (!current) return null;
  const dx = (finite(xFraction) ? xFraction : 0) * (current.xMax - current.xMin);
  const dy = (finite(yFraction) ? yFraction : 0) * (current.yMax - current.yMin);
  return clampViewport({xMin:current.xMin + dx, xMax:current.xMax + dx, yMin:current.yMin + dy, yMax:current.yMax + dy}, full);
}

export function viewportZoom(view, full) {
  if (!validDomain(view) || !validDomain(full)) return 1;
  return Math.max((full.xMax - full.xMin) / (view.xMax - view.xMin), (full.yMax - full.yMin) / (view.yMax - view.yMin));
}
