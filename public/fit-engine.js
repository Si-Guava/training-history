/**
 * Descriptive weighted regression for the training charts.
 * Duplicate observations remain independent contributions. Coordinates are normalized
 * before solving; display jitter, camera position and chart zoom never enter a fit.
 */
const finite = value => typeof value === 'number' && Number.isFinite(value);
const bound = (value, low, high) => Math.max(low, Math.min(high, value));
const sum = values => values.reduce((total, value) => total + value, 0);
const EPS = 1e-10;
const labels = {
  linear: 'Weighted linear fit', quadratic: 'Weighted quadratic fit',
  smooth: 'Smooth local average', plane: 'Weighted plane',
};

/** Assign weights once. `volume` must already include any completed-hang count. */
export function applyObservationWeights(observations = [], mode = 'sets') {
  const weighted = observations.map((observation, index) => {
    const units = observation.units === undefined ? 1 : observation.units;
    const base = finite(units) && units > 0 ? units : 0;
    const sessionKey = observation.sessionKey ?? `observation-${index}`;
    const weight = mode === 'volume'
      ? finite(observation.volume) && observation.volume > 0 ? observation.volume : 0
      : base;
    return {...observation, sessionKey, weight};
  }).filter(observation => observation.weight > 0);
  if (mode === 'sessions') {
    const totals = new Map();
    for (const observation of weighted) totals.set(observation.sessionKey, (totals.get(observation.sessionKey) || 0) + observation.weight);
    return weighted.map(observation => ({...observation, weight:observation.weight / totals.get(observation.sessionKey)}));
  }
  return weighted;
}

function validObservations(observations, surface = false) {
  return observations.flatMap(observation => {
    const weight = observation.weight === undefined ? 1 : observation.weight;
    return finite(observation.x) && finite(observation.y) && (!surface || finite(observation.z)) && finite(weight) && weight > 0
      ? [{...observation, weight}] : [];
  });
}

function numericRange(values) {
  return {min:Math.min(...values), max:Math.max(...values)};
}

function normalization(min, max) {
  const center = min + (max - min) / 2, scale = (max - min) / 2;
  return {normalize:value => (value - center) / scale, denormalize:value => center + value * scale};
}

/** Householder QR with column pivoting; a missing rank returns null, never a ridge solution. */
function weightedLeastSquares(features, values, weights) {
  const rowCount = features.length, columnCount = features[0]?.length || 0;
  if (!columnCount || rowCount < columnCount) return null;
  const maxWeight = Math.max(...weights);
  const matrix = features.map((row, index) => row.map(value => value * Math.sqrt(weights[index] / maxWeight)));
  const target = values.map((value, index) => value * Math.sqrt(weights[index] / maxWeight));
  const permutation = Array.from({length:columnCount}, (_, index) => index);
  let initialNorm = 0;
  const diagonals = [];
  for (let column = 0; column < columnCount; column++) {
    let pivot = column, pivotSquared = -1;
    for (let candidate = column; candidate < columnCount; candidate++) {
      let squared = 0;
      for (let row = column; row < rowCount; row++) squared += matrix[row][candidate] ** 2;
      if (squared > pivotSquared) {pivot = candidate; pivotSquared = squared;}
    }
    const norm = Math.sqrt(pivotSquared);
    if (column === 0) initialNorm = norm;
    if (!finite(norm) || norm <= Math.max(1e-13, initialNorm * EPS)) return null;
    if (pivot !== column) {
      for (const row of matrix) [row[column], row[pivot]] = [row[pivot], row[column]];
      [permutation[column], permutation[pivot]] = [permutation[pivot], permutation[column]];
    }
    const reflection = matrix.slice(column).map(row => row[column]);
    reflection[0] += reflection[0] >= 0 ? norm : -norm;
    const reflectionNorm = Math.hypot(...reflection);
    if (!reflectionNorm) return null;
    for (let row = 0; row < reflection.length; row++) reflection[row] /= reflectionNorm;
    for (let next = column; next < columnCount; next++) {
      let dot = 0;
      for (let row = column; row < rowCount; row++) dot += reflection[row - column] * matrix[row][next];
      for (let row = column; row < rowCount; row++) matrix[row][next] -= 2 * reflection[row - column] * dot;
    }
    let dot = 0;
    for (let row = column; row < rowCount; row++) dot += reflection[row - column] * target[row];
    for (let row = column; row < rowCount; row++) target[row] -= 2 * reflection[row - column] * dot;
    diagonals.push(Math.abs(matrix[column][column]));
  }
  const pivoted = Array(columnCount).fill(0), coefficients = Array(columnCount).fill(0);
  for (let row = columnCount - 1; row >= 0; row--) {
    let value = target[row];
    for (let column = row + 1; column < columnCount; column++) value -= matrix[row][column] * pivoted[column];
    pivoted[row] = value / matrix[row][row];
  }
  pivoted.forEach((value, index) => {coefficients[permutation[index]] = value;});
  return coefficients.every(finite) ? {coefficients, conditionIndicator:Math.max(...diagonals) / Math.min(...diagonals)} : null;
}

