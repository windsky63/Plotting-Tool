const numberOr = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const getWeldPoint = weld => {
  const center = weld?.center || weld?.weldData?.center;
  if (center && Number.isFinite(Number(center.x)) && Number.isFinite(Number(center.y))) {
    return { x: Number(center.x), y: Number(center.y) };
  }
  if (Number.isFinite(Number(weld?.startX)) && Number.isFinite(Number(weld?.startY))) {
    return { x: Number(weld.startX), y: Number(weld.startY) };
  }
  return null;
};

export const getAiMergeDistance = pageInfo => {
  const width = numberOr(pageInfo?.page_width ?? pageInfo?.width);
  const height = numberOr(pageInfo?.page_height ?? pageInfo?.height);
  const diagonal = Math.hypot(width, height);
  return Math.max(10, Math.min(30, diagonal > 0 ? diagonal * 0.0025 : 15));
};

// AI detections and rule centers are both in the unscaled page coordinate
// space. This is a radius, not a square or a screen-zoom-dependent distance.
export const AI_RULE_HIT_RADIUS = 5;

const distanceBetween = (left, right) => {
  const a = getWeldPoint(left);
  const b = getWeldPoint(right);
  if (!a || !b) return Infinity;
  return Math.hypot(a.x - b.x, a.y - b.y);
};

const normalizeAiDetection = (detection, pageNum, index) => {
  const point = getWeldPoint(detection) || {
    x: numberOr(detection?.x),
    y: numberOr(detection?.y)
  };
  const confidence = Math.max(0, Math.min(1, numberOr(detection?.confidence)));
  return {
    ...detection,
    id: detection?.id || `ai-${pageNum}-${index}-${point.x.toFixed(2)}-${point.y.toFixed(2)}`,
    reviewId: detection?.reviewId || `ai-review-${pageNum}-${index}-${point.x.toFixed(2)}-${point.y.toFixed(2)}`,
    center: point,
    pageNum: Number(pageNum),
    pageIndex: index,
    confidence,
    aiConfidence: confidence,
    recognitionSource: 'ai',
    recognitionSources: ['ai'],
    reviewSource: 'ai',
    reviewReason: 'ai_only',
    isAiReviewCandidate: true,
    modelVersion: String(detection?.modelVersion || '')
  };
};

/**
 * AI is an additive candidate source. Rule welds are never removed here.
 * AI-only results remain review candidates until an operator accepts them.
 */
export const fuseRuleAndAiWelds = ({
  ruleWelds = [],
  aiDetections = [],
  pageNum = 1,
  pageInfo = null,
  mergeDistance = null
} = {}) => {
  const threshold = mergeDistance !== null && mergeDistance !== undefined && mergeDistance !== '' &&
    Number.isFinite(Number(mergeDistance)) && Number(mergeDistance) >= 0
    ? Number(mergeDistance)
    : AI_RULE_HIT_RADIUS;
  const normalizedAi = (aiDetections || []).map((item, index) => (
    normalizeAiDetection(item, pageNum, index)
  ));
  const matchedAiIndexes = new Set();

  const welds = (ruleWelds || []).map(ruleWeld => {
    let nearestIndex = -1;
    let nearestDistance = Infinity;
    normalizedAi.forEach((aiWeld, index) => {
      if (matchedAiIndexes.has(index)) return;
      const distance = distanceBetween(ruleWeld, aiWeld);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    });

    if (nearestIndex < 0 || nearestDistance > threshold) {
      return {
        ...ruleWeld,
        recognitionSource: ruleWeld?.recognitionSource || 'rule',
        recognitionSources: Array.from(new Set([
          ...(ruleWeld?.recognitionSources || []),
          'rule'
        ]))
      };
    }

    const aiWeld = normalizedAi[nearestIndex];
    matchedAiIndexes.add(nearestIndex);
    return {
      ...ruleWeld,
      recognitionSource: 'rule+ai',
      recognitionSources: Array.from(new Set([
        ...(ruleWeld?.recognitionSources || []),
        'rule',
        'ai'
      ])),
      aiConfidence: aiWeld.aiConfidence,
      aiDetectionId: aiWeld.id,
      aiModelVersion: aiWeld.modelVersion,
      aiMatchDistance: nearestDistance
    };
  });

  const reviewCandidates = normalizedAi.filter((_, index) => !matchedAiIndexes.has(index));
  return {
    welds,
    reviewCandidates,
    diagnostics: {
      ruleCount: ruleWelds.length,
      aiCount: normalizedAi.length,
      matchedCount: matchedAiIndexes.size,
      aiOnlyCount: reviewCandidates.length,
      ruleOnlyCount: welds.filter(weld => !weld.recognitionSources?.includes('ai')).length,
      mergeDistance: threshold
    }
  };
};

