export const createPageSelectionKey = (pageAnnotations, selection = {}) => {
  const selectedIds = new Set([
    selection.selectedAnnotation,
    ...(selection.selectedAnnotationIds || []),
    ...Array.from(selection.multiSelectedAnnotationIds || []),
    ...Array.from(selection.externalSelectedAnnotationIds || [])
  ].filter(Boolean));

  return (Array.isArray(pageAnnotations) ? pageAnnotations : [])
    .filter(annotation => selectedIds.has(annotation?.id))
    .map(annotation => String(annotation.id))
    .sort()
    .join('|');
};

export const createAnnotationRenderCacheEntry = ({
  content,
  pageAnnotations,
  pageRevision,
  visualKey,
  selectionKey,
  renderer
}) => ({ content, pageAnnotations, pageRevision, visualKey, selectionKey, renderer });

export const isAnnotationRenderCacheHit = (entry, next) => Boolean(
  entry &&
  entry.pageAnnotations === next.pageAnnotations &&
  entry.pageRevision === next.pageRevision &&
  entry.visualKey === next.visualKey &&
  entry.selectionKey === next.selectionKey &&
  entry.renderer === next.renderer
);
