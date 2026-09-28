const getWeldPoint = weld => {
  if (Number.isFinite(Number(weld?.center?.x)) && Number.isFinite(Number(weld?.center?.y))) {
    return { x: Number(weld.center.x), y: Number(weld.center.y) };
  }
  if (weld?.boundingBox) {
    const minX = Number(weld.boundingBox.minX) || 0;
    const minY = Number(weld.boundingBox.minY) || 0;
    const width = Number(weld.boundingBox.width) || 0;
    const height = Number(weld.boundingBox.height) || 0;
    return { x: minX + width / 2, y: minY + height / 2 };
  }
  return { x: Number(weld?.x) || 0, y: Number(weld?.y) || 0 };
};

const distance = (left, right) => Math.hypot(left.x - right.x, left.y - right.y);

const median = values => {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

const resolvePageDiagonal = (entries, pageInfo = {}) => {
  const width = Number(pageInfo.page_width || pageInfo.width);
  const height = Number(pageInfo.page_height || pageInfo.height);
  if (width > 0 && height > 0) return Math.hypot(width, height);
  const xs = entries.map(entry => entry.point.x);
  const ys = entries.map(entry => entry.point.y);
  return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
};

const getNearestGaps = entries => entries.map((entry, index) => {
  let nearest = Infinity;
  entries.forEach((candidate, candidateIndex) => {
    if (candidateIndex === index) return;
    nearest = Math.min(nearest, distance(entry.point, candidate.point));
  });
  return nearest;
}).filter(Number.isFinite);

/**
 * Builds a page-local numbering order where every next weld is the closest
 * remaining one. Therefore a long jump happens only when no nearer weld is
 * left, and is reported as a spatial break instead of silently losing points.
 */
export const buildSpatiallyContinuousWeldSequence = (welds, { pageInfo = {}, maxDistance } = {}) => {
  const entries = (Array.isArray(welds) ? welds : []).map((weld, originalIndex) => ({
    weld,
    originalIndex,
    point: getWeldPoint(weld)
  }));
  if (entries.length <= 1) {
    return { welds: entries.map(entry => entry.weld), maxDistance: 0, breaks: [] };
  }

  const pageDiagonal = resolvePageDiagonal(entries, pageInfo);
  const typicalGap = median(getNearestGaps(entries));
  const lowerBound = pageDiagonal > 0 ? pageDiagonal * 0.04 : typicalGap;
  const upperBound = pageDiagonal > 0 ? pageDiagonal * 0.2 : typicalGap * 5;
  const adaptiveMaxDistance = Number.isFinite(Number(maxDistance)) && Number(maxDistance) > 0
    ? Number(maxDistance)
    : Math.max(lowerBound, Math.min(typicalGap * 4, upperBound || typicalGap * 4));

  const compareStart = (left, right) => {
    const scoreDiff = (left.point.x + left.point.y) - (right.point.x + right.point.y);
    if (Math.abs(scoreDiff) > 1e-6) return scoreDiff;
    if (left.point.y !== right.point.y) return left.point.y - right.point.y;
    if (left.point.x !== right.point.x) return left.point.x - right.point.x;
    return left.originalIndex - right.originalIndex;
  };

  let current = [...entries].sort(compareStart)[0];
  const remaining = entries.filter(entry => entry !== current);
  const ordered = [current.weld];
  const breaks = [];

  while (remaining.length > 0) {
    let nearestIndex = 0;
    let nearestDistance = distance(current.point, remaining[0].point);
    for (let index = 1; index < remaining.length; index += 1) {
      const candidateDistance = distance(current.point, remaining[index].point);
      if (
        candidateDistance < nearestDistance - 1e-6 ||
        (Math.abs(candidateDistance - nearestDistance) <= 1e-6 &&
          remaining[index].originalIndex < remaining[nearestIndex].originalIndex)
      ) {
        nearestIndex = index;
        nearestDistance = candidateDistance;
      }
    }

    current = remaining.splice(nearestIndex, 1)[0];
    if (adaptiveMaxDistance > 0 && nearestDistance > adaptiveMaxDistance) {
      breaks.push({
        beforeIndex: ordered.length,
        distance: nearestDistance,
        maxDistance: adaptiveMaxDistance,
        weldId: current.weld?.id ?? current.weld?.pathId ?? current.originalIndex
      });
    }
    ordered.push(current.weld);
  }

  return {
    welds: ordered,
    maxDistance: adaptiveMaxDistance,
    typicalGap,
    pageDiagonal,
    breaks
  };
};

