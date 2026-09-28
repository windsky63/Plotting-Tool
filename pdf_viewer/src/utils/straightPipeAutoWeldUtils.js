import { PathTypeClassifier, PathType } from './PathTypeClassifier';
import { groupVectorsIntoPathsStructured } from './WeldDetector';
import { convertMaterialSizeMmToIntegerInch } from './batchAnnotationContentUtils';

const normalize = value => String(value ?? '').normalize('NFKC').trim();

const descriptionOf = row => normalize(
  row?.description || row?.materialDescription || row?.DESCRIPTION ||
  row?.rawMaterial?.DESCRIPTION || row?.rawLogicalRow?.[4] || row?.rawLogicalRow?.[1]
);

const categoryOf = row => normalize(
  row?.category || row?.type || row?.partType || row?.partNumber ||
  row?.['PART NO.'] || row?.rawMaterial?.['PART NO.'] || row?.rawLogicalRow?.[0]
);

const sizeOf = row => normalize(
  row?.specification || row?.diameter || row?.SIZE || row?.['SIZE(MM)'] ||
  row?.rawMaterial?.SIZE || row?.rawLogicalRow?.[2]
);

const LENGTH_WITH_UNIT_PATTERN = /^-?\d+(?:\.\d+)?\s*(?:MM|M|毫米|米)$/i;
const BARE_LENGTH_PATTERN = /^-?\d+(?:\.\d+)?$/;

const isPlausibleBareLength = value => {
  const text = normalize(value).replace(/,/g, '');
  if (!BARE_LENGTH_PATTERN.test(text)) return false;
  const number = Number(text);
  // Unit-less QTY values exist in older recognition results. Keep reasonable
  // values, but never allow a long ITEM CODE to become a pipe length.
  return Number.isFinite(number) && number > 0 && number <= 100000;
};

const quantityCandidateOf = row => {
  const explicitCandidates = [
    ['quantity', row?.quantity],
    ['qty', row?.qty],
    ['QTY', row?.QTY],
    ['rawMaterial.QTY', row?.rawMaterial?.QTY],
    ['rawMaterial.quantity', row?.rawMaterial?.quantity],
    ['rawMaterial.qty', row?.rawMaterial?.qty]
  ].map(([source, value]) => ({ source, value: normalize(value) }))
    .filter(candidate => candidate.value);
  const rawCandidates = (Array.isArray(row?.rawLogicalRow) ? row.rawLogicalRow : [])
    .map((value, index) => ({ source: `rawLogicalRow[${index}]`, value: normalize(value) }))
    .filter(candidate => candidate.value);
  const allCandidates = [...explicitCandidates, ...rawCandidates];

  // A length unit is unambiguous. Scan the full raw row so QTY can still be
  // recovered when OCR drops an empty ACC cell and shifts the columns.
  const unitCandidate = allCandidates.find(candidate => (
    LENGTH_WITH_UNIT_PATTERN.test(candidate.value.replace(/,/g, ''))
  ));
  if (unitCandidate) return unitCandidate;

  // Only trust unit-less values from named QTY fields or the stable QTY column.
  return explicitCandidates.find(candidate => isPlausibleBareLength(candidate.value)) ||
    rawCandidates.find(candidate => candidate.source === 'rawLogicalRow[5]' && isPlausibleBareLength(candidate.value)) ||
    null;
};

export const STRAIGHT_PIPE_WELD_SAFETY_LIMIT = 100;

export const isStraightPipeMaterialRow = row => {
  const text = `${categoryOf(row)} ${descriptionOf(row)}`.toUpperCase();
  if (!text) return false;
  const description = descriptionOf(row).toUpperCase();
  const materialIdentity = normalize(
    row?.materialId || row?.materialCode || row?.itemCode || row?.['ITEM CODE'] ||
    row?.rawMaterial?.['ITEM CODE'] || row?.rawLogicalRow?.[1]
  );
  // Section headers such as a lone "PIPE" are not material rows. Treating one
  // as a pipe produces an empty QTY that poisons the otherwise valid page.
  if (/^PIPES?$/.test(description) && !sizeOf(row) && (!materialIdentity || /^PIPES?$/.test(materialIdentity))) return false;
  if (/\bFITTINGS?\b|\bELBOW\b|\bTEE\b|\bREDUCER\b|\bFLANGE\b|\bSUPPORTS?\b|弯头|三通|异径|法兰|支架/.test(text)) {
    return false;
  }
  return /\bPIPE\b|\bSMLS\b|\bERW\b|管子|管材|钢管|无缝钢管|焊管/.test(text);
};

