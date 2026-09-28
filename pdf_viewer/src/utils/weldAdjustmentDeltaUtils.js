const asNumber = weld => {
  const value = Number(weld?.weldNumber ?? weld?.number);
  return Number.isFinite(value) ? value : null;
};

const identity = weld => String(
  weld?.sourceAnnotationId ||
  weld?.manualInsertId ||
  weld?.sourceStableKey ||
  weld?.stableKey ||
  weld?.id ||
  ''
);

const normalizePipeline = value => String(value || '').trim().toUpperCase().replace(/\s+/g, '');

/** Keep cumulative deleted annotation IDs on one weld instead of copying the
 * same growing array onto every weld in a large PDF sequence. */
export const compactReplacementSourceIds = (welds = [], additionalIds = []) => {
  const source = Array.isArray(welds) ? welds : [];
  const replacementIds = Array.from(new Set([
    ...source.flatMap(weld => Array.isArray(weld?.replacementSourceAnnotationIds)
      ? weld.replacementSourceAnnotationIds
      : []),
    ...(Array.isArray(additionalIds) ? additionalIds : [])
  ].filter(Boolean)));
  const carrierIndex = replacementIds.length > 0
    ? source.findIndex(weld => (
      weld?.isWeldedSupport !== true &&
      (weld?.sourceAnnotationId || weld?.manualInsertId || weld?.isManualInserted)
    ))
    : -1;

  return source.map((weld, index) => {
    if (index === carrierIndex) {
      return { ...weld, replacementSourceAnnotationIds: replacementIds };
    }
    if (Array.isArray(weld?.replacementSourceAnnotationIds)) {
      const { replacementSourceAnnotationIds, ...rest } = weld;
      return rest;
    }
    return weld;
  });
};

/**
 * The complete PDF sequence is used for calculation, but only changed source
 * annotations and new manual welds are submitted. This prevents a large PDF
 * from being regenerated merely to shift one pipeline.
 */
export const buildWeldAdjustmentDelta = ({ originalWelds = [], currentWelds = [] } = {}) => {
  const originals = new Map(
    (Array.isArray(originalWelds) ? originalWelds : [])
      .map(weld => [identity(weld), weld])
      .filter(([key]) => key)
  );
  const current = Array.isArray(currentWelds) ? currentWelds : [];
  const replacementIds = Array.from(new Set(
    current.flatMap(weld => Array.isArray(weld?.replacementSourceAnnotationIds)
      ? weld.replacementSourceAnnotationIds
      : []
    ).filter(Boolean)
  ));

  let delta = current.filter(weld => {
    if (weld?.isManualInserted || weld?.manualInsertId) return true;
    const original = originals.get(identity(weld));
    if (!original) return false;
    return (
      asNumber(original) !== asNumber(weld) ||
      normalizePipeline(original?.pipelineNumber) !== normalizePipeline(weld?.pipelineNumber)
    );
  });

  // Deleting the final weld in a pipeline may leave no renumbered survivor.
  // Keep one unchanged source annotation as a carrier for the exact deleted ID.
  if (replacementIds.length > 0 && delta.length === 0) {
    const carrier = current.find(weld => weld?.sourceAnnotationId && weld?.isWeldedSupport !== true);
    if (carrier) delta = [carrier];
  }

  delta = delta.map((weld, index) => ({
    ...weld,
    replacementSourceAnnotationIds: index === 0 ? replacementIds : []
  }));

  return {
    welds: delta,
    changedExistingCount: delta.filter(weld => weld?.sourceAnnotationId).length,
    manualInsertedCount: delta.filter(weld => weld?.isManualInserted || weld?.manualInsertId).length,
    deletedSourceCount: replacementIds.length
  };
};

/** Preserve existing geometry/style in confirmation preview, matching App's
 * final exact-ID replacement behavior. */
export const prepareWeldAdjustmentPreview = (existingAnnotations = [], incomingAnnotations = []) => {
  const existingById = new Map(
    (Array.isArray(existingAnnotations) ? existingAnnotations : [])
      .filter(annotation => annotation?.id)
      .map(annotation => [annotation.id, annotation])
  );
  const incoming = (Array.isArray(incomingAnnotations) ? incomingAnnotations : []).map(annotation => {
    const sourceId = annotation?.weldData?.sourceAnnotationId;
    const existing = sourceId ? existingById.get(sourceId) : null;
    if (!existing) return annotation;
    return {
      ...annotation,
      ...existing,
      id: annotation.id,
      text: annotation.text,
      weldData: {
        ...(existing.weldData || {}),
        ...(annotation.weldData || {})
      },
      batchRunId: annotation.batchRunId,
      pipelineNumber: annotation.pipelineNumber || existing.pipelineNumber
    };
  });
  const replacedIds = new Set(incoming.flatMap(annotation => [
    annotation?.weldData?.sourceAnnotationId,
    ...(Array.isArray(annotation?.replacementSourceAnnotationIds)
      ? annotation.replacementSourceAnnotationIds
      : [])
  ]).filter(Boolean));
  return { annotations: incoming, replacedIds };
};

/**
 * Build an atomic commit plan for weld adjustment on an already annotated PDF.
 * Existing welds are updated in place, deleted source annotations are removed
 * by their exact ids, and only genuinely manual inserts become new annotations.
 */
export const buildDirectWeldAdjustmentPlan = (existingAnnotations = [], incomingAnnotations = []) => {
  const existing = Array.isArray(existingAnnotations) ? existingAnnotations : [];
  const incoming = Array.isArray(incomingAnnotations) ? incomingAnnotations : [];
  const existingById = new Map(existing.filter(item => item?.id).map(item => [item.id, item]));
  const deletedIds = Array.from(new Set(incoming.flatMap(item => (
    Array.isArray(item?.replacementSourceAnnotationIds)
      ? item.replacementSourceAnnotationIds
      : []
  )).filter(id => id && existingById.has(id))));
  const deletedIdSet = new Set(deletedIds);
  const updatesById = {};
  const additions = [];

  incoming.forEach(item => {
    const weldData = item?.weldData || {};
    const sourceId = weldData.sourceAnnotationId;
    const isManual = Boolean(
      weldData.isManualInserted || weldData.manualInsertId ||
      item?.isManualInserted || item?.manualInsertId
    );
    const source = sourceId ? existingById.get(sourceId) : null;

    // Once a manual weld has been saved and the PDF is reopened it has both a
    // manual-origin marker and a real source annotation id. It is now an
    // existing annotation and must be updated in place, not treated as new.
    if (source && !deletedIdSet.has(sourceId)) {
      const nextWeldData = {
        ...(source.weldData || {}),
        weldNumber: weldData.weldNumber,
        number: weldData.number ?? weldData.weldNumber,
        displayNumber: weldData.displayNumber ?? item.text,
        pipelineNumber: weldData.pipelineNumber || item.pipelineNumber || source.weldData?.pipelineNumber || ''
      };
      updatesById[sourceId] = {
        text: item.text,
        pipelineNumber: item.pipelineNumber || source.pipelineNumber || '',
        weldNumber: weldData.weldNumber,
        number: weldData.number ?? weldData.weldNumber,
        weldData: nextWeldData,
        qualityModified: true,
        isUploaded: false
      };
      return;
    }

    if (isManual && !source) additions.push(item);
  });

  return { updatesById, deletedIds, additions };
};

export default buildWeldAdjustmentDelta;
