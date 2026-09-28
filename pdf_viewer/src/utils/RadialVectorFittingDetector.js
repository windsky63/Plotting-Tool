const distance = (left, right) => Math.hypot(left.x - right.x, left.y - right.y);

const normalizeSegment = (vector, index) => {
  if (!Array.isArray(vector) || vector.length < 5) return null;
  const [, x1, y1, x2, y2, color, width, pathId] = vector;
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  const start = { x: x1, y: y1 };
  const end = { x: x2, y: y2 };
  const length = distance(start, end);
  if (!length) return null;
  return { index, pathId, color, width, start, end, length };
};

const angleDifference = (left, right) => {
  const diff = Math.abs(left - right) % 360;
  return Math.min(diff, 360 - diff);
};

const getWeldPoint = weld => {
  const point = weld?.center || weld?.weldData?.center;
  if (!Number.isFinite(Number(point?.x)) || !Number.isFinite(Number(point?.y))) return null;
  return { x: Number(point.x), y: Number(point.y) };
};

const getBounds = segments => {
  if (!segments.length) return { diagonal: 1000 };
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
  return { minX, minY, maxX, maxY, diagonal: Math.hypot(maxX - minX, maxY - minY) || 1000 };
};

const buildEndpointNodes = (segments, tolerance) => {
  const nodes = [];
  const buckets = new Map();
  const cellSize = Math.max(0.1, tolerance);
  const bucketKey = (x, y) => `${x}:${y}`;
  const addEndpoint = (point, segment, endpoint) => {
    const cellX = Math.floor(point.x / cellSize);
    const cellY = Math.floor(point.y / cellSize);
    let node = null;
    for (let dx = -1; dx <= 1 && !node; dx += 1) {
      for (let dy = -1; dy <= 1 && !node; dy += 1) {
        const nearby = buckets.get(bucketKey(cellX + dx, cellY + dy)) || [];
        node = nearby.find(item => distance(item.center, point) <= tolerance) || null;
      }
    }
    if (!node) {
      node = { center: { ...point }, samples: [], incidents: [] };
      nodes.push(node);
      const key = bucketKey(cellX, cellY);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(node);
    }
    node.samples.push(point);
    node.incidents.push({ segment, endpoint });
    node.center = {
      x: node.samples.reduce((sum, item) => sum + item.x, 0) / node.samples.length,
      y: node.samples.reduce((sum, item) => sum + item.y, 0) / node.samples.length
    };
  };
  segments.forEach(segment => {
    addEndpoint(segment.start, segment, 'start');
    addEndpoint(segment.end, segment, 'end');
  });
  return nodes;
};

const getDirectionArms = (node, angleTolerance = 10) => {
  const groups = [];
  node.incidents.forEach(({ segment, endpoint }) => {
    const outer = endpoint === 'start' ? segment.end : segment.start;
    const dx = outer.x - node.center.x;
    const dy = outer.y - node.center.y;
    const length = Math.hypot(dx, dy);
    if (!length) return;
    const angle = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
    let group = groups.find(item => angleDifference(item.angle, angle) <= angleTolerance);
    const arm = { segment, outer, length, angle, unit: { x: dx / length, y: dy / length } };
    if (!group) {
      group = { angle, arms: [] };
      groups.push(group);
    }
    group.arms.push(arm);
    if (arm.length > (group.longest?.length || 0)) {
      group.longest = arm;
      group.angle = angle;
    }
  });
  return groups;
};

const classifyDirections = groups => {
  if (groups.length === 2) {
    const angle = angleDifference(groups[0].angle, groups[1].angle);
    if (angle >= 25 && angle <= 155) return { type: 'elbow', expectedCount: 2, angle };
    return null;
  }
  if (groups.length === 3) {
    const pairs = [];
    for (let left = 0; left < groups.length; left += 1) {
      for (let right = left + 1; right < groups.length; right += 1) {
        pairs.push(angleDifference(groups[left].angle, groups[right].angle));
      }
    }
    if (Math.max(...pairs) >= 145 && Math.min(...pairs) >= 25) {
      return { type: 'tee-fitting', expectedCount: 3, angle: null };
    }
  }
  return null;
};

const findMatchedWeld = (point, weldPoints, tolerance) => {
  let best = null;
  let bestDistance = Infinity;
  weldPoints.forEach(item => {
    const currentDistance = distance(point, item.point);
    if (currentDistance < bestDistance) {
      best = item;
      bestDistance = currentDistance;
    }
  });
  return bestDistance <= tolerance ? { ...best, distance: bestDistance } : null;
};

const evaluateRadius = ({ node, groups, radius, weldPoints, matchTolerance }) => {
  const intersections = [];
  for (const group of groups) {
    const arm = group.longest;
    if (!arm || arm.length + matchTolerance < radius) return null;
    const point = {
      x: node.center.x + arm.unit.x * radius,
      y: node.center.y + arm.unit.y * radius
    };
    intersections.push({ point, arm, matchedWeld: findMatchedWeld(point, weldPoints, matchTolerance) });
  }
  const matchedCount = intersections.filter(item => item.matchedWeld).length;
  if (matchedCount < 1) return null;
  const error = intersections.reduce((sum, item) => sum + Number(item.matchedWeld?.distance || matchTolerance), 0);
  return { radius, intersections, matchedCount, error };
};