export const detectSteelClass = rows => {
  const text = (rows || []).map(row => `${categoryOf(row)} ${descriptionOf(row)}`).join(' ').toUpperCase();
  const stainless = /不锈钢|STAINLESS|\bSS\b|A312|304L?|316L?/.test(text);
  const carbon = /碳钢|CARBON|\bCS\b|A106|A53|API\s*5L/.test(text);
  if (stainless === carbon) return '';
  return stainless ? 'stainless' : 'carbon';
};

const parseLengthMetres = value => {
  const text = normalize(value).replace(/,/g, '').toUpperCase();
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match || /\b(?:PCS?|EA|件|个)\b/.test(text)) return NaN;
  const number = Number(match[0]);
  if (!Number.isFinite(number) || number <= 0) return NaN;
  if (/\bMM\b|毫米/.test(text)) return number / 1000;
  return number;
};

export const resolveStraightPipeMaterialPlan = (materialRows, { manualQuantity = '' } = {}) => {
  const pipeRows = (materialRows || []).filter(isStraightPipeMaterialRow);
  if (!pipeRows.length) return { eligible: false, reason: '未找到直管材料行' };

  const diameters = Array.from(new Set(pipeRows.map(row => (
    convertMaterialSizeMmToIntegerInch(sizeOf(row))
  )).filter(Boolean)));
  if (diameters.length !== 1) {
    return { eligible: false, reason: diameters.length ? '存在多种直管规格' : '无法确定直管规格' };
  }

  const steelClass = detectSteelClass(pipeRows);
  if (!steelClass) return { eligible: false, reason: '无法确定碳钢或不锈钢材质' };

  const normalizedManualQuantity = normalize(manualQuantity);
  const quantityCandidates = normalizedManualQuantity
    ? [{ source: 'manual', value: normalizedManualQuantity }]
    : pipeRows.map(quantityCandidateOf);
  const rawQuantityValues = quantityCandidates.map(candidate => candidate?.value || '');
  const quantitySources = quantityCandidates.map(candidate => candidate?.source || 'unresolved');
  const lengths = rawQuantityValues.map(parseLengthMetres);
  if (lengths.some(value => !Number.isFinite(value))) {
    return {
      eligible: false,
      reason: '直管 QTY 不是可用的长度',
      rawQuantityValues,
      quantitySources,
      parsedLengthsM: lengths.map(value => Number.isFinite(value) ? value : null),
      pipeRowCount: pipeRows.length
    };
  }
  const totalLengthM = lengths.reduce((sum, value) => sum + value, 0);
  const diameterInch = Number(diameters[0]);
  const referenceLengthM = steelClass === 'carbon'
    ? (diameterInch <= 2 ? 6 : diameterInch <= 8 ? 10 : 11)
    : (diameterInch <= 2 ? 6 : diameterInch <= 8 ? 8 : 10);
  const weldCount = Math.max(0, Math.ceil(totalLengthM / referenceLengthM) - 1);
  if (weldCount > STRAIGHT_PIPE_WELD_SAFETY_LIMIT) {
    return {
      eligible: false,
      reason: `计算出的补点数 ${weldCount} 超过安全上限 ${STRAIGHT_PIPE_WELD_SAFETY_LIMIT}`,
      steelClass,
      diameterInch,
      rawQuantityValues,
      quantitySources,
      parsedLengthsM: lengths,
      totalLengthM,
      referenceLengthM,
      weldCount,
      safetyLimit: STRAIGHT_PIPE_WELD_SAFETY_LIMIT,
      pipeRowCount: pipeRows.length
    };
  }

  return {
    eligible: true,
    steelClass,
    diameterInch,
    totalLengthM,
    referenceLengthM,
    weldCount,
    rawQuantityValues,
    quantitySources,
    parsedLengthsM: lengths,
    safetyLimit: STRAIGHT_PIPE_WELD_SAFETY_LIMIT,
    pipeRowCount: pipeRows.length
  };
};

