import { sortWelds, SortStrategy } from './WeldSmartSorter';

export const PDF_LAYOUT_BASE_SCALE = 2.0;

const BASE_DIAGONAL_LENGTH = 56.7;
const CIRCLE_RADIUS = BASE_DIAGONAL_LENGTH / 2;
const FIXED_LINE_LENGTHS = [140, 180, 220, 270, 330, 400];
const PERIMETER_LINE_LENGTHS = [120, 150, 180, 220, 270, 330, 400, 500, 620];
const TRACK_GRID_SIZE = 28;
const TRACK_SNAP_LIMIT = 56;
const MAX_REOPTIMIZE_ITERATIONS = 3;
const REOPTIMIZE_FRACTION = 0.2;
// Labels may sit close together as long as their frames do not overlap.
const HARD_LABEL_MIN_GAP = 2;
const HARD_LEADER_LABEL_MIN_GAP = 8;
const HARD_LEADER_LEADER_MIN_GAP = 18;
const GRAPHIC_INDEX_CELL_SIZE = 96;
const LONG_PIPE_MIN_WELDS = 4;
const LONG_PIPE_ANGLE_TOLERANCE = Math.PI / 24;

const CANONICAL_DIRECTIONS = [
  { id: 'right', angle: 0, family: 'horizontal', signX: 1, signY: 0 },
  { id: 'down-right', angle: Math.PI / 4, family: 'diagonal', signX: 1, signY: 1 },
  { id: 'down', angle: Math.PI / 2, family: 'vertical', signX: 0, signY: 1 },
  { id: 'down-left', angle: (3 * Math.PI) / 4, family: 'diagonal', signX: -1, signY: 1 },
  { id: 'left', angle: Math.PI, family: 'horizontal', signX: -1, signY: 0 },
  { id: 'up-left', angle: (-3 * Math.PI) / 4, family: 'diagonal', signX: -1, signY: -1 },
  { id: 'up', angle: -Math.PI / 2, family: 'vertical', signX: 0, signY: -1 },
  { id: 'up-right', angle: -Math.PI / 4, family: 'diagonal', signX: 1, signY: -1 }
];

const roundTrackValue = (value) => Number(value.toFixed(1));

const normalizeAngle = (angle) => {
  let normalized = angle;
  while (normalized > Math.PI) normalized -= Math.PI * 2;
  while (normalized <= -Math.PI) normalized += Math.PI * 2;
  return normalized;
};

const quantizeToGrid = (value, grid = TRACK_GRID_SIZE) => Math.round(value / grid) * grid;

const dedupeByKey = (items, getKey) => {
  const seen = new Set();
  return items.filter((item) => {
    const key = getKey(item);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

const getLayoutSegmentId = (weld) => weld?.__layoutSegmentId ?? null;

const getWeldCenter = (weld) => {
  if (weld?.center) {
    return weld.center;
  }

  if (weld?.boundingBox) {
    const { minX, minY, maxX, maxY, width = 0, height = 0 } = weld.boundingBox;
    const resolvedWidth = typeof maxX === 'number' && typeof minX === 'number' ? maxX - minX : width;
    const resolvedHeight = typeof maxY === 'number' && typeof minY === 'number' ? maxY - minY : height;

    return {
      x: (minX ?? 0) + resolvedWidth / 2,
      y: (minY ?? 0) + resolvedHeight / 2
    };
  }

  return { x: 0, y: 0 };
};

const getWeldDisplayNumber = (weld, index) => {
  if (weld?.isNumberless === true) return '';
  const value = weld?.number ?? weld?.weldNumber;
  return value === undefined || value === null || value === ''
    ? (index + 1)
    : value;
};

const getDistancePointToSegment = (px, py, x1, y1, x2, y2) => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
  }

  let t = ((px - x1) * dx + (py - y1) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));

  const projectionX = x1 + t * dx;
  const projectionY = y1 + t * dy;

  return Math.sqrt((px - projectionX) ** 2 + (py - projectionY) ** 2);
};

const doSegmentsIntersect = (ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) => {
  const dax = ax2 - ax1;
  const day = ay2 - ay1;
  const dbx = bx2 - bx1;
  const dby = by2 - by1;
  const cross = dax * dby - day * dbx;

  if (Math.abs(cross) < 1e-10) {
    return false;
  }

  const t = ((bx1 - ax1) * dby - (by1 - ay1) * dbx) / cross;
  const u = ((bx1 - ax1) * day - (by1 - ay1) * dax) / cross;

  return t > 0.01 && t < 0.99 && u > 0.01 && u < 0.99;
};

const getSegmentToSegmentMinDist = (ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) => {
  return Math.min(
    getDistancePointToSegment(ax1, ay1, bx1, by1, bx2, by2),
    getDistancePointToSegment(ax2, ay2, bx1, by1, bx2, by2),
    getDistancePointToSegment(bx1, by1, ax1, ay1, ax2, ay2),
    getDistancePointToSegment(bx2, by2, ax1, ay1, ax2, ay2)
  );
};

const trimLeaderStart = (x1, y1, x2, y2, trimDistance = 20) => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  if (length <= trimDistance || length === 0) {
    return { x1, y1, x2, y2 };
  }
  const ratio = trimDistance / length;
  return {
    x1: x1 + dx * ratio,
    y1: y1 + dy * ratio,
    x2,
    y2
  };
};

const getConnectionPoint = (startX, startY, endX, endY, circleRadius = CIRCLE_RADIUS) => {
  const dx = endX - startX;
  const dy = endY - startY;
  const length = Math.sqrt(dx * dx + dy * dy);

  if (length === 0) {
    return { connectionX: endX, connectionY: endY };
  }

  return {
    connectionX: endX - (dx / length) * circleRadius,
    connectionY: endY - (dy / length) * circleRadius
  };
};

const getLabelBounds = (centerX, centerY, padding = 0, circleRadius = CIRCLE_RADIUS) => ({
  minX: centerX - circleRadius - padding,
  minY: centerY - circleRadius - padding,
  maxX: centerX + circleRadius + padding,
  maxY: centerY + circleRadius + padding
});

const isPointInsideRect = (x, y, rect) => (
  x > rect.minX && x < rect.maxX && y > rect.minY && y < rect.maxY
);

const doRectsOverlap = (rectA, rectB) => (
  rectA.minX < rectB.maxX &&
  rectA.maxX > rectB.minX &&
  rectA.minY < rectB.maxY &&
  rectA.maxY > rectB.minY
);

const getRectEdges = (rect) => ([
  [rect.minX, rect.minY, rect.maxX, rect.minY],
  [rect.maxX, rect.minY, rect.maxX, rect.maxY],
  [rect.maxX, rect.maxY, rect.minX, rect.maxY],
  [rect.minX, rect.maxY, rect.minX, rect.minY]
]);

const doesSegmentIntersectRect = (x1, y1, x2, y2, rect) => {
  if (isPointInsideRect(x1, y1, rect) || isPointInsideRect(x2, y2, rect)) {
    return true;
  }

  return getRectEdges(rect).some(([rx1, ry1, rx2, ry2]) => (
    doSegmentsIntersect(x1, y1, x2, y2, rx1, ry1, rx2, ry2)
  ));
};

const getSegmentToRectMinDist = (x1, y1, x2, y2, rect) => {
  if (doesSegmentIntersectRect(x1, y1, x2, y2, rect)) {
    return 0;
  }

  return Math.min(
    getDistancePointToSegment(rect.minX, rect.minY, x1, y1, x2, y2),
    getDistancePointToSegment(rect.maxX, rect.minY, x1, y1, x2, y2),
    getDistancePointToSegment(rect.maxX, rect.maxY, x1, y1, x2, y2),
    getDistancePointToSegment(rect.minX, rect.maxY, x1, y1, x2, y2),
    ...getRectEdges(rect).map(([rx1, ry1, rx2, ry2]) => (
      getSegmentToSegmentMinDist(x1, y1, x2, y2, rx1, ry1, rx2, ry2)
    ))
  );
};

const classifyAngleFamily = (angle) => {
  const normalized = normalizeAngle(angle);
  const absCos = Math.abs(Math.cos(normalized));
  const absSin = Math.abs(Math.sin(normalized));

  if (absCos > 0.999) {
    return 'horizontal';
  }

  if (absSin > 0.999) {
    return 'vertical';
  }

  return 'diagonal';
};

const collectPipelineSegments = (sortedWelds, pipelines, scale) => {
  const pipelineMap = new Map();

  (pipelines || []).forEach((pipeline) => {
    if (pipeline?.pathId !== undefined) {
      pipelineMap.set(String(pipeline.pathId), pipeline);
    }
  });

  sortedWelds.forEach((weld) => {
    if (weld?.relatedPipeline?.pathId !== undefined) {
      pipelineMap.set(String(weld.relatedPipeline.pathId), weld.relatedPipeline);
    }
  });

  const segments = [];
  pipelineMap.forEach((pipeline) => {
    (pipeline?.segments || []).forEach((segment) => {
      const p1 = segment.p1 || segment.start || { x: segment.x1, y: segment.y1 };
      const p2 = segment.p2 || segment.end || { x: segment.x2, y: segment.y2 };

      if (
        typeof p1?.x === 'number' &&
        typeof p1?.y === 'number' &&
        typeof p2?.x === 'number' &&
        typeof p2?.y === 'number'
      ) {
        segments.push({
          x1: p1.x * scale,
          y1: p1.y * scale,
          x2: p2.x * scale,
          y2: p2.y * scale
        });
      }
    });
  });

  return segments;
};

const inferPageBounds = (sortedWelds, allPipelineSegments, allTextRegions) => {
  const xValues = [];
  const yValues = [];

  sortedWelds.forEach((weld) => {
    const center = getWeldCenter(weld);
    xValues.push(center.x);
    yValues.push(center.y);
  });

  allPipelineSegments.forEach((segment) => {
    xValues.push(segment.x1, segment.x2);
    yValues.push(segment.y1, segment.y2);
  });

  allTextRegions.forEach((region) => {
    xValues.push(region.minX, region.maxX);
    yValues.push(region.minY, region.maxY);
  });

  if (xValues.length === 0 || yValues.length === 0) {
    return {
      minX: 0,
      minY: 0,
      maxX: 1200,
      maxY: 900,
      centerX: 600,
      centerY: 450
    };
  }

  const minX = Math.min(0, ...xValues);
  const minY = Math.min(0, ...yValues);
  const maxX = Math.max(...xValues) + 420;
  const maxY = Math.max(...yValues) + 420;

  return {
    minX,
    minY,
    maxX,
    maxY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2
  };
};

