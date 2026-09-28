function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function angleBetween(v1, v2) {
  const len1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y);
  const len2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y);
  if (!len1 || !len2) return 0;

  const dot = (v1.x * v2.x + v1.y * v2.y) / (len1 * len2);
  const clamped = Math.max(-1, Math.min(1, dot));
  return Math.acos(clamped) * 180 / Math.PI;
}

function normalizeVectorElement(vec, index) {
  if (!Array.isArray(vec) || vec.length < 5) return null;

  const [, x1, y1, x2, y2, color, width, pathId] = vec;
  if (![x1, y1, x2, y2].every(value => typeof value === 'number' && Number.isFinite(value))) {
    return null;
  }

  const start = { x: x1, y: y1 };
  const end = { x: x2, y: y2 };
  const length = distance(start, end);
  if (!length) return null;

  return {
    index,
    pathId,
    color,
    width,
    start,
    end,
    length,
    bbox: {
      minX: Math.min(x1, x2),
      minY: Math.min(y1, y2),
      maxX: Math.max(x1, x2),
      maxY: Math.max(y1, y2)
    }
  };
}

function getVectorBounds(segments) {
  if (!segments.length) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, diagonal: 0 };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  segments.forEach(segment => {
    minX = Math.min(minX, segment.start.x, segment.end.x);
    minY = Math.min(minY, segment.start.y, segment.end.y);
    maxX = Math.max(maxX, segment.start.x, segment.end.x);
    maxY = Math.max(maxY, segment.start.y, segment.end.y);
  });

  const diagonal = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2);

  return { minX, minY, maxX, maxY, diagonal };
}

function calculateSegmentsBounds(segments) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  segments.forEach(segment => {
    minX = Math.min(minX, segment.start.x, segment.end.x);
    minY = Math.min(minY, segment.start.y, segment.end.y);
    maxX = Math.max(maxX, segment.start.x, segment.end.x);
    maxY = Math.max(maxY, segment.start.y, segment.end.y);
  });

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    center: {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2
    }
  };
}

function segmentVector(segment) {
  return {
    x: segment.end.x - segment.start.x,
    y: segment.end.y - segment.start.y
  };
}

function angleOfSegment(segment) {
  const vector = segmentVector(segment);
  const raw = Math.atan2(vector.y, vector.x) * 180 / Math.PI;
  return raw < 0 ? raw + 360 : raw;
}

function lineAngleDistance(a, b) {
  const diff = Math.abs(a - b) % 360;
  const angleDiff = Math.min(diff, 360 - diff);
  return Math.min(angleDiff, Math.abs(180 - angleDiff));
}

function pointLineDistance(point, origin, direction) {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  return Math.abs(dx * direction.y - dy * direction.x);
}

function canMergeFragments(a, b, tolerance, angleTolerance, lineTolerance) {
  if (lineAngleDistance(angleOfSegment(a), angleOfSegment(b)) > angleTolerance) return false;

  const endpointsClose =
    distance(a.start, b.start) <= tolerance ||
    distance(a.start, b.end) <= tolerance ||
    distance(a.end, b.start) <= tolerance ||
    distance(a.end, b.end) <= tolerance;
  if (!endpointsClose) return false;

  const vector = segmentVector(a);
  const length = Math.sqrt(vector.x * vector.x + vector.y * vector.y);
  if (!length) return false;
  const direction = { x: vector.x / length, y: vector.y / length };

  return pointLineDistance(b.start, a.start, direction) <= lineTolerance &&
    pointLineDistance(b.end, a.start, direction) <= lineTolerance;
}

function createMergedFragment(component, indexOffset) {
  if (!component || component.length === 0) return null;

  const longest = component.reduce((best, current) => current.length > best.length ? current : best, component[0]);
  const vector = segmentVector(longest);
  const baseLength = Math.sqrt(vector.x * vector.x + vector.y * vector.y);
  if (!baseLength) return null;
  const direction = { x: vector.x / baseLength, y: vector.y / baseLength };

  const points = component.flatMap(segment => [segment.start, segment.end]);
  const projected = points.map(point => ({
    point,
    t: (point.x - longest.start.x) * direction.x + (point.y - longest.start.y) * direction.y
  }));
  const first = projected.reduce((best, current) => current.t < best.t ? current : best, projected[0]);
  const last = projected.reduce((best, current) => current.t > best.t ? current : best, projected[0]);
  const start = {
    x: longest.start.x + direction.x * first.t,
    y: longest.start.y + direction.y * first.t
  };
  const end = {
    x: longest.start.x + direction.x * last.t,
    y: longest.start.y + direction.y * last.t
  };
  const length = distance(start, end);
  if (!length) return null;

  return {
    index: indexOffset,
    pathId: `merged-${component.map(segment => segment.pathId ?? segment.index).join('-')}`,
    color: longest.color,
    width: longest.width,
    start,
    end,
    length,
    sourceSegmentIndices: component.map(segment => segment.index),
    bbox: {
      minX: Math.min(start.x, end.x),
      minY: Math.min(start.y, end.y),
      maxX: Math.max(start.x, end.x),
      maxY: Math.max(start.y, end.y)
    }
  };
}

