import {
  getStoredWeldDisplayAffixes,
  getWeldDisplayAffixKey,
  replaceWeldDisplayNumber
} from './weldDisplayNumberUtils';

const getWeldNumber = (weld) => {
  const value = Number(weld?.weldNumber ?? weld?.number);
  return Number.isFinite(value) ? value : null;
};

const normalizePipelineNumber = (value) => (
  String(value || '').trim().replace(/\s+/g, '').toUpperCase()
);

/**
 * Older editable PDFs may contain weld metadata without a pipeline number,
 * even though the page pipeline region can still be recognized. Bind only
 * pages that are explicitly confirmed as the selected pipeline so insertion
 * can shift the existing welds in the same scope. Never overwrite a different
 * explicit pipeline and never merge support numbering into regular welds.
 */
export const bindPipelineToMatchingPages = ({
  welds,
  pipelineNumber,
  pipelineNumberSource = 'business_data',
  anchorPage,
  matchedPages = [],
  getPagePipeline
}) => {
  const source = Array.isArray(welds) ? welds : [];
  const targetPipeline = normalizePipelineNumber(pipelineNumber);
  if (!targetPipeline) return source;

  const confirmedPages = new Set(
    [anchorPage, ...(Array.isArray(matchedPages) ? matchedPages : [])]
      .map(Number)
      .filter(Number.isFinite)
  );
  const weldsByPage = new Map();
  source.forEach(weld => {
    const page = Number(weld?.page || weld?.pageNum);
    if (!Number.isFinite(page)) return;
    if (!weldsByPage.has(page)) weldsByPage.set(page, []);
    weldsByPage.get(page).push(weld);
  });

  const matchingPages = new Set();
  weldsByPage.forEach((pageWelds, page) => {
    const explicitPipelines = new Set(
      pageWelds
        .map(weld => normalizePipelineNumber(weld?.pipelineNumber))
        .filter(Boolean)
    );
    if (explicitPipelines.size > 0 && !explicitPipelines.has(targetPipeline)) return;

    const recognizedPipeline = typeof getPagePipeline === 'function'
      ? normalizePipelineNumber(getPagePipeline(page, pageWelds))
      : '';
    if (
      explicitPipelines.has(targetPipeline) ||
      recognizedPipeline === targetPipeline ||
      (confirmedPages.has(page) && explicitPipelines.size === 0)
    ) {
      matchingPages.add(page);
    }
  });

  let changed = false;
  const result = source.map(weld => {
    const page = Number(weld?.page || weld?.pageNum);
    if (!matchingPages.has(page) || weld?.isWeldedSupport === true) return weld;
    const explicitPipeline = normalizePipelineNumber(weld?.pipelineNumber);
    if (explicitPipeline && explicitPipeline !== targetPipeline) return weld;
    if (
      explicitPipeline === targetPipeline &&
      String(weld?.numberingScopeKey || '').trim() === targetPipeline &&
      weld?.pipelineNumberRaw === targetPipeline &&
      weld?.pipelineNumberSource === pipelineNumberSource
    ) {
      return weld;
    }
    changed = true;
    return {
      ...weld,
      pipelineNumber: targetPipeline,
      pipelineNumberRaw: targetPipeline,
      pipelineNumberSource,
      numberingScopeKey: targetPipeline
    };
  });
  return changed ? result : source;
};

export const reserveManualInsertNumber = ({
  cursorValue,
  minNumber = 1,
  fallbackNumber = 1
}) => {
  const minimum = Number.isFinite(Number(minNumber)) ? Number(minNumber) : 1;
  const fallback = Number.isFinite(Number(fallbackNumber))
    ? Number(fallbackNumber)
    : minimum;
  const requested = Number(cursorValue);
  const insertNumber = Math.max(
    minimum,
    Number.isFinite(requested) ? requested : fallback
  );
  return {
    insertNumber,
    nextCursorValue: insertNumber + 1
  };
};