export const isTrainableWeldAnnotation = annotation => {
  if (!annotation) return false;
  if (annotation.isScaffoldAnnotation || annotation.isValveAnnotation) return false;
  if (annotation?.weldData?.isWeldedSupport || annotation.isWeldedSupport) return false;
  if (annotation?.weldData?.isStaticGrounding || /^E\d+$/i.test(String(annotation.text || '').trim())) return false;

  const shape = String(annotation.borderShape || '').toLowerCase();
  if (['none', 'rectangle', 'rect', 'pipe-tag'].includes(shape)) return false;
  return Boolean(getWeldPoint(annotation));
};

const PDF_LAYOUT_BASE_SCALE = 2;
const toPoint = point => (
  point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y))
    ? { x: Number(point.x), y: Number(point.y) }
    : null
);
const distance = (left, right) => Math.hypot(left.x - right.x, left.y - right.y);
const toPdfPoint = point => ({
  x: point.x / PDF_LAYOUT_BASE_SCALE,
  y: point.y / PDF_LAYOUT_BASE_SCALE
});

const getLeaderPoints = annotation => {
  const storedPoints = annotation?.leaderPoints || annotation?.leaderLinePoints || annotation?.linePoints;
  const normalizedStored = Array.isArray(storedPoints) ? storedPoints.map(toPoint).filter(Boolean) : [];
  if (normalizedStored.length >= 2) return normalizedStored;
  const start = toPoint({ x: annotation?.startX, y: annotation?.startY });
  const end = toPoint({ x: annotation?.endX, y: annotation?.endY });
  return start && end ? [start, end] : [];
};

// Preserve the exact text shown inside the weld annotation. Structured
// metadata is only a fallback for editable PDFs whose visible text field is
// unavailable; never send an empty or over-limit guessed value.
export const getConfirmedWeldNumber = annotation => {
  const candidates = [
    annotation?.text,
    annotation?.weldData?.displayNumber,
    annotation?.displayNumber,
    annotation?.weldData?.weldNumber,
    annotation?.weldNumber,
    annotation?.number
  ];
  const value = candidates.find(candidate => (
    candidate !== undefined && candidate !== null && String(candidate).trim()
  ));
  if (value === undefined) return undefined;
  const normalized = String(value).trim();
  return normalized.length <= 120 ? normalized : undefined;
};

const CONFIRMED_PIPELINE_SOURCES = new Set([
  'business_data', 'user_confirmed', 'ocr_confirmed', 'inferred'
]);

const cleanPipelineText = (value, { uppercase = false } = {}) => {
  if (value === undefined || value === null) return '';
  const cleaned = String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '')
    .trim()
    .replace(/\s+/g, '');
  if (!cleaned || cleaned.length > 240) return '';
  return uppercase ? cleaned.toUpperCase() : cleaned;
};