function mergeCollinearFragments(rawSegments, bounds, options = {}) {
  const diagonal = bounds.diagonal || 1000;
  const maxFragmentLength = options.mergeMaxFragmentLength ?? Math.max(14, diagonal * 0.011);
  const minMergedLength = options.mergeMinLength ?? Math.max(6, diagonal * 0.0035);
  const maxMergedLength = options.mergeMaxLength ?? Math.max(30, diagonal * 0.028);
  const endpointTolerance = options.mergeEndpointTolerance ?? Math.max(1.6, diagonal * 0.0016);
  const angleTolerance = options.mergeAngleTolerance ?? 13;
  const lineTolerance = options.mergeLineTolerance ?? Math.max(0.8, diagonal * 0.0009);
  const fragments = rawSegments.filter(segment => segment.length > 0.04 && segment.length <= maxFragmentLength);
  const cellSize = endpointTolerance;
  const endpointBuckets = new Map();
  const visited = new Set();
  const merged = [];

  const addEndpoint = (point, segment) => {
    const cellX = Math.floor(point.x / cellSize);
    const cellY = Math.floor(point.y / cellSize);
    const key = `${cellX}:${cellY}`;
    if (!endpointBuckets.has(key)) endpointBuckets.set(key, []);
    endpointBuckets.get(key).push(segment);
  };

  fragments.forEach(segment => {
    addEndpoint(segment.start, segment);
    addEndpoint(segment.end, segment);
  });

  const nearSegments = (point) => {
    const cellX = Math.floor(point.x / cellSize);
    const cellY = Math.floor(point.y / cellSize);
    const result = [];
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const bucket = endpointBuckets.get(`${cellX + dx}:${cellY + dy}`);
        if (bucket) result.push(...bucket);
      }
    }
    return result;
  };

  fragments.forEach(segment => {
    if (visited.has(segment.index)) return;
    const component = [segment];
    const queue = [segment];
    visited.add(segment.index);

    while (queue.length && component.length < 90) {
      const current = queue.shift();
      for (const point of [current.start, current.end]) {
        for (const candidate of nearSegments(point)) {
          if (visited.has(candidate.index)) continue;
          if (!canMergeFragments(current, candidate, endpointTolerance, angleTolerance, lineTolerance)) continue;
          visited.add(candidate.index);
          component.push(candidate);
          queue.push(candidate);
        }
      }
    }

    if (component.length < 2) return;
    const line = createMergedFragment(component, rawSegments.length + merged.length);
    if (line && line.length >= minMergedLength && line.length <= maxMergedLength) {
      merged.push(line);
    }
  });

  return merged;
}

function getSegmentTurnAngles(component) {
  const turns = [];
  for (let i = 0; i < component.length - 1; i += 1) {
    const angle = angleBetween(segmentVector(component[i]), segmentVector(component[i + 1]));
    turns.push(Math.min(angle, 180 - angle));
  }
  return turns;
}

function isActuallyConnectedComponent(component, tolerance = 0.8) {
  if (!component || component.length < 2) return true;
  for (let i = 0; i < component.length - 1; i += 1) {
    if (distance(component[i].end, component[i + 1].start) > tolerance) {
      return false;
    }
  }
  return true;
}

function hasProgressiveArcTurn(component) {
  if (!component || component.length < 3) return false;
  const turns = getSegmentTurnAngles(component);
  const meaningfulTurns = turns.filter(angle => angle >= 2).length;
  const totalTurn = turns.reduce((sum, angle) => sum + angle, 0);
  const maxTurn = turns.length ? Math.max(...turns) : 0;
  const dominantTurnRatio = totalTurn > 0 ? maxTurn / totalTurn : 1;
  return meaningfulTurns >= 2 &&
    totalTurn >= 8 &&
    totalTurn <= 170 &&
    maxTurn <= 70 &&
    dominantTurnRatio <= 0.72;
}

function isArrowLikeComponent(component, bounds) {
  if (!component || component.length < 3 || component.length > 8) {
    return false;
  }

  const componentBounds = calculateSegmentsBounds(component);
  const maxSize = Math.max(componentBounds.width, componentBounds.height);
  const minSize = Math.max(0.01, Math.min(componentBounds.width, componentBounds.height));
  const ratio = maxSize / minSize;
  const turns = getSegmentTurnAngles(component);
  const sharpTurns = turns.filter(angle => angle >= 35).length;
  const verySharpTurns = turns.filter(angle => angle >= 70).length;
  const diagonal = bounds.diagonal || 1000;

  // Small compact paths with sharp straight-line corners are usually arrow heads or glyph strokes.
  return maxSize <= diagonal * 0.03 &&
    ratio <= 3.2 &&
    sharpTurns >= 2 &&
    verySharpTurns >= 1;
}

function isDigitFourLikeComponent(component, bounds) {
  if (!component || component.length < 3 || component.length > 14) {
    return false;
  }

  const componentBounds = calculateSegmentsBounds(component);
  const maxSize = Math.max(componentBounds.width, componentBounds.height);
  const minSize = Math.max(0.01, Math.min(componentBounds.width, componentBounds.height));
  const ratio = maxSize / minSize;
  const turns = getSegmentTurnAngles(component);
  const nearRightAngles = turns.filter(angle => angle >= 65 && angle <= 115).length;
  const sharpTurns = turns.filter(angle => angle >= 45).length;
  const totalTurn = turns.reduce((sum, angle) => sum + angle, 0);
  const maxTurn = turns.length ? Math.max(...turns) : 0;
  const dominantTurnRatio = totalTurn > 0 ? maxTurn / totalTurn : 1;
  const diagonal = bounds.diagonal || 1000;

  // Number/label glyphs such as "4" are compact open strokes with one dominant
  // corner. Real elbow arcs bend progressively and should not be dominated by a
  // single near-right-angle turn.
  return maxSize <= diagonal * 0.045 &&
    ratio >= 0.75 &&
    ratio <= 5.2 &&
    nearRightAngles >= 1 &&
    sharpTurns >= 1 &&
    (dominantTurnRatio >= 0.48 || component.length <= 6);
}

function looksLikeDenseTextStroke(component, bounds) {
  if (!component || component.length < 3 || component.length > 18) {
    return false;
  }

  const componentBounds = calculateSegmentsBounds(component);
  const maxSize = Math.max(componentBounds.width, componentBounds.height);
  const minSize = Math.max(0.01, Math.min(componentBounds.width, componentBounds.height));
  const ratio = maxSize / minSize;
  const turns = getSegmentTurnAngles(component);
  const sharpTurns = turns.filter(angle => angle >= 42).length;
  const nearRightAngles = turns.filter(angle => angle >= 65 && angle <= 115).length;
  const diagonal = bounds.diagonal || 1000;
  const totalLength = component.reduce((sum, segment) => sum + segment.length, 0);
  const density = totalLength / Math.max(maxSize, 0.1);

  // Compact glyph strokes are often dense, angular, and sit in a very small box.
  // Real small elbows can be compact too, so keep this limited to short stroke
  // components and require several angular turns.
  return maxSize <= diagonal * 0.04 &&
    ratio <= 5.5 &&
    density >= 2.2 &&
    sharpTurns >= 2 &&
    nearRightAngles >= 1;
}

