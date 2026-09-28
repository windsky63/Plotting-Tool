import { replaceWeldDisplayNumber } from './weldDisplayNumberUtils';

const asFiniteNumber = value => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const normalizePipeline = value => String(value || '').trim().toUpperCase().replace(/\s+/g, '');

export const resolvePipelineFromWeldAnnotations = ({
  welds = [],
  currentPage = 1,
  currentPipelineNumber = ''
}) => {
  const page = Number(currentPage || 1);
  const pagePipelineCounts = new Map();
  (Array.isArray(welds) ? welds : []).forEach(weld => {
    if (weld?.isWeldedSupport === true) return;
    const weldPage = Number(weld?.page || weld?.pageNum);
    const pipelineNumber = normalizePipeline(weld?.pipelineNumber);
    if (!Number.isFinite(weldPage) || !pipelineNumber) return;
    if (!pagePipelineCounts.has(weldPage)) pagePipelineCounts.set(weldPage, new Map());
    const counts = pagePipelineCounts.get(weldPage);
    counts.set(pipelineNumber, (counts.get(pipelineNumber) || 0) + 1);
  });
  const pipelineByPage = new Map(
    Array.from(pagePipelineCounts.entries()).map(([weldPage, counts]) => [
      weldPage,
      Array.from(counts.entries()).sort((left, right) => right[1] - left[1])[0][0]
    ])
  );
  const annotationPages = Array.from(pipelineByPage.keys()).sort((left, right) => left - right);
  const regularWeldPages = Array.from(new Set(
    (Array.isArray(welds) ? welds : [])
      .filter(weld => weld?.isWeldedSupport !== true)
      .map(weld => Number(weld?.page || weld?.pageNum))
      .filter(Number.isFinite)
  )).sort((left, right) => left - right);
  const pagePipeline = pipelineByPage.get(page) || '';
  const regionPipeline = normalizePipeline(currentPipelineNumber);
  const requestedPipeline = pagePipeline || regionPipeline;
  const getMatchedPagesForPipeline = pipelineNumber => {
    const normalizedPipeline = normalizePipeline(pipelineNumber);
    if (!normalizedPipeline) return [];
    const explicitMatchedPages = annotationPages.filter(
      candidatePage => pipelineByPage.get(candidatePage) === normalizedPipeline
    );
    const inferredMatchedPages = regularWeldPages.filter(candidatePage => {
        if (pipelineByPage.has(candidatePage)) return false;
        const previousPage = annotationPages.filter(pageNumber => pageNumber < candidatePage).pop();
        const nextPage = annotationPages.find(pageNumber => pageNumber > candidatePage);
        return Boolean(
          previousPage &&
          nextPage &&
          pipelineByPage.get(previousPage) === normalizedPipeline &&
          pipelineByPage.get(nextPage) === normalizedPipeline
        );
      });
    return Array.from(new Set([
      ...explicitMatchedPages,
      ...inferredMatchedPages
    ])).sort((left, right) => left - right);
  };
  const allMatchedPages = getMatchedPagesForPipeline(requestedPipeline);

  // A directly recognized region is sufficient evidence for its own page.
  // It does not authorize binding unrecognized neighbouring pages.
  if (requestedPipeline && allMatchedPages.length === 0) {
    return {
      status: 'resolved', pipelineNumber: requestedPipeline,
      matchedPages: [page], matchedPage: page,
      source: 'current-page-pipeline-area', candidates: [requestedPipeline]
    };
  }

  if (requestedPipeline && allMatchedPages.length > 0) {
    return {
      status: 'resolved',
      pipelineNumber: requestedPipeline,
      matchedPages: allMatchedPages,
      matchedPage: pagePipeline ? page : allMatchedPages.reduce((nearest, candidatePage) => (
        nearest === null || Math.abs(candidatePage - page) < Math.abs(nearest - page)
          ? candidatePage
          : nearest
      ), null),
      source: pagePipeline ? 'current-page-annotation' : 'pipeline-area-annotation-match',
      candidates: [requestedPipeline]
    };
  }

  const previousPage = annotationPages.filter(candidatePage => candidatePage < page).pop();
  const nextPage = annotationPages.find(candidatePage => candidatePage > page);
  const previousPipeline = pipelineByPage.get(previousPage) || '';
  const nextPipeline = pipelineByPage.get(nextPage) || '';
  if (previousPipeline && previousPipeline === nextPipeline) {
    const matchedPages = getMatchedPagesForPipeline(previousPipeline);
    return {
      status: 'resolved',
      pipelineNumber: previousPipeline,
      matchedPages,
      matchedPage: `${previousPage}、${nextPage}`,
      source: 'surrounding-annotation-match',
      candidates: [previousPipeline]
    };
  }

  return {
    status: 'unresolved',
    pipelineNumber: '',
    matchedPages: [],
    matchedPage: null,
    source: 'annotation-needs-confirmation',
    candidates: Array.from(new Set([
      regionPipeline,
      previousPipeline,
      nextPipeline
    ].filter(Boolean)))
  };
};