export const resolveManualInsertContext = ({
  welds,
  pageNum,
  pipelineNumber,
  fallbackStartNumber = 1,
  increment = 1
}) => {
  const source = Array.isArray(welds) ? welds : [];
  const resolvedPage = Number(pageNum || 1);
  const step = Math.abs(Number(increment)) || 1;
  const fallback = Number.isFinite(Number(fallbackStartNumber))
    ? Number(fallbackStartNumber)
    : 1;
  let resolvedPipeline = normalizePipelineNumber(pipelineNumber);

  // If OCR did not resolve the empty page, infer only when the nearest
  // numbered pages on both sides agree. A one-sided guess could accidentally
  // connect two different pipelines, so it deliberately remains unresolved.
  if (!resolvedPipeline) {
    const pagePipelines = new Map();
    source.forEach(weld => {
      const weldPage = Number(weld?.page || weld?.pageNum);
      const weldPipeline = normalizePipelineNumber(weld?.pipelineNumber);
      if (Number.isFinite(weldPage) && weldPipeline && !pagePipelines.has(weldPage)) {
        pagePipelines.set(weldPage, weldPipeline);
      }
    });
    const previous = Array.from(pagePipelines.entries())
      .filter(([candidatePage]) => candidatePage < resolvedPage)
      .sort((a, b) => b[0] - a[0])[0];
    const next = Array.from(pagePipelines.entries())
      .filter(([candidatePage]) => candidatePage > resolvedPage)
      .sort((a, b) => a[0] - b[0])[0];
    if (previous?.[1] && previous[1] === next?.[1]) {
      resolvedPipeline = previous[1];
    }
  }

  const pipelineWelds = resolvedPipeline
    ? source.filter(weld => normalizePipelineNumber(weld?.pipelineNumber) === resolvedPipeline)
    : [];
  const regularPipelineWelds = pipelineWelds.filter(weld => weld?.isWeldedSupport !== true);
  const scopedAnchor = [...(regularPipelineWelds.length > 0 ? regularPipelineWelds : pipelineWelds)]
    .sort((left, right) => {
      const leftPage = Number(left?.page || left?.pageNum);
      const rightPage = Number(right?.page || right?.pageNum);
      const leftPrevious = leftPage <= resolvedPage ? 0 : 1;
      const rightPrevious = rightPage <= resolvedPage ? 0 : 1;
      return leftPrevious - rightPrevious ||
        Math.abs(leftPage - resolvedPage) - Math.abs(rightPage - resolvedPage);
    })
    .find(weld => String(weld?.numberingScopeKey || '').trim());
  const numberingScopeKey = String(
    scopedAnchor?.numberingScopeKey || resolvedPipeline || ''
  ).trim();
  const scopedWelds = numberingScopeKey
    ? source.filter(weld => isSameNumberingScope(
        weld,
        resolvedPipeline,
        resolvedPage,
        numberingScopeKey
      ))
    : [];
  const numbered = scopedWelds
    .map(weld => ({
      page: Number(weld?.page || weld?.pageNum),
      number: getWeldNumber(weld)
    }))
    .filter(item => Number.isFinite(item.page) && item.number !== null);
  const previousNumbers = numbered
    .filter(item => item.page < resolvedPage)
    .map(item => item.number);
  const nextNumbers = numbered
    .filter(item => item.page > resolvedPage)
    .map(item => item.number);
  const suggestedNumber = previousNumbers.length > 0
    ? Math.max(...previousNumbers) + step
    : nextNumbers.length > 0
      ? Math.min(...nextNumbers)
      : fallback;

  return {
    pipelineNumber: resolvedPipeline,
    numberingScopeKey,
    suggestedNumber: Math.max(1, suggestedNumber),
    inferredPipeline: !normalizePipelineNumber(pipelineNumber) && Boolean(resolvedPipeline)
  };
};

export const getPageScopedNumberingSegmentPatternKey = (segment) => (
  `${segment?.page ?? segment?.pageNum ?? ''}__` +
  `${segment?.startOrderIndex ?? ''}__${segment?.endOrderIndex ?? ''}__` +
  `${segment?.startPathId ?? ''}__${segment?.endPathId ?? ''}`
);