function looksLikeCompactArcCore(component, bounds) {
  if (!component || component.length < 8 || component.length > 52) {
    return false;
  }

  const componentBounds = calculateSegmentsBounds(component);
  const maxSize = Math.max(componentBounds.width, componentBounds.height);
  const minSize = Math.max(0.01, Math.min(componentBounds.width, componentBounds.height));
  const diagonal = bounds.diagonal || 1000;
  const totalLength = component.reduce((sum, segment) => sum + segment.length, 0);
  const avgLength = totalLength / component.length;
  const turns = getSegmentTurnAngles(component);
  const meaningfulTurns = turns.filter(angle => angle >= 2).length;
  const sharpTurns = turns.filter(angle => angle >= 55).length;
  const chord = distance(component[0].start, component[component.length - 1].end);
  const lengthRatio = totalLength / Math.max(chord, 0.1);

  return maxSize >= Math.max(0.8, diagonal * 0.00035) &&
    maxSize <= diagonal * 0.055 &&
    minSize >= 0.12 &&
    avgLength <= Math.max(1.8, diagonal * 0.0014) &&
    meaningfulTurns >= Math.min(6, Math.max(2, Math.floor(component.length * 0.22))) &&
    sharpTurns <= Math.max(4, Math.floor(component.length * 0.35)) &&
    lengthRatio >= 1.08;
}

function isSmoothArcComponent(component) {
  if (!component || component.length < 3) {
    return false;
  }

  const turns = getSegmentTurnAngles(component);
  if (turns.length === 0) {
    return false;
  }

  const maxTurn = Math.max(...turns);
  const avgTurn = turns.reduce((sum, angle) => sum + angle, 0) / turns.length;
  const sharpTurns = turns.filter(angle => angle >= 45).length;
  const totalTurn = turns.reduce((sum, angle) => sum + angle, 0);
  const meaningfulTurns = turns.filter(angle => angle >= 3).length;
  const dominantTurnRatio = totalTurn > 0 ? maxTurn / totalTurn : 1;

  // A rendered elbow bends progressively across multiple segments. Glyph strokes
  // often contain one dominant corner with otherwise almost straight segments.
  return isActuallyConnectedComponent(component) &&
    maxTurn <= 70 &&
    avgTurn >= 1.5 &&
    sharpTurns <= 1 &&
    totalTurn >= 8 &&
    meaningfulTurns >= 2 &&
    dominantTurnRatio <= 0.72;
}

function segmentIntersectsBox(segment, box, padding = 0) {
  return segment.bbox.maxX >= box.minX - padding &&
    segment.bbox.minX <= box.maxX + padding &&
    segment.bbox.maxY >= box.minY - padding &&
    segment.bbox.minY <= box.maxY + padding;
}

function looksLikeSmallRectangularLabel(candidate, rawSegments, bounds) {
  const candidateBox = candidate.boundingBox;
  if (!candidateBox || !candidate.center) return false;

  const diagonal = bounds.diagonal || 1000;
  const searchPadding = Math.max(2, diagonal * 0.0018);
  const nearby = rawSegments.filter(segment => segmentIntersectsBox(segment, candidateBox, searchPadding));
  if (nearby.length < 4 || nearby.length > 28) return false;

  const box = calculateSegmentsBounds(nearby);
  const maxSize = Math.max(box.width, box.height);
  const minSize = Math.max(0.01, Math.min(box.width, box.height));
  const ratio = maxSize / minSize;
  const candidateMaxSize = Math.max(candidateBox.width || 0, candidateBox.height || 0);

  if (
    maxSize > diagonal * 0.035 ||
    ratio > 1.8 ||
    candidateMaxSize > maxSize * 0.92
  ) {
    return false;
  }

  const horizontal = nearby.filter(segment => {
    const dx = Math.abs(segment.end.x - segment.start.x);
    const dy = Math.abs(segment.end.y - segment.start.y);
    return dx >= minSize * 0.35 && dy <= Math.max(0.35, dx * 0.18);
  });
  const vertical = nearby.filter(segment => {
    const dx = Math.abs(segment.end.x - segment.start.x);
    const dy = Math.abs(segment.end.y - segment.start.y);
    return dy >= minSize * 0.35 && dx <= Math.max(0.35, dy * 0.18);
  });

  const centerInside = candidate.center.x >= box.minX &&
    candidate.center.x <= box.maxX &&
    candidate.center.y >= box.minY &&
    candidate.center.y <= box.maxY;

  return centerInside && horizontal.length >= 2 && vertical.length >= 2;
}