export const getRecoverableWeldNumber = annotation => {
  const structured = annotation?.weldData?.weldNumber ?? annotation?.weldNumber ?? annotation?.number;
  const structuredNumber = asFiniteNumber(structured);
  if (structuredNumber !== null) return structuredNumber;
  const match = String(annotation?.text || '').match(/\d+/);
  return match ? Number(match[0]) : null;
};

export const getRecoverableWeldCenter = annotation => {
  // A weld label without a leader has no separate pipe-side anchor. Its own
  // frame centre is therefore the only truthful selectable weld position.
  if (
    annotation?.hasLeaderLine === false &&
    Number.isFinite(Number(annotation?.endX)) &&
    Number.isFinite(Number(annotation?.endY))
  ) {
    return { x: Number(annotation.endX) / 2, y: Number(annotation.endY) / 2 };
  }
  // The visible leader start is the authoritative weld position in an
  // editable PDF. Layout coordinates are stored at the fixed 2x PDF baseline,
  // while WeldNumberOverlay expects the original recognition coordinate.
  if (Number.isFinite(Number(annotation?.startX)) && Number.isFinite(Number(annotation?.startY))) {
    return { x: Number(annotation.startX) / 2, y: Number(annotation.startY) / 2 };
  }
  const embeddedCenter = annotation?.weldData?.center;
  if (Number.isFinite(Number(embeddedCenter?.x)) && Number.isFinite(Number(embeddedCenter?.y))) {
    return { x: Number(embeddedCenter.x), y: Number(embeddedCenter.y) };
  }
  // Older editable exports may retain the visible annotation fields but not
  // weldData. For a leader annotation startX/startY is the original weld point.
  return null;
};

export const isRecoverableWeldAnnotation = annotation => {
  const center = getRecoverableWeldCenter(annotation);
  const number = getRecoverableWeldNumber(annotation);
  const shape = String(annotation?.borderShape || '').toLowerCase();
  const isWeldShape = ['diamond', 'circle', 'split-circle', 'field-weld', 'shop-weld'].includes(shape);
  const hasVisibleNumber = /\d+/.test(String(annotation?.text || ''));
  const hasWeldMarker = Boolean(
    annotation?.weldData ||
    annotation?.isBatchGenerated ||
    annotation?.batchRunId ||
    isWeldShape
  );
  return !!(
    annotation &&
    annotation?.isWeldedSupport !== true &&
    annotation?.weldData?.isWeldedSupport !== true &&
    isWeldShape &&
    hasVisibleNumber &&
    hasWeldMarker &&
    Number.isFinite(center?.x) &&
    Number.isFinite(center?.y) &&
    Number.isFinite(number)
  );
};