export const getConfirmedPipelineInfo = annotation => {
  const value = [annotation?.pipelineNumber, annotation?.weldData?.pipelineNumber]
    .find(candidate => cleanPipelineText(candidate));
  const pipelineNumber = cleanPipelineText(value, { uppercase: true });
  // The app already treats OCR results made only of digits as invalid
  // pipeline numbers. Keep that protection here while preserving leading
  // zeroes inside real identifiers such as 001-P/A-01.
  if (!pipelineNumber || /^\d+$/.test(pipelineNumber)) return null;
  const rawCandidate = [
    annotation?.pipelineNumberRaw,
    annotation?.weldData?.pipelineNumberRaw,
    value
  ].find(candidate => cleanPipelineText(candidate));
  const explicitSource = [
    annotation?.pipelineNumberSource,
    annotation?.weldData?.pipelineNumberSource
  ].map(source => String(source || '').trim().toLowerCase())
    .find(source => CONFIRMED_PIPELINE_SOURCES.has(source));
  const detectionSource = String(
    annotation?.pipelineSource || annotation?.weldData?.pipelineSource || ''
  ).toLowerCase();
  const pipelineNumberSource = explicitSource || (
    annotation?.origin === 'manual' || annotation?.weldData?.isManualInserted
      ? 'user_confirmed'
      : /ocr|mineru|paddle|text-recognition/.test(detectionSource)
        ? 'inferred'
        : 'business_data'
  );
  return {
    pipelineNumber,
    pipelineNumberRaw: cleanPipelineText(rawCandidate) || pipelineNumber,
    pipelineNumberSource
  };
};

const getPagePipelineFallback = (pipelineNumberByPage, page) => {
  const value = pipelineNumberByPage?.[page];
  if (value === undefined || value === null) return null;
  return getConfirmedPipelineInfo(
    typeof value === 'object' ? value : { pipelineNumber: value }
  );
};

const legacyJointToken = '(BW|SW|RR|OL|AW|SBR|承插焊|对接焊|承插|对接)';
const legacyDiameterToken = '(?:\\d+(?:\\.\\d+)?(?:\\s+\\d+/\\d+|/\\d+)?)';
const legacyJointPatterns = [
  new RegExp(`^${legacyJointToken}$`, 'i'),
  new RegExp(`^${legacyDiameterToken}\\s*"?\\s*${legacyJointToken}$`, 'i'),
  new RegExp(`^"\\s*${legacyJointToken}\\s*${legacyDiameterToken}$`, 'i'),
];