export const buildCrossPageNumberingScopes = ({
  welds,
  explicitPipelineByPage = {},
  increment = 1
}) => {
  const source = Array.isArray(welds) ? welds : [];
  const step = Math.abs(Number(increment)) || 1;
  const pageMap = new Map();

  source.forEach((weld) => {
    const pageNum = Number(weld?.page || weld?.pageNum);
    if (!Number.isFinite(pageNum)) return;
    if (!pageMap.has(pageNum)) {
      pageMap.set(pageNum, { pageNum, numbers: [] });
    }
    const number = getWeldNumber(weld);
    if (number !== null) pageMap.get(pageNum).numbers.push(number);
  });

  const pages = Array.from(pageMap.values())
    .map(meta => ({
      ...meta,
      min: meta.numbers.length > 0 ? Math.min(...meta.numbers) : null,
      max: meta.numbers.length > 0 ? Math.max(...meta.numbers) : null,
      explicitPipeline: normalizePipelineNumber(
        explicitPipelineByPage instanceof Map
          ? explicitPipelineByPage.get(meta.pageNum)
          : explicitPipelineByPage?.[meta.pageNum]
      )
    }))
    .sort((a, b) => a.pageNum - b.pageNum);

  const isContinuous = (left, right) => (
    left &&
    right &&
    left.max !== null &&
    right.min !== null &&
    right.min === left.max + step
  );

  const numberingGroups = [];
  pages.forEach((meta, index) => {
    const previous = pages[index - 1];
    const currentGroup = numberingGroups[numberingGroups.length - 1];
    const groupPipeline = currentGroup?.find(item => item.explicitPipeline)?.explicitPipeline || '';
    const explicitPipelineChanged = Boolean(
      meta.explicitPipeline &&
      groupPipeline &&
      meta.explicitPipeline !== groupPipeline
    );
    const canInferMissingPipeline = Boolean(
      !meta.explicitPipeline &&
      previous &&
      isContinuous(previous, meta)
    );
    const canAttachResolvedPipeline = Boolean(
      meta.explicitPipeline &&
      !groupPipeline &&
      previous &&
      isContinuous(previous, meta)
    );
    const shouldStartNewGroup = (
      index === 0 ||
      explicitPipelineChanged ||
      (
        !meta.explicitPipeline &&
        !canInferMissingPipeline
      ) ||
      (
        meta.explicitPipeline &&
        !groupPipeline &&
        !canAttachResolvedPipeline
      )
    );

    if (shouldStartNewGroup) numberingGroups.push([]);
    numberingGroups[numberingGroups.length - 1].push(meta);
  });

  let previousResolvedPipeline = '';
  numberingGroups.forEach((group) => {
    const resolvedPipeline = group.find(meta => meta.explicitPipeline)?.explicitPipeline || '';
    const firstPage = group[0].pageNum;
    const scopeKey = resolvedPipeline
      ? `${resolvedPipeline}__PAGE_CHAIN_${firstPage}`
      : `__PAGE_CHAIN_${firstPage}`;
    const resetToStartNumber = Boolean(
      resolvedPipeline &&
      previousResolvedPipeline &&
      resolvedPipeline !== previousResolvedPipeline
    );
    group.forEach((meta) => {
      meta.scopeKey = scopeKey;
      meta.pipelineNumber = resolvedPipeline;
      meta.resetToStartNumber = resetToStartNumber;
    });
    if (resolvedPipeline) previousResolvedPipeline = resolvedPipeline;
  });

  return new Map(pages.map(meta => [meta.pageNum, {
    scopeKey: meta.scopeKey,
    pipelineNumber: meta.pipelineNumber,
    resetToStartNumber: meta.resetToStartNumber === true,
    min: meta.min,
    max: meta.max
  }]));
};

const replaceDisplayNumber = (weld, nextNumber) => {
  const storedAffixes = getStoredWeldDisplayAffixes(weld);
  if (storedAffixes) {
    return `${storedAffixes.prefix}${nextNumber}${storedAffixes.suffix}`;
  }
  const oldDisplay = String(weld?.displayNumber ?? weld?.number ?? '');
  return replaceWeldDisplayNumber(oldDisplay, getWeldNumber(weld), nextNumber);
};

const normalizeSequenceMetadata = (welds) => {
  const pageIndexes = new Map();
  return (welds || []).map((weld, globalIndex) => {
    const pageNum = Number(weld?.page || weld?.pageNum || 1);
    const pageIndex = pageIndexes.get(pageNum) || 0;
    pageIndexes.set(pageNum, pageIndex + 1);
    return {
      ...weld,
      page: pageNum,
      pageNum,
      globalIndex,
      pageIndex
    };
  });
};

