function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
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

  return {
    minX,
    minY,
    maxX,
    maxY,
    diagonal: Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2)
  };
}

function angleOfVector(vector) {
  const raw = Math.atan2(vector.y, vector.x) * 180 / Math.PI;
  return raw < 0 ? raw + 360 : raw;
}

function angleDistance(a, b) {
  const diff = Math.abs(a - b) % 360;
  return Math.min(diff, 360 - diff);
}

function lineAngleDistance(a, b) {
  const diff = angleDistance(a, b);
  return Math.min(diff, Math.abs(180 - diff));
}

function segmentAngle(segment) {
  return angleOfVector({
    x: segment.end.x - segment.start.x,
    y: segment.end.y - segment.start.y
  });
}

function pointLineDistance(point, origin, direction) {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  return Math.abs(dx * direction.y - dy * direction.x);
}

function canMergeFragments(a, b, tolerance, angleTolerance, lineTolerance) {
  if (lineAngleDistance(segmentAngle(a), segmentAngle(b)) > angleTolerance) return false;

  const endpointsClose =
    distance(a.start, b.start) <= tolerance ||
    distance(a.start, b.end) <= tolerance ||
    distance(a.end, b.start) <= tolerance ||
    distance(a.end, b.end) <= tolerance;
  if (!endpointsClose) return false;

  const vector = {
    x: a.end.x - a.start.x,
    y: a.end.y - a.start.y
  };
  const length = Math.sqrt(vector.x * vector.x + vector.y * vector.y);
  if (!length) return false;
  const direction = { x: vector.x / length, y: vector.y / length };

  return pointLineDistance(b.start, a.start, direction) <= lineTolerance &&
    pointLineDistance(b.end, a.start, direction) <= lineTolerance;
}

