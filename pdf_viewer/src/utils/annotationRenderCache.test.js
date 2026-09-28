import {
  createAnnotationRenderCacheEntry,
  createPageSelectionKey,
  isAnnotationRenderCacheHit
} from './annotationRenderCache';

describe('annotationRenderCache', () => {
  test('keeps a cached page valid when an unrelated page changes', () => {
    const pageAnnotations = [{ id: 'page-1', page: 1 }];
    const entry = createAnnotationRenderCacheEntry({
      content: ['rendered'],
      pageAnnotations,
      pageRevision: 3,
      visualKey: 'scale:1',
      selectionKey: ''
    });

    expect(isAnnotationRenderCacheHit(entry, {
      pageAnnotations,
      pageRevision: 3,
      visualKey: 'scale:1',
      selectionKey: ''
    })).toBe(true);
  });

  test('invalidates only when page data, visual state, or page selection changes', () => {
    const pageAnnotations = [{ id: 'a', page: 1 }];
    const entry = createAnnotationRenderCacheEntry({
      content: null,
      pageAnnotations,
      pageRevision: 1,
      visualKey: 'scale:1',
      selectionKey: ''
    });

    expect(isAnnotationRenderCacheHit(entry, {
      pageAnnotations: [...pageAnnotations], pageRevision: 2, visualKey: 'scale:1', selectionKey: ''
    })).toBe(false);
    expect(isAnnotationRenderCacheHit(entry, {
      pageAnnotations, pageRevision: 1, visualKey: 'scale:2', selectionKey: ''
    })).toBe(false);
    expect(isAnnotationRenderCacheHit(entry, {
      pageAnnotations, pageRevision: 1, visualKey: 'scale:1', selectionKey: 'a'
    })).toBe(false);
  });

  test('selection key contains only selected ids present on the page', () => {
    const pageAnnotations = [{ id: 'a' }, { id: 'b' }];

    expect(createPageSelectionKey(pageAnnotations, {
      selectedAnnotation: 'outside',
      selectedAnnotationIds: ['b', 'outside'],
      multiSelectedAnnotationIds: new Set(['a']),
      externalSelectedAnnotationIds: new Set(['b', 'outside'])
    })).toBe('a|b');
  });
});