const getRelatedSegmentAngle = (weld) => {
  if (Number.isFinite(weld?.relatedSegmentAngle)) {
    return weld.relatedSegmentAngle;
  }

  const segment = weld?.relatedSegment?.segment || weld?.relatedSegment;
  if (!segment) {
    return null;
  }

  const p1 = segment.p1 || segment.start || { x: segment.x1, y: segment.y1 };
  const p2 = segment.p2 || segment.end || { x: segment.x2, y: segment.y2 };

  if (
    typeof p1?.x !== 'number' ||
    typeof p1?.y !== 'number' ||
    typeof p2?.x !== 'number' ||
    typeof p2?.y !== 'number'
  ) {
    return null;
  }

  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  if (dx === 0 && dy === 0) {
    return null;
  }

  return Math.atan2(dy, dx);
};

const normalizeAxisAngle = (angle) => {
  let normalized = normalizeAngle(angle);
  if (normalized < -Math.PI / 2) normalized += Math.PI;
  if (normalized >= Math.PI / 2) normalized -= Math.PI;
  return normalized;
};

const getAxisAngleDifference = (angleA, angleB) => {
  const difference = Math.abs(normalizeAngle(angleA - angleB));
  return Math.min(difference, Math.abs(Math.PI - difference));
};

const getLongPipeRelationKey = (weld) => {
  const relationId = (
    weld?.relatedPipelineId ??
    weld?.relatedPipeline?.pathId ??
    weld?.relatedSegmentId ??
    weld?.relatedSegment?.pathId
  );
  return relationId === undefined || relationId === null || relationId === ''
    ? ''
    : String(relationId);
};

const getRayDistanceToBounds = (x, y, dx, dy, bounds) => {
  if (!bounds) return 0;
  const distances = [];
  if (dx > 1e-6) distances.push((bounds.maxX - x) / dx);
  if (dx < -1e-6) distances.push((bounds.minX - x) / dx);
  if (dy > 1e-6) distances.push((bounds.maxY - y) / dy);
  if (dy < -1e-6) distances.push((bounds.minY - y) / dy);
  const positiveDistances = distances.filter(distance => distance >= 0 && Number.isFinite(distance));
  return positiveDistances.length > 0 ? Math.min(...positiveDistances) : 0;
};

const buildLongPipeGroupMap = (sortedWelds, scale, pageBounds, circleRadius) => {
  const candidates = (sortedWelds || []).map((weld, index) => {
    const angle = getRelatedSegmentAngle(weld);
    const relationKey = getLongPipeRelationKey(weld);
    if (!relationKey || !Number.isFinite(angle)) return null;
    const center = getWeldCenter(weld);
    return {
      weld,
      index,
      relationKey,
      x: center.x * scale,
      y: center.y * scale,
      axisAngle: normalizeAxisAngle(angle)
    };
  }).filter(Boolean);

  const clusters = [];
  candidates.forEach((candidate) => {
    const matchingCluster = clusters.find((cluster) => {
      if (getAxisAngleDifference(cluster.axisAngle, candidate.axisAngle) > LONG_PIPE_ANGLE_TOLERANCE) {
        return false;
      }
      const normalX = -Math.sin(cluster.axisAngle);
      const normalY = Math.cos(cluster.axisAngle);
      const offset = Math.abs(
        (candidate.x - cluster.anchorX) * normalX +
        (candidate.y - cluster.anchorY) * normalY
      );
      const maximumOffset = cluster.relationKey === candidate.relationKey
        ? Math.max(48, circleRadius * 1.8)
        : Math.max(18, circleRadius * 0.75);
      return offset <= maximumOffset;
    });

    if (matchingCluster) {
      matchingCluster.items.push(candidate);
      return;
    }

    clusters.push({
      relationKey: candidate.relationKey,
      axisAngle: candidate.axisAngle,
      anchorX: candidate.x,
      anchorY: candidate.y,
      items: [candidate]
    });
  });

  const groupMap = new Map();
  let groupIndex = 0;
  clusters.forEach((cluster) => {
    if (cluster.items.length < LONG_PIPE_MIN_WELDS) return;
    const tangentX = Math.cos(cluster.axisAngle);
    const tangentY = Math.sin(cluster.axisAngle);
    const normalX = -tangentY;
    const normalY = tangentX;
    const ordered = cluster.items
      .map(item => ({
        ...item,
        projection: item.x * tangentX + item.y * tangentY
      }))
      .sort((a, b) => a.projection - b.projection);
    const tangentSpan = ordered[ordered.length - 1].projection - ordered[0].projection;
    if (tangentSpan < Math.max(160, circleRadius * 4)) return;

    const groupCenter = ordered.reduce((result, item) => ({
      x: result.x + item.x / ordered.length,
      y: result.y + item.y / ordered.length
    }), { x: 0, y: 0 });
    const positiveSpace = getRayDistanceToBounds(
      groupCenter.x,
      groupCenter.y,
      normalX,
      normalY,
      pageBounds
    );
    const negativeSpace = getRayDistanceToBounds(
      groupCenter.x,
      groupCenter.y,
      -normalX,
      -normalY,
      pageBounds
    );
    const preferredSide = positiveSpace >= negativeSpace ? 1 : -1;
    const minimumTangentGap = circleRadius * 2 + 2;
    const laneEnds = [];
    const groupId = `long-pipe-${groupIndex + 1}`;

    ordered.forEach((item, orderedIndex) => {
      let lane = laneEnds.findIndex(endProjection => (
        item.projection - endProjection >= minimumTangentGap
      ));
      if (lane < 0 && laneEnds.length < 2) {
        lane = laneEnds.length;
        laneEnds.push(Number.NEGATIVE_INFINITY);
      }
      if (lane < 0) {
        lane = laneEnds[0] <= laneEnds[1] ? 0 : 1;
      }
      const requiredProjection = Math.max(item.projection, laneEnds[lane] + minimumTangentGap);
      const tangentShift = Number.isFinite(requiredProjection - item.projection)
        ? requiredProjection - item.projection
        : 0;
      laneEnds[lane] = requiredProjection;

      groupMap.set(item.weld, {
        groupId,
        relationKey: cluster.relationKey,
        axisAngle: cluster.axisAngle,
        tangentX,
        tangentY,
        normalX,
        normalY,
        preferredSide,
        lane,
        laneCount: 2,
        orderedIndex,
        groupSize: ordered.length,
        tangentShift
      });
    });
    groupIndex += 1;
  });

  return groupMap;
};

const buildStrictNormalDirections = (segmentAngle) => {
  const positiveNormal = normalizeAngle(segmentAngle + Math.PI / 2);
  const negativeNormal = normalizeAngle(segmentAngle - Math.PI / 2);

  return [positiveNormal, negativeNormal].map((angle, index) => ({
    id: `segment-normal-${index}`,
    angle,
    family: classifyAngleFamily(angle),
    signX: Math.cos(angle),
    signY: Math.sin(angle),
    source: 'segment-normal',
    lockDirection: true
  }));
};

const buildPreferredDirections = (startX, startY, pageBounds) => {
  const horizontalPrimary = startX < pageBounds.centerX ? 'left' : 'right';
  const verticalPrimary = startY < pageBounds.centerY ? 'up' : 'down';
  const horizontalSecondary = horizontalPrimary === 'left' ? 'right' : 'left';
  const verticalSecondary = verticalPrimary === 'up' ? 'down' : 'up';
  const primaryDiagonal = `${verticalPrimary}-${horizontalPrimary}`;
  const secondaryDiagonal = `${verticalPrimary}-${horizontalSecondary}`;
  const tertiaryDiagonal = `${verticalSecondary}-${horizontalPrimary}`;

  const priorities = [];

  priorities.push(
    horizontalPrimary,
    verticalPrimary,
    horizontalSecondary,
    verticalSecondary,
    primaryDiagonal,
    secondaryDiagonal,
    tertiaryDiagonal
  );

  return dedupeByKey(
    priorities
      .map((directionId) => CANONICAL_DIRECTIONS.find((direction) => direction.id === directionId))
      .filter(Boolean),
    (direction) => direction.id
  );
};

const buildRadialDirection = (startX, startY, focusBounds) => {
  if (!focusBounds) {
    return null;
  }

  const dx = startX - focusBounds.centerX;
  const dy = startY - focusBounds.centerY;
  if (Math.sqrt(dx * dx + dy * dy) < 8) {
    return null;
  }

  const angle = Math.atan2(dy, dx);
  return {
    id: 'weld-cluster-radial',
    angle,
    family: classifyAngleFamily(angle),
    signX: Math.cos(angle),
    signY: Math.sin(angle),
    source: 'weld-cluster-radial',
    lockDirection: true
  };
};

const buildPerimeterSpokeDirections = (startX, startY, focusBounds) => {
  const radialAngle = focusBounds
    ? Math.atan2(startY - focusBounds.centerY, startX - focusBounds.centerX)
    : 0;

  return Array.from({ length: 16 }, (_, index) => {
    const angle = normalizeAngle(index * Math.PI / 8);
    return {
      id: `perimeter-spoke-${index}`,
      angle,
      family: classifyAngleFamily(angle),
      signX: Math.cos(angle),
      signY: Math.sin(angle),
      source: 'perimeter-spoke',
      lockDirection: true,
      radialDifference: Math.abs(normalizeAngle(angle - radialAngle))
    };
  }).sort((a, b) => a.radialDifference - b.radialDifference);
};

const createPageBoundsFromRect = (rect) => ({
  minX: rect.minX,
  minY: rect.minY,
  maxX: rect.maxX,
  maxY: rect.maxY,
  centerX: (rect.minX + rect.maxX) / 2,
  centerY: (rect.minY + rect.maxY) / 2
});

const getWeldFocusBounds = (welds, scale) => {
  const points = (welds || [])
    .map((weld) => getWeldCenter(weld))
    .filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
    .map((point) => ({ x: point.x * scale, y: point.y * scale }));

  if (points.length < 2) {
    return null;
  }

  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  if (maxX - minX < 1 && maxY - minY < 1) {
    return null;
  }

  return createPageBoundsFromRect({ minX, minY, maxX, maxY });
};