function createEndpointIndex(segments, minLength, tolerance) {
  const cellSize = Math.max(0.1, tolerance);
  const buckets = new Map();

  const addPoint = (point, segment) => {
    const cellX = Math.floor(point.x / cellSize);
    const cellY = Math.floor(point.y / cellSize);
    const key = `${cellX}:${cellY}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ point, segment });
  };

  segments.forEach(segment => {
    if (segment.length < minLength) return;
    addPoint(segment.start, segment);
    addPoint(segment.end, segment);
  });

  return {
    find(point, excludedIndices = new Set(), predicate = null) {
      const cellX = Math.floor(point.x / cellSize);
      const cellY = Math.floor(point.y / cellSize);

      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          const bucket = buckets.get(`${cellX + dx}:${cellY + dy}`);
          if (!bucket) continue;

          for (const item of bucket) {
            if (excludedIndices.has(item.segment.index)) continue;
            if (predicate && !predicate(item.segment)) continue;
            if (distance(item.point, point) <= tolerance) {
              return item.segment;
            }
          }
        }
      }

      return null;
    }
  };
}

function isDirectionallyConnected(connector, tangentSegment, maxAngle = 38) {
  if (!connector || !tangentSegment) return false;
  const rawAngle = angleBetween(segmentVector(connector), segmentVector(tangentSegment));
  const undirectedAngle = Math.min(rawAngle, 180 - rawAngle);
  return undirectedAngle <= maxAngle;
}

function isLooselyConnectedToCore(connector, tangentSegment, maxAngle = 72) {
  if (!connector || !tangentSegment) return false;
  if (isDirectionallyConnected(connector, tangentSegment, maxAngle)) return true;
  const rawAngle = angleBetween(segmentVector(connector), segmentVector(tangentSegment));
  const undirectedAngle = Math.min(rawAngle, 180 - rawAngle);
  return undirectedAngle <= maxAngle || Math.abs(90 - undirectedAngle) <= 28;
}

function isSamePath(segment, componentPathIds) {
  return componentPathIds.has(segment.pathId ?? `segment-${segment.index}`);
}

function getExternalConnectorsForComponent(component, connectorLookup, maxAngle = 45, loose = false) {
  const componentIndices = new Set(component.map(segment => segment.index));
  const componentPathIds = new Set(component.map(segment => segment.pathId ?? `segment-${segment.index}`));
  const candidates = [];

  component.forEach(segment => {
    [
      { point: segment.start, tangent: segment },
      { point: segment.end, tangent: segment }
    ].forEach(({ point, tangent }) => {
      const connector = connectorLookup.find(
        point,
        componentIndices,
        item => !isSamePath(item, componentPathIds) && (
          loose ? isLooselyConnectedToCore(item, tangent, maxAngle) : isDirectionallyConnected(item, tangent, maxAngle)
        )
      );
      if (!connector || candidates.some(candidate => candidate.connector.index === connector.index)) {
        return;
      }
      candidates.push({ point, tangent, connector });
    });
  });

  candidates.sort((a, b) => b.connector.length - a.connector.length);
  const selected = [];
  candidates.forEach(candidate => {
    if (selected.length >= 2) return;
    if (selected.some(item => distance(item.point, candidate.point) < 0.5)) return;
    selected.push(candidate);
  });

  return selected;
}

function getElbowConnectorMinLength(component, bounds, options = {}) {
  const diagonal = bounds.diagonal || 1000;
  if (!component || component.length === 0) {
    return options.connectorMinLength ?? Math.max(7.5, diagonal * 0.004);
  }

  const lengths = component
    .map(segment => segment.length)
    .filter(length => Number.isFinite(length) && length > 0)
    .sort((a, b) => a - b);
  const medianLength = lengths[Math.floor(lengths.length / 2)] || 0;
  const chord = distance(component[0].start, component[component.length - 1].end);
  return options.connectorMinLength ?? Math.max(
    7.5,
    diagonal * 0.004,
    medianLength * 3.2,
    chord * 0.85
  );
}

function hasLongConnector(point, componentIndices, allSegments, longMinLength, tolerance) {
  if (allSegments?.connectorLookup) {
    return !!allSegments.connectorLookup.find(point, componentIndices);
  }

  return allSegments.some(segment => {
    if (componentIndices.has(segment.index) || segment.length < longMinLength) {
      return false;
    }

    return distance(segment.start, point) <= tolerance || distance(segment.end, point) <= tolerance;
  });
}

function isReasonableElbowComponent(component, bounds, thresholds) {
  if (!component || component.length < thresholds.minCount || component.length > thresholds.maxCount) {
    return null;
  }

  const componentBounds = calculateSegmentsBounds(component);
  const maxSize = Math.max(componentBounds.width, componentBounds.height);
  const minSize = Math.min(componentBounds.width, componentBounds.height);
  const totalLength = component.reduce((sum, segment) => sum + segment.length, 0);
  const chord = distance(component[0].start, component[component.length - 1].end);

  if (
    !isSmoothArcComponent(component) ||
    isArrowLikeComponent(component, bounds) ||
    isDigitFourLikeComponent(component, bounds) ||
    looksLikeDenseTextStroke(component, bounds)
  ) {
    return null;
  }

  if (
    maxSize < thresholds.minSize ||
    maxSize > thresholds.maxSize ||
    minSize <= thresholds.minThickness ||
    totalLength <= 0 ||
    chord <= thresholds.minChord
  ) {
    return null;
  }

  const firstVector = segmentVector(component[0]);
  const lastVector = segmentVector(component[component.length - 1]);
  const rawAngle = angleBetween(firstVector, lastVector);
  const turnAngle = Math.min(rawAngle, 180 - rawAngle);

  if (turnAngle < thresholds.minAngle || turnAngle > thresholds.maxAngle) {
    return null;
  }

  const componentIndices = new Set(component.map(segment => segment.index));
  const startConnector = bounds.allSegments.connectorLookup.find(
    component[0].start,
    componentIndices,
    connector => isDirectionallyConnected(connector, component[0])
  );
  const endConnector = bounds.allSegments.connectorLookup.find(
    component[component.length - 1].end,
    componentIndices,
    connector => isDirectionallyConnected(connector, component[component.length - 1])
  );

  const connectorCount = (startConnector ? 1 : 0) + (endConnector ? 1 : 0);
  if (connectorCount < 2) {
    return null;
  }
  const curvatureScore = Math.min(1, Math.max(0, (totalLength / Math.max(chord, 0.1) - 1) * 5));
  const countScore = Math.min(1, component.length / 5);
  const angleScore = 1 - Math.abs(turnAngle - 90) / 90;
  const connectorScore = connectorCount / 2;
  const score = Math.max(0, connectorScore * 0.28 + countScore * 0.25 + curvatureScore * 0.22 + angleScore * 0.25);

  if (score < thresholds.minScore) {
    return null;
  }

  return {
    center: componentBounds.center,
    angle: turnAngle,
    score,
    segmentIndices: component.map(segment => segment.index),
    pathIds: Array.from(new Set(component.map(segment => segment.pathId))),
    segmentLengths: component.map(segment => segment.length),
    endpointDistance: chord,
    connectorCount,
    boundingBox: componentBounds
  };
}

function detectPathRoundElbowCandidates(rawSegments, bounds, options = {}) {
  const diagonal = bounds.diagonal || 1000;
  const smallMinLength = options.smallMinLength ?? Math.max(0.05, diagonal * 0.00004);
  const smallMaxLength = options.smallMaxLength ?? Math.max(14, diagonal * 0.011);
  const grouped = new Map();

  rawSegments.forEach(segment => {
    if (segment.length < smallMinLength || segment.length > smallMaxLength) {
      return;
    }
    const key = segment.pathId ?? `segment-${segment.index}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(segment);
  });

  const thresholds = {
    minCount: options.pathMinCount ?? 3,
    maxCount: options.pathMaxCount ?? 42,
    minSize: options.minSize ?? smallMinLength * 1.6,
    maxSize: options.maxSize ?? diagonal * 0.055,
    minThickness: options.minThickness ?? 0.15,
    minChord: options.minChord ?? smallMinLength,
    minAngle: options.minAngle ?? 8,
    maxAngle: options.maxAngle ?? 165,
    longMinLength: options.longMinLength ?? Math.max(7.5, diagonal * 0.004),
    connectorTolerance: (options.endpointTolerance ?? Math.max(3, diagonal * 0.0025)) * 2,
    minScore: options.pathMinScore ?? 0.24
  };

  const detectorBounds = {
    ...bounds,
    allSegments: rawSegments
  };
  const candidates = [];
  grouped.forEach(component => {
    const ordered = [...component].sort((a, b) => a.index - b.index);
    detectorBounds.allSegments.connectorLookup = createEndpointIndex(
      rawSegments,
      getElbowConnectorMinLength(ordered, bounds, options),
      thresholds.connectorTolerance
    );
    const candidate = isReasonableElbowComponent(ordered, detectorBounds, thresholds);
    if (candidate) {
      candidates.push({
        ...candidate,
        type: 'path-round-elbow'
      });
    }
  });

  return candidates;
}