const normalizeAngle = angle => {
  let result = angle % Math.PI;
  if (result < 0) result += Math.PI;
  return result;
};

const angleDifference = (left, right) => {
  const diff = Math.abs(normalizeAngle(left) - normalizeAngle(right));
  return Math.min(diff, Math.PI - diff);
};

const pointInArea = (point, area, pageInfo) => {
  if (!area || !pageInfo) return true;
  const width = Number(pageInfo.page_width || pageInfo.width || 0);
  const height = Number(pageInfo.page_height || pageInfo.height || 0);
  if (!width || !height) return true;
  const minX = Number(area.x || 0) * width;
  const minY = Number(area.y || 0) * height;
  const maxX = minX + Number(area.width || 0) * width;
  const maxY = minY + Number(area.height || 0) * height;
  return point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY;
};

const getVectorReferenceDiagonal = (vectors, area, pageInfo) => {
  const pageWidth = Number(pageInfo?.page_width || pageInfo?.width || 0);
  const pageHeight = Number(pageInfo?.page_height || pageInfo?.height || 0);
  if (pageWidth > 0 && pageHeight > 0) {
    const areaWidth = Number(area?.width || 0);
    const areaHeight = Number(area?.height || 0);
    if (areaWidth > 0 && areaHeight > 0 && areaWidth <= 1 && areaHeight <= 1) {
      return Math.hypot(pageWidth * areaWidth, pageHeight * areaHeight);
    }
    return Math.hypot(pageWidth, pageHeight);
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let pointCount = 0;
  const includePoint = (x, y) => {
    const normalizedX = Number(x);
    const normalizedY = Number(y);
    if (!Number.isFinite(normalizedX) || !Number.isFinite(normalizedY)) return;
    minX = Math.min(minX, normalizedX);
    minY = Math.min(minY, normalizedY);
    maxX = Math.max(maxX, normalizedX);
    maxY = Math.max(maxY, normalizedY);
    pointCount += 1;
  };
  (vectors || []).forEach(vector => {
    if (Array.isArray(vector)) {
      includePoint(vector[1], vector[2]);
      includePoint(vector[3], vector[4]);
      return;
    }
    includePoint(vector?.x1 ?? vector?.p1?.x, vector?.y1 ?? vector?.p1?.y);
    includePoint(vector?.x2 ?? vector?.p2?.x, vector?.y2 ?? vector?.p2?.y);
  });
  return pointCount >= 2 ? Math.hypot(maxX - minX, maxY - minY) : 0;
};

const getMinimumStraightPipeVectorLength = ({ vectors, area, pageInfo }) => {
  const referenceDiagonal = getVectorReferenceDiagonal(vectors, area, pageInfo);
  // A material-total pipe must occupy a meaningful span of the isometric area.
  // The cap keeps the rule usable on unusually large-coordinate PDFs.
  return Math.max(180, Math.min(650, referenceDiagonal * 0.16));
};

const pipeAxisFromClassification = (path, classification) => {
  const lines = (path.segments || [])
    .filter(segment => segment.type === 'line')
    .map(segment => ({
      ...segment,
      length: Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1)
    }))
    .sort((left, right) => right.length - left.length);
  if (lines.length < 2) return null;
  const primary = lines[0];
  let dx = primary.x2 - primary.x1;
  let dy = primary.y2 - primary.y1;
  const length = Math.hypot(dx, dy);
  if (!length) return null;
  dx /= length;
  dy /= length;
  if (dx < 0 || (Math.abs(dx) < 1e-8 && dy < 0)) {
    dx *= -1;
    dy *= -1;
  }
  const bbox = classification.features.bbox;
  return {
    pathId: path.id,
    center: { x: (bbox.minX + bbox.maxX) / 2, y: (bbox.minY + bbox.maxY) / 2 },
    direction: { x: dx, y: dy },
    angle: normalizeAngle(Math.atan2(dy, dx)),
    length: (lines[0].length + lines[1].length) / 2,
    structuralWidth: classification.features.structuralWidth || 1.5
  };
};