function statistics(observations, predictions, target = 'y') {
  const maxWeight = Math.max(...observations.map(observation => observation.weight));
  const weights = observations.map(observation => observation.weight / maxWeight);
  const total = sum(weights);
  const mean = sum(observations.map((observation, index) => observation[target] * weights[index])) / total;
  const error = sum(observations.map((observation, index) => weights[index] * (observation[target] - predictions[index]) ** 2));
  const variation = sum(observations.map((observation, index) => weights[index] * (observation[target] - mean) ** 2));
  return {weightedRMSE:Math.sqrt(error / total), weightedR2:variation > 0 ? 1 - error / variation : error < 1e-18 ? 1 : null};
}

function unavailable(method, reason, extras = {}) {
  return {available:false, reason, method, label:labels[method] || labels.smooth, samples:[], vertices:[], triangles:[], hull:[], domain:null, predict:() => null, ...extras};
}

/** A positive-kernel local average. Bandwidth uses actual time, never row density. */
function localTrendPredictor(points, smoothing) {
  // Dates span [-1,1]. A fixed normalized bandwidth remains unchanged when sets repeat.
  const bandwidth = .06 + .5 * smoothing;
  const denominator = 2 * bandwidth * bandwidth;
  return query => {
    const logs = points.map(point => Math.log(point.weight) - (point.x - query) ** 2 / denominator);
    const maximum = Math.max(...logs);
    let total = 0, value = 0;
    points.forEach((point, index) => {const weight = Math.exp(logs[index] - maximum); total += weight; value += weight * point.y;});
    return value / total;
  };
}

/** Fit a descriptive trend over the observed date interval only. */
export function fitTrend(input = [], options = {}) {
  const method = ['linear','quadratic','smooth'].includes(options.method) ? options.method : 'linear';
  const observations = validObservations(input);
  const distinct = [...new Set(observations.map(observation => observation.x))];
  const counts = {observations:observations.length, uniqueX:distinct.length, totalWeight:sum(observations.map(observation => observation.weight))};
  const required = method === 'linear' ? 2 : 3;
  if (distinct.length < required) return unavailable(method, `${labels[method]} needs records on at least ${required} different dates.`, {counts});
  const xr = numericRange(distinct), yr = numericRange(observations.map(observation => observation.y));
  const nx = normalization(xr.min, xr.max);
  const points = observations.map(observation => ({...observation, x:nx.normalize(observation.x)}));
  let predictor, coefficients = null, conditionIndicator = null;
  if (method === 'smooth') predictor = localTrendPredictor(points, bound(finite(options.smoothing) ? options.smoothing : .55, .15, 1));
  else {
    const features = points.map(point => method === 'quadratic' ? [1, point.x, point.x ** 2] : [1, point.x]);
    const result = weightedLeastSquares(features, points.map(point => point.y), points.map(point => point.weight));
    if (!result) return unavailable(method, 'The dates do not provide enough independent information for this fit.', {counts});
    coefficients = result.coefficients; conditionIndicator = result.conditionIndicator;
    predictor = value => coefficients[0] + coefficients[1] * value + (method === 'quadratic' ? coefficients[2] * value * value : 0);
  }
  const constant = yr.min === yr.max;
  const predict = value => {
    if (!finite(value) || value < xr.min || value > xr.max) return null;
    const result = constant ? yr.min : predictor(nx.normalize(value));
    return finite(result) ? result : null;
  };
  const resolution = bound(Math.round(finite(options.resolution) ? options.resolution : 96), 12, 256);
  const samples = Array.from({length:resolution + 1}, (_, index) => {
    const x = index === resolution ? xr.max : xr.min + (xr.max - xr.min) * index / resolution;
    return {x, y:predict(x)};
  });
  if (samples.some(sample => !finite(sample.y))) return unavailable(method, 'This fit could not be evaluated reliably.', {counts});
  return {
    available:true, reason:null, method, label:labels[method], samples, predict, counts, coefficients, conditionIndicator,
    observedRange:{min:yr.min,max:yr.max}, fittedRange:numericRange(samples.map(sample => sample.y)),
    domain:{xMin:xr.min, xMax:xr.max, yMin:Math.min(yr.min, ...samples.map(sample => sample.y)), yMax:Math.max(yr.max, ...samples.map(sample => sample.y))},
    start:xr.min, end:xr.max, startValue:samples[0].y, endValue:samples.at(-1).y,
    ...statistics(observations, observations.map(observation => predict(observation.x))),
  };
}