const isSameNumberingScope = (weld, pipelineNumber, pageNum, numberingScopeKey = '') => {
  // Supports use an independent 600-series sequence and must never be moved
  // by ordinary weld insertion/deletion.
  if (weld?.isWeldedSupport === true) return false;
  // Pipeline identity is authoritative. Historical multi-page runs may have
  // assigned different numberingScopeKeys to different pages of the same
  // pipeline; honoring those stale keys truncates shift/rollback at a batch or
  // page boundary.
  const targetPipeline = normalizePipelineNumber(pipelineNumber);
  if (targetPipeline) {
    return normalizePipelineNumber(weld?.pipelineNumber) === targetPipeline;
  }
  const targetScope = String(numberingScopeKey || '').trim();
  if (targetScope) {
    const weldScope = String(
      weld?.numberingScopeKey || normalizePipelineNumber(weld?.pipelineNumber)
    ).trim();
    return weldScope === targetScope;
  }
  return Number(weld?.page || weld?.pageNum) === Number(pageNum);
};

const isSameWeldAdjustmentSequence = (
  weld,
  pipelineNumber,
  pageNum,
  numberingScopeKey = '',
  numberingAffixKey = null
) => (
  isSameNumberingScope(weld, pipelineNumber, pageNum, numberingScopeKey) &&
  (numberingAffixKey === null || getWeldDisplayAffixKey(weld) === numberingAffixKey)
);

export const insertManualWeldIntoSequence = ({
  welds,
  pageNum,
  pipelineNumber,
  numberingScopeKey,
  insertNumber,
  manualWeld
}) => {
  const source = Array.isArray(welds) ? [...welds] : [];
  const resolvedPage = Number(pageNum || 1);
  const targetNumber = Number(insertNumber);
  if (!Number.isFinite(targetNumber)) {
    return { welds: source, insertedNumber: null, insertedIndex: -1 };
  }

  const sameScopeCandidates = source.filter(weld => (
    isSameNumberingScope(weld, pipelineNumber, resolvedPage, numberingScopeKey)
  ));
  const nearestTemplate = [...sameScopeCandidates].sort((left, right) => {
    const leftPage = Number(left?.page || left?.pageNum);
    const rightPage = Number(right?.page || right?.pageNum);
    const leftPageDistance = Math.abs(leftPage - resolvedPage);
    const rightPageDistance = Math.abs(rightPage - resolvedPage);
    if (leftPageDistance !== rightPageDistance) return leftPageDistance - rightPageDistance;
    return Math.abs(Number(getWeldNumber(left)) - targetNumber) -
      Math.abs(Number(getWeldNumber(right)) - targetNumber);
  })[0] || null;
  const numberingAffixKey = manualWeld?.numberingAffixKey ?? getWeldDisplayAffixKey(nearestTemplate);

  const pageItemIndexes = source
    .map((weld, index) => (
      Number(weld?.page || weld?.pageNum) === resolvedPage &&
      isSameWeldAdjustmentSequence(
        weld, pipelineNumber, resolvedPage, numberingScopeKey, numberingAffixKey
      )
        ? index
        : -1
    ))
    .filter(index => index >= 0);

  const matchingPageIndex = pageItemIndexes.find(index => {
    const number = getWeldNumber(source[index]);
    return number !== null && number >= targetNumber;
  });
  const sameScopeIndexes = source
    .map((weld, index) => (
      isSameWeldAdjustmentSequence(
        weld, pipelineNumber, resolvedPage, numberingScopeKey, numberingAffixKey
      )
        ? index
        : -1
    ))
    .filter(index => index >= 0);
  const nextPageScopeIndex = sameScopeIndexes.find(index => (
    Number(source[index]?.page || source[index]?.pageNum) > resolvedPage
  ));
  const fallbackPageIndex = source.findIndex(weld => (
    Number(weld?.page || weld?.pageNum) > resolvedPage
  ));
  const globalInsertIndex = matchingPageIndex !== undefined
    ? matchingPageIndex
    : pageItemIndexes.length > 0
      ? pageItemIndexes[pageItemIndexes.length - 1] + 1
      : nextPageScopeIndex !== undefined
        ? nextPageScopeIndex
        : sameScopeIndexes.length > 0
          ? sameScopeIndexes[sameScopeIndexes.length - 1] + 1
          : fallbackPageIndex >= 0 ? fallbackPageIndex : source.length;

  const shifted = source.map(weld => {
    const oldNumber = getWeldNumber(weld);
    if (
      oldNumber === null ||
      oldNumber < targetNumber ||
      !isSameWeldAdjustmentSequence(
        weld, pipelineNumber, resolvedPage, numberingScopeKey, numberingAffixKey
      )
    ) {
      return weld;
    }
    const nextNumber = oldNumber + 1;
    return {
      ...weld,
      weldNumber: nextNumber,
      number: nextNumber,
      displayNumber: replaceDisplayNumber(weld, nextNumber)
    };
  });

  const numberTemplate = nearestTemplate || source[globalInsertIndex] || source[Math.max(0, globalInsertIndex - 1)];
  shifted.splice(globalInsertIndex, 0, {
    ...manualWeld,
    batchRunId: manualWeld?.batchRunId || numberTemplate?.batchRunId,
    page: resolvedPage,
    pageNum: resolvedPage,
    pipelineNumber,
    numberingScopeKey: numberingScopeKey || manualWeld?.numberingScopeKey || '',
    numberingAffixKey,
    weldNumber: targetNumber,
    number: targetNumber,
    manualRequestedNumber: targetNumber,
    isNumberingEdited: true,
    displayNumber: replaceDisplayNumber(numberTemplate, targetNumber)
  });

  return {
    welds: normalizeSequenceMetadata(shifted),
    insertedNumber: targetNumber,
    insertedIndex: globalInsertIndex
  };
};