const pipeAxisFromRelatedSegment = related => {
  const start = related?.start || related?.segment?.p1 || {
    x: related?.segment?.x1,
    y: related?.segment?.y1
  };
  const end = related?.end || related?.segment?.p2 || {
    x: related?.segment?.x2,
    y: related?.segment?.y2
  };
  if (![start?.x, start?.y, end?.x, end?.y].every(Number.isFinite)) return null;
  let dx = end.x - start.x;
  let dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length < 20) return null;
  dx /= length;
  dy /= length;
  if (dx < 0 || (Math.abs(dx) < 1e-8 && dy < 0)) {
    dx *= -1;
    dy *= -1;
  }
  return {
    pathId: related.pathId || related.id || '',
    center: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
    direction: { x: dx, y: dy },
    angle: normalizeAngle(Math.atan2(dy, dx)),
    length,
    structuralWidth: 1.5
  };
};

const rawLineFromVector = (vector, index) => {
  const type = Array.isArray(vector) ? vector[0] : vector?.type;
  if (!(type === 1 || type === 'line' || type === 'LINE')) return null;
  const x1 = Number(Array.isArray(vector) ? vector[1] : (vector?.x1 ?? vector?.p1?.x));
  const y1 = Number(Array.isArray(vector) ? vector[2] : (vector?.y1 ?? vector?.p1?.y));
  const x2 = Number(Array.isArray(vector) ? vector[3] : (vector?.x2 ?? vector?.p2?.x));
  const y2 = Number(Array.isArray(vector) ? vector[4] : (vector?.y2 ?? vector?.p2?.y));
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  const length = Math.hypot(x2 - x1, y2 - y1);
  if (length < 8) return null;
  return {
    id: index,
    x1,
    y1,
    x2,
    y2,
    length,
    angle: normalizeAngle(Math.atan2(y2 - y1, x2 - x1)),
    endpoints: [{ x: x1, y: y1 }, { x: x2, y: y2 }]
  };
};

const pointToLineDistance = (point, line) => {
  const dx = line.x2 - line.x1;
  const dy = line.y2 - line.y1;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(point.x - line.x1, point.y - line.y1);
  const ratio = Math.max(0, Math.min(1, (
    (point.x - line.x1) * dx + (point.y - line.y1) * dy
  ) / lengthSquared));
  return Math.hypot(point.x - (line.x1 + ratio * dx), point.y - (line.y1 + ratio * dy));
};