function createMergedFragment(component, indexOffset) {
  if (!component || component.length === 0) return null;

  const longest = component.reduce((best, current) => current.length > best.length ? current : best, component[0]);
  const vector = {
    x: longest.end.x - longest.start.x,
    y: longest.end.y - longest.start.y
  };
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
  const minMergedLength = options.mergeMinLength ?? Math.max(8, diagonal * 0.004);
  const maxMergedLength = options.mergeMaxLength ?? Math.max(18, diagonal * 0.018);
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

    while (queue.length && component.length < 80) {
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

function clusterEndpoints(segments, tolerance) {
  const clusters = [];

  segments.forEach(segment => {
    [segment.start, segment.end].forEach(point => {
      let cluster = clusters.find(item => distance(item.center, point) <= tolerance);
      if (!cluster) {
        cluster = { center: { ...point }, points: [], segments: [] };
        clusters.push(cluster);
      }
      cluster.points.push(point);
      cluster.segments.push(segment);
      cluster.center = {
        x: cluster.points.reduce((sum, current) => sum + current.x, 0) / cluster.points.length,
        y: cluster.points.reduce((sum, current) => sum + current.y, 0) / cluster.points.length
      };
    });
  });

  return clusters;
}

function segmentDirectionAwayFromNode(segment, node, tolerance) {
  const startDistance = distance(segment.start, node);
  const endDistance = distance(segment.end, node);
  const anchor = startDistance <= endDistance ? segment.start : segment.end;
  const far = startDistance <= endDistance ? segment.end : segment.start;
  if (distance(anchor, node) > tolerance) return null;
  return {
    x: far.x - anchor.x,
    y: far.y - anchor.y
  };
}

function calculateBounds(segments) {
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

function candidateKey(candidate) {
  const x = Math.round(candidate.center.x * 2) / 2;
  const y = Math.round(candidate.center.y * 2) / 2;
  return `${x}:${y}:${candidate.segmentIndices.slice().sort((a, b) => a - b).join('-')}`;
}

function classifyTeeArms(arms, options = {}) {
  if (!Array.isArray(arms) || arms.length < 3) return null;

  const maxCollinearDiff = options.maxCollinearDiff ?? 26;
  const minBranchSeparation = options.minBranchSeparation ?? 32;
  let bestPair = null;

  for (let i = 0; i < arms.length - 1; i += 1) {
    for (let j = i + 1; j < arms.length; j += 1) {
      const diffFromLine = lineAngleDistance(arms[i].angle, arms[j].angle);
      const oppositeDiff = Math.abs(180 - angleDistance(arms[i].angle, arms[j].angle));
      const score = diffFromLine + oppositeDiff * 0.35;
      if (!bestPair || score < bestPair.score) {
        bestPair = { i, j, diffFromLine, oppositeDiff, score };
      }
    }
  }

  if (!bestPair || bestPair.diffFromLine > maxCollinearDiff) {
    return null;
  }

  const branchIndex = arms.findIndex((_, index) => index !== bestPair.i && index !== bestPair.j);
  if (branchIndex < 0) return null;

  const mainArms = [arms[bestPair.i], arms[bestPair.j]];
  const branchArm = arms[branchIndex];
  const branchSeparation = Math.min(
    lineAngleDistance(branchArm.angle, mainArms[0].angle),
    lineAngleDistance(branchArm.angle, mainArms[1].angle)
  );
  if (branchSeparation < minBranchSeparation) {
    return null;
  }

  return {
    mainArms,
    branchArm,
    mainSegmentIndices: mainArms.map(arm => arm.segment.index),
    branchSegmentIndex: branchArm.segment.index,
    mainAngles: mainArms.map(arm => arm.angle),
    branchAngle: branchArm.angle,
    collinearDiff: bestPair.diffFromLine,
    branchSeparation
  };
}

function collapseSimilarDirectionArms(arms, minDirectionSeparation) {
  const collapsed = [];
  const sorted = [...arms].sort((a, b) => b.length - a.length);

  sorted.forEach(arm => {
    const existing = collapsed.find(item => angleDistance(item.angle, arm.angle) < minDirectionSeparation);
    if (!existing) {
      collapsed.push(arm);
    }
  });

  return collapsed.sort((a, b) => a.segment.index - b.segment.index);
}

export function detectTeeCandidates(vectors, options = {}) {
  if (!Array.isArray(vectors) || vectors.length === 0) return [];

  const rawSegments = vectors.map(normalizeVectorElement).filter(Boolean);
  if (rawSegments.length < 3) return [];

  const bounds = getVectorBounds(rawSegments);
  const diagonal = bounds.diagonal || 1000;
  const endpointTolerance = options.endpointTolerance ?? Math.max(1.2, diagonal * 0.0015);
  // Samples are around 12.7-12.8 units. Keep this deliberately narrow enough
  // to avoid tiny glyph strokes and long pipe/leader segments.
  const minLength = options.minLength ?? Math.max(8, diagonal * 0.004);
  const maxLength = options.maxLength ?? Math.max(16, Math.min(24, diagonal * 0.012));
  const minDirectionSeparation = options.minDirectionSeparation ?? 28;
  const mergedSegments = mergeCollinearFragments(rawSegments, bounds, options);
  const shortSegments = [
    ...rawSegments.filter(segment => segment.length >= minLength && segment.length <= maxLength),
    ...mergedSegments
  ];
  const clusters = clusterEndpoints(shortSegments, endpointTolerance);
  const candidates = [];

  clusters.forEach(cluster => {
    const uniqueSegments = Array.from(new Map(cluster.segments.map(segment => [segment.index, segment])).values());
    if (uniqueSegments.length < 3 || uniqueSegments.length > 5) return;

    const arms = uniqueSegments
      .map(segment => {
        const direction = segmentDirectionAwayFromNode(segment, cluster.center, endpointTolerance * 1.4);
        if (!direction) return null;
        return {
          segment,
          angle: angleOfVector(direction),
          length: segment.length
        };
      })
      .filter(Boolean);

    if (arms.length < 3) return;

    const directionArms = collapseSimilarDirectionArms(arms, minDirectionSeparation);
    if (directionArms.length < 3) return;
    const topology = classifyTeeArms(directionArms, options);
    if (!topology) return;

    const sortedAngles = directionArms.map(arm => arm.angle).sort((a, b) => a - b);
    const tooClose = sortedAngles.some((angle, index) => {
      const next = sortedAngles[(index + 1) % sortedAngles.length];
      return angleDistance(angle, next) < minDirectionSeparation;
    });
    if (tooClose) return;

    const lengths = directionArms.map(arm => arm.length);
    const minArmLength = Math.min(...lengths);
    const maxArmLength = Math.max(...lengths);
    if (maxArmLength / Math.max(0.1, minArmLength) > 2.8) return;

    const usedSegments = directionArms.slice(0, 3).map(arm => arm.segment);
    const box = calculateBounds(usedSegments);
    const maxSize = Math.max(box.width, box.height);
    const minSize = Math.max(0.1, Math.min(box.width, box.height));
    if (maxSize > diagonal * 0.04 || maxSize / minSize > 5.5) return;

    candidates.push({
      type: 'tee-fitting',
      center: cluster.center,
      score: Math.min(1, 0.6 + directionArms.length * 0.08 + (1 - topology.collinearDiff / 90) * 0.12),
      segmentIndices: usedSegments.map(segment => segment.index),
      pathIds: Array.from(new Set(usedSegments.map(segment => segment.pathId))),
      segmentLengths: usedSegments.map(segment => segment.length),
      connectorCount: directionArms.length,
      teeTopology: topology,
      boundingBox: box
    });
  });

  const unique = new Map();
  candidates
    .sort((a, b) => b.score - a.score)
    .forEach(candidate => {
      const key = candidateKey(candidate);
      if (!unique.has(key)) {
        unique.set(key, candidate);
      }
    });

  return Array.from(unique.values()).sort((a, b) => b.score - a.score);
}

// 六边形支管台：仅作为三通候选的加强判据，不改变普通三通识别。
export function detectBranchOutletCandidates(vectors, options = {}) {
  if (!Array.isArray(vectors) || vectors.length < 6) return [];
  const raw = vectors.map(normalizeVectorElement).filter(Boolean);
  if (raw.length < 6) return [];
  const bounds = getVectorBounds(raw);
  const diagonal = bounds.diagonal || 1000;
  const tolerance = options.endpointTolerance ?? Math.max(1.2, diagonal * 0.0015);
  const minSize = options.minSize ?? Math.max(5, diagonal * 0.004);
  // Real outlet hexagons are compact (roughly 15-22 units on the 1684x1191
  // Shenyuan sheets).  The old 5.5%-of-page ceiling admitted instrument and
  // valve bodies large enough to steal the material QTY slots.
  const maxSize = options.maxSize ?? Math.max(34, diagonal * 0.0185);
  const maxShort = options.maxShortLength ?? Math.max(24, diagonal * 0.014);
  // ISO drawings often split the pipe run at a branch-outlet symbol.  Those
  // adjacent fragments can be much shorter than a whole-page-relative limit
  // (the real 2456-2678 sample is about 28-32 units on a ~2060 diagonal page).
  // Material-gated callers keep this relaxed geometry threshold from being
  // applied indiscriminately to unrelated hexagons.
  const minConnector = options.minConnectorLength ?? Math.max(18, diagonal * 0.01);
  const groups = new Map();
  raw.forEach(segment => {
    const key = segment.pathId ?? `segment-${segment.index}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(segment);
  });
  const pointSegmentDistance = (point, segment) => {
    const vx = segment.end.x - segment.start.x;
    const vy = segment.end.y - segment.start.y;
    const denom = vx * vx + vy * vy;
    const t = denom ? Math.max(0, Math.min(1, ((point.x - segment.start.x) * vx + (point.y - segment.start.y) * vy) / denom)) : 0;
    return distance(point, { x: segment.start.x + t * vx, y: segment.start.y + t * vy });
  };
  const candidates = [];
  groups.forEach(group => {
    const short = group.filter(segment => segment.length <= maxShort);
    if (short.length < 6 || short.length > 8) return;
    const xs = short.flatMap(segment => [segment.start.x, segment.end.x]);
    const ys = short.flatMap(segment => [segment.start.y, segment.end.y]);
    const minX = Math.min(...xs); const maxX = Math.max(...xs);
    const minY = Math.min(...ys); const maxY = Math.max(...ys);
    const width = maxX - minX; const height = maxY - minY;
    const size = Math.max(width, height);
    const aspect = size / Math.max(0.1, Math.min(width, height));
    if (size < minSize || size > maxSize || aspect > 1.8) return;
    const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    const connected = short.reduce((count, segment) => count + [segment.start, segment.end].filter(point => (
      short.some(other => other !== segment && (distance(point, other.start) <= tolerance || distance(point, other.end) <= tolerance))
    )).length, 0);
    if (connected < 10) return;
    // The main run may terminate at a vertex of the outlet instead of crossing
    // its geometric centre.  Allow that vertex distance, while the caller's
    // material-table gate and the closed 6-8 edge topology still prevent a
    // generic hexagon from becoming an outlet.
    const connectorDistance = options.connectorDistance ?? Math.max(tolerance * 3.5, size * 0.45);
    const connectors = raw.filter(segment => (
      segment.length >= minConnector && pointSegmentDistance(center, segment) <= connectorDistance
    ));
    if (!connectors.length) return;
    const welds = Array.isArray(options.welds) ? options.welds : null;
    const nearbyWelds = welds
      ? welds.filter(weld => weld?.center && distance(weld.center, center) <= size * 1.1)
      : [];
    if (welds && !nearbyWelds.length) return;

    // A welding outlet sits on the branch pipe, with one weld at the main-pipe
    // root (OL) and the opposite weld continuing along the branch (normally BW).
    // Main runs usually contribute the strongest collinear group of long
    // segments through the compact hexagon.  Keep the inferred point on the
    // candidate so annotation binding does not have to guess by page order.
    const roleConnectors = raw.filter(segment => (
      segment.length >= minConnector
      && pointSegmentDistance(center, segment) <= Math.max(tolerance * 4, size * 0.8)
    ));
    const connectorGroups = [];
    roleConnectors
      .slice()
      .sort((a, b) => b.length - a.length)
      .forEach(segment => {
        const angle = segmentAngle(segment);
        let groupMatch = connectorGroups.find(group => lineAngleDistance(group.angle, angle) <= 12);
        if (!groupMatch) {
          groupMatch = { angle, segments: [], totalLength: 0 };
          connectorGroups.push(groupMatch);
        }
        groupMatch.segments.push(segment);
        groupMatch.totalLength += segment.length;
      });
    // The main pipe must continue past the outlet on both sides.  Prefer that
    // topology over raw accumulated length: long dimension/leader lines can
    // otherwise make the correct hexagon bind OL to its branch-side weld.
    connectorGroups.forEach(group => {
      const radians = group.angle * Math.PI / 180;
      const axis = { x: Math.cos(radians), y: Math.sin(radians) };
      let negativeReach = 0;
      let positiveReach = 0;
      group.segments.forEach(segment => {
        const projections = [segment.start, segment.end].map(point => (
          (point.x - center.x) * axis.x + (point.y - center.y) * axis.y
        ));
        negativeReach = Math.max(negativeReach, Math.max(0, -Math.min(...projections)));
        positiveReach = Math.max(positiveReach, Math.max(0, Math.max(...projections)));
      });
      group.negativeReach = negativeReach;
      group.positiveReach = positiveReach;
      group.oppositeReach = Math.min(negativeReach, positiveReach);
      group.crossesBothSides = negativeReach >= size * 0.45 && positiveReach >= size * 0.45;
      group.nearbyWeldCount = nearbyWelds.filter(weld => (
        group.segments.some(segment => pointSegmentDistance(weld.center, segment) <= tolerance * 2.5)
      )).length;
    });
    connectorGroups.sort((a, b) =>
      Number(b.crossesBothSides) - Number(a.crossesBothSides) ||
      b.nearbyWeldCount - a.nearbyWeldCount ||
      b.oppositeReach - a.oppositeReach ||
      b.totalLength - a.totalLength
    );
    const mainConnectorGroup = connectorGroups[0] || null;
    // An outlet is rooted on a continuing main pipe. One-sided leaders and
    // instrument stems are not sufficient evidence even when QTY is present.
    if (!mainConnectorGroup?.crossesBothSides) return;
    const rankedNearbyWelds = mainConnectorGroup
      ? nearbyWelds
        .map(weld => ({
          weld,
          distance: Math.min(...mainConnectorGroup.segments.map(segment => pointSegmentDistance(weld.center, segment)))
        }))
        .sort((a, b) => a.distance - b.distance)
      : [];
    const mainConnectionWeld = rankedNearbyWelds[0]?.weld || null;
    const branchConnectionWeld = nearbyWelds
      .filter(weld => weld !== mainConnectionWeld)
      .sort((a, b) => distance(a.center, center) - distance(b.center, center))[0] || null;
    const mainConnectionCenterDistance = mainConnectionWeld
      ? distance(mainConnectionWeld.center, center)
      : null;
    const branchConnectionCenterDistance = branchConnectionWeld
      ? distance(branchConnectionWeld.center, center)
      : null;
    candidates.push({
      type: 'tee-fitting',
      branchOutlet: true,
      center,
      score: Math.min(1, 0.72 + Math.min(0.18, connectors.length * 0.04)),
      segmentIndices: short.map(segment => segment.index),
      pathIds: Array.from(new Set(short.map(segment => segment.pathId))),
      segmentLengths: short.map(segment => segment.length),
      connectorCount: connectors.length,
      connectedWeldIds: nearbyWelds.map(weld => weld.id || weld.pathId).filter(Boolean),
      mainConnectionWeldId: mainConnectionWeld?.id || mainConnectionWeld?.pathId || null,
      mainConnectionPoint: mainConnectionWeld?.center ? { ...mainConnectionWeld.center } : null,
      mainConnectionCenterDistance,
      branchConnectionWeldId: branchConnectionWeld?.id || branchConnectionWeld?.pathId || null,
      branchConnectionPoint: branchConnectionWeld?.center ? { ...branchConnectionWeld.center } : null,
      branchConnectionCenterDistance,
      mainConnectorAngle: mainConnectorGroup?.angle ?? null,
      boundingBox: { minX, minY, maxX, maxY, width, height, center }
    });
  });

  // Some PDFs split the six outlet edges across large unrelated drawing
  // paths, so path-local polygon reconstruction cannot see the hexagon.  The
  // physical signature is still strong: two very close welds, one at a
  // two-sided main run and the other continuing along a differently angled
  // branch. Recover only that topology; ordinary nearby weld pairs and inline
  // valve welds do not satisfy it.
  if (Array.isArray(options.welds) && options.welds.length >= 2) {
    const weldsWithCenters = options.welds.filter(weld => weld?.center);
    const minPairDistance = Math.max(8, diagonal * 0.004);
    const maxPairDistance = Math.max(28, diagonal * 0.016);
    const connectionTolerance = Math.max(tolerance * 2.5, diagonal * 0.0018);
    const findThroughGroup = point => {
      const localGroups = [];
      raw
        .filter(segment => segment.length >= minConnector && pointSegmentDistance(point, segment) <= connectionTolerance)
        .forEach(segment => {
          const angle = segmentAngle(segment);
          let match = localGroups.find(group => lineAngleDistance(group.angle, angle) <= 12);
          if (!match) {
            match = { angle, segments: [], totalLength: 0, negativeReach: 0, positiveReach: 0 };
            localGroups.push(match);
          }
          match.segments.push(segment);
          match.totalLength += segment.length;
          const radians = match.angle * Math.PI / 180;
          const axis = { x: Math.cos(radians), y: Math.sin(radians) };
          const projections = [segment.start, segment.end].map(endpoint => (
            (endpoint.x - point.x) * axis.x + (endpoint.y - point.y) * axis.y
          ));
          match.negativeReach = Math.max(match.negativeReach, Math.max(0, -Math.min(...projections)));
          match.positiveReach = Math.max(match.positiveReach, Math.max(0, Math.max(...projections)));
        });
      return localGroups
        .filter(group => group.negativeReach >= minConnector * 0.45 && group.positiveReach >= minConnector * 0.45)
        .sort((left, right) => right.totalLength - left.totalLength)[0] || null;
    };
    const hasAngledBranch = (point, mainAngle) => raw.some(segment => (
      segment.length >= minConnector &&
      pointSegmentDistance(point, segment) <= connectionTolerance &&
      lineAngleDistance(segmentAngle(segment), mainAngle) >= 25
    ));

    for (let leftIndex = 0; leftIndex < weldsWithCenters.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < weldsWithCenters.length; rightIndex += 1) {
        const leftWeld = weldsWithCenters[leftIndex];
        const rightWeld = weldsWithCenters[rightIndex];
        const pairDistance = distance(leftWeld.center, rightWeld.center);
        if (pairDistance < minPairDistance || pairDistance > maxPairDistance) continue;
        const leftMain = findThroughGroup(leftWeld.center);
        const rightMain = findThroughGroup(rightWeld.center);
        let mainWeld = null;
        let branchWeld = null;
        let mainGroup = null;
        if (leftMain && !rightMain && hasAngledBranch(rightWeld.center, leftMain.angle)) {
          mainWeld = leftWeld; branchWeld = rightWeld; mainGroup = leftMain;
        } else if (rightMain && !leftMain && hasAngledBranch(leftWeld.center, rightMain.angle)) {
          mainWeld = rightWeld; branchWeld = leftWeld; mainGroup = rightMain;
        } else {
          continue;
        }
        const center = {
          x: (leftWeld.center.x + rightWeld.center.x) / 2,
          y: (leftWeld.center.y + rightWeld.center.y) / 2
        };
        const extent = pairDistance * 0.7;
        const weldIdentity = weld => weld?.id || weld?.pathId || null;
        candidates.push({
          type: 'tee-fitting',
          branchOutlet: true,
          center,
          score: 0.86,
          segmentIndices: [],
          pathIds: [],
          segmentLengths: [],
          connectorCount: mainGroup.segments.length + 1,
          connectedWeldIds: [weldIdentity(mainWeld), weldIdentity(branchWeld)].filter(Boolean),
          mainConnectionWeldId: weldIdentity(mainWeld),
          mainConnectionPoint: { ...mainWeld.center },
          mainConnectionCenterDistance: pairDistance / 2,
          branchConnectionWeldId: weldIdentity(branchWeld),
          branchConnectionPoint: { ...branchWeld.center },
          branchConnectionCenterDistance: pairDistance / 2,
          mainConnectorAngle: mainGroup.angle,
          recoveredFromWeldPair: true,
          boundingBox: {
            minX: center.x - extent,
            minY: center.y - extent,
            maxX: center.x + extent,
            maxY: center.y + extent,
            width: extent * 2,
            height: extent * 2,
            center
          }
        });
      }
    }
  }

  // PyMuPDF may expose the same drawn hexagon through two almost-identical
  // paths. Collapse those before material QTY ranking so a duplicate cannot
  // hide a real outlet elsewhere on the page.
  const uniqueCandidates = [];
  candidates
    .slice()
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0))
    .forEach(candidate => {
      const duplicate = uniqueCandidates.some(existing => {
        const sameWeldPair = candidate.mainConnectionWeldId && existing.mainConnectionWeldId &&
          candidate.mainConnectionWeldId === existing.mainConnectionWeldId &&
          (candidate.branchConnectionWeldId || '') === (existing.branchConnectionWeldId || '');
        const localSize = Math.min(
          Number(candidate.boundingBox?.width || candidate.boundingBox?.height || 0),
          Number(existing.boundingBox?.width || existing.boundingBox?.height || 0)
        );
        const nearSameCenter = distance(candidate.center, existing.center) <=
          Math.max(tolerance * 2.5, localSize * 0.3);
        return sameWeldPair || nearSameCenter;
      });
      if (!duplicate) uniqueCandidates.push(candidate);
    });
  return uniqueCandidates;
}