const cross = (a, b, point) => (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);

function convexHull(points) {
  const unique = [...new Map(points.map(point => [`${point.x},${point.y}`, {x:point.x, y:point.y}])).values()].sort((a, b) => a.x - b.x || a.y - b.y);
  if (unique.length < 3) return [];
  const half = ordered => {
    const hull = [];
    for (const point of ordered) {
      while (hull.length > 1 && cross(hull[hull.length - 2], hull.at(-1), point) <= EPS) hull.pop();
      hull.push(point);
    }
    return hull.slice(0, -1);
  };
  const hull = [...half(unique), ...half([...unique].reverse())];
  if (hull.length < 3) return [];
  const area = Math.abs(sum(hull.map((point, index) => point.x * hull[(index + 1) % hull.length].y - point.y * hull[(index + 1) % hull.length].x))) / 2;
  return area > EPS ? hull : [];
}

function insideHull(point, hull) {
  return hull.every((a, index) => cross(a, hull[(index + 1) % hull.length], point) >= -EPS);
}

function clipToHull(polygon, hull) {
  let result = polygon;
  for (let index = 0; index < hull.length && result.length; index++) {
    const a = hull[index], b = hull[(index + 1) % hull.length], next = [];
    let previous = result.at(-1), previousCross = cross(a, b, previous);
    for (const current of result) {
      const currentCross = cross(a, b, current), currentInside = currentCross >= -EPS, previousInside = previousCross >= -EPS;
      if (currentInside !== previousInside) {
        const fraction = bound(previousCross / (previousCross - currentCross), 0, 1);
        next.push({x:previous.x + fraction * (current.x - previous.x), y:previous.y + fraction * (current.y - previous.y)});
      }
      if (currentInside) next.push(current);
      previous = current; previousCross = currentCross;
    }
    result = next.filter((point, pointIndex) => pointIndex === 0 || Math.hypot(point.x - next[pointIndex - 1].x, point.y - next[pointIndex - 1].y) > EPS);
  }
  return result;
}

function localSurfacePredictor(points, smoothing) {
  // Both inputs span [-1,1]. A positive Gaussian kernel gives a bounded local mean.
  const bandwidth = .12 + 1.15 * smoothing;
  const denominator = 2 * bandwidth * bandwidth;
  return (x, y) => {
    const logs = points.map(point => Math.log(point.weight) - ((point.x - x) ** 2 + (point.y - y) ** 2) / denominator);
    const maximum = Math.max(...logs);
    let total = 0, value = 0;
    points.forEach((point, index) => {const weight = Math.exp(logs[index] - maximum); total += weight; value += weight * point.z;});
    return value / total;
  };
}