export const removeManualWeldFromSequence = ({ welds, manualInsertId }) => {
  const source = Array.isArray(welds) ? [...welds] : [];
  const removeIndex = source.findIndex(weld => weld?.manualInsertId === manualInsertId);
  if (removeIndex < 0) {
    return { welds: source, removedNumber: null, removedIndex: -1 };
  }

  const removed = source[removeIndex];
  const removedNumber = getWeldNumber(removed);
  const pipelineNumber = removed?.pipelineNumber || '';
  const numberingScopeKey = removed?.numberingScopeKey || '';
  const numberingAffixKey = getWeldDisplayAffixKey(removed);
  const removedPage = Number(removed?.page || removed?.pageNum || 1);
  source.splice(removeIndex, 1);

  const shifted = source.map(weld => {
    const oldNumber = getWeldNumber(weld);
    if (
      removedNumber === null ||
      oldNumber === null ||
      oldNumber <= removedNumber ||
      !isSameWeldAdjustmentSequence(
        weld, pipelineNumber, removedPage, numberingScopeKey, numberingAffixKey
      )
    ) {
      return weld;
    }
    const nextNumber = oldNumber - 1;
    return {
      ...weld,
      weldNumber: nextNumber,
      number: nextNumber,
      displayNumber: replaceDisplayNumber(weld, nextNumber)
    };
  });

  return {
    welds: normalizeSequenceMetadata(shifted),
    removedNumber,
    removedIndex: removeIndex
  };
};

export const removeWeldFromSequence = ({ welds, weldKey, getWeldKey }) => {
  const source = Array.isArray(welds) ? [...welds] : [];
  const resolveKey = typeof getWeldKey === 'function'
    ? getWeldKey
    : weld => weld?.manualInsertId || weld?.id || weld?.pathId;
  const removeIndex = source.findIndex(weld => resolveKey(weld) === weldKey);
  if (removeIndex < 0) {
    return { welds: source, removedWeld: null, removedNumber: null, removedIndex: -1 };
  }

  const removedWeld = source[removeIndex];
  if (removedWeld?.isWeldedSupport === true) {
    return { welds: source, removedWeld: null, removedNumber: null, removedIndex: -1 };
  }

  const removedNumber = getWeldNumber(removedWeld);
  const pipelineNumber = removedWeld?.pipelineNumber || '';
  const numberingScopeKey = removedWeld?.numberingScopeKey || '';
  const numberingAffixKey = getWeldDisplayAffixKey(removedWeld);
  const removedPage = Number(removedWeld?.page || removedWeld?.pageNum || 1);
  source.splice(removeIndex, 1);

  const shifted = source.map(weld => {
    const oldNumber = getWeldNumber(weld);
    if (
      weld?.isWeldedSupport === true ||
      removedNumber === null ||
      oldNumber === null ||
      oldNumber <= removedNumber ||
      !isSameWeldAdjustmentSequence(
        weld, pipelineNumber, removedPage, numberingScopeKey, numberingAffixKey
      )
    ) {
      return weld;
    }
    const nextNumber = oldNumber - 1;
    return {
      ...weld,
      weldNumber: nextNumber,
      number: nextNumber,
      displayNumber: replaceDisplayNumber(weld, nextNumber)
    };
  });

  return {
    welds: normalizeSequenceMetadata(shifted),
    removedWeld,
    removedNumber,
    removedIndex: removeIndex
  };
};

