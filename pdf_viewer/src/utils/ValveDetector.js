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
    pathId: pathId ?? `path-${index}`,
    color,
    width,
    start,
    end,
    length,
    angle: Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI
  };
}

function getBounds(segments) {
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
    },
    diagonal: Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2)
  };
}

function isClosedPath(segments, tolerance) {
  if (segments.length < 4) return false;
  const endpoints = [];
  segments.forEach(segment => {
    endpoints.push(segment.start, segment.end);
  });

  return endpoints.every((point, index) => {
    const matches = endpoints.filter((other, otherIndex) => otherIndex !== index && distance(point, other) <= tolerance);
    return matches.length > 0;
  });
}

function lineAngleDistance(a, b) {
  const diff = Math.abs(a - b) % 180;
  return Math.min(diff, 180 - diff);
}

function hasLongDiagonalStroke(segments, bounds) {
  const maxLen = Math.max(...segments.map(segment => segment.length));
  const candidate = segments.find(segment => segment.length === maxLen);
  if (!candidate) return false;

  const normalizedAngle = Math.abs(((candidate.angle % 180) + 180) % 180);
  const isDiagonal = Math.min(
    Math.abs(normalizedAngle - 45),
    Math.abs(normalizedAngle - 135)
  ) <= 28;
  const spansBox = candidate.length >= bounds.diagonal * 0.72;
  const notAxisAligned = lineAngleDistance(normalizedAngle, 0) > 18 && lineAngleDistance(normalizedAngle, 90) > 18;
  return isDiagonal && spansBox && notAxisAligned;
}

function candidateKey(candidate) {
  const x = Math.round(candidate.center.x * 2) / 2;
  const y = Math.round(candidate.center.y * 2) / 2;
  return `${x}:${y}:${candidate.pathIds.join('-')}`;
}

export function detectValveCandidates(vectors, options = {}) {
  if (!Array.isArray(vectors) || vectors.length === 0) return [];

  const segments = vectors.map(normalizeVectorElement).filter(Boolean);
  if (segments.length < 4) return [];

  const pageBounds = getBounds(segments);
  const pageDiagonal = pageBounds.diagonal || 1000;
  const minSize = options.minSize ?? Math.max(3, pageDiagonal * 0.0015);
  const maxSize = options.maxSize ?? Math.max(16, pageDiagonal * 0.016);
  const closeTolerance = options.closeTolerance ?? Math.max(0.8, pageDiagonal * 0.0008);

  const byPath = new Map();
  segments.forEach(segment => {
    if (!byPath.has(segment.pathId)) byPath.set(segment.pathId, []);
    byPath.get(segment.pathId).push(segment);
  });

  const candidates = [];
  byPath.forEach((pathSegments, pathId) => {
    if (pathSegments.length < 4 || pathSegments.length > 7) return;
    if (!pathSegments.every(segment => segment.length > 0.4 && segment.length <= maxSize * 1.6)) return;

    const bounds = getBounds(pathSegments);
    const width = bounds.width;
    const height = bounds.height;
    const major = Math.max(width, height);
    const minor = Math.max(0.1, Math.min(width, height));
    if (major < minSize || major > maxSize) return;
    if (minor < minSize * 0.55) return;
    if (major / minor > 4.2) return;
    if (!isClosedPath(pathSegments, closeTolerance)) return;
    if (!hasLongDiagonalStroke(pathSegments, bounds)) return;

    const lengths = pathSegments.map(segment => segment.length);
    const maxLen = Math.max(...lengths);
    const minLen = Math.min(...lengths);
    if (maxLen / Math.max(0.1, minLen) < 2.0) return;

    candidates.push({
      type: 'valve-fitting',
      center: bounds.center,
      score: Math.min(1, 0.72 + Math.min(0.18, pathSegments.length * 0.025)),
      segmentIndices: pathSegments.map(segment => segment.index),
      pathIds: [pathId],
      segmentLengths: lengths,
      boundingBox: bounds,
      valveShape: {
        closed: true,
        segmentCount: pathSegments.length,
        hasLongDiagonal: true
      }
    });
  });

  const unique = new Map();
  candidates
    .sort((a, b) => b.score - a.score)
    .forEach(candidate => {
      const key = candidateKey(candidate);
      if (!unique.has(key)) unique.set(key, candidate);
    });

  return Array.from(unique.values()).sort((a, b) => b.score - a.score);
}
