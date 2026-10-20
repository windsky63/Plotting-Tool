import {AnnotationIdIndex, createAnnotationIdIndex} from './annotationIdIndex';

const EMPTY_PAGE_ANNOTATIONS = Object.freeze([]);

export const normalizeAnnotationPageNumber = value => {
  const page = Number(value || 1);
  return Number.isInteger(page) && page > 0 ? page : 1;
};

const sameAnnotationReferences = (left, right) => (
  left === right || (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((annotation, index) => annotation === right[index])
  )
);

const nextPageRevision = (previousIndex, page) => (
  Number(previousIndex?.pageRevision?.get(page) || 0) + 1
);

const buildIndex = (annotations, previousIndex) => {
  const grouped = new Map();
  const idUpdates = new Map();
  const currentIds = new Set();

  annotations.forEach(annotation => {
    const page = normalizeAnnotationPageNumber(annotation?.page);
    const pageAnnotations = grouped.get(page);
    if (pageAnnotations) {
      pageAnnotations.push(annotation);
    } else {
      grouped.set(page, [annotation]);
    }
    if (annotation?.id !== undefined && annotation?.id !== null) {
      if (previousIndex?.byId) {
        currentIds.add(annotation.id);
        if (previousIndex.byId.get(annotation.id) !== annotation) idUpdates.set(annotation.id, annotation);
        else idUpdates.delete(annotation.id); // A later duplicate ID still wins.
      }
    }
  });

  const byPage = new Map();
  const pageRevision = new Map(previousIndex?.pageRevision || []);
  const pages = new Set([
    ...(previousIndex?.byPage?.keys?.() || []),
    ...grouped.keys()
  ]);

  pages.forEach(page => {
    const previousPage = previousIndex?.byPage?.get(page);
    const nextPage = grouped.get(page);
    if (nextPage && sameAnnotationReferences(previousPage, nextPage)) {
      byPage.set(page, previousPage);
      return;
    }
    if (nextPage) {
      byPage.set(page, nextPage);
    }
    pageRevision.set(page, nextPageRevision(previousIndex, page));
  });

  const removedIds = previousIndex?.annotations
    ? previousIndex.annotations.filter(annotation => annotation?.id != null && !currentIds.has(annotation.id)).map(annotation => annotation.id)
    : [];
  const byId = previousIndex?.byId instanceof AnnotationIdIndex
    ? previousIndex.byId.withChanges(annotations, idUpdates, removedIds)
    : createAnnotationIdIndex(annotations);
  return { annotations, byPage, byId, pageRevision };
};

const appendToIndex = (annotations, previousIndex) => {
  const byPage = new Map(previousIndex.byPage);
  const idUpdates = new Map();
  const pageRevision = new Map(previousIndex.pageRevision);
  const touchedPages = new Set();

  for (let index = previousIndex.annotations.length; index < annotations.length; index += 1) {
    const annotation = annotations[index];
    const page = normalizeAnnotationPageNumber(annotation?.page);
    if (!touchedPages.has(page)) {
      byPage.set(page, [...(byPage.get(page) || EMPTY_PAGE_ANNOTATIONS)]);
      pageRevision.set(page, nextPageRevision(previousIndex, page));
      touchedPages.add(page);
    }
    byPage.get(page).push(annotation);
    if (annotation?.id !== undefined && annotation?.id !== null) {
      idUpdates.set(annotation.id, annotation);
    }
  }

  const byId = previousIndex.byId instanceof AnnotationIdIndex
    ? previousIndex.byId.withChanges(annotations, idUpdates)
    : createAnnotationIdIndex(annotations);
  return { annotations, byPage, byId, pageRevision };
};

export const createPageAnnotationIndex = (annotations, previousIndex = null) => {
  const nextAnnotations = Array.isArray(annotations) ? annotations : [];
  if (previousIndex?.annotations === nextAnnotations) return previousIndex;

  const previousAnnotations = previousIndex?.annotations;
  const appendOnly = Array.isArray(previousAnnotations) &&
    nextAnnotations.length > previousAnnotations.length &&
    previousAnnotations.every((annotation, index) => nextAnnotations[index] === annotation);

  return appendOnly
    ? appendToIndex(nextAnnotations, previousIndex)
    : buildIndex(nextAnnotations, previousIndex);
};

export const getPageAnnotations = (index, pageNumber) => (
  index?.byPage?.get(normalizeAnnotationPageNumber(pageNumber)) || EMPTY_PAGE_ANNOTATIONS
);

export const getPageAnnotationRevision = (index, pageNumber) => (
  Number(index?.pageRevision?.get(normalizeAnnotationPageNumber(pageNumber)) || 0)
);

export const buildPreviewPageAnnotationMap = (index, previewResult = {}) => {
  const replacedIds = previewResult.replacedIds instanceof Set
    ? previewResult.replacedIds
    : new Set(previewResult.replacedIds || []);
  const previewAnnotations = Array.isArray(previewResult.annotations)
    ? previewResult.annotations
    : [];
  if (!replacedIds.size && !previewAnnotations.length) {
    return index?.byPage || new Map();
  }

  const affectedPages = new Set();
  const additionsByPage = new Map();
  replacedIds.forEach(id => {
    const existing = index?.byId?.get(id);
    if (existing) affectedPages.add(normalizeAnnotationPageNumber(existing.page));
  });
  previewAnnotations.forEach(annotation => {
    const page = normalizeAnnotationPageNumber(annotation?.page);
    affectedPages.add(page);
    const additions = additionsByPage.get(page);
    if (additions) additions.push(annotation);
    else additionsByPage.set(page, [annotation]);
  });

  const overlay = new Map(index?.byPage || []);
  affectedPages.forEach(page => {
    const retained = (index?.byPage?.get(page) || EMPTY_PAGE_ANNOTATIONS)
      .filter(annotation => !replacedIds.has(annotation?.id));
    const nextPage = [...retained, ...(additionsByPage.get(page) || EMPTY_PAGE_ANNOTATIONS)];
    if (nextPage.length) overlay.set(page, nextPage);
    else overlay.delete(page);
  });
  return overlay;
};