export const buildReopenedWeldSequence = (annotations = [], currentPage = 1) => {
  const recoverable = (Array.isArray(annotations) ? annotations : [])
    .map((annotation, sourceIndex) => ({ annotation, sourceIndex }))
    .filter(({ annotation }) => isRecoverableWeldAnnotation(annotation));

  if (recoverable.length === 0) {
    return { welds: [], pageRange: null, batchRunId: '', sourceCount: 0, skippedBatchCount: 0 };
  }

  // An editable PDF may have been generated or adjusted several times, so one
  // physical pipeline can span several historical batchRunIds. Recovering only
  // the batch visible on the current page truncates the numbering chain and
  // prevents later pages from shifting. Keep every recoverable weld; exact
  // sourceAnnotationId replacement keeps unrelated annotations safe on save.
  const groups = new Map();
  recoverable.forEach(item => {
    const batchRunId = String(item.annotation?.batchRunId || '').trim();
    const key = batchRunId || '__NO_BATCH__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  const rankedGroups = Array.from(groups.entries()).sort((left, right) => {
    const leftOnPage = left[1].some(item => Number(item.annotation?.page || 1) === Number(currentPage));
    const rightOnPage = right[1].some(item => Number(item.annotation?.page || 1) === Number(currentPage));
    if (leftOnPage !== rightOnPage) return rightOnPage ? 1 : -1;
    return right[1].length - left[1].length;
  });
  const [selectedGroupKey] = rankedGroups[0];
  const batchRunId = selectedGroupKey === '__NO_BATCH__' ? '' : selectedGroupKey;

  const welds = recoverable
    .sort((left, right) => {
      const pageDelta = Number(left.annotation?.page || 1) - Number(right.annotation?.page || 1);
      return pageDelta || left.sourceIndex - right.sourceIndex;
    })
    .map(({ annotation, sourceIndex }) => {
      const weldData = annotation.weldData || {};
      const page = Number(annotation.page || weldData.pageNum || 1);
      const weldNumber = getRecoverableWeldNumber(annotation);
      const weldCenter = getRecoverableWeldCenter(annotation);
      const pipelineNumber = String(annotation.pipelineNumber || weldData.pipelineNumber || '').trim();
      const stableKey = String(weldData.stableKey || '').trim();
      const isWeldedSupport = annotation.isWeldedSupport === true || weldData.isWeldedSupport === true;
      return {
        ...weldData,
        id: stableKey || annotation.id || `reopened-weld-${page}-${sourceIndex}`,
        pathId: weldData.pathId ?? null,
        sourceStableKey: stableKey,
        sourceAnnotationId: annotation.id,
        center: weldCenter,
        boundingBox: weldData.boundingBox || {
          minX: weldCenter.x - 3,
          minY: weldCenter.y - 3,
          width: 6,
          height: 6
        },
        page,
        pageNum: page,
        weldNumber,
        number: weldNumber,
        displayNumber: String(annotation.text || weldNumber),
        pipelineNumber,
        pipelineNumberRaw: annotation.pipelineNumberRaw || weldData.pipelineNumberRaw || pipelineNumber,
        pipelineNumberSource: annotation.pipelineNumberSource ||
          weldData.pipelineNumberSource || (pipelineNumber ? 'business_data' : ''),
        numberingScopeKey: isWeldedSupport
          ? `__SUPPORT_${normalizePipeline(pipelineNumber) || `PAGE_${page}`}`
          : (normalizePipeline(pipelineNumber) || `__PAGE_${page}`),
        pipeClass: annotation.pipeClass || annotation.pipelineClass || weldData.pipeClass || weldData.pipelineClass || '',
        pipelineClass: annotation.pipeClass || annotation.pipelineClass || weldData.pipeClass || weldData.pipelineClass || '',
        batchRunId: annotation.batchRunId || batchRunId,
        isWeldedSupport,
        supportCode: annotation.supportCode || weldData.supportCode || '',
        annotationTopText: annotation.topText ?? '',
        annotationJointTypeText: annotation.jointTypeText ?? '',
        annotationBorderShape: annotation.borderShape || 'split-circle',
        annotationFontSize: annotation.fontSize,
        annotationTopFontSize: annotation.topFontSize,
        annotationBottomFontSize: annotation.bottomFontSize,
        annotationFrameSize: annotation.frameSize,
        annotationFrameSizeMode: annotation.frameSizeMode,
        annotationColor: annotation.color || '#ff0000',
        annotationRuleId: annotation.ruleId || null,
        annotationRuleName: annotation.ruleName || ''
      };
    });

  const pages = welds.map(weld => weld.page).filter(Number.isFinite);
  return {
    welds,
    pageRange: pages.length > 0
      ? { startPage: Math.min(...pages), endPage: Math.max(...pages) }
      : null,
    batchRunId,
    sourceCount: welds.length,
    skippedBatchCount: 0
  };
};

const replaceRecoveredDisplayNumber = (displayNumber, oldNumber, nextNumber) => {
  return replaceWeldDisplayNumber(displayNumber, oldNumber, nextNumber);
};

/**
 * Repair the common legacy export defect where every page of the same
 * pipeline restarts at 1. Existing non-overlapping ranges are preserved; only
 * a later page whose range overlaps the preceding range is moved forward.
 */