export const detectRadialVectorFittingCandidates = (vectors = [], welds = [], pageInfo = null) => {
  const segments = vectors.map(normalizeSegment).filter(Boolean);
  const bounds = getBounds(segments);
  const diagonal = Math.hypot(
    Number(pageInfo?.page_width || pageInfo?.width || 0),
    Number(pageInfo?.page_height || pageInfo?.height || 0)
  ) || bounds.diagonal;
  const nodeTolerance = Math.max(1.2, Math.min(6, diagonal * 0.0015));
  const matchTolerance = Math.max(3, Math.min(12, diagonal * 0.003));
  const minRadius = Math.max(4, diagonal * 0.0015);
  const maxRadius = Math.max(18, Math.min(80, diagonal * 0.04));
  const weldPoints = welds.map(weld => ({ weld, point: getWeldPoint(weld) })).filter(item => item.point);
  if (!segments.length || !weldPoints.length) return [];

  const candidates = [];
  buildEndpointNodes(segments, nodeTolerance).forEach((node, nodeIndex) => {
    const groups = getDirectionArms(node);
    const topology = classifyDirections(groups);
    if (!topology) return;
    const nearbyRadii = weldPoints
      .map(item => ({ ...item, radius: distance(node.center, item.point) }))
      .filter(item => item.radius >= minRadius && item.radius <= maxRadius)
      .sort((left, right) => left.radius - right.radius)
      .slice(0, 8);
    let best = null;
    nearbyRadii.forEach(item => {
      const evaluated = evaluateRadius({
        node,
        groups,
        radius: item.radius,
        weldPoints,
        matchTolerance
      });
      if (!evaluated) return;
      if (!best || evaluated.matchedCount > best.matchedCount || (
        evaluated.matchedCount === best.matchedCount && evaluated.error < best.error
      )) best = evaluated;
    });
    if (!best) return;

    const connectionPoints = best.intersections.map(item => item.point);
    const xs = connectionPoints.map(point => point.x).concat(node.center.x);
    const ys = connectionPoints.map(point => point.y).concat(node.center.y);
    const nominalAngle = topology.type === 'elbow'
      ? (Math.abs(topology.angle - 45) <= 15 ? 45 : Math.abs(topology.angle - 90) <= 25 ? 90 : null)
      : null;
    candidates.push({
      type: topology.type === 'elbow' ? 'radial-vector-elbow' : 'tee-fitting',
      center: { ...node.center },
      score: Math.min(0.98, 0.58 + best.matchedCount / topology.expectedCount * 0.4),
      confidence: best.matchedCount === topology.expectedCount ? 'high' : 'medium',
      nominalAngle,
      elbowAngle: nominalAngle,
      connectionPoints,
      radialReferenceRadius: best.radius,
      radialIntersectionCount: connectionPoints.length,
      radialMatchedWeldCount: best.matchedCount,
      radialMatchedWeldIds: best.intersections
        .map(item => item.matchedWeld?.weld?.id || item.matchedWeld?.weld?.pathId)
        .filter(value => value !== undefined && value !== null),
      radialVectorInferred: true,
      connectorCount: groups.length,
      segmentIndices: groups.map(group => group.longest.segment.index),
      pathIds: Array.from(new Set(groups.map(group => group.longest.segment.pathId))),
      boundingBox: {
        minX: Math.min(...xs), minY: Math.min(...ys),
        maxX: Math.max(...xs), maxY: Math.max(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys)
      },
      radialNodeIndex: nodeIndex
    });
  });
  return candidates;
};

export const mergeRadialVectorFittingCandidates = (existing = [], radial = [], pageInfo = null) => {
  const diagonal = Math.hypot(
    Number(pageInfo?.page_width || pageInfo?.width || 0),
    Number(pageInfo?.page_height || pageInfo?.height || 0)
  ) || 1000;
  const mergeDistance = Math.max(5, Math.min(24, diagonal * 0.006));
  const result = existing.map(item => ({ ...item }));
  const family = item => item?.type === 'tee-fitting' ? 'tee' : 'elbow';
  radial.forEach(candidate => {
    const matchIndex = result.findIndex(item => (
      !item.branchOutlet && family(item) === family(candidate) && distance(item.center, candidate.center) <= mergeDistance
    ));
    if (matchIndex < 0) {
      result.push(candidate);
      return;
    }
    result[matchIndex] = {
      ...result[matchIndex],
      radialVectorInferred: true,
      radialReferenceRadius: candidate.radialReferenceRadius,
      radialIntersectionCount: candidate.radialIntersectionCount,
      radialMatchedWeldCount: candidate.radialMatchedWeldCount,
      radialMatchedWeldIds: candidate.radialMatchedWeldIds,
      connectionPoints: candidate.connectionPoints,
      score: Math.max(Number(result[matchIndex].score || 0), Number(candidate.score || 0))
    };
  });
  return result;
};
