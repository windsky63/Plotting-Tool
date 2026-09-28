import { selectPanelTextAnnotations } from './annotationPanelSelectors';

describe('selectPanelTextAnnotations', () => {
  test('filters only text and scaffold annotations from the supplied page slice', () => {
    const text = { id: 'text', type: 'text', page: 8 };
    const scaffold = { id: 'scaffold', type: 'shape', isScaffoldAnnotation: true, page: 8 };
    const shape = { id: 'shape', type: 'shape', page: 8 };

    expect(selectPanelTextAnnotations([text, scaffold, shape])).toEqual([text, scaffold]);
  });

  test('returns an empty list for missing page data', () => {
    expect(selectPanelTextAnnotations(undefined)).toEqual([]);
  });
});