export const repairReopenedPageNumberingContinuity = (welds = []) => {
  const source = (Array.isArray(welds) ? welds : []).map(weld => ({ ...weld }));
  const indexesByPipelineAndPage = new Map();
  source.forEach((weld, index) => {
    if (weld?.isWeldedSupport === true) return;
    const pipeline = normalizePipeline(weld?.pipelineNumber);
    const page = Number(weld?.page || weld?.pageNum);
    if (!pipeline || !Number.isFinite(page) || !Number.isFinite(Number(weld?.weldNumber))) return;
    if (!indexesByPipelineAndPage.has(pipeline)) indexesByPipelineAndPage.set(pipeline, new Map());
    const pages = indexesByPipelineAndPage.get(pipeline);
    if (!pages.has(page)) pages.set(page, []);
    pages.get(page).push(index);
  });

  let adjustedCount = 0;
  indexesByPipelineAndPage.forEach(pages => {
    let previousMax = null;
    Array.from(pages.entries())
      .sort((left, right) => left[0] - right[0])
      .forEach(([, indexes]) => {
        const numbers = indexes.map(index => Number(source[index].weldNumber)).filter(Number.isFinite);
        if (numbers.length === 0) return;
        const pageMin = Math.min(...numbers);
        const offset = previousMax !== null && pageMin <= previousMax
          ? previousMax + 1 - pageMin
          : 0;
        if (offset > 0) {
          indexes.forEach(index => {
            const weld = source[index];
            const oldNumber = Number(weld.weldNumber);
            const nextNumber = oldNumber + offset;
            source[index] = {
              ...weld,
              originalRecoveredWeldNumber: weld.originalRecoveredWeldNumber ?? oldNumber,
              continuityAdjusted: true,
              weldNumber: nextNumber,
              number: nextNumber,
              displayNumber: replaceRecoveredDisplayNumber(weld.displayNumber, oldNumber, nextNumber)
            };
            adjustedCount += 1;
          });
        }
        previousMax = Math.max(
          previousMax ?? Number.NEGATIVE_INFINITY,
          ...indexes.map(index => Number(source[index].weldNumber)).filter(Number.isFinite)
        );
      });
  });
  return { welds: source, adjustedCount };
};

export const buildReopenedAnnotationRule = (welds = [], currentPage = 1) => {
  const source = Array.isArray(welds) ? welds : [];
  const exemplar = source.find(weld => Number(weld.page || weld.pageNum) === Number(currentPage)) || source[0];
  if (!exemplar) return null;
  const display = String(exemplar.displayNumber || exemplar.weldNumber || '');
  const numberText = String(exemplar.weldNumber ?? '');
  const numberIndex = numberText ? display.indexOf(numberText) : -1;
  const prefix = numberIndex >= 0 ? display.slice(0, numberIndex) : '';
  const suffix = numberIndex >= 0 ? display.slice(numberIndex + numberText.length) : '';
  return {
    id: exemplar.annotationRuleId || `reopened-weld-rule-${Date.now()}`,
    name: exemplar.annotationRuleName || '已打开PDF补点',
    prefix,
    suffix,
    increment: 1,
    startNumber: Math.min(...source.map(weld => Number(weld.weldNumber)).filter(Number.isFinite)),
    color: exemplar.annotationColor || '#ff0000',
    fontSize: exemplar.annotationFontSize || 34,
    topFontSize: exemplar.annotationTopFontSize,
    bottomFontSize: exemplar.annotationBottomFontSize,
    frameSize: exemplar.annotationFrameSize || 56.7,
    frameSizeMode: exemplar.annotationFrameSizeMode,
    borderShape: exemplar.annotationBorderShape || 'split-circle',
    batchContent: {
      diameterSource: 'manual',
      jointTypeSource: 'manual',
      manualDiameter: exemplar.annotationTopText || '',
      manualJointType: exemplar.annotationJointTypeText || ''
    }
  };
};

export const findReopenedWeldTemplate = (
  welds = [],
  pageNum,
  pipelineNumber,
  targetNumber,
  targetCenter = null
) => {
  const normalizedPipeline = normalizePipeline(pipelineNumber);
  const hasTargetCenter = Number.isFinite(Number(targetCenter?.x)) && Number.isFinite(Number(targetCenter?.y));
  const centerDistance = weld => {
    if (!hasTargetCenter) return Number.POSITIVE_INFINITY;
    const center = weld?.center;
    if (!Number.isFinite(Number(center?.x)) || !Number.isFinite(Number(center?.y))) {
      return Number.POSITIVE_INFINITY;
    }
    return Math.hypot(Number(center.x) - Number(targetCenter.x), Number(center.y) - Number(targetCenter.y));
  };
  return (Array.isArray(welds) ? welds : [])
    .filter(weld => (
      (!normalizedPipeline || normalizePipeline(weld.pipelineNumber) === normalizedPipeline) &&
      !weld.isManualInserted
    ))
    .sort((left, right) => {
      const leftPageDistance = Math.abs(Number(left.page || left.pageNum) - Number(pageNum));
      const rightPageDistance = Math.abs(Number(right.page || right.pageNum) - Number(pageNum));
      if (leftPageDistance !== rightPageDistance) return leftPageDistance - rightPageDistance;
      const spatialDelta = centerDistance(left) - centerDistance(right);
      if (Number.isFinite(spatialDelta) && spatialDelta !== 0) return spatialDelta;
      return (
        Math.abs(Number(left.weldNumber) - Number(targetNumber)) -
        Math.abs(Number(right.weldNumber) - Number(targetNumber))
      );
    })[0] || null;
};