const buildConnectedVectorGroupAxes = ({ vectors, existingWelds, area, pageInfo }) => {
  if (!Array.isArray(vectors) || !vectors.length) return [];
  const lines = vectors
    .map(rawLineFromVector)
    .filter(Boolean)
    .filter(line => pointInArea({ x: (line.x1 + line.x2) / 2, y: (line.y1 + line.y2) / 2 }, area, pageInfo));
  if (lines.length < 2) return [];

  const endpointTolerance = 6;
  const angleTolerance = 6 * Math.PI / 180;
  const buckets = new Map();
  const bucketKey = (x, y) => `${Math.floor(x / endpointTolerance)}:${Math.floor(y / endpointTolerance)}`;
  lines.forEach((line, lineIndex) => line.endpoints.forEach(point => {
    const key = bucketKey(point.x, point.y);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ lineIndex, point });
  }));

  const parents = lines.map((_, index) => index);
  const find = index => {
    let root = index;
    while (parents[root] !== root) root = parents[root];
    while (parents[index] !== index) {
      const next = parents[index];
      parents[index] = root;
      index = next;
    }
    return root;
  };
  const unite = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };

  lines.forEach((line, lineIndex) => line.endpoints.forEach(point => {
    const bucketX = Math.floor(point.x / endpointTolerance);
    const bucketY = Math.floor(point.y / endpointTolerance);
    for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
      for (let yOffset = -1; yOffset <= 1; yOffset += 1) {
        const nearby = buckets.get(`${bucketX + xOffset}:${bucketY + yOffset}`) || [];
        nearby.forEach(candidate => {
          if (candidate.lineIndex === lineIndex) return;
          if (angleDifference(line.angle, lines[candidate.lineIndex].angle) > angleTolerance) return;
          if (Math.hypot(point.x - candidate.point.x, point.y - candidate.point.y) > endpointTolerance) return;
          unite(lineIndex, candidate.lineIndex);
        });
      }
    }
  }));

  const grouped = new Map();
  lines.forEach((line, index) => {
    const root = find(index);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(line);
  });

  const weldCenters = (Array.isArray(existingWelds) ? existingWelds : [])
    .map(weld => weld?.center || { x: weld?.x, y: weld?.y })
    .filter(center => Number.isFinite(Number(center?.x)) && Number.isFinite(Number(center?.y)))
    .map(center => ({ x: Number(center.x), y: Number(center.y) }));

  return Array.from(grouped.values()).map((group, groupIndex) => {
    if (group.length < 2) return null;
    const primary = [...group].sort((left, right) => right.length - left.length)[0];
    let dx = primary.x2 - primary.x1;
    let dy = primary.y2 - primary.y1;
    const primaryLength = Math.hypot(dx, dy);
    if (!primaryLength) return null;
    dx /= primaryLength;
    dy /= primaryLength;
    if (dx < 0 || (Math.abs(dx) < 1e-8 && dy < 0)) {
      dx *= -1;
      dy *= -1;
    }
    const direction = { x: dx, y: dy };
    const normal = { x: -dy, y: dx };
    let minProjection = Infinity;
    let maxProjection = -Infinity;
    const offsets = [];
    group.forEach(line => line.endpoints.forEach(point => {
      const projection = point.x * dx + point.y * dy;
      minProjection = Math.min(minProjection, projection);
      maxProjection = Math.max(maxProjection, projection);
      offsets.push(point.x * normal.x + point.y * normal.y);
    }));
    const sortedOffsets = offsets.sort((left, right) => left - right);
    const offset = sortedOffsets[Math.floor(sortedOffsets.length / 2)];
    const touchesKnownWeld = weldCenters.some(center => group.some(line => pointToLineDistance(center, line) <= 12));
    // A page may contain a long straight pipe before any weld has been
    // recognized. In that case geometry must be allowed to establish the pipe
    // axis on its own. Use a stricter page-relative span for geometry-only
    // groups so short dimension/text strokes still cannot trigger auto welds.
    const groupLength = maxProjection - minProjection;
    const referenceDiagonal = getVectorReferenceDiagonal(vectors, area, pageInfo);
    const geometryOnlyMinimum = Math.max(
      getMinimumStraightPipeVectorLength({ vectors, area, pageInfo }) * 1.35,
      referenceDiagonal * 0.22
    );
    if (!touchesKnownWeld && groupLength < geometryOnlyMinimum) return null;
    return {
      pathId: `connected-vector-group-${groupIndex}`,
      center: {
        x: direction.x * ((minProjection + maxProjection) / 2) + normal.x * offset,
        y: direction.y * ((minProjection + maxProjection) / 2) + normal.y * offset
      },
      direction,
      angle: normalizeAngle(Math.atan2(dy, dx)),
      length: groupLength,
      structuralWidth: 1.5,
      segmentCount: group.length,
      source: 'connected-vector-group',
      hasKnownWeldConnection: touchesKnownWeld,
      geometryOnlyMinimum
    };
  }).filter(Boolean);
};