/** Fit load over date and reps/hold duration; the mesh is clipped to observed support. */
export function fitSurface(input = [], options = {}) {
  const method = ['plane','quadratic','smooth'].includes(options.method) ? options.method : 'smooth';
  const observations = validObservations(input, true);
  const distinctX = [...new Set(observations.map(observation => observation.x))];
  const distinctY = [...new Set(observations.map(observation => observation.y))];
  const counts = {observations:observations.length, uniqueX:distinctX.length, uniqueY:distinctY.length, uniqueLocations:new Set(observations.map(point => `${point.x},${point.y}`)).size, totalWeight:sum(observations.map(observation => observation.weight))};
  if (distinctX.length < 2 || distinctY.length < 2) return unavailable(method, 'A surface needs variation in both date and reps or hold duration. The recorded sets are still shown.', {counts});
  const xr = numericRange(distinctX), yr = numericRange(distinctY), zr = numericRange(observations.map(observation => observation.z));
  const nx = normalization(xr.min, xr.max), ny = normalization(yr.min, yr.max);
  const points = observations.map(observation => ({...observation, x:nx.normalize(observation.x), y:ny.normalize(observation.y)}));
  const hull = convexHull(points);
  const domain = {xMin:xr.min, xMax:xr.max, yMin:yr.min, yMax:yr.max, zMin:zr.min, zMax:zr.max};
  if (!hull.length) return unavailable(method, 'These date and rep/hold combinations lie on one line, so a two-dimensional surface is not identifiable.', {counts, domain});
  const publicHull = hull.map(point => ({x:nx.denormalize(point.x), y:ny.denormalize(point.y)}));
  let predictor, coefficients = null, conditionIndicator = null;
  if (method === 'smooth') predictor = localSurfacePredictor(points, bound(finite(options.smoothing) ? options.smoothing : .55, .1, 1));
  else {
    if (method === 'quadratic' && (distinctX.length < 3 || distinctY.length < 3 || counts.uniqueLocations < 6)) {
      return unavailable(method, 'A curved quadratic surface needs at least three dates, three rep/hold values, and six independent combinations. Try the smooth local surface or recorded sets.', {counts, domain, hull:publicHull});
    }
    const features = points.map(point => method === 'quadratic'
      ? [1, point.x, point.y, point.x ** 2, point.x * point.y, point.y ** 2]
      : [1, point.x, point.y]);
    const result = weightedLeastSquares(features, points.map(point => point.z), points.map(point => point.weight));
    if (!result) return unavailable(method, 'These observations do not independently support all terms of this surface. Try the smooth local surface or recorded sets.', {counts, domain, hull:publicHull});
    coefficients = result.coefficients; conditionIndicator = result.conditionIndicator;
    predictor = (x, y) => coefficients[0] + coefficients[1] * x + coefficients[2] * y + (method === 'quadratic' ? coefficients[3] * x * x + coefficients[4] * x * y + coefficients[5] * y * y : 0);
  }
  const constant = zr.min === zr.max;
  const normalizedPredict = (x, y) => constant ? zr.min : predictor(x, y);
  const predict = (x, y) => {
    if (!finite(x) || !finite(y)) return null;
    const point = {x:nx.normalize(x), y:ny.normalize(y)};
    if (!insideHull(point, hull)) return null;
    const value = normalizedPredict(point.x, point.y);
    return finite(value) ? value : null;
  };
  const resolution = bound(Math.round(finite(options.resolution) ? options.resolution : 24), 4, 48);
  const vertices = [], triangles = [], vertexIndices = new Map();
  const vertexIndex = point => {
    const key = `${point.x.toFixed(11)},${point.y.toFixed(11)}`;
    if (!vertexIndices.has(key)) {
      const z = normalizedPredict(point.x, point.y);
      if (!finite(z)) return -1;
      vertexIndices.set(key, vertices.length);
      vertices.push({x:nx.denormalize(point.x), y:ny.denormalize(point.y), z});
    }
    return vertexIndices.get(key);
  };
  for (let row = 0; row < resolution; row++) for (let column = 0; column < resolution; column++) {
    const left = -1 + 2 * column / resolution, right = -1 + 2 * (column + 1) / resolution;
    const bottom = -1 + 2 * row / resolution, top = -1 + 2 * (row + 1) / resolution;
    const cell = [{x:left,y:bottom},{x:right,y:bottom},{x:right,y:top},{x:left,y:top}];
    for (const triangle of [[cell[0],cell[1],cell[2]],[cell[0],cell[2],cell[3]]]) {
      const polygon = clipToHull(triangle, hull);
      for (let index = 1; index + 1 < polygon.length; index++) {
        const points = [polygon[0],polygon[index],polygon[index + 1]];
        if (Math.abs(cross(points[0],points[1],points[2])) <= 1e-12) continue;
        const indices = points.map(vertexIndex);
        if (indices.every(index => index >= 0) && new Set(indices).size === 3) triangles.push(indices);
      }
    }
  }
  if (!triangles.length) return unavailable(method, 'There is too little two-dimensional coverage to draw a reliable surface.', {counts, domain, hull:publicHull});
  domain.zMin = Math.min(zr.min, ...vertices.map(vertex => vertex.z));
  domain.zMax = Math.max(zr.max, ...vertices.map(vertex => vertex.z));
  return {
    available:true, reason:null, method, label:method === 'smooth' ? 'Smooth local surface' : method === 'quadratic' ? 'Weighted quadratic surface' : labels.plane,
    vertices, triangles, hull:publicHull, domain, counts, predict, coefficients, conditionIndicator,
    observedRange:{min:zr.min,max:zr.max}, fittedRange:numericRange(vertices.map(vertex => vertex.z)),
    ...statistics(observations, observations.map(point => predict(point.x, point.y)), 'z'),
  };
}
