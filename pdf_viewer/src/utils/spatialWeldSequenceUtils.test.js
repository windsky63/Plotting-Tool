import { buildSpatiallyContinuousWeldSequence } from './spatialWeldSequenceUtils';

describe('spatial weld sequence', () => {
  test('keeps nearby welds together instead of alternating between distant rows', () => {
    const welds = [
      { id: 'top-1', center: { x: 0, y: 0 } },
      { id: 'top-2', center: { x: 100, y: 0 } },
      { id: 'bottom-1', center: { x: 0, y: 150 } },
      { id: 'top-3', center: { x: 200, y: 0 } },
      { id: 'bottom-2', center: { x: 100, y: 150 } },
      { id: 'bottom-3', center: { x: 200, y: 150 } }
    ];

    const result = buildSpatiallyContinuousWeldSequence(welds, {
      pageInfo: { page_width: 600, page_height: 400 }
    });

    expect(result.welds.map(weld => weld.id)).toEqual([
      'top-1', 'top-2', 'top-3', 'bottom-3', 'bottom-2', 'bottom-1'
    ]);
  });

  test('reports a long jump without dropping either weld', () => {
    const result = buildSpatiallyContinuousWeldSequence([
      { id: 'a', center: { x: 0, y: 0 } },
      { id: 'b', center: { x: 20, y: 0 } },
      { id: 'remote', center: { x: 500, y: 500 } }
    ], {
      pageInfo: { page_width: 600, page_height: 600 },
      maxDistance: 100
    });

    expect(result.welds.map(weld => weld.id)).toEqual(['a', 'b', 'remote']);
    expect(result.breaks).toHaveLength(1);
    expect(result.breaks[0].weldId).toBe('remote');
  });
});

