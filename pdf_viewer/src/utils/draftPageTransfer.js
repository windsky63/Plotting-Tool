import { createPageAnnotationIndex } from './pageAnnotationIndex';

export function prepareDraftPageTransfer(draft, previous = null) {
  const scope = draft?.fileInfo?.fingerprint || draft?.fileName || 'latest';
  const index = draft.__pageIndex || (Array.isArray(draft.annotations)
    ? createPageAnnotationIndex(draft.annotations) : null);
  const sameScope = previous?.scope === scope;
  const byPage = index?.byPage || new Map((draft.annotationPageUpdates || []).map(x => [x.page, x.annotations]));
  const pages = index ? Array.from(byPage.keys()) : (draft.annotationPages || []);
  const updates = index
    ? Array.from(new Set([...byPage.keys(), ...(sameScope ? previous.byPage.keys() : [])]))
      .filter(page => !sameScope || byPage.get(page) !== previous.byPage.get(page))
      .map(page => ({ page, annotations: byPage.get(page) || [] }))
    : (draft.annotationPageUpdates || []);
  const { annotations, annotationPageUpdates, ...meta } = draft;
  if (sameScope && previous.batchSequenceState === draft.batchSequenceState) delete meta.batchSequenceState;
  const nextPages = index ? byPage : new Map(sameScope ? previous.byPage : []);
  if (!index) updates.forEach(x => x.annotations.length ? nextPages.set(x.page, x.annotations) : nextPages.delete(x.page));
  return {
    payload: {
      ...meta, annotationCount: index ? draft.annotations?.length ?? draft.annotationCount : draft.annotationCount,
      annotationPages: pages, annotationPageUpdates: updates,
      annotationOrder: index ? index.annotations.map(annotation => annotation.id) : undefined,
      resetPageSnapshot: !sameScope,
    },
    next: { scope, byPage: nextPages, batchSequenceState: draft.batchSequenceState },
    index,
  };
}
