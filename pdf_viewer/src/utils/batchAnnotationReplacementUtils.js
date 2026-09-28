const isManualAdjustmentAnnotation = annotation => Boolean(
  annotation?.weldData?.isManualInserted ||
  annotation?.weldData?.manualInsertId ||
  annotation?.isManualInserted ||
  annotation?.manualInsertId
);

/**
 * Build the exact removal scope for a generated annotation update.
 *
 * Reopened-PDF adjustments carry sourceAnnotationId for every old annotation
 * they intend to update. A shared batchRunId is provenance only; using it as
 * the removal key for a partial result can erase untouched pages.
 */
export const buildAnnotationReplacementPlan = (existingAnnotations = [], incomingAnnotations = []) => {
  const incoming = Array.isArray(incomingAnnotations) ? incomingAnnotations : [];
  const existing = Array.isArray(existingAnnotations) ? existingAnnotations : [];
  const batchRunIds = new Set(incoming.map(annotation => annotation?.batchRunId).filter(Boolean));
  const replacementAnnotationIds = new Set(
    incoming.flatMap(annotation => [
      annotation?.weldData?.sourceAnnotationId,
      ...(Array.isArray(annotation?.replacementSourceAnnotationIds)
        ? annotation.replacementSourceAnnotationIds
        : [])
    ]).filter(Boolean)
  );
  const hasManualAdjustment = incoming.some(isManualAdjustmentAnnotation);
  // Batch-wide replacement remains available only for legacy automatic
  // regeneration that has no exact source ids. Manual add/delete/renumbering
  // must always use exact ids, regardless of the shared batchRunId.
  const replaceWholeBatch = !hasManualAdjustment && replacementAnnotationIds.size === 0;
  const shouldReplace = annotation => (
    replacementAnnotationIds.has(annotation?.id) ||
    (replaceWholeBatch && batchRunIds.has(annotation?.batchRunId))
  );

  return {
    batchRunIds,
    replacementAnnotationIds,
    replaceWholeBatch,
    shouldReplace,
    replacedAnnotations: existing.filter(shouldReplace)
  };
};

export default buildAnnotationReplacementPlan;