function detectCrossPathRoundElbowCandidates(rawSegments, bounds, options = {}) {
  const diagonal = bounds.diagonal || 1000;
  const smallMinLength = options.smallMinLength ?? Math.max(0.05, diagonal * 0.00004);
  const smallMaxLength = options.crossPathSmallMaxLength ?? Math.max(14, diagonal * 0.011);
  const endpointTolerance = options.endpointTolerance ?? Math.max(3, diagonal * 0.0025);
  const grouped = new Map();

  rawSegments.forEach(segment => {
    if (segment.length < smallMinLength || segment.length > smallMaxLength) {
      return;
    }
    const key = segment.pathId ?? `segment-${segment.index}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(segment);
  });

  const candidates = [];

  grouped.forEach(component => {
    const ordered = [...component].sort((a, b) => a.index - b.index);
    if (ordered.length < 8 || ordered.length > (options.crossPathMaxCount ?? 48)) {
      return;
    }

    const connectorLookup = createEndpointIndex(
      rawSegments,
      getElbowConnectorMinLength(ordered, bounds, options),
      endpointTolerance * 2.5
    );
    const externalConnectors = getExternalConnectorsForComponent(ordered, connectorLookup, 45, false);
    const connectorCount = externalConnectors.length;
    if (connectorCount < 2) {
      return;
    }

    const smoothArc = isSmoothArcComponent(ordered);
    const compactArc = looksLikeCompactArcCore(ordered, bounds);
    if (
      (!smoothArc && !compactArc) ||
      isArrowLikeComponent(ordered, bounds) ||
      isDigitFourLikeComponent(ordered, bounds) ||
      (!compactArc && looksLikeDenseTextStroke(ordered, bounds))
    ) {
      return;
    }

    const componentBounds = calculateSegmentsBounds(ordered);
    const maxSize = Math.max(componentBounds.width, componentBounds.height);
    const minSize = Math.min(componentBounds.width, componentBounds.height);
    if (
      maxSize < smallMinLength * 1.8 ||
      maxSize > diagonal * 0.055 ||
      minSize <= 0.15
    ) {
      return;
    }

    const firstVector = segmentVector(ordered[0]);
    const lastVector = segmentVector(ordered[ordered.length - 1]);
    const rawAngle = angleBetween(firstVector, lastVector);
    const turnAngle = Math.min(rawAngle, 180 - rawAngle);
    if (turnAngle < 8 || turnAngle > 170) {
      return;
    }

    const totalLength = ordered.reduce((sum, segment) => sum + segment.length, 0);
    const chord = distance(ordered[0].start, ordered[ordered.length - 1].end);
    const curvatureScore = Math.min(1, Math.max(0, (totalLength / Math.max(chord, 0.1) - 1) * 5));
    const angleScore = 1 - Math.abs(turnAngle - 90) / 90;
    const countScore = Math.min(1, ordered.length / 24);
    const score = Math.max(0, 0.3 + countScore * 0.25 + curvatureScore * 0.2 + angleScore * 0.25);
    if (score < (options.crossPathMinScore ?? 0.36)) {
      return;
    }

    candidates.push({
      type: 'cross-path-round-elbow',
      center: componentBounds.center,
      angle: turnAngle,
      score,
      segmentIndices: [
        ...ordered.map(segment => segment.index),
        ...externalConnectors.map(item => item.connector.index)
      ],
      pathIds: Array.from(new Set([
        ...ordered.map(segment => segment.pathId),
        ...externalConnectors.map(item => item.connector.pathId)
      ])),
      segmentLengths: ordered.map(segment => segment.length),
      endpointDistance: chord,
      connectorCount,
      boundingBox: componentBounds
    });
  });

  return candidates;
}

function detectThreePartElbowCandidates(rawSegments, bounds, options = {}) {
  const diagonal = bounds.diagonal || 1000;
  const endpointTolerance = options.endpointTolerance ?? Math.max(3, diagonal * 0.0025);
  const smallMinLength = options.smallMinLength ?? Math.max(0.05, diagonal * 0.00004);
  const smallMaxLength = options.smallMaxLength ?? Math.max(14, diagonal * 0.011);
  const grouped = new Map();

  rawSegments.forEach(segment => {
    const key = segment.pathId ?? `segment-${segment.index}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(segment);
  });

  const candidates = [];
  grouped.forEach(component => {
    const ordered = [...component].sort((a, b) => a.index - b.index);
    if (ordered.length < 3 || ordered.length > 12) {
      return;
    }

    if (!ordered.every(segment => segment.length >= smallMinLength && segment.length <= smallMaxLength)) {
      return;
    }

    if (
      !isSmoothArcComponent(ordered) ||
      isArrowLikeComponent(ordered, bounds) ||
      isDigitFourLikeComponent(ordered, bounds) ||
      looksLikeDenseTextStroke(ordered, bounds)
    ) {
      return;
    }

    const startPoint = ordered[0].start;
    const endPoint = ordered[ordered.length - 1].end;
    const componentIndices = new Set(ordered.map(segment => segment.index));
    const connectorLookup = createEndpointIndex(
      rawSegments,
      getElbowConnectorMinLength(ordered, bounds, options),
      endpointTolerance * 2.5
    );

    const startConnector = connectorLookup.find(
      startPoint,
      componentIndices,
      connector => isDirectionallyConnected(connector, ordered[0])
    );
    const endConnector = connectorLookup.find(
      endPoint,
      componentIndices,
      connector => isDirectionallyConnected(connector, ordered[ordered.length - 1])
    );

    if (!startConnector || !endConnector) {
      return;
    }

    const componentBounds = calculateSegmentsBounds(ordered);
    const firstVector = segmentVector(ordered[0]);
    const lastVector = segmentVector(ordered[ordered.length - 1]);
    const rawAngle = angleBetween(firstVector, lastVector);
    const turnAngle = Math.min(rawAngle, 180 - rawAngle);

    if (turnAngle < 8 || turnAngle > 170) {
      return;
    }

    const connectorCount = (startConnector ? 1 : 0) + (endConnector ? 1 : 0);
    const score = Math.min(1, 0.45 + ordered.length / 20 + connectorCount * 0.15);

    candidates.push({
      type: 'three-part-elbow',
      center: componentBounds.center,
      angle: turnAngle,
      score,
      segmentIndices: [
        ...ordered.map(segment => segment.index),
        ...(startConnector ? [startConnector.index] : []),
        ...(endConnector ? [endConnector.index] : [])
      ],
      pathIds: Array.from(new Set([
        ...ordered.map(segment => segment.pathId),
        ...(startConnector ? [startConnector.pathId] : []),
        ...(endConnector ? [endConnector.pathId] : [])
      ])),
      segmentLengths: ordered.map(segment => segment.length),
      endpointDistance: distance(startPoint, endPoint),
      connectorCount,
      boundingBox: componentBounds
    });
  });

  return candidates;
}