/**
 * Remove all selected welds atomically. Renumbering is calculated from the
 * original snapshot, so selecting several welds never exposes intermediate
 * single-delete numbering states to React or the preview layer.
 */
export const removeWeldsFromSequence = ({ welds, weldKeys, getWeldKey }) => {
  const source = Array.isArray(welds) ? [...welds] : [];
  const resolveKey = typeof getWeldKey === 'function'
    ? getWeldKey
    : weld => weld?.manualInsertId || weld?.id || weld?.pathId;
  const requestedKeys = new Set((Array.isArray(weldKeys) ? weldKeys : []).filter(Boolean));
  if (!requestedKeys.size) {
    return { welds: source, removedWelds: [], removedNumbers: [], removedIndexes: [] };
  }

  const removedEntries = source
    .map((weld, index) => ({ weld, index, key: resolveKey(weld) }))
    .filter(entry => requestedKeys.has(entry.key) && entry.weld?.isWeldedSupport !== true)
    .map(entry => ({
      ...entry,
      number: getWeldNumber(entry.weld),
      pipelineNumber: entry.weld?.pipelineNumber || '',
      numberingScopeKey: entry.weld?.numberingScopeKey || '',
      numberingAffixKey: getWeldDisplayAffixKey(entry.weld),
      page: Number(entry.weld?.page || entry.weld?.pageNum || 1)
    }));
  if (!removedEntries.length) {
    return { welds: source, removedWelds: [], removedNumbers: [], removedIndexes: [] };
  }

  const removedKeySet = new Set(removedEntries.map(entry => entry.key));
  const shifted = source
    .filter(weld => !removedKeySet.has(resolveKey(weld)))
    .map(weld => {
      if (weld?.isWeldedSupport === true) return weld;
      const oldNumber = getWeldNumber(weld);
      if (oldNumber === null) return weld;
      const precedingDeleteCount = removedEntries.filter(entry => (
        entry.number !== null &&
        entry.number < oldNumber &&
        isSameWeldAdjustmentSequence(
          weld,
          entry.pipelineNumber,
          entry.page,
          entry.numberingScopeKey,
          entry.numberingAffixKey
        )
      )).length;
      if (!precedingDeleteCount) return weld;
      const nextNumber = oldNumber - precedingDeleteCount;
      return {
        ...weld,
        weldNumber: nextNumber,
        number: nextNumber,
        displayNumber: replaceDisplayNumber(weld, nextNumber)
      };
    });

  return {
    welds: normalizeSequenceMetadata(shifted),
    removedWelds: removedEntries.map(entry => entry.weld),
    removedNumbers: removedEntries.map(entry => entry.number).filter(number => number !== null),
    removedIndexes: removedEntries.map(entry => entry.index)
  };
};