export const getConfirmedJointType = annotation => {
  const candidates = [
    annotation?.jointTypeText,
    annotation?.weldData?.annotationJointTypeText,
    annotation?.weldData?.jointTypeText,
    annotation?.jointType,
    annotation?.weldData?.jointType
  ];
  const value = candidates.find(candidate => (
    candidate !== undefined && candidate !== null && String(candidate).trim()
  ));
  if (value === undefined) {
    // Older editable PDFs store the entire upper half in topText rather than
    // keeping diameter and jointTypeText separate. Read only that weld's own
    // split-circle text, never material/page/neighbour guesses or remarks.
    if (annotation?.borderShape !== 'split-circle') return undefined;
    const top = String(annotation.topText || '').trim().replace(/[“”″＂]/g, '"');
    // Includes historical "BW6 (joint first, then diameter). Compile once,
    // because completeness summaries can inspect thousands of annotations.
    for (const pattern of legacyJointPatterns) {
      const match = top.match(pattern);
      if (match) return match[1];
    }
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized.length <= 120 ? normalized : undefined;
};

/**
 * Resolve the endpoint that is away from the annotation circle. The editable
 * annotation currently stores startX/startY at the pipe and endX/endY at the
 * circle centre, but distance-based resolution also protects future reversed
 * or polyline geometry.
 */
export const resolveLeaderPipeEnd = annotation => {
  if (!annotation || annotation.hasLeaderLine === false) {
    return { valid: false, reason: 'missing_leader' };
  }
  const circleCenter = toPoint({ x: annotation.endX, y: annotation.endY });
  const leaderPoints = getLeaderPoints(annotation);
  if (!circleCenter || leaderPoints.length < 2) {
    return { valid: false, reason: 'missing_geometry' };
  }
  const first = leaderPoints[0];
  const last = leaderPoints[leaderPoints.length - 1];
  const firstDistance = distance(first, circleCenter);
  const lastDistance = distance(last, circleCenter);
  const lineLength = leaderPoints.slice(1).reduce(
    (total, point, index) => total + distance(leaderPoints[index], point),
    0
  );
  const ambiguityTolerance = Math.max(2, Math.min(12, lineLength * 0.02));
  if (lineLength <= ambiguityTolerance || Math.abs(firstDistance - lastDistance) <= ambiguityTolerance) {
    return { valid: false, reason: 'ambiguous_endpoints' };
  }
  const pipeEnd = firstDistance > lastDistance ? first : last;
  const circleEnd = firstDistance > lastDistance ? last : first;
  return {
    valid: true,
    leaderPipeEnd: toPdfPoint(pipeEnd),
    circleCenter: toPdfPoint(circleCenter),
    leaderCircleEnd: toPdfPoint(circleEnd),
    leaderPoints: leaderPoints.map(toPdfPoint),
    lineLength: lineLength / PDF_LAYOUT_BASE_SCALE
  };
};

export const buildConfirmedWeldLabels = (annotations, { pipelineNumberByPage = {} } = {}) => (annotations || [])
  .filter(isTrainableWeldAnnotation)
  .map(annotation => {
    const resolved = resolveLeaderPipeEnd(annotation);
    if (!resolved.valid) return null;
    const weldNumber = getConfirmedWeldNumber(annotation);
    const jointType = getConfirmedJointType(annotation);
    // Current business rule: a PDF page has one pipeline-number region. An
    // annotation-owned value remains more specific; otherwise reuse the saved
    // region result for that page without another OCR request.
    const pipelineInfo = getConfirmedPipelineInfo(annotation) ||
      getPagePipelineFallback(pipelineNumberByPage, Number(annotation.page || 1));
    return {
      annotationId: String(annotation.id || ''),
      page: Number(annotation.page || 1),
      center: resolved.circleCenter,
      leaderPipeEnd: resolved.leaderPipeEnd,
      leaderCircleEnd: resolved.leaderCircleEnd,
      leaderPoints: resolved.leaderPoints,
      leaderLength: resolved.lineLength,
      ...(weldNumber ? { weldNumber } : {}),
      ...(jointType ? { jointType } : {}),
      ...(pipelineInfo || {}),
      stableKey: String(annotation?.weldData?.stableKey || ''),
      source: annotation?.weldData?.isManualInserted || annotation.origin === 'manual'
        ? 'manual'
        : 'confirmed',
      originalDetectionSource: String(
        annotation?.weldData?.recognitionSource || annotation.recognitionSource || ''
      )
    };
  })
  .filter(Boolean);

export const summarizeConfirmedWeldLabels = (annotations, { pipelineNumberByPage = {} } = {}) => {
  const trainable = (annotations || []).filter(isTrainableWeldAnnotation);
  const labels = [];
  const rejected = [];
  trainable.forEach(annotation => {
    const resolved = resolveLeaderPipeEnd(annotation);
    if (!resolved.valid) {
      rejected.push({
        annotationId: String(annotation?.id || ''),
        page: Number(annotation?.page || 1),
        reason: resolved.reason
      });
      return;
    }
    labels.push(annotation);
  });
  const numberedCount = labels.filter(annotation => getConfirmedWeldNumber(annotation)).length;
  const jointTypeCount = labels.filter(annotation => getConfirmedJointType(annotation)).length;
  const getPipelineInfo = annotation => getConfirmedPipelineInfo(annotation) ||
    getPagePipelineFallback(pipelineNumberByPage, Number(annotation?.page || 1));
  const pipelineCount = labels.filter(annotation => getPipelineInfo(annotation)).length;
  const completeCount = labels.filter(annotation => (
    getConfirmedWeldNumber(annotation) && getConfirmedJointType(annotation)
  )).length;
  const fullyQualifiedCount = labels.filter(annotation => (
    getConfirmedWeldNumber(annotation) && getConfirmedJointType(annotation) &&
    getPipelineInfo(annotation)
  )).length;
  const missingPipelinePages = Array.from(new Set(
    labels.filter(annotation => !getPipelineInfo(annotation))
      .map(annotation => Number(annotation?.page || 1))
  )).sort((left, right) => left - right);
  return {
    trainableCount: trainable.length,
    validCount: labels.length,
    numberedCount,
    jointTypeCount,
    pipelineCount,
    completeCount,
    fullyQualifiedCount,
    missingPipelinePages,
    rejected
  };
};