export const resolveSingleDirectionPipeRun = ({ vectors, existingWelds = [], area, pageInfo }) => {
  if (!Array.isArray(vectors) || !vectors.length) return { eligible: false, reason: '没有页面矢量' };
  const linkedAxesByPath = new Map();
  existingWelds.forEach(weld => {
    const axis = pipeAxisFromRelatedSegment(weld?.relatedSegment);
    if (!axis || !pointInArea(axis.center, area, pageInfo)) return;
    const key = axis.pathId || `${axis.center.x.toFixed(2)}:${axis.center.y.toFixed(2)}:${axis.angle.toFixed(3)}`;
    linkedAxesByPath.set(key, axis);
  });
  let axes = Array.from(linkedAxesByPath.values());

  const connectedGroupAxes = buildConnectedVectorGroupAxes({
    vectors,
    existingWelds,
    area,
    pageInfo
  });
  if (connectedGroupAxes.length > 0) {
    const weldConfirmedGroups = connectedGroupAxes.filter(axis => axis.hasKnownWeldConnection);
    // If a known weld confirms one or more groups, keep that stronger evidence
    // and suppress unrelated geometry-only lines. With no confirmed group,
    // retain the long geometry candidates so a blank pipe can still be filled.
    axes = [
      ...axes,
      ...(weldConfirmedGroups.length > 0 ? weldConfirmedGroups : connectedGroupAxes)
    ];
  }

  // Some PDFs draw pipes as closed narrow rectangles rather than center lines.
  // Use that established classifier only when weld-linked center lines are unavailable.
  if (!axes.length) {
    const paths = groupVectorsIntoPathsStructured(vectors);
    const classifications = new PathTypeClassifier(vectors).classifyAllPaths(paths);
    axes = paths.map(path => {
      const classification = classifications.get(path.id);
      if (classification?.type !== PathType.PIPELINE || classification.confidence < 0.9) return null;
      const axis = pipeAxisFromClassification(path, classification);
      return axis && pointInArea(axis.center, area, pageInfo) ? axis : null;
    }).filter(Boolean);
  }
  if (!axes.length) return { eligible: false, reason: '未可靠识别到直管' };

  const referenceAngle = axes[0].angle;
  const angleTolerance = 8 * Math.PI / 180;
  if (axes.some(axis => angleDifference(axis.angle, referenceAngle) > angleTolerance)) {
    return { eligible: false, reason: '单线图存在多个管道方向' };
  }

  const direction = axes[0].direction;
  const normal = { x: -direction.y, y: direction.x };
  const offsets = axes.map(axis => axis.center.x * normal.x + axis.center.y * normal.y);
  const sortedOffsets = [...offsets].sort((a, b) => a - b);
  const medianOffset = sortedOffsets[Math.floor(sortedOffsets.length / 2)];
  const medianWidth = [...axes.map(axis => axis.structuralWidth)].sort((a, b) => a - b)[Math.floor(axes.length / 2)];
  const offsetTolerance = Math.max(12, medianWidth * 8);
  if (offsets.some(offset => Math.abs(offset - medianOffset) > offsetTolerance)) {
    return { eligible: false, reason: '存在多根平行直管，无法确定补点对象' };
  }

  const intervals = axes.map(axis => {
    const projection = axis.center.x * direction.x + axis.center.y * direction.y;
    return { min: projection - axis.length / 2, max: projection + axis.length / 2 };
  }).sort((left, right) => left.min - right.min);
  let min = intervals[0].min;
  let max = intervals[0].max;
  for (let index = 1; index < intervals.length; index += 1) {
    const gap = intervals[index].min - max;
    const provisionalSpan = Math.max(max - min, intervals[index].max - intervals[index].min);
    if (gap > Math.max(30, provisionalSpan * 0.2)) {
      return { eligible: false, reason: '直管矢量不连续，无法安全合并' };
    }
    max = Math.max(max, intervals[index].max);
  }
  const length = max - min;
  if (length <= 0) return { eligible: false, reason: '直管长度无效' };
  const minimumLength = getMinimumStraightPipeVectorLength({ vectors, area, pageInfo });
  if (length < minimumLength) {
    return {
      eligible: false,
      reason: `识别到的直管矢量过短（${Math.round(length)}，最低需要 ${Math.round(minimumLength)}），已跳过自动补点`,
      recognizedLength: length,
      minimumLength
    };
  }
  const start = {
    x: direction.x * min + normal.x * medianOffset,
    y: direction.y * min + normal.y * medianOffset
  };
  const end = {
    x: direction.x * max + normal.x * medianOffset,
    y: direction.y * max + normal.y * medianOffset
  };
  return {
    eligible: true,
    start,
    end,
    length,
    minimumLength,
    angle: referenceAngle,
    pathCount: axes.length
  };
};