export const applyFixedManualWeldNumbers = ({ orderedWelds, numberSlots }) => {
  const ordered = Array.isArray(orderedWelds) ? orderedWelds : [];
  const slots = (Array.isArray(numberSlots) ? numberSlots : ordered)
    .map((weld, index) => ({
      number: getWeldNumber(weld),
      displayNumber: weld?.displayNumber,
      index
    }))
    .filter(slot => slot.number !== null)
    .sort((a, b) => (a.number === b.number ? a.index - b.index : a.number - b.number));

  const manualWelds = ordered.filter(weld => weld?.isManualInserted);
  const fixedNumbers = new Set(
    manualWelds.map(getWeldNumber).filter(number => number !== null)
  );
  const availableSlots = slots.filter(slot => !fixedNumbers.has(slot.number));
  const regularWelds = ordered.filter(weld => !weld?.isManualInserted);

  const maxSlotNumber = slots.length > 0 ? slots[slots.length - 1].number : 0;
  const assignedRegular = regularWelds.map((weld, index) => {
    const slot = availableSlots[index];
    const nextNumber = slot?.number ?? (maxSlotNumber + index - availableSlots.length + 1);
    const displayTemplate = slot?.displayNumber !== undefined
      ? { ...weld, displayNumber: slot.displayNumber }
      : weld;
    return {
      ...weld,
      weldNumber: nextNumber,
      number: nextNumber,
      displayNumber: replaceDisplayNumber(displayTemplate, nextNumber)
    };
  });

  return [...assignedRegular, ...manualWelds]
    .map((weld, index) => ({ weld, index, number: getWeldNumber(weld) }))
    .sort((a, b) => {
      if (a.number === null && b.number === null) return a.index - b.index;
      if (a.number === null) return 1;
      if (b.number === null) return -1;
      return a.number === b.number ? a.index - b.index : a.number - b.number;
    })
    .map(item => item.weld);
};

export const assignCompactWeldNumbers = ({
  welds,
  hiddenKeys = [],
  forcedStarts = [],
  startNumber = 1,
  increment = 1,
  getKey,
  getScopeKey,
  getScopeStartNumber
}) => {
  const source = Array.isArray(welds) ? welds : [];
  const keyOf = typeof getKey === 'function'
    ? getKey
    : weld => weld?.manualInsertId || weld?.pathId || weld?.id;
  const scopeOf = typeof getScopeKey === 'function'
    ? getScopeKey
    : () => 'default';
  const hidden = hiddenKeys instanceof Set ? hiddenKeys : new Set(hiddenKeys || []);
  const forcedStartMap = new Map(
    (forcedStarts || [])
      .map(item => [item?.key, Number(item?.startNumber)])
      .filter(([key, number]) => key !== undefined && key !== null && key !== '' && Number.isFinite(number))
  );
  const step = Number.isFinite(Number(increment)) ? Number(increment) : 1;
  const fallbackStart = Number.isFinite(Number(startNumber)) ? Number(startNumber) : 1;
  const nextByScope = new Map();
  const numberedWelds = [];

  source.forEach((weld) => {
    const key = keyOf(weld);
    if (hidden.has(key)) return;

    const scopeKey = scopeOf(weld) || 'default';
    if (!nextByScope.has(scopeKey)) {
      const scopedStart = typeof getScopeStartNumber === 'function'
        ? Number(getScopeStartNumber(scopeKey, weld))
        : fallbackStart;
      nextByScope.set(scopeKey, Number.isFinite(scopedStart) ? scopedStart : fallbackStart);
    }

    if (forcedStartMap.has(key)) {
      nextByScope.set(scopeKey, forcedStartMap.get(key));
    }

    const nextNumber = nextByScope.get(scopeKey);
    numberedWelds.push({
      ...weld,
      weldNumber: nextNumber,
      number: nextNumber,
      displayNumber: replaceDisplayNumber(weld, nextNumber),
      // 每次重建都显式清除旧预览残留；只有本轮 hiddenKeys 命中的焊点才允许为空。
      isNumberless: false
    });
    nextByScope.set(scopeKey, nextNumber + step);
  });

  return {
    welds: normalizeSequenceMetadata(numberedWelds),
    nextByScope
  };
};

/**
 * Keep manually corrected numbers fixed and move only ordinary welds forward
 * when a number is duplicated inside the same pipeline/numbering scope.
 * The operation is pure and deterministic so preview rebuilds cannot oscillate.
 */
