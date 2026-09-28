import {
  buildPreviewPageAnnotationMap,
  createPageAnnotationIndex,
  getPageAnnotations,
  normalizeAnnotationPageNumber
} from './pageAnnotationIndex';

const annotation = (id, page, text = id) => ({ id, page, text });

describe('pageAnnotationIndex', () => {
  test('groups annotations by normalized page and id', () => {
    const first = annotation('a', 1);
    const second = annotation('b', '2');
    const missingPage = { id: 'c', text: 'page one fallback' };

    const index = createPageAnnotationIndex([first, second, missingPage]);

    expect(getPageAnnotations(index, 1)).toEqual([first, missingPage]);
    expect(getPageAnnotations(index, 2)).toEqual([second]);
    expect(index.byId.get('b')).toBe(second);
  });

  test('append changes only the affected page reference and revision', () => {
    const pageOne = annotation('a', 1);
    const pageTwo = annotation('b', 2);
    const previous = createPageAnnotationIndex([pageOne, pageTwo]);
    const previousPageOne = getPageAnnotations(previous, 1);
    const previousPageTwo = getPageAnnotations(previous, 2);
    const added = annotation('c', 2);

    const next = createPageAnnotationIndex([pageOne, pageTwo, added], previous);

    expect(getPageAnnotations(next, 1)).toBe(previousPageOne);
    expect(getPageAnnotations(next, 2)).not.toBe(previousPageTwo);
    expect(getPageAnnotations(next, 2)).toEqual([pageTwo, added]);
    expect(next.pageRevision.get(1)).toBe(previous.pageRevision.get(1));
    expect(next.pageRevision.get(2)).toBe(previous.pageRevision.get(2) + 1);
  });

  test('editing one annotation preserves untouched page references', () => {
    const pageOne = annotation('a', 1, 'old');
    const pageTwo = annotation('b', 2);
    const previous = createPageAnnotationIndex([pageOne, pageTwo]);
    const changed = { ...pageOne, text: 'new' };

    const next = createPageAnnotationIndex([changed, pageTwo], previous);

    expect(getPageAnnotations(next, 1)).toEqual([changed]);
    expect(getPageAnnotations(next, 1)).not.toBe(getPageAnnotations(previous, 1));
    expect(getPageAnnotations(next, 2)).toBe(getPageAnnotations(previous, 2));
    expect(next.pageRevision.get(1)).toBe(previous.pageRevision.get(1) + 1);
    expect(next.pageRevision.get(2)).toBe(previous.pageRevision.get(2));
  });

  test('does not treat an edit plus append as append-only', () => {
    const pageOne = annotation('a', 1, 'old');
    const pageTwo = annotation('b', 2);
    const previous = createPageAnnotationIndex([pageOne, pageTwo]);
    const changed = { ...pageOne, text: 'new' };
    const added = annotation('c', 2);

    const next = createPageAnnotationIndex([changed, pageTwo, added], previous);

    expect(getPageAnnotations(next, 1)).toEqual([changed]);
    expect(getPageAnnotations(next, 2)).toEqual([pageTwo, added]);
    expect(next.byId.get('a')).toBe(changed);
  });

  test('moving an annotation invalidates source and destination pages', () => {
    const moving = annotation('a', 1);
    const destination = annotation('b', 2);
    const stable = annotation('c', 3);
    const previous = createPageAnnotationIndex([moving, destination, stable]);
    const moved = { ...moving, page: 2 };

    const next = createPageAnnotationIndex([moved, destination, stable], previous);

    expect(getPageAnnotations(next, 1)).toEqual([]);
    expect(getPageAnnotations(next, 2)).toEqual([moved, destination]);
    expect(getPageAnnotations(next, 3)).toBe(getPageAnnotations(previous, 3));
    expect(next.pageRevision.get(1)).toBe(previous.pageRevision.get(1) + 1);
    expect(next.pageRevision.get(2)).toBe(previous.pageRevision.get(2) + 1);
    expect(next.pageRevision.get(3)).toBe(previous.pageRevision.get(3));
  });

  test('deleting the last annotation removes stale page and id entries', () => {
    const removed = annotation('a', 1);
    const remaining = annotation('b', 2);
    const previous = createPageAnnotationIndex([removed, remaining]);

    const next = createPageAnnotationIndex([remaining], previous);

    expect(next.byPage.has(1)).toBe(false);
    expect(next.byId.has('a')).toBe(false);
    expect(getPageAnnotations(next, 2)).toBe(getPageAnnotations(previous, 2));
    expect(next.pageRevision.get(1)).toBe(previous.pageRevision.get(1) + 1);
  });

  test('preview overlay preserves untouched page arrays', () => {
    const pageOne = annotation('a', 1);
    const replaced = annotation('b', 2, 'old');
    const pageThree = annotation('c', 3);
    const index = createPageAnnotationIndex([pageOne, replaced, pageThree]);
    const preview = annotation('preview-b', 2, 'new');

    const overlay = buildPreviewPageAnnotationMap(index, {
      annotations: [preview],
      replacedIds: new Set(['b'])
    });

    expect(overlay.get(1)).toBe(index.byPage.get(1));
    expect(overlay.get(2)).toEqual([preview]);
    expect(overlay.get(3)).toBe(index.byPage.get(3));
  });

  test('normalizes invalid preview and committed pages consistently', () => {
    expect([
      normalizeAnnotationPageNumber(undefined),
      normalizeAnnotationPageNumber(0),
      normalizeAnnotationPageNumber(-2),
      normalizeAnnotationPageNumber('bad'),
      normalizeAnnotationPageNumber(Infinity)
    ]).toEqual([1, 1, 1, 1, 1]);

    const invalid = annotation('invalid', 'bad');
    const index = createPageAnnotationIndex([invalid]);
    const preview = annotation('preview', -3);
    const overlay = buildPreviewPageAnnotationMap(index, {
      annotations: [preview],
      replacedIds: new Set(['invalid'])
    });

    expect(getPageAnnotations(index, 1)).toEqual([invalid]);
    expect(overlay.get(1)).toEqual([preview]);
  });
});