function directionAwayFromNode(segment, node) {
  const startDistance = distance(segment.start, node);
  const endDistance = distance(segment.end, node);
  const anchor = startDistance <= endDistance ? segment.start : segment.end;
  const far = startDistance <= endDistance ? segment.end : segment.start;
  return {
    anchor,
    vector: {
      x: far.x - anchor.x,
      y: far.y - anchor.y
    }
  };
}

function pointsClose(a, b, tolerance) {
  return distance(a, b) <= tolerance;
}

function getWeldCenter(weld) {
  if (
    weld?.center &&
    Number.isFinite(weld.center.x) &&
    Number.isFinite(weld.center.y)
  ) {
    return weld.center;
  }
  const box = weld?.boundingBox;
  if (
    box &&
    [box.minX, box.minY, box.maxX, box.maxY].every(Number.isFinite)
  ) {
    return {
      x: (box.minX + box.maxX) / 2,
      y: (box.minY + box.maxY) / 2
    };
  }
  return null;
}

function findNearestWeld(point, welds, tolerance, excludedWeld = null) {
  let nearest = null;
  let nearestDistance = Infinity;
  (welds || []).forEach(weld => {
    if (weld === excludedWeld) return;
    const center = getWeldCenter(weld);
    if (!center) return;
    const currentDistance = distance(point, center);
    if (currentDistance <= tolerance && currentDistance < nearestDistance) {
      nearest = weld;
      nearestDistance = currentDistance;
    }
  });
  return nearest ? { weld: nearest, distance: nearestDistance } : null;
}

function classifySharpElbowNominalAngle(projectedAngle, options = {}) {
  const shallowAngleMax = options.sharpElbow45ShallowAngleMax ?? 38;
  const reflexAngleMin = options.sharpElbow45ReflexAngleMin ?? 142;
  return projectedAngle <= shallowAngleMax || projectedAngle >= reflexAngleMin ? 45 : 90;
}