export const planStraightPipeAutoWelds = ({
  pageNum,
  materialRows,
  manualQuantity = '',
  vectors,
  existingWelds,
  area,
  pageInfo
}) => {
  const material = resolveStraightPipeMaterialPlan(materialRows, { manualQuantity });
  if (!material.eligible) {
    return { status: 'skipped', pageNum, reason: material.reason, material, addedWelds: [] };
  }
  if (material.weldCount === 0) {
    return { status: 'unchanged', pageNum, reason: '材料总长不超过单根参考长度', material, addedWelds: [] };
  }
  const retained = (existingWelds || []).filter(weld => weld.isAutoPipeLengthInserted !== true);
  const geometry = resolveSingleDirectionPipeRun({ vectors, existingWelds: retained, area, pageInfo });
  if (!geometry.eligible) {
    return { status: 'skipped', pageNum, reason: geometry.reason, material, geometry, addedWelds: [] };
  }

  const relatedPathId = `auto-straight-pipe-${pageNum}`;
  const relatedLine = {
    type: 'line',
    x1: geometry.start.x,
    y1: geometry.start.y,
    x2: geometry.end.x,
    y2: geometry.end.y,
    p1: geometry.start,
    p2: geometry.end
  };
  const relatedBbox = {
    minX: Math.min(geometry.start.x, geometry.end.x),
    minY: Math.min(geometry.start.y, geometry.end.y),
    maxX: Math.max(geometry.start.x, geometry.end.x),
    maxY: Math.max(geometry.start.y, geometry.end.y)
  };
  const relatedPipeline = {
    pathId: relatedPathId,
    segments: [relatedLine],
    bbox: relatedBbox,
    totalLength: geometry.length
  };
  const relatedSegment = {
    pathId: relatedPathId,
    segment: relatedLine,
    start: geometry.start,
    end: geometry.end,
    angle: geometry.angle,
    length: geometry.length,
    bbox: relatedBbox,
    pipeline: relatedPipeline
  };
  const candidates = [];
  for (let index = 1; index <= material.weldCount; index += 1) {
    const ratio = index / (material.weldCount + 1);
    const point = {
      x: geometry.start.x + (geometry.end.x - geometry.start.x) * ratio,
      y: geometry.start.y + (geometry.end.y - geometry.start.y) * ratio
    };
    const duplicatesExisting = retained.some(weld => {
      const center = weld.center || {};
      return Math.hypot(Number(center.x) - point.x, Number(center.y) - point.y) <= 8;
    });
    if (duplicatesExisting) continue;
    candidates.push({
      id: `auto-pipe-length-${pageNum}-${index}`,
      pathId: null,
      center: point,
      boundingBox: { minX: point.x - 3, minY: point.y - 3, maxX: point.x + 3, maxY: point.y + 3, width: 6, height: 6 },
      page: Number(pageNum),
      pageNum: Number(pageNum),
      relatedSegmentId: relatedPathId,
      relatedSegment,
      relatedSegmentAngle: geometry.angle,
      relatedPipelineId: relatedPathId,
      relatedPipeline,
      isAutoPipeLengthInserted: true,
      autoPipeLengthMeta: { ...material, positionIndex: index, positionCount: material.weldCount }
    });
  }
  const combined = [...retained, ...candidates];
  return {
    status: 'applied',
    pageNum,
    material,
    geometry,
    addedWelds: candidates,
    welds: combined
  };
};