const getPageBoundsFromTextRegions = (textRegions, scale) => {
  if (!textRegions) {
    return null;
  }

  const metadata = textRegions.__pageBounds || textRegions.pageBounds || null;
  if (!metadata) {
    return null;
  }

  const maxX = metadata.maxX ?? metadata.width ?? metadata.page_width;
  const maxY = metadata.maxY ?? metadata.height ?? metadata.page_height;

  if (!(maxX > 0) || !(maxY > 0)) {
    return null;
  }

  return createPageBoundsFromRect({
    minX: (metadata.minX || 0) * scale,
    minY: (metadata.minY || 0) * scale,
    maxX: maxX * scale,
    maxY: maxY * scale
  });
};

const getPageBoundsFromSize = (pageSize, scale) => {
  const width = Number(pageSize?.width ?? pageSize?.page_width);
  const height = Number(pageSize?.height ?? pageSize?.page_height);
  if (!(width > 0) || !(height > 0)) {
    return null;
  }
  return createPageBoundsFromRect({
    minX: 0,
    minY: 0,
    maxX: width * scale,
    maxY: height * scale
  });
};

const getPlacementBounds = (pageBounds, normalizedArea) => {
  if (
    !pageBounds ||
    !normalizedArea ||
    !Number.isFinite(normalizedArea.x) ||
    !Number.isFinite(normalizedArea.y) ||
    !Number.isFinite(normalizedArea.width) ||
    !Number.isFinite(normalizedArea.height) ||
    normalizedArea.width <= 0 ||
    normalizedArea.height <= 0
  ) {
    return pageBounds;
  }

  const pageWidth = pageBounds.maxX - pageBounds.minX;
  const pageHeight = pageBounds.maxY - pageBounds.minY;
  const minX = pageBounds.minX + normalizedArea.x * pageWidth;
  const minY = pageBounds.minY + normalizedArea.y * pageHeight;
  const maxX = minX + normalizedArea.width * pageWidth;
  const maxY = minY + normalizedArea.height * pageHeight;
  return createPageBoundsFromRect({ minX, minY, maxX, maxY });
};