function detectSharpLineElbowCandidates(rawSegments, bounds, welds, options = {}) {
  if (!Array.isArray(welds) || welds.length === 0) return [];

  const diagonal = bounds.diagonal || 1000;
  const endpointTolerance = options.sharpElbowEndpointTolerance ??
    Math.max(0.8, Math.min(2.2, diagonal * 0.0015));
  const minArmLength = options.sharpElbowMinArmLength ??
    Math.max(8, diagonal * 0.008);
  const maxArmLength = options.sharpElbowMaxArmLength ??
    Math.max(24, diagonal * 0.026);
  // In an isometric drawing a physical 45-degree elbow commonly projects to a
  // roughly 30/150-degree corner, while a 90-degree elbow projects near 60/120.
  const minAngle = options.sharpElbowMinAngle ?? 22;
  const maxAngle = options.sharpElbowMaxAngle ?? 158;
  const candidates = [];
  const seenPairs = new Set();
  const shortSegments = rawSegments.filter(segment =>
    segment.length >= minArmLength &&
    segment.length <= maxArmLength
  );

  const endpointIndex = createEndpointIndex(shortSegments, minArmLength, endpointTolerance);

  shortSegments.forEach(first => {
    [first.start, first.end].forEach(firstJoint => {
      const second = endpointIndex.find(
        firstJoint,
        new Set([first.index]),
        candidate => candidate.pathId !== first.pathId
      );
      if (!second) return;

      const pairKey = [first.index, second.index].sort((a, b) => a - b).join(':');
      if (seenPairs.has(pairKey)) return;
      seenPairs.add(pairKey);

      const secondEndpoints = [second.start, second.end]
        .map(point => ({ point, gap: distance(firstJoint, point) }))
        .sort((a, b) => a.gap - b.gap);
      const secondJoint = secondEndpoints[0];
      if (!secondJoint || secondJoint.gap > endpointTolerance) return;

      if (
        first.color !== undefined &&
        second.color !== undefined &&
        first.color !== second.color
      ) {
        return;
      }
      if (
        Number.isFinite(first.width) &&
        Number.isFinite(second.width) &&
        Math.abs(first.width - second.width) > Math.max(0.18, Math.abs(first.width) * 0.25)
      ) {
        return;
      }

      const node = {
        x: (firstJoint.x + secondJoint.point.x) / 2,
        y: (firstJoint.y + secondJoint.point.y) / 2
      };
      const firstOuter = distance(first.start, firstJoint) <= endpointTolerance
        ? first.end
        : first.start;
      const secondOuter = distance(second.start, secondJoint.point) <= endpointTolerance
        ? second.end
        : second.start;
      const firstVector = {
        x: firstOuter.x - node.x,
        y: firstOuter.y - node.y
      };
      const secondVector = {
        x: secondOuter.x - node.x,
        y: secondOuter.y - node.y
      };
      const angle = angleBetween(firstVector, secondVector);
      if (angle < minAngle || angle > maxAngle) return;
      const nominalAngle = classifySharpElbowNominalAngle(angle, options);

      const lengthRatio = Math.max(first.length, second.length) /
        Math.max(0.01, Math.min(first.length, second.length));
      if (lengthRatio > (options.sharpElbowMaxLengthRatio ?? 1.45)) return;

      // The arm endpoint must land on the weld center. A broad "near the weld"
      // test incorrectly accepts pipe strokes that only pass the weld edge.
      const weldTolerance = options.sharpElbowWeldCenterTolerance ??
        Math.max(0.75, Math.min(2.4, diagonal * 0.0014));
      const firstWeld = findNearestWeld(firstOuter, welds, weldTolerance);
      const secondWeld = findNearestWeld(
        secondOuter,
        welds,
        weldTolerance,
        firstWeld?.weld || null
      );
      const weldEvidenceCount = Number(!!firstWeld) + Number(!!secondWeld);
      if (weldEvidenceCount < 1) return;

      const box = calculateSegmentsBounds([first, second]);
      candidates.push({
        type: 'sharp-line-elbow',
        center: node,
        angle,
        nominalAngle,
        elbowAngle: nominalAngle,
        score: weldEvidenceCount === 2 ? 0.95 : 0.72,
        confidence: weldEvidenceCount === 2 ? 'high' : 'low',
        weldEvidenceCount,
        missingWeldEndpoint: weldEvidenceCount === 1
          ? (firstWeld ? 'second' : 'first')
          : null,
        weldPathIds: [firstWeld?.weld?.pathId, secondWeld?.weld?.pathId]
          .filter(value => value !== undefined && value !== null),
        weldCenterDistances: [firstWeld?.distance, secondWeld?.distance]
          .filter(Number.isFinite),
        elbowEndpoints: {
          first: firstOuter,
          second: secondOuter,
          corner: node
        },
        segmentIndices: [first.index, second.index],
        pathIds: Array.from(new Set([first.pathId, second.pathId])),
        segmentLengths: [first.length, second.length],
        endpointDistance: secondJoint.gap,
        connectorCount: 2,
        boundingBox: box
      });
    });
  });

  return candidates;
}

function orientArcChainBetweenPoints(arcSegments, firstPoint, secondPoint, tolerance) {
  if (!Array.isArray(arcSegments) || arcSegments.length < 3) return null;
  const ordered = [...arcSegments].sort((a, b) => a.index - b.index);
  const variants = [ordered, [...ordered].reverse().map(segment => ({
    ...segment,
    start: segment.end,
    end: segment.start
  }))];

  for (const chain of variants) {
    if (!isActuallyConnectedComponent(chain, tolerance)) continue;
    const startsAtFirst = pointsClose(chain[0].start, firstPoint, tolerance);
    const endsAtSecond = pointsClose(chain[chain.length - 1].end, secondPoint, tolerance);
    const startsAtSecond = pointsClose(chain[0].start, secondPoint, tolerance);
    const endsAtFirst = pointsClose(chain[chain.length - 1].end, firstPoint, tolerance);
    if (startsAtFirst && endsAtSecond) return chain;
    if (startsAtSecond && endsAtFirst) return [...chain].reverse().map(segment => ({
      ...segment,
      start: segment.end,
      end: segment.start
    }));
  }

  return null;
}