export const resolvePipelineNumberConflicts = ({
  welds,
  increment = 1,
  getKey,
  getScopeKey,
  isEdited
}) => {
  const source = Array.isArray(welds) ? welds : [];
  const keyOf = typeof getKey === 'function'
    ? getKey
    : weld => weld?.manualInsertId || weld?.pathId || weld?.id;
  const scopeOf = typeof getScopeKey === 'function'
    ? getScopeKey
    : weld => weld?.numberingScopeKey || normalizePipelineNumber(weld?.pipelineNumber) || `__PAGE_${weld?.page || weld?.pageNum || 1}`;
  const edited = typeof isEdited === 'function'
    ? isEdited
    : weld => weld?.isNumberingEdited === true;
  const step = Math.max(1, Math.abs(Number(increment)) || 1);
  const assignedByKey = new Map();
  const usedByScope = new Map();

  const reserve = (weld, sourceIndex) => {
    if (weld?.isWeldedSupport === true) return;
    const originalNumber = getWeldNumber(weld);
    if (originalNumber === null) return;
    const scopeKey = scopeOf(weld) || 'default';
    if (!usedByScope.has(scopeKey)) usedByScope.set(scopeKey, new Set());
    const used = usedByScope.get(scopeKey);
    let nextNumber = originalNumber;
    while (used.has(nextNumber)) nextNumber += step;
    used.add(nextNumber);
    assignedByKey.set(`${String(keyOf(weld))}__${sourceIndex}`, nextNumber);
  };

  // Edited welds reserve their requested numbers before ordinary welds are
  // considered. A rare edited-vs-edited collision is resolved deterministically
  // by moving the later edited item to the next free number.
  source.forEach((weld, index) => {
    if (edited(weld)) reserve(weld, index);
  });
  source.forEach((weld, index) => {
    if (!edited(weld)) reserve(weld, index);
  });

  return source.map((weld, index) => {
    if (weld?.isWeldedSupport === true) return weld;
    const nextNumber = assignedByKey.get(`${String(keyOf(weld))}__${index}`);
    if (!Number.isFinite(nextNumber)) return weld;
    const oldNumber = getWeldNumber(weld);
    if (oldNumber === nextNumber) return weld;
    return {
      ...weld,
      weldNumber: nextNumber,
      number: nextNumber,
      displayNumber: replaceDisplayNumber(weld, nextNumber)
    };
  });
};

export const moveWeldRangeInSequence = ({
  welds,
  rangeWelds,
  targetNumber,
  position = 'before',
  getKey
}) => {
  const source = Array.isArray(welds) ? [...welds] : [];
  const range = Array.isArray(rangeWelds) ? rangeWelds : [];
  const keyOf = typeof getKey === 'function'
    ? getKey
    : weld => weld?.manualInsertId || weld?.pathId || weld?.id;
  const rangeKeys = new Set(range.map(keyOf).filter(key => key !== undefined && key !== null && key !== ''));
  if (rangeKeys.size === 0) return source;

  const remaining = source.filter(weld => !rangeKeys.has(keyOf(weld)));
  const numericTarget = Number(targetNumber);
  let insertAt;
  if (Number.isFinite(numericTarget)) {
    const targetIndex = remaining.findIndex(weld => getWeldNumber(weld) === numericTarget);
    if (targetIndex >= 0) {
      insertAt = position === 'after' ? targetIndex + 1 : targetIndex;
    }
  }
  if (!Number.isInteger(insertAt)) {
    const affectedIndexes = source
      .map((weld, index) => (rangeKeys.has(keyOf(weld)) ? index : -1))
      .filter(index => index >= 0);
    insertAt = affectedIndexes.length > 0
      ? Math.min(Math.min(...affectedIndexes), remaining.length)
      : remaining.length;
  }

  return [
    ...remaining.slice(0, insertAt),
    ...range,
    ...remaining.slice(insertAt)
  ];
};

export const getOverlappingSegmentIndexes = ({
  segments,
  rangeWelds,
  pageNum,
  getKey
}) => {
  const keyOf = typeof getKey === 'function'
    ? getKey
    : weld => weld?.manualInsertId || weld?.pathId || weld?.id;
  const nextKeys = new Set(
    (rangeWelds || []).map(keyOf).filter(key => key !== undefined && key !== null && key !== '')
  );
  if (nextKeys.size === 0) return [];

  return (segments || [])
    .map((segment, index) => {
      if (Number(segment?.page || pageNum) !== Number(pageNum)) return -1;
      const overlaps = (segment?.sourceRangeWelds || []).some(weld => nextKeys.has(keyOf(weld)));
      return overlaps ? index : -1;
    })
    .filter(index => index >= 0);
};
