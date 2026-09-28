import { collectBatchMaterialCandidates } from './batchMaterialCandidateUtils';

describe('collectBatchMaterialCandidates', () => {
  test('collects and ranks every diameter and joint type from material rows', () => {
    expect(collectBatchMaterialCandidates([
      { specification: '150', description: 'PIPE BW' },
      { specification: '150', description: 'ELBOW BW' },
      { specification: '100', description: 'REDUCER RR' }
    ])).toEqual({
      diameters: [
        { value: '6', count: 2 },
        { value: '4', count: 1 }
      ],
      jointTypes: [
        { value: 'BW', count: 2 },
        { value: 'RR', count: 1 }
      ]
    });
  });

  test('uses fitting sizes as diameter candidates', () => {
    expect(collectBatchMaterialCandidates([
      { specification: '50', description: '弯头 BW' },
      { specification: '80', description: 'TEE SW' },
      { specification: '100', description: 'FLANGE' }
    ]).diameters).toEqual([
      { value: '4', count: 1 },
      { value: '3', count: 1 },
      { value: '2', count: 1 }
    ]);
  });

  test('keeps PIPE diameter first while retaining more frequent FITTINGS sizes', () => {
    expect(collectBatchMaterialCandidates([
      { specification: '200', description: 'PIPE' },
      { specification: '100', description: 'ELBOW' },
      { specification: '100', description: 'TEE' }
    ]).diameters).toEqual([
      { value: '8', count: 1 },
      { value: '4', count: 2 }
    ]);
  });

  test('prefers the larger diameter when material quantities are tied', () => {
    expect(collectBatchMaterialCandidates([
      { specification: '100', description: 'PIPE' },
      { specification: '200', description: 'PIPE' }
    ]).diameters).toEqual([
      { value: '8', count: 1 },
      { value: '4', count: 1 }
    ]);
  });

  test('uses raw OCR cells as a fallback without counting one row twice', () => {
    expect(collectBatchMaterialCandidates([
      {
        rawLogicalRow: ['1', 'ITEM', '200', '', 'PIPE OL'],
        rawMaterial: { DESCRIPTION: 'PIPE OL' }
      }
    ])).toEqual({
      diameters: [{ value: '8', count: 1 }],
      jointTypes: [{ value: 'OL', count: 1 }]
    });
  });

  test('keeps the single PIPE size when MinerU glues it to the description', () => {
    expect(collectBatchMaterialCandidates([
      { description: 'PIPE A312GR.TP304L SMLS PE ASME B36.19100 S-10S' }
    ]).diameters).toEqual([
      { value: '4', count: 1 }
    ]);
  });
});