function detectMergedLineElbowCandidates(mergedSegments, rawSegments, bounds, options = {}) {
  if (!mergedSegments || mergedSegments.length < 2) return [];

  const diagonal = bounds.diagonal || 1000;
  const endpointTolerance = options.endpointTolerance ?? Math.max(3, diagonal * 0.0025);
  const minArmLength = options.mergedElbowMinArmLength ?? Math.max(7.5, diagonal * 0.004);
  const maxArmLength = options.mergedElbowMaxArmLength ?? Math.max(34, diagonal * 0.028);
  const arcSearchRadius = options.mergedElbowArcRadius ?? Math.max(5, diagonal * 0.0045);
  const candidates = [];

  for (let i = 0; i < mergedSegments.length - 1; i += 1) {
    for (let j = i + 1; j < mergedSegments.length; j += 1) {
      const first = mergedSegments[i];
      const second = mergedSegments[j];
      if (
        first.length < minArmLength ||
        second.length < minArmLength ||
        first.length > maxArmLength ||
        second.length > maxArmLength
      ) {
        continue;
      }

      const endpointPairs = [
        [first.start, second.start],
        [first.start, second.end],
        [first.end, second.start],
        [first.end, second.end]
      ];
      const closest = endpointPairs
        .map(pair => ({ pair, gap: distance(pair[0], pair[1]) }))
        .sort((a, b) => a.gap - b.gap)[0];
      if (!closest || closest.gap > endpointTolerance * 1.6) continue;

      const node = {
        x: (closest.pair[0].x + closest.pair[1].x) / 2,
        y: (closest.pair[0].y + closest.pair[1].y) / 2
      };
      const firstAway = directionAwayFromNode(first, node);
      const secondAway = directionAwayFromNode(second, node);
      const turnAngle = Math.min(
        angleBetween(firstAway.vector, secondAway.vector),
        180 - angleBetween(firstAway.vector, secondAway.vector)
      );
      if (turnAngle < 22 || turnAngle > 165) continue;

      const firstJoint = firstAway.anchor;
      const secondJoint = secondAway.anchor;
      const nearbyArc = rawSegments.filter(segment => {
        if (segment.length > Math.max(8, diagonal * 0.006)) return false;
        return distance(segment.start, node) <= arcSearchRadius ||
          distance(segment.end, node) <= arcSearchRadius ||
          (segment.bbox.minX <= node.x + arcSearchRadius &&
            segment.bbox.maxX >= node.x - arcSearchRadius &&
            segment.bbox.minY <= node.y + arcSearchRadius &&
            segment.bbox.maxY >= node.y - arcSearchRadius);
      });
      const arcChain = orientArcChainBetweenPoints(nearbyArc, firstJoint, secondJoint, endpointTolerance * 1.8);
      if (!arcChain || !hasProgressiveArcTurn(arcChain)) continue;

      const box = calculateSegmentsBounds([first, second, ...arcChain]);
      const maxSize = Math.max(box.width, box.height);
      const minSize = Math.max(0.1, Math.min(box.width, box.height));
      if (maxSize > diagonal * 0.07 || maxSize / minSize > 8.5) continue;

      candidates.push({
        type: 'merged-line-elbow',
        center: node,
        angle: turnAngle,
        score: Math.min(1, 0.48 + arcChain.length * 0.02 + (1 - Math.abs(turnAngle - 90) / 90) * 0.22),
        segmentIndices: [
          ...(first.sourceSegmentIndices || [first.index]),
          ...(second.sourceSegmentIndices || [second.index])
        ],
        pathIds: Array.from(new Set([
          first.pathId,
          second.pathId,
          ...(arcChain.map(segment => segment.pathId))
        ])),
        segmentLengths: [first.length, second.length],
        endpointDistance: closest.gap,
        connectorCount: 2,
        boundingBox: box
      });
    }
  }

  return candidates;
}

function candidateKey(candidate) {
  const x = Math.round(candidate.center.x * 2) / 2;
  const y = Math.round(candidate.center.y * 2) / 2;
  const ids = candidate.segmentIndices.slice().sort((a, b) => a - b).join('-');
  return `${candidate.type}:${x}:${y}:${ids}`;
}

function getSamePositionElbowPriority(candidate) {
  const nominalAngle = Number(candidate?.nominalAngle || candidate?.elbowAngle);
  if (nominalAngle === 90) return 2;
  if (nominalAngle === 45) return 1;
  return 0;
}

export function detectElbowCandidates(vectors, options = {}) {
  if (!Array.isArray(vectors) || vectors.length === 0) {
    return [];
  }

  const rawSegments = vectors
    .map(normalizeVectorElement)
    .filter(Boolean);

  const bounds = getVectorBounds(rawSegments);
  const requestedGeometryMode = options.elbowGeometryMode ||
    (options.includeSharpElbows ? 'auto-exclusive' : 'round');
  const sharpLineElbowCandidates = (
    options.includeSharpElbows &&
    requestedGeometryMode !== 'round'
  )
    ? detectSharpLineElbowCandidates(rawSegments, bounds, options.welds, options)
    : [];
  const selectedGeometryMode = requestedGeometryMode === 'auto-exclusive'
    ? (sharpLineElbowCandidates.length > 0 ? 'sharp' : 'round')
    : requestedGeometryMode;
  const mergedLineSegments = mergeCollinearFragments(rawSegments, bounds, options);
  const detectionSegments = [...rawSegments, ...mergedLineSegments];
  const roundCandidates = selectedGeometryMode === 'round'
    ? [
      ...detectThreePartElbowCandidates(detectionSegments, bounds, options),
      ...detectPathRoundElbowCandidates(detectionSegments, bounds, options),
      ...detectCrossPathRoundElbowCandidates(detectionSegments, bounds, options),
      ...detectMergedLineElbowCandidates(mergedLineSegments, rawSegments, bounds, options)
    ]
    : [];
  const candidates = (
    selectedGeometryMode === 'sharp'
      ? sharpLineElbowCandidates
      : roundCandidates
  )
    .map(candidate => ({
      ...candidate,
      geometryRuleMode: selectedGeometryMode
    }))
    .filter(candidate => !looksLikeSmallRectangularLabel(candidate, rawSegments, bounds));

  const diagonal = bounds.diagonal || 1000;
  const mergeDistance = options.mergeDistance ?? Math.max(3, diagonal * 0.0025);
  const mergeCellSize = Math.max(0.5, mergeDistance);
  const nearbyCells = (center) => {
    const cellX = Math.floor(center.x / mergeCellSize);
    const cellY = Math.floor(center.y / mergeCellSize);
    const keys = [];
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        keys.push(`${cellX + dx}:${cellY + dy}`);
      }
    }
    return keys;
  };
  const unique = [];
  const uniqueByKey = new Map();
  const uniqueByCell = new Map();

  candidates
    .sort((a, b) => (
      getSamePositionElbowPriority(b) - getSamePositionElbowPriority(a) ||
      b.score - a.score
    ))
    .forEach(candidate => {
      const currentKey = candidateKey(candidate);
      const duplicateByKey = uniqueByKey.has(currentKey);
      const duplicateByDistance = nearbyCells(candidate.center).some(key => {
        const bucket = uniqueByCell.get(key);
        return bucket?.some(existing => distance(existing.center, candidate.center) <= mergeDistance);
      });

      if (duplicateByKey || duplicateByDistance) return;

      unique.push(candidate);
      uniqueByKey.set(currentKey, candidate);
      const cellX = Math.floor(candidate.center.x / mergeCellSize);
      const cellY = Math.floor(candidate.center.y / mergeCellSize);
      const cellKey = `${cellX}:${cellY}`;
      if (!uniqueByCell.has(cellKey)) uniqueByCell.set(cellKey, []);
      uniqueByCell.get(cellKey).push(candidate);
    });

  return unique.sort((a, b) => b.score - a.score);
}
