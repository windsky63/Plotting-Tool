const normalizePipeline = value => String(value || '').trim().replace(/\s+/g, '').toUpperCase();

/** Build one shallow-update map for App's undoable batch update API. */
export const buildAnnotationPipelineUpdates = ({
  annotations = [],
  pages = [],
  pipelineNumber = '',
  pipelineNumberSource = 'business_data'
}) => {
  const targetPipeline = normalizePipeline(pipelineNumber);
  if (!targetPipeline) return {};
  const pageSet = new Set((Array.isArray(pages) ? pages : [pages]).map(Number).filter(Number.isFinite));
  if (pageSet.size === 0) return {};

  return (Array.isArray(annotations) ? annotations : []).reduce((updatesById, annotation) => {
    if (!annotation?.id || !pageSet.has(Number(annotation.page || 1))) return updatesById;
    const updates = {};
    if (normalizePipeline(annotation.pipelineNumber) !== targetPipeline) {
      updates.pipelineNumber = targetPipeline;
    }
    if (annotation.pipelineNumberRaw !== targetPipeline) updates.pipelineNumberRaw = targetPipeline;
    if (annotation.pipelineNumberSource !== pipelineNumberSource) {
      updates.pipelineNumberSource = pipelineNumberSource;
    }
    if (annotation.weldData && typeof annotation.weldData === 'object' && (
      normalizePipeline(annotation.weldData.pipelineNumber) !== targetPipeline ||
      annotation.weldData.pipelineNumberRaw !== targetPipeline ||
      annotation.weldData.pipelineNumberSource !== pipelineNumberSource
    )) {
      updates.weldData = {
        ...annotation.weldData,
        pipelineNumber: targetPipeline,
        pipelineNumberRaw: targetPipeline,
        pipelineNumberSource
      };
    }
    if (Object.keys(updates).length > 0) updatesById[annotation.id] = updates;
    return updatesById;
  }, {});
};