const buildGraphicSpatialIndex = (vectors, scale, placementBounds) => {
  if (!Array.isArray(vectors) || vectors.length === 0) {
    return null;
  }

  const segments = [];
  const cells = new Map();
  const addToCell = (cellX, cellY, segmentIndex) => {
    const key = `${cellX}:${cellY}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(segmentIndex);
  };

  vectors.forEach((vector) => {
    const values = Array.isArray(vector)
      ? vector.slice(1, 5)
      : [vector?.x1, vector?.y1, vector?.x2, vector?.y2];
    if (!values.every(Number.isFinite)) return;

    const [rawX1, rawY1, rawX2, rawY2] = values;
    const segment = {
      x1: rawX1 * scale,
      y1: rawY1 * scale,
      x2: rawX2 * scale,
      y2: rawY2 * scale
    };
    segment.minX = Math.min(segment.x1, segment.x2);
    segment.minY = Math.min(segment.y1, segment.y2);
    segment.maxX = Math.max(segment.x1, segment.x2);
    segment.maxY = Math.max(segment.y1, segment.y2);

    if (
      Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1) < 1 ||
      (
        placementBounds &&
        (
          segment.maxX < placementBounds.minX ||
          segment.minX > placementBounds.maxX ||
          segment.maxY < placementBounds.minY ||
          segment.minY > placementBounds.maxY
        )
      )
    ) {
      return;
    }

    const segmentIndex = segments.length;
    segments.push(segment);
    const minCellX = Math.floor(segment.minX / GRAPHIC_INDEX_CELL_SIZE);
    const maxCellX = Math.floor(segment.maxX / GRAPHIC_INDEX_CELL_SIZE);
    const minCellY = Math.floor(segment.minY / GRAPHIC_INDEX_CELL_SIZE);
    const maxCellY = Math.floor(segment.maxY / GRAPHIC_INDEX_CELL_SIZE);
    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
        addToCell(cellX, cellY, segmentIndex);
      }
    }
  });

  return { segments, cells };
};

const getGraphicSegmentsNearPoint = (graphicIndex, x, y, radius) => {
  if (!graphicIndex) return [];

  const minCellX = Math.floor((x - radius) / GRAPHIC_INDEX_CELL_SIZE);
  const maxCellX = Math.floor((x + radius) / GRAPHIC_INDEX_CELL_SIZE);
  const minCellY = Math.floor((y - radius) / GRAPHIC_INDEX_CELL_SIZE);
  const maxCellY = Math.floor((y + radius) / GRAPHIC_INDEX_CELL_SIZE);
  const segmentIndexes = new Set();

  for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
    for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
      (graphicIndex.cells.get(`${cellX}:${cellY}`) || []).forEach(index => segmentIndexes.add(index));
    }
  }

  return Array.from(segmentIndexes, index => graphicIndex.segments[index]);
};

const getGraphicSegmentsNearSegment = (graphicIndex, x1, y1, x2, y2, padding = 0) => {
  if (!graphicIndex) return [];

  const minCellX = Math.floor((Math.min(x1, x2) - padding) / GRAPHIC_INDEX_CELL_SIZE);
  const maxCellX = Math.floor((Math.max(x1, x2) + padding) / GRAPHIC_INDEX_CELL_SIZE);
  const minCellY = Math.floor((Math.min(y1, y2) - padding) / GRAPHIC_INDEX_CELL_SIZE);
  const maxCellY = Math.floor((Math.max(y1, y2) + padding) / GRAPHIC_INDEX_CELL_SIZE);
  const segmentIndexes = new Set();

  for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
    for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
      (graphicIndex.cells.get(`${cellX}:${cellY}`) || []).forEach(index => segmentIndexes.add(index));
    }
  }

  return Array.from(segmentIndexes, index => graphicIndex.segments[index]);
};

const getPageBoundsFromWindow = () => {
  if (typeof window === 'undefined' || !window.__pdfPageSize__) {
    return null;
  }

  const { width, height } = window.__pdfPageSize__;
  if (!(width > 0) || !(height > 0)) {
    return null;
  }

  return createPageBoundsFromRect({
    minX: 0,
    minY: 0,
    maxX: width,
    maxY: height
  });
};

const getExistingTrackCandidates = (tracks, baseValue) => {
  return [...tracks]
    .map((trackValue) => ({ value: trackValue, diff: Math.abs(trackValue - baseValue) }))
    .filter((item) => item.diff <= TRACK_SNAP_LIMIT)
    .sort((a, b) => a.diff - b.diff)
    .slice(0, 3)
    .map((item) => ({
      value: item.value,
      reusedTrack: true,
      trackOffset: item.value - baseValue
    }));
};

const getTrackCandidates = (baseValue, trackValues) => {
  const gridValue = quantizeToGrid(baseValue);
  const baseCandidates = [
    { value: baseValue, reusedTrack: false, trackOffset: 0 },
    { value: gridValue, reusedTrack: false, trackOffset: gridValue - baseValue },
    { value: gridValue - TRACK_GRID_SIZE, reusedTrack: false, trackOffset: gridValue - TRACK_GRID_SIZE - baseValue },
    { value: gridValue + TRACK_GRID_SIZE, reusedTrack: false, trackOffset: gridValue + TRACK_GRID_SIZE - baseValue }
  ];

  return dedupeByKey(
    [...getExistingTrackCandidates(trackValues, baseValue), ...baseCandidates],
    (candidate) => roundTrackValue(candidate.value)
  ).sort((a, b) => {
    if (a.reusedTrack !== b.reusedTrack) {
      return a.reusedTrack ? -1 : 1;
    }
    return Math.abs(a.trackOffset) - Math.abs(b.trackOffset);
  });
};

const buildPlacementState = (entries, excludeIndex = -1, scopeSegmentId = null) => {
  const state = {
    placedEntries: [],
    horizontalTracks: new Set(),
    verticalTracks: new Set()
  };

  entries.forEach((entry, index) => {
    if (!entry || index === excludeIndex) {
      return;
    }

    const placement = {
      x: entry.endX,
      y: entry.endY,
      lx1: entry.startX,
      ly1: entry.startY,
      lx2: entry.connectionX,
      ly2: entry.connectionY,
      family: entry.meta.family,
      leaderAngle: Math.atan2(entry.connectionY - entry.startY, entry.connectionX - entry.startX),
      leaderLength: Math.hypot(entry.connectionX - entry.startX, entry.connectionY - entry.startY),
      labelBounds: entry.labelBounds || getLabelBounds(entry.endX, entry.endY),
      segmentId: getLayoutSegmentId(entry.weld),
      longPipeGroupId: entry.meta?.longPipeGroupId || '',
      longPipeSide: Number(entry.meta?.longPipeSide || 0),
      source: entry.meta?.source || ''
    };

    state.placedEntries.push(placement);

    const canReuseTrack = scopeSegmentId === null || getLayoutSegmentId(entry.weld) === scopeSegmentId;

    if (canReuseTrack && entry.meta.family === 'horizontal') {
      state.horizontalTracks.add(roundTrackValue(entry.endY));
    }

    if (canReuseTrack && entry.meta.family === 'vertical') {
      state.verticalTracks.add(roundTrackValue(entry.endX));
    }
  });

  state.horizontalTracks = [...state.horizontalTracks];
  state.verticalTracks = [...state.verticalTracks];

  return state;
};

const getHardCollisionSummary = (candidate, state, env = null) => {
  const summary = {
    leaderIntersection: 0,
    leaderLeader: 0,
    leaderLabel: 0,
    labelLabel: 0,
    labelText: 0,
    labelGraphic: 0,
    pageBounds: 0,
    collisionViolationCount: 0,
    constraintViolationCount: 0,
    total: 0
  };

  const circleRadius = env?.circleRadius || CIRCLE_RADIUS;
  const candidateLabelBounds = candidate.labelBounds || getLabelBounds(candidate.endX, candidate.endY, 0, circleRadius);
  const candidateExpandedBounds = getLabelBounds(candidate.endX, candidate.endY, HARD_LABEL_MIN_GAP / 2, circleRadius);

  state.placedEntries.forEach((placed) => {
    const placedLabelBounds = placed.labelBounds || getLabelBounds(placed.x, placed.y);
    const placedExpandedBounds = getLabelBounds(placed.x, placed.y, HARD_LABEL_MIN_GAP / 2, circleRadius);

    if (doRectsOverlap(candidateExpandedBounds, placedExpandedBounds)) {
      summary.labelLabel += 1;
    }

    const candidateHitsPlacedLabel = (
      doesSegmentIntersectRect(
        candidate.startX,
        candidate.startY,
        candidate.connectionX,
        candidate.connectionY,
        placedLabelBounds
      ) ||
      getSegmentToRectMinDist(
        candidate.startX,
        candidate.startY,
        candidate.connectionX,
        candidate.connectionY,
        placedLabelBounds
      ) < HARD_LEADER_LABEL_MIN_GAP
    );

    if (candidateHitsPlacedLabel) {
      summary.leaderLabel += 1;
    }

    const placedHitsCandidateLabel = (
      doesSegmentIntersectRect(
        placed.lx1,
        placed.ly1,
        placed.lx2,
        placed.ly2,
        candidateLabelBounds
      ) ||
      getSegmentToRectMinDist(
        placed.lx1,
        placed.ly1,
        placed.lx2,
        placed.ly2,
        candidateLabelBounds
      ) < HARD_LEADER_LABEL_MIN_GAP
    );

    if (placedHitsCandidateLabel) {
      summary.leaderLabel += 1;
    }

    if (!env?.allowLeaderCrossing) {
      const leadersIntersect = doSegmentsIntersect(
        candidate.startX,
        candidate.startY,
        candidate.connectionX,
        candidate.connectionY,
        placed.lx1,
        placed.ly1,
        placed.lx2,
        placed.ly2
      );
      if (leadersIntersect) {
        summary.leaderIntersection += 1;
        summary.leaderLeader += 1;
      } else {
        const candidateLeader = trimLeaderStart(
          candidate.startX,
          candidate.startY,
          candidate.connectionX,
          candidate.connectionY
        );
        const placedLeader = trimLeaderStart(
          placed.lx1,
          placed.ly1,
          placed.lx2,
          placed.ly2
        );
        const minLineDistance = getSegmentToSegmentMinDist(
          candidateLeader.x1,
          candidateLeader.y1,
          candidateLeader.x2,
          candidateLeader.y2,
          placedLeader.x1,
          placedLeader.y1,
          placedLeader.x2,
          placedLeader.y2
        );
        if (minLineDistance < HARD_LEADER_LEADER_MIN_GAP) {
          summary.leaderLeader += 1;
        }
      }
    }
  });

  const expandedTextSensitiveBounds = getLabelBounds(
    candidate.endX,
    candidate.endY,
    HARD_LEADER_LABEL_MIN_GAP,
    circleRadius
  );
  const allTextRegions = env?.allTextRegions || [];

  allTextRegions.forEach((region) => {
    if (doRectsOverlap(expandedTextSensitiveBounds, region)) {
      summary.labelText += 1;
    }
  });

  const graphicClearance = circleRadius + HARD_LABEL_MIN_GAP;
  const nearbyGraphicSegments = getGraphicSegmentsNearPoint(
    env?.graphicIndex,
    candidate.endX,
    candidate.endY,
    graphicClearance
  );
  if (nearbyGraphicSegments.some(segment => (
    getDistancePointToSegment(
      candidate.endX,
      candidate.endY,
      segment.x1,
      segment.y1,
      segment.x2,
      segment.y2
    ) < graphicClearance
  ))) {
    summary.labelGraphic += 1;
  }

  const pageBounds = env?.pageBounds;
  if (
    pageBounds &&
    (
      candidateLabelBounds.minX < pageBounds.minX ||
      candidateLabelBounds.minY < pageBounds.minY ||
      candidateLabelBounds.maxX > pageBounds.maxX ||
      candidateLabelBounds.maxY > pageBounds.maxY
    )
  ) {
    summary.pageBounds += 1;
  }

  summary.collisionViolationCount = summary.leaderLeader + summary.leaderLabel + summary.labelLabel;
  summary.constraintViolationCount = summary.labelText + summary.labelGraphic + summary.pageBounds;
  summary.total = summary.collisionViolationCount + summary.constraintViolationCount;
  return summary;
};

const evaluateCollisionPenalty = (candidate, state, env, options = null) => {
  const {
    startX,
    startY,
    endX,
    endY,
    connectionX,
    connectionY,
    meta
  } = candidate;

  const {
    allPipelineSegments,
    allTextRegions,
    pageBounds,
    weldFocusBounds
  } = env;
  const circleRadius = env?.circleRadius || CIRCLE_RADIUS;

  let penalty = 0;
  const margin = 10;
  const labelMargin = 2;
  const boxCollisionRadius = circleRadius * 2 + labelMargin;
  const lineBoxRadius = circleRadius + margin;
  const pipeCollisionRadius = circleRadius + margin;
  const leaderPipeMinDistance = 10;
  const leaderParallelMinDistance = 26;
  const safeBoundaryPadding = 20;
  const candidateLeaderAngle = Math.atan2(connectionY - startY, connectionX - startX);
  const candidateLeaderLength = Math.hypot(connectionX - startX, connectionY - startY);
  const isLocalPipeBand = String(meta.source || '').startsWith('local-pipe-band');
  const isLongPipeGroup = String(meta.source || '').startsWith('long-pipe-group');
  const isPipeBand = isLocalPipeBand || isLongPipeGroup;

  state.placedEntries.forEach((placed) => {
    const distBox = Math.sqrt((endX - placed.x) ** 2 + (endY - placed.y) ** 2);
    if (distBox < boxCollisionRadius) {
      penalty += 12000 + (boxCollisionRadius - distBox) * 120;
    }

    const lineToBox = getDistancePointToSegment(placed.x, placed.y, startX, startY, connectionX, connectionY);
    if (lineToBox < lineBoxRadius) {
      penalty += 5200 + (lineBoxRadius - lineToBox) * 55;
    }

    const boxToLine = getDistancePointToSegment(endX, endY, placed.lx1, placed.ly1, placed.lx2, placed.ly2);
    if (boxToLine < lineBoxRadius) {
      penalty += 5200 + (lineBoxRadius - boxToLine) * 55;
    }

    if (
      !env.allowLeaderCrossing &&
      doSegmentsIntersect(startX, startY, connectionX, connectionY, placed.lx1, placed.ly1, placed.lx2, placed.ly2)
    ) {
      penalty += 8200;
    } else if (!env.allowLeaderCrossing) {
      const candidateLeader = trimLeaderStart(startX, startY, connectionX, connectionY);
      const placedLeader = trimLeaderStart(placed.lx1, placed.ly1, placed.lx2, placed.ly2);
      const minLineDistance = getSegmentToSegmentMinDist(
        candidateLeader.x1,
        candidateLeader.y1,
        candidateLeader.x2,
        candidateLeader.y2,
        placedLeader.x1,
        placedLeader.y1,
        placedLeader.x2,
        placedLeader.y2
      );

      if (minLineDistance < leaderParallelMinDistance) {
        penalty += 3000 + (leaderParallelMinDistance - minLineDistance) * 90;
      }
    }

    const sameLongPipeGroup = (
      meta.longPipeGroupId &&
      placed.longPipeGroupId === meta.longPipeGroupId
    );
    if (!sameLongPipeGroup && candidateLeaderLength > 260 && placed.leaderLength > 260) {
      const rawAngleDifference = Math.abs(normalizeAngle(candidateLeaderAngle - placed.leaderAngle));
      const parallelAngleDifference = Math.min(rawAngleDifference, Math.abs(Math.PI - rawAngleDifference));
      if (parallelAngleDifference < Math.PI / 18) {
        penalty += 900 + (Math.PI / 18 - parallelAngleDifference) * 1200;
      }
    }
  });

  allPipelineSegments.forEach((segment) => {
    const dist = getDistancePointToSegment(endX, endY, segment.x1, segment.y1, segment.x2, segment.y2);
    if (dist < pipeCollisionRadius) {
      penalty += 2200 + (pipeCollisionRadius - dist) * 30;
    }

    if (!env.allowLeaderThroughGraphics && doSegmentsIntersect(
      startX,
      startY,
      connectionX,
      connectionY,
      segment.x1,
      segment.y1,
      segment.x2,
      segment.y2
    )) {
      penalty += 3600;
    } else if (!env.allowLeaderThroughGraphics) {
      const lineToSegment = getSegmentToSegmentMinDist(
        startX,
        startY,
        connectionX,
        connectionY,
        segment.x1,
        segment.y1,
        segment.x2,
        segment.y2
      );

      if (lineToSegment < leaderPipeMinDistance) {
        penalty += 1200 + (leaderPipeMinDistance - lineToSegment) * 65;
      }
    }
  });

  const graphicPenaltyRadius = circleRadius + margin;
  getGraphicSegmentsNearPoint(
    env.graphicIndex,
    endX,
    endY,
    graphicPenaltyRadius + 18
  ).forEach((segment) => {
    const distance = getDistancePointToSegment(
      endX,
      endY,
      segment.x1,
      segment.y1,
      segment.x2,
      segment.y2
    );
    if (distance < graphicPenaltyRadius) {
      penalty += 9000 + (graphicPenaltyRadius - distance) * 140;
    } else {
      penalty += Math.max(0, graphicPenaltyRadius + 18 - distance) * 12;
    }
  });

  if (env.allowLeaderThroughGraphics && !options?.skipSoftGraphicPenalty) {
    getGraphicSegmentsNearSegment(
      env.graphicIndex,
      startX,
      startY,
      connectionX,
      connectionY,
      5
    ).forEach((segment) => {
      if (doSegmentsIntersect(
        startX,
        startY,
        connectionX,
        connectionY,
        segment.x1,
        segment.y1,
        segment.x2,
        segment.y2
      )) {
        penalty += 65;
        return;
      }

      const distance = getSegmentToSegmentMinDist(
        startX,
        startY,
        connectionX,
        connectionY,
        segment.x1,
        segment.y1,
        segment.x2,
        segment.y2
      );
      if (distance < 4) {
        const graphicAngle = Math.atan2(segment.y2 - segment.y1, segment.x2 - segment.x1);
        const rawAngleDifference = Math.abs(normalizeAngle(candidateLeaderAngle - graphicAngle));
        const parallelAngleDifference = Math.min(rawAngleDifference, Math.abs(Math.PI - rawAngleDifference));
        penalty += parallelAngleDifference < Math.PI / 12 ? 220 : 35;
      }
    });
  }

  allTextRegions.forEach((region) => {
    const closestX = Math.max(region.minX, Math.min(endX, region.maxX));
    const closestY = Math.max(region.minY, Math.min(endY, region.maxY));
    const distance = Math.sqrt((endX - closestX) ** 2 + (endY - closestY) ** 2);

    if (distance < circleRadius + margin) {
      penalty += 6400 + (circleRadius + margin - distance) * 90;
    }
  });

  const boundaryDistances = [
    endX - pageBounds.minX,
    pageBounds.maxX - endX,
    endY - pageBounds.minY,
    pageBounds.maxY - endY
  ];

  boundaryDistances.forEach((distance) => {
    const safeDistance = circleRadius + safeBoundaryPadding;
    if (distance < safeDistance) {
      penalty += 4000 + (safeDistance - distance) * 140;
    }
  });

  const actualAngle = Math.atan2(endY - startY, endX - startX);
  const angleDiff = Math.abs(normalizeAngle(actualAngle - meta.targetAngle));

  penalty += meta.rank * (env.usePerimeterLayout ? 30 : 520);
  penalty += env.usePerimeterLayout
    ? Math.abs(meta.lineLength - 150) * 1.8 + meta.lineLength * 0.55
    : meta.lineLength * 1.8;
  if (env.usePerimeterLayout && meta.lineLength > 200) {
    const excessiveLength = meta.lineLength - 200;
    penalty += excessiveLength * 4.5 + excessiveLength * excessiveLength * 0.04;
  }
  penalty += angleDiff * 260;
  penalty += Math.abs(meta.trackOffset || 0) * 2.4;

  if (env.usePerimeterLayout) {
    if (isPipeBand) {
      penalty -= 1500;
      penalty += Math.abs((meta.bandDistance || 150) - 130) * 2.8;
      penalty += Math.abs(meta.tangentShift || 0) * 0.75;
      penalty += Number(meta.perpendicularDeviation || 0) * 1600;
      if (isLongPipeGroup) {
        penalty -= 1100;
        penalty += Number(meta.longPipeLane || 0) * 45;
        if (Number(meta.longPipeSide || 0) !== Number(meta.preferredLongPipeSide || 0)) {
          penalty += 650;
        }
      }
    } else if (meta.family === 'horizontal') {
      penalty += 2200;
    } else if (meta.family === 'vertical') {
      penalty += 420;
    } else {
      penalty -= 220;
    }

    if (meta.reusedTrack) {
      penalty += 360;
    }
  } else {
    if (meta.family === 'diagonal') {
      penalty += meta.source === 'segment-normal' ? 220 : 820;
    }

    if (meta.reusedTrack) {
      penalty -= 650;
    } else if (meta.family !== 'diagonal') {
      penalty += 180;
    }

    if (meta.source !== 'segment-normal' && meta.family === 'diagonal') {
      penalty += 180;
    }
  }

  if (env.usePerimeterLayout && weldFocusBounds) {
    const outsideX = Math.max(
      weldFocusBounds.minX - endX,
      0,
      endX - weldFocusBounds.maxX
    );
    const outsideY = Math.max(
      weldFocusBounds.minY - endY,
      0,
      endY - weldFocusBounds.maxY
    );
    const outsideDistance = Math.hypot(outsideX, outsideY);
    if (outsideDistance > 170) {
      const excess = outsideDistance - 170;
      penalty += excess * 4 + excess * excess * 0.025;
    }
  }

  if (weldFocusBounds && !isPipeBand) {
    const outwardX = startX - weldFocusBounds.centerX;
    const outwardY = startY - weldFocusBounds.centerY;
    const outwardLength = Math.sqrt(outwardX * outwardX + outwardY * outwardY);
    const leaderX = endX - startX;
    const leaderY = endY - startY;
    const leaderLength = Math.sqrt(leaderX * leaderX + leaderY * leaderY);

    if (outwardLength > 8 && leaderLength > 0) {
      const outwardAlignment = (
        outwardX * leaderX + outwardY * leaderY
      ) / (outwardLength * leaderLength);
      const startRadius = outwardLength;
      const endRadius = Math.sqrt(
        (endX - weldFocusBounds.centerX) ** 2 +
        (endY - weldFocusBounds.centerY) ** 2
      );
      const outwardGain = endRadius - startRadius;

      penalty += (1 - outwardAlignment) * 260;
      if (outwardAlignment < 0) {
        penalty += Math.abs(outwardAlignment) * 400;
      }
      if (outwardGain < 0) {
        penalty += 500 + Math.abs(outwardGain) * 2;
      } else {
        penalty -= Math.min(outwardGain, 180) * 0.8;
      }
    }
  }

  return penalty;
};

const buildCandidatesForDirection = (
  startX,
  startY,
  direction,
  rank,
  state,
  lineLengths = FIXED_LINE_LENGTHS
) => {
  if (direction.lockDirection) {
    return lineLengths.map((lineLength) => ({
      startX,
      startY,
      endX: startX + Math.cos(direction.angle) * lineLength,
      endY: startY + Math.sin(direction.angle) * lineLength,
      meta: {
        family: direction.family,
        targetAngle: direction.angle,
        lineLength,
        rank,
        source: direction.source,
        reusedTrack: false,
        trackOffset: 0,
        lockDirection: true
      }
    }));
  }

  const trackValues = direction.family === 'horizontal'
    ? state.horizontalTracks
    : direction.family === 'vertical'
      ? state.verticalTracks
      : [];

  const trackCandidates = direction.family === 'horizontal'
    ? getTrackCandidates(startY, trackValues)
    : direction.family === 'vertical'
      ? getTrackCandidates(startX, trackValues)
      : [{ value: 0, reusedTrack: false, trackOffset: 0 }];

  const candidates = [];

  lineLengths.forEach((lineLength) => {
    if (direction.family === 'horizontal') {
      trackCandidates.forEach((trackCandidate) => {
        candidates.push({
          startX,
          startY,
          endX: startX + direction.signX * lineLength,
          endY: trackCandidate.value,
          meta: {
            family: direction.family,
            targetAngle: direction.angle,
            lineLength,
            rank,
            source: direction.source,
            reusedTrack: trackCandidate.reusedTrack,
            trackOffset: trackCandidate.trackOffset
          }
        });
      });
      return;
    }

    if (direction.family === 'vertical') {
      trackCandidates.forEach((trackCandidate) => {
        candidates.push({
          startX,
          startY,
          endX: trackCandidate.value,
          endY: startY + direction.signY * lineLength,
          meta: {
            family: direction.family,
            targetAngle: direction.angle,
            lineLength,
            rank,
            source: direction.source,
            reusedTrack: trackCandidate.reusedTrack,
            trackOffset: trackCandidate.trackOffset
          }
        });
      });
      return;
    }

    const rawEndX = startX + Math.cos(direction.angle) * lineLength;
    const rawEndY = startY + Math.sin(direction.angle) * lineLength;

    candidates.push({
      startX,
      startY,
      endX: quantizeToGrid(rawEndX, TRACK_GRID_SIZE / 2),
      endY: quantizeToGrid(rawEndY, TRACK_GRID_SIZE / 2),
      meta: {
        family: direction.family,
        targetAngle: direction.angle,
        lineLength,
        rank,
        source: direction.source,
        reusedTrack: false,
        trackOffset: 0
      }
    });
  });

  return candidates;
};

const buildLocalPipeBandCandidates = (
  startX,
  startY,
  segmentAngle
) => {
  const tangentX = Math.cos(segmentAngle);
  const tangentY = Math.sin(segmentAngle);
  const normalX = -tangentY;
  const normalY = tangentX;
  const bandDistances = [100, 125, 150, 180, 215, 260, 320];
  const tangentShifts = [0, -32, 32, -64, 64, -96, 96, -128, 128, -176, 176, -224, 224];
  const candidates = [];
  let rank = 0;

  bandDistances.forEach((bandDistance) => {
    tangentShifts.forEach((tangentShift) => {
      [-1, 1].forEach((side) => {
        const endX = startX + normalX * side * bandDistance + tangentX * tangentShift;
        const endY = startY + normalY * side * bandDistance + tangentY * tangentShift;
        const dx = endX - startX;
        const dy = endY - startY;
        const actualAngle = Math.atan2(dy, dx);

        candidates.push({
          startX,
          startY,
          endX,
          endY,
          meta: {
            family: classifyAngleFamily(actualAngle),
            targetAngle: actualAngle,
            lineLength: Math.hypot(dx, dy),
            rank,
            source: 'local-pipe-band',
            reusedTrack: false,
            trackOffset: 0,
            bandDistance,
            tangentShift,
            bandSide: side,
            pipeAngle: segmentAngle,
            perpendicularDeviation: Math.atan2(Math.abs(tangentShift), bandDistance)
          }
        });
        rank += 1;
      });
    });
  });

  return candidates;
};

const buildLongPipeGroupCandidates = (startX, startY, group) => {
  if (!group) return [];
  const laneBaseDistance = 115 + Number(group.lane || 0) * 64;
  const bandDistances = dedupeByKey(
    [laneBaseDistance, laneBaseDistance + 24, laneBaseDistance + 50, 240, 300, 380, 500],
    value => value
  ).sort((a, b) => a - b);
  const baseShift = Number(group.tangentShift || 0);
  const tangentShifts = dedupeByKey(
    [baseShift, 0, baseShift - 14, baseShift + 14, baseShift - 28, baseShift + 28],
    value => roundTrackValue(value)
  );
  const sides = [group.preferredSide, -group.preferredSide];
  const candidates = [];
  let rank = 0;

  sides.forEach((side) => {
    bandDistances.forEach((bandDistance) => {
      tangentShifts.forEach((tangentShift) => {
        const endX = (
          startX +
          group.normalX * side * bandDistance +
          group.tangentX * tangentShift
        );
        const endY = (
          startY +
          group.normalY * side * bandDistance +
          group.tangentY * tangentShift
        );
        const dx = endX - startX;
        const dy = endY - startY;
        const actualAngle = Math.atan2(dy, dx);
        candidates.push({
          startX,
          startY,
          endX,
          endY,
          meta: {
            family: classifyAngleFamily(actualAngle),
            targetAngle: actualAngle,
            lineLength: Math.hypot(dx, dy),
            rank,
            source: 'long-pipe-group',
            reusedTrack: false,
            trackOffset: 0,
            bandDistance,
            tangentShift,
            longPipeGroupId: group.groupId,
            longPipeSide: side,
            preferredLongPipeSide: group.preferredSide,
            longPipeLane: group.lane,
            longPipeGroupSize: group.groupSize,
            pipeAngle: group.axisAngle,
            perpendicularDeviation: Math.atan2(Math.abs(tangentShift), bandDistance)
          }
        });
        rank += 1;
      });
    });
  });

  return candidates;
};

const completeCandidateGeometry = (candidate, circleRadius = CIRCLE_RADIUS) => {
  const { connectionX, connectionY } = getConnectionPoint(
    candidate.startX,
    candidate.startY,
    candidate.endX,
    candidate.endY,
    circleRadius
  );

  return {
    ...candidate,
    labelBounds: getLabelBounds(candidate.endX, candidate.endY, 0, circleRadius),
    connectionX,
    connectionY
  };
};

const clampCandidateIntoPlacementBounds = (candidate, env) => {
  if (!env?.enforcePlacementBounds) return candidate;
  const bounds = env?.pageBounds;
  const circleRadius = env?.circleRadius || CIRCLE_RADIUS;
  if (!bounds) return candidate;

  const boundaryInset = 2;
  const minCenterX = bounds.minX + circleRadius + boundaryInset;
  const maxCenterX = bounds.maxX - circleRadius - boundaryInset;
  const minCenterY = bounds.minY + circleRadius + boundaryInset;
  const maxCenterY = bounds.maxY - circleRadius - boundaryInset;
  if (minCenterX > maxCenterX || minCenterY > maxCenterY) {
    return null;
  }

  const endX = Math.max(minCenterX, Math.min(candidate.endX, maxCenterX));
  const endY = Math.max(minCenterY, Math.min(candidate.endY, maxCenterY));
  if (endX === candidate.endX && endY === candidate.endY) {
    return candidate;
  }

  const dx = endX - candidate.startX;
  const dy = endY - candidate.startY;
  const actualLength = Math.hypot(dx, dy);
  if (actualLength < 1) {
    return null;
  }
  const actualAngle = Math.atan2(dy, dx);
  return {
    ...candidate,
    endX,
    endY,
    meta: {
      ...candidate.meta,
      family: classifyAngleFamily(actualAngle),
      targetAngle: actualAngle,
      lineLength: actualLength,
      source: `${candidate.meta.source || 'default'}-boundary-clamped`,
      reusedTrack: false
    }
  };
};

const chooseBestCollisionFreeCandidate = (candidates) => {
  if (candidates.length === 0) {
    return null;
  }

  return candidates.reduce((best, current) => {
    if (!best) {
      return current;
    }

    if (current.penalty !== best.penalty) {
      return current.penalty < best.penalty ? current : best;
    }

    if (current.meta.rank !== best.meta.rank) {
      return current.meta.rank < best.meta.rank ? current : best;
    }

    return current;
  }, null);
};

const evaluateCandidates = (candidates, state, env) => candidates.map((candidate) => {
  const completed = completeCandidateGeometry(candidate, env?.circleRadius);
  const hardCollisionSummary = getHardCollisionSummary(completed, state, env);
  const penalty = evaluateCollisionPenalty(completed, state, env, {
    skipSoftGraphicPenalty: hardCollisionSummary.total > 0
  });

  return {
    ...completed,
    hardCollisionSummary,
    collisionViolationCount: hardCollisionSummary.collisionViolationCount,
    constraintViolationCount: hardCollisionSummary.constraintViolationCount,
    hardCollisionCount: hardCollisionSummary.total,
    penalty,
    fallbackPenalty: penalty
  };
});

const findCollisionFreeCandidateByLength = (evaluatedCandidates) => {
  const candidateLengths = [...new Set(evaluatedCandidates.map((candidate) => candidate.meta.lineLength))]
    .sort((a, b) => a - b);

  for (const lineLength of candidateLengths) {
    const collisionFreeCandidates = evaluatedCandidates.filter((candidate) => (
      candidate.meta.lineLength === lineLength && candidate.hardCollisionCount === 0
    ));

    const bestCollisionFreeCandidate = chooseBestCollisionFreeCandidate(collisionFreeCandidates);
    if (bestCollisionFreeCandidate) {
      return bestCollisionFreeCandidate;
    }
  }

  return null;
};

const chooseBestFallbackCandidate = (candidates) => candidates.reduce((best, current) => {
  if (!best) {
    return current;
  }

  if (current.hardCollisionSummary.pageBounds !== best.hardCollisionSummary.pageBounds) {
    return current.hardCollisionSummary.pageBounds < best.hardCollisionSummary.pageBounds
      ? current
      : best;
  }

  const currentCircleViolationCount = (
    current.hardCollisionSummary.labelGraphic +
    current.hardCollisionSummary.labelText +
    current.hardCollisionSummary.labelLabel
  );
  const bestCircleViolationCount = (
    best.hardCollisionSummary.labelGraphic +
    best.hardCollisionSummary.labelText +
    best.hardCollisionSummary.labelLabel
  );
  if (currentCircleViolationCount !== bestCircleViolationCount) {
    return currentCircleViolationCount < bestCircleViolationCount ? current : best;
  }

  if (current.hardCollisionSummary.leaderLabel !== best.hardCollisionSummary.leaderLabel) {
    return current.hardCollisionSummary.leaderLabel < best.hardCollisionSummary.leaderLabel
      ? current
      : best;
  }

  if (current.hardCollisionSummary.leaderLeader !== best.hardCollisionSummary.leaderLeader) {
    return current.hardCollisionSummary.leaderLeader < best.hardCollisionSummary.leaderLeader
      ? current
      : best;
  }

  if (current.fallbackPenalty !== best.fallbackPenalty) {
    return current.fallbackPenalty < best.fallbackPenalty ? current : best;
  }

  if (current.meta.lineLength !== best.meta.lineLength) {
    return current.meta.lineLength < best.meta.lineLength ? current : best;
  }

  return current.meta.rank < best.meta.rank ? current : best;
}, null);

const chooseBestNonCrossingFallbackCandidate = (candidates) => chooseBestFallbackCandidate(
  candidates.filter(candidate => candidate.hardCollisionSummary?.leaderIntersection === 0)
);

const buildEmergencyNonCrossingCandidates = (startX, startY, env) => {
  const pageWidth = Math.max(1, env.pageBounds.maxX - env.pageBounds.minX);
  const pageHeight = Math.max(1, env.pageBounds.maxY - env.pageBounds.minY);
  const maxReach = Math.hypot(pageWidth, pageHeight);
  const lengths = [140, 180, 220, 270, 330, 400, 500, 620, 760, maxReach];
  const candidates = [];

  for (let angleIndex = 0; angleIndex < 72; angleIndex += 1) {
    const angle = (angleIndex * Math.PI * 2) / 72;
    lengths.forEach((lineLength, lengthIndex) => {
      candidates.push({
        startX,
        startY,
        endX: startX + Math.cos(angle) * lineLength,
        endY: startY + Math.sin(angle) * lineLength,
        meta: {
          family: classifyAngleFamily(angle),
          targetAngle: angle,
          lineLength,
          rank: angleIndex * lengths.length + lengthIndex,
          source: 'non-crossing-emergency',
          reusedTrack: false,
          trackOffset: 0
        }
      });
    });
  }

  return candidates;
};

const findBestPlacement = (weld, state, env) => {
  const center = getWeldCenter(weld);
  const startX = center.x * env.scale;
  const startY = center.y * env.scale;
  const relatedSegmentAngle = getRelatedSegmentAngle(weld);
  const buildRankedDirections = (directions) => directions.map((direction, rank) => ({
    ...direction,
    rank,
    source: direction.source || 'default'
  }));
  const strictDirections = relatedSegmentAngle !== null
    ? buildRankedDirections(buildStrictNormalDirections(relatedSegmentAngle))
    : [];
  const radialDirection = env.usePerimeterLayout
    ? buildRadialDirection(startX, startY, env.weldFocusBounds)
    : null;
  const relaxedDirections = buildRankedDirections(buildPreferredDirections(
    startX,
    startY,
    env.weldFocusBounds || env.pageBounds
  ));
  const perimeterDirections = env.usePerimeterLayout
    ? buildRankedDirections([
      ...(radialDirection ? [radialDirection] : []),
      ...strictDirections,
      ...buildPerimeterSpokeDirections(startX, startY, env.weldFocusBounds),
      ...relaxedDirections
    ])
    : [];
  const lineLengths = env.usePerimeterLayout ? PERIMETER_LINE_LENGTHS : FIXED_LINE_LENGTHS;
  const longPipeGroup = env.longPipeGroupMap?.get(weld) || null;

  const finalizeCandidatePool = (candidates) => dedupeByKey(
    candidates
      .map(candidate => clampCandidateIntoPlacementBounds(candidate, env))
      .filter(Boolean),
    (candidate) => `${roundTrackValue(candidate.endX)}:${roundTrackValue(candidate.endY)}`
  );
  const buildCandidatePool = (directions) => finalizeCandidatePool(
    directions.flatMap((direction) => buildCandidatesForDirection(
      startX,
      startY,
      direction,
      direction.rank,
      state,
      lineLengths
    ))
  );
  const findForcedNonCrossingFallback = (evaluatedCandidates) => {
    const emergencyCandidates = evaluateCandidates(
      finalizeCandidatePool(buildEmergencyNonCrossingCandidates(startX, startY, env)),
      state,
      env
    );
    const inBoundsEmergencyCandidates = emergencyCandidates.filter(
      candidate => candidate.hardCollisionSummary.pageBounds === 0
    );
    const eligibleEmergencyCandidates = inBoundsEmergencyCandidates.length > 0
      ? inBoundsEmergencyCandidates
      : emergencyCandidates;
    const collisionFreeEmergency = chooseBestCollisionFreeCandidate(
      eligibleEmergencyCandidates.filter(candidate => candidate.hardCollisionCount === 0)
    );
    if (collisionFreeEmergency) {
      return collisionFreeEmergency;
    }

    const regularFallback = chooseBestNonCrossingFallbackCandidate(evaluatedCandidates);
    const emergencyFallback = chooseBestNonCrossingFallbackCandidate(
      eligibleEmergencyCandidates
    );
    const bestNonCrossingFallback = chooseBestFallbackCandidate(
      [regularFallback, emergencyFallback].filter(Boolean)
    );
    if (bestNonCrossingFallback) {
      return bestNonCrossingFallback;
    }

    return evaluateCandidates([{
      startX,
      startY,
      endX: startX,
      endY: startY,
      meta: {
        family: 'none',
        targetAngle: 0,
        lineLength: 0,
        rank: Number.MAX_SAFE_INTEGER,
        source: 'leader-suppressed-to-prevent-crossing',
        reusedTrack: false,
        trackOffset: 0
      }
    }], state, env)[0];
  };

  if (longPipeGroup) {
    const longPipeCandidatePool = finalizeCandidatePool(
      buildLongPipeGroupCandidates(startX, startY, longPipeGroup)
    );
    const evaluatedLongPipeCandidates = evaluateCandidates(
      longPipeCandidatePool,
      state,
      env
    );
    const inBoundsLongPipeCandidates = evaluatedLongPipeCandidates.filter(
      candidate => candidate.hardCollisionSummary.pageBounds === 0
    );
    const eligibleLongPipeCandidates = inBoundsLongPipeCandidates.length > 0
      ? inBoundsLongPipeCandidates
      : evaluatedLongPipeCandidates;
    const compactLongPipeCandidates = eligibleLongPipeCandidates.filter(candidate => (
      Number(candidate.meta?.bandDistance || 0) <= 240 &&
      Number(candidate.meta?.lineLength || 0) <= 280
    ));
    const bestLongPipeCandidate = chooseBestCollisionFreeCandidate(
      compactLongPipeCandidates.filter(candidate => candidate.hardCollisionCount === 0)
    ) || chooseBestCollisionFreeCandidate(
      eligibleLongPipeCandidates.filter(candidate => candidate.hardCollisionCount === 0)
    );
    if (bestLongPipeCandidate) {
      return {
        ...bestLongPipeCandidate,
        isCollisionFree: true,
        usedFallback: false,
        selectionStage: 'long-pipe-group'
      };
    }
  }

  if (env.usePerimeterLayout) {
    const localPipeBandCandidates = relatedSegmentAngle !== null
      ? buildLocalPipeBandCandidates(startX, startY, relatedSegmentAngle)
      : [];
    const localCandidatePool = finalizeCandidatePool(localPipeBandCandidates);
    const compactLocalCandidatePool = localCandidatePool.filter(candidate => (
      Number(candidate.meta?.bandDistance || 0) <= 180 &&
      Math.abs(Number(candidate.meta?.tangentShift || 0)) <= 96
    ));
    const evaluatedCompactLocalCandidates = evaluateCandidates(
      compactLocalCandidatePool,
      state,
      env
    );
    const inBoundsCompactLocalCandidates = evaluatedCompactLocalCandidates.filter(
      candidate => candidate.hardCollisionSummary.pageBounds === 0
    );
    const eligibleCompactLocalCandidates = inBoundsCompactLocalCandidates.length > 0
      ? inBoundsCompactLocalCandidates
      : evaluatedCompactLocalCandidates;
    const bestCompactLocalCandidate = chooseBestCollisionFreeCandidate(
      eligibleCompactLocalCandidates.filter(candidate => candidate.hardCollisionCount === 0)
    );
    if (bestCompactLocalCandidate) {
      return {
        ...bestCompactLocalCandidate,
        isCollisionFree: true,
        usedFallback: false,
        selectionStage: 'local-pipe-band-compact'
      };
    }

    const primaryLocalCandidatePool = localCandidatePool.filter(candidate => (
      Number(candidate.meta?.bandDistance || 0) <= 240 &&
      Math.abs(Number(candidate.meta?.tangentShift || 0)) <= 126
    ));
    const evaluatedPrimaryLocalCandidates = evaluateCandidates(
      primaryLocalCandidatePool,
      state,
      env
    );
    const inBoundsPrimaryLocalCandidates = evaluatedPrimaryLocalCandidates.filter(
      candidate => candidate.hardCollisionSummary.pageBounds === 0
    );
    const eligiblePrimaryLocalCandidates = inBoundsPrimaryLocalCandidates.length > 0
      ? inBoundsPrimaryLocalCandidates
      : evaluatedPrimaryLocalCandidates;
    const bestPrimaryLocalCandidate = chooseBestCollisionFreeCandidate(
      eligiblePrimaryLocalCandidates.filter(candidate => candidate.hardCollisionCount === 0)
    );
    if (bestPrimaryLocalCandidate) {
      return {
        ...bestPrimaryLocalCandidate,
        isCollisionFree: true,
        usedFallback: false,
        selectionStage: 'local-pipe-band'
      };
    }

    const evaluatedLocalCandidates = evaluateCandidates(localCandidatePool, state, env);
    const inBoundsLocalCandidates = evaluatedLocalCandidates.filter(
      candidate => candidate.hardCollisionSummary.pageBounds === 0
    );
    const eligibleLocalCandidates = inBoundsLocalCandidates.length > 0
      ? inBoundsLocalCandidates
      : evaluatedLocalCandidates;
    const bestExtendedLocalCandidate = chooseBestCollisionFreeCandidate(
      eligibleLocalCandidates.filter(candidate => candidate.hardCollisionCount === 0)
    );
    if (bestExtendedLocalCandidate) {
      return {
        ...bestExtendedLocalCandidate,
        isCollisionFree: true,
        usedFallback: false,
        selectionStage: 'local-pipe-band-extended'
      };
    }

    const perimeterCandidatePool = finalizeCandidatePool(
      perimeterDirections.flatMap((direction) => buildCandidatesForDirection(
        startX,
        startY,
        direction,
        direction.rank,
        state,
        lineLengths
      ))
    );
    const perimeterCandidates = evaluateCandidates(perimeterCandidatePool, state, env);
    const inBoundsCandidates = perimeterCandidates.filter(
      candidate => candidate.hardCollisionSummary.pageBounds === 0
    );
    const eligiblePerimeterCandidates = inBoundsCandidates.length > 0
      ? inBoundsCandidates
      : perimeterCandidates;
    const bestPerimeterCandidate = chooseBestCollisionFreeCandidate(
      eligiblePerimeterCandidates.filter(candidate => candidate.hardCollisionCount === 0)
    );
    if (bestPerimeterCandidate) {
      return {
        ...bestPerimeterCandidate,
        isCollisionFree: true,
        usedFallback: false,
        selectionStage: 'perimeter-distribution'
      };
    }

    const bestPerimeterFallback = findForcedNonCrossingFallback([
      ...eligibleLocalCandidates,
      ...eligiblePerimeterCandidates
    ]);
    return {
      ...bestPerimeterFallback,
      isCollisionFree: false,
      usedFallback: true,
      selectionStage: 'perimeter-best-effort'
    };
  }

  const strictCandidates = strictDirections.length > 0
    ? evaluateCandidates(buildCandidatePool(strictDirections), state, env)
    : [];
  const relaxedCandidates = evaluateCandidates(buildCandidatePool(relaxedDirections), state, env);

  const bestStrictCandidate = findCollisionFreeCandidateByLength(strictCandidates);
  if (bestStrictCandidate) {
    return {
      ...bestStrictCandidate,
      isCollisionFree: true,
      usedFallback: false,
      selectionStage: 'strict-perpendicular'
    };
  }

  const bestRelaxedCandidate = findCollisionFreeCandidateByLength(relaxedCandidates);
  if (bestRelaxedCandidate) {
    return {
      ...bestRelaxedCandidate,
      isCollisionFree: true,
      usedFallback: false,
      selectionStage: 'relaxed-direction'
    };
  }

  const bestCandidate = findForcedNonCrossingFallback([...strictCandidates, ...relaxedCandidates]);

  if (!bestCandidate) {
    const fallback = completeCandidateGeometry({
      startX,
      startY,
      endX: startX,
      endY: startY + FIXED_LINE_LENGTHS[0],
      meta: {
        family: 'vertical',
        targetAngle: Math.PI / 2,
        lineLength: FIXED_LINE_LENGTHS[0],
        rank: 999,
        source: 'fallback',
        reusedTrack: false,
        trackOffset: 0
      }
    }, env?.circleRadius);

    return {
      ...fallback,
      hardCollisionSummary: {
        leaderLeader: 0,
        leaderLabel: 0,
        labelLabel: 0,
        labelText: 0,
        pageBounds: 0,
        collisionViolationCount: 0,
        constraintViolationCount: 0,
        total: 0
      },
      collisionViolationCount: 0,
      constraintViolationCount: 0,
      hardCollisionCount: 0,
      penalty: evaluateCollisionPenalty(fallback, state, env),
      isCollisionFree: true,
      usedFallback: false,
      selectionStage: 'fallback-best-effort'
    };
  }

  return {
    ...bestCandidate,
    isCollisionFree: false,
    usedFallback: true,
    selectionStage: 'fallback-best-effort'
  };
};

const toPublicLayoutEntry = (entry, index) => ({
  ...entry.weld,
  number: getWeldDisplayNumber(entry.weld, index),
  startX: entry.startX,
  startY: entry.startY,
  endX: entry.endX,
  endY: entry.endY,
  connectionX: entry.connectionX,
  connectionY: entry.connectionY,
  layoutDiagnostics: {
    family: entry.meta?.family || '',
    source: entry.meta?.source || '',
    lineLength: Number(entry.meta?.lineLength || 0),
    selectionStage: entry.selectionStage || '',
    usedFallback: entry.usedFallback === true,
    isCollisionFree: entry.isCollisionFree !== false,
    hardCollisionCount: Number(entry.hardCollisionCount || 0),
    leaderIntersectionCount: Number(entry.hardCollisionSummary?.leaderIntersection || 0),
    collisionViolationCount: Number(entry.collisionViolationCount || 0),
    constraintViolationCount: Number(entry.constraintViolationCount || 0),
    hardCollisionSummary: entry.hardCollisionSummary || null,
    penalty: Number(entry.penalty || 0),
    longPipeGroupId: entry.meta?.longPipeGroupId || '',
    longPipeLane: Number(entry.meta?.longPipeLane ?? -1),
    pipeAngleDegrees: Number.isFinite(entry.meta?.pipeAngle)
      ? Number((entry.meta.pipeAngle * 180 / Math.PI).toFixed(1))
      : null,
    perpendicularDeviationDegrees: Number.isFinite(entry.meta?.perpendicularDeviation)
      ? Number((entry.meta.perpendicularDeviation * 180 / Math.PI).toFixed(1))
      : null
  }
});

const getIncrementalLayoutKey = (weld) => {
  if (!weld) return '';
  if (weld.manualInsertId) return `manual:${weld.manualInsertId}`;
  if (weld.id !== undefined && weld.id !== null && weld.id !== '') {
    return `id:${weld.id}`;
  }
  const center = getWeldCenter(weld);
  return `path:${weld.pathId ?? 'none'}:${Number(center.x || 0).toFixed(3)}:${Number(center.y || 0).toFixed(3)}`;
};

const toFixedLayoutEntry = (weld, fixedLayout) => {
  const coordinates = [
    fixedLayout?.startX,
    fixedLayout?.startY,
    fixedLayout?.endX,
    fixedLayout?.endY,
    fixedLayout?.connectionX,
    fixedLayout?.connectionY
  ];
  if (!coordinates.every(Number.isFinite)) return null;
  const diagnostics = fixedLayout.layoutDiagnostics || {};
  return {
    weld,
    startX: fixedLayout.startX,
    startY: fixedLayout.startY,
    endX: fixedLayout.endX,
    endY: fixedLayout.endY,
    connectionX: fixedLayout.connectionX,
    connectionY: fixedLayout.connectionY,
    meta: {
      family: diagnostics.family || '',
      source: diagnostics.source || 'incremental-cache',
      lineLength: Number(diagnostics.lineLength || 0),
      longPipeGroupId: diagnostics.longPipeGroupId || '',
      longPipeLane: Number(diagnostics.longPipeLane ?? -1),
      pipeAngle: Number.isFinite(diagnostics.pipeAngleDegrees)
        ? diagnostics.pipeAngleDegrees * Math.PI / 180
        : null,
      perpendicularDeviation: Number.isFinite(diagnostics.perpendicularDeviationDegrees)
        ? diagnostics.perpendicularDeviationDegrees * Math.PI / 180
        : null
    },
    selectionStage: diagnostics.selectionStage || 'incremental-cache',
    usedFallback: diagnostics.usedFallback === true,
    isCollisionFree: diagnostics.isCollisionFree !== false,
    hardCollisionCount: Number(diagnostics.hardCollisionCount || 0),
    hardCollisionSummary: diagnostics.hardCollisionSummary || null,
    collisionViolationCount: Number(diagnostics.collisionViolationCount || 0),
    constraintViolationCount: Number(diagnostics.constraintViolationCount || 0),
    penalty: Number(diagnostics.penalty || 0),
    fixedIncrementalLayout: true
  };
};

export const calculateWeldLayout = (
  welds,
  scale,
  sortStrategy = null,
  pipelines = null,
  flowArrows = null,
  textRegions = null,
  layoutOptions = null
) => {
  if (!welds || welds.length === 0) {
    return [];
  }

  let sorted;
  let strategy;

  if (sortStrategy === 'KEEP_ORDER') {
    console.log('🔢 焊点排序策略: KEEP_ORDER (保持输入顺序)');
    sorted = [...welds];
    strategy = 'KEEP_ORDER';
  } else {
    strategy = sortStrategy || SortStrategy.NEAREST_NEIGHBOR;
    console.log(`🔢 焊点排序策略: ${strategy}`);
    sorted = sortWelds(welds, pipelines, flowArrows, strategy, {
      startPosition: 'top-left',
      rowHeight: 100,
      fallbackStrategy: SortStrategy.LEFT_TO_RIGHT,
      respectFlowDirection: true
    });
  }

  console.log(`=== 焊点排序结果（策略: ${strategy}） ===`);
  sorted.forEach((weld, index) => {
    const center = getWeldCenter(weld);
    const weldPathId = weld.pathId || weld.id || '未知';
    const pipeInfo = weld.relatedSegmentId
      ? ` → 线段Path:${weld.relatedSegmentId}`
      : weld.relatedPipelineId
        ? ` → 管道Path:${weld.relatedPipelineId}`
        : ' → 未关联管线';
    console.log(`序号: ${index + 1}, 焊点Path:${weldPathId}, 中心点: (${center.x.toFixed(2)}, ${center.y.toFixed(2)})${pipeInfo}`);
  });
  console.log(`总共 ${sorted.length} 个焊点`);

  const allPipelineSegments = collectPipelineSegments(sorted, pipelines, scale);
  console.log(`📏 收集到 ${allPipelineSegments.length} 条管道线段用于碰撞检测`);
  const explicitPageBounds = (
    getPageBoundsFromSize(layoutOptions?.pageSize, scale) ||
    getPageBoundsFromTextRegions(textRegions, scale) ||
    getPageBoundsFromWindow()
  );

  const allTextRegions = (textRegions || []).map((region) => ({
    minX: region.minX * scale,
    minY: region.minY * scale,
    maxX: region.maxX * scale,
    maxY: region.maxY * scale
  }));

  const fullPageBounds = explicitPageBounds || inferPageBounds(
    sorted.map((weld) => ({
      ...weld,
      center: {
        x: getWeldCenter(weld).x * scale,
        y: getWeldCenter(weld).y * scale
      }
    })),
    allPipelineSegments,
    allTextRegions
  );
  const pageBounds = getPlacementBounds(
    fullPageBounds,
    layoutOptions?.normalizedPlacementArea
  );
  const weldFocusBounds = getWeldFocusBounds(sorted, scale);
  const usePerimeterLayout = Boolean(
    sorted.length >= 8 &&
    weldFocusBounds &&
    (
      weldFocusBounds.maxX - weldFocusBounds.minX >= 160 ||
      weldFocusBounds.maxY - weldFocusBounds.minY >= 160
    )
  );

  const env = {
    scale,
    enforcePlacementBounds: Boolean(layoutOptions?.normalizedPlacementArea),
    circleRadius: Math.max(
      1,
      Number(layoutOptions?.circleDiameter) > 0
        ? Number(layoutOptions.circleDiameter) / 2
        : CIRCLE_RADIUS
    ),
    pageBounds,
    weldFocusBounds,
    usePerimeterLayout,
    graphicIndex: buildGraphicSpatialIndex(
      layoutOptions?.graphicVectors,
      scale,
      pageBounds
    ),
    allowLeaderThroughGraphics: layoutOptions?.allowLeaderThroughGraphics === true,
    // 引线相交是全局强制禁用条件，不允许调用入口放宽。
    allowLeaderCrossing: false,
    allPipelineSegments,
    allTextRegions
  };
  env.longPipeGroupMap = buildLongPipeGroupMap(
    sorted,
    scale,
    pageBounds,
    env.circleRadius
  );

  const fixedLayoutMap = new Map(
    (layoutOptions?.fixedLayouts || [])
      .map(layout => [getIncrementalLayoutKey(layout), layout])
      .filter(([key]) => key)
  );
  const fixedEntriesByKey = new Map();
  sorted.forEach((weld) => {
    const key = getIncrementalLayoutKey(weld);
    const fixedEntry = toFixedLayoutEntry(weld, fixedLayoutMap.get(key));
    if (fixedEntry) fixedEntriesByKey.set(key, fixedEntry);
  });
  const fixedObstacleEntries = Array.from(fixedEntriesByKey.values());
  const entries = [];

  sorted.forEach((weld, index) => {
    const incrementalKey = getIncrementalLayoutKey(weld);
    const fixedEntry = fixedEntriesByKey.get(incrementalKey);
    if (fixedEntry) {
      entries.push(fixedEntry);
      return;
    }

    const placedNewEntries = entries.filter(entry => !entry.fixedIncrementalLayout);
    const state = buildPlacementState(
      [...fixedObstacleEntries, ...placedNewEntries],
      -1,
      getLayoutSegmentId(weld)
    );
    const placement = findBestPlacement(weld, state, env);

    entries.push({
      weld,
      ...placement
    });

    if (weld.relatedSegmentId || weld.relatedPipelineId) {
      const relationId = weld.relatedSegmentId || weld.relatedPipelineId;
      const collisionInfo = placement.usedFallback
        ? `，硬碰撞:${placement.hardCollisionCount}，阶段:${placement.selectionStage}`
        : `，阶段:${placement.selectionStage}`;
      console.log(`   焊点 ${index + 1} 关联到线段/管道 (${relationId})，布局方向: ${placement.meta.family}, 评分: ${placement.penalty.toFixed(1)}${collisionInfo}`);
    }
  });

  const requiresReoptimization = entries.some(entry => (
    !entry.fixedIncrementalLayout &&
    (
      entry.usedFallback ||
      entry.hardCollisionCount > 0 ||
      entry.constraintViolationCount > 0
    )
  ));

  for (
    let iteration = 0;
    requiresReoptimization && iteration < MAX_REOPTIMIZE_ITERATIONS;
    iteration++
  ) {
    const scoredEntries = entries.map((entry, index) => ({
      index,
      hardCollisionCount: getHardCollisionSummary(
        entry,
        buildPlacementState(entries, index, getLayoutSegmentId(entry.weld)),
        env
      ).total,
      penalty: evaluateCollisionPenalty(
        entry,
        buildPlacementState(entries, index, getLayoutSegmentId(entry.weld)),
        env
      )
    }));

    const problematicEntries = scoredEntries.filter(({ index, hardCollisionCount }) => (
      !entries[index].fixedIncrementalLayout &&
      (
        hardCollisionCount > 0 ||
        entries[index].usedFallback ||
        entries[index].constraintViolationCount > 0
      )
    ));
    if (problematicEntries.length === 0) {
      break;
    }
    const reoptimizeCount = Math.max(1, Math.ceil(entries.length * REOPTIMIZE_FRACTION));
    const targets = problematicEntries
      .sort((a, b) => {
        if (a.hardCollisionCount !== b.hardCollisionCount) {
          return b.hardCollisionCount - a.hardCollisionCount;
        }
        return b.penalty - a.penalty;
      })
      .slice(0, reoptimizeCount);

    let improved = false;

    targets.forEach(({ index, penalty: oldPenalty }) => {
      const state = buildPlacementState(entries, index, getLayoutSegmentId(entries[index].weld));
      const newPlacement = findBestPlacement(entries[index].weld, state, env);
      const oldHardCollisionCount = getHardCollisionSummary(entries[index], state, env).total;
      const shouldReplace = (
        newPlacement.hardCollisionCount < oldHardCollisionCount ||
        (newPlacement.hardCollisionCount === oldHardCollisionCount && newPlacement.penalty + 1 < oldPenalty)
      );

      if (shouldReplace) {
        entries[index] = {
          weld: entries[index].weld,
          ...newPlacement
        };
        improved = true;
      }
    });

    if (!improved) {
      break;
    }
  }

  return entries.map(toPublicLayoutEntry);
};
