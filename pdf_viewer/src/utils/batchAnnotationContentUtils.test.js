import {
  convertMaterialSizeMmToIntegerInch,
  extractPipeSizesFromSupplementalText,
  extractJointTypeFromMaterialDescription,
  buildJointTypeConfirmationsByPipeline,
  resolveBatchSplitUpperContent
} from './batchAnnotationContentUtils';

test('synchronizes a recognized joint type to every page with the same pipeline number', () => {
  expect(buildJointTypeConfirmationsByPipeline({
    pages: [17, 18, 19, 20],
    pipelineNumberByPage: {
      17: 'PIPE-A',
      18: 'PIPE-A',
      19: 'PIPE-A',
      20: 'PIPE-B'
    },
    materialJointTypeByPage: { 17: 'BW', 20: 'RR' }
  })).toEqual({ 17: 'BW', 18: 'BW', 19: 'BW', 20: 'RR' });
});

test('uses a manual joint type as the shared value for the whole pipeline', () => {
  expect(buildJointTypeConfirmationsByPipeline({
    pages: [1, 2],
    pipelineNumberByPage: { 1: 'PIPE-A', 2: ' pipe-a ' },
    materialJointTypeByPage: { 1: 'BW' },
    manualJointTypeByPage: { 2: 'RR' }
  })).toEqual({ 1: 'RR', 2: 'RR' });
});

test('converts material SIZE(MM) to an integer nominal inch size', () => {
  expect(convertMaterialSizeMmToIntegerInch('450')).toBe('18');
  expect(convertMaterialSizeMmToIntegerInch('DN15')).toBe('0.5');
  expect(convertMaterialSizeMmToIntegerInch('SIZE(MM): 65')).toBe('2.5');
});

test('extracts artificial drawing joint type codes', () => {
  expect(extractJointTypeFromMaterialDescription('90 DEG ELBOW SMLS BW ASME B16.9')).toBe('BW');
  expect(extractJointTypeFromMaterialDescription('REDUCER A234 WPB RR ASME')).toBe('RR');
  expect(extractJointTypeFromMaterialDescription('OUTLET OL TYPE')).toBe('OL');
});

test('infers RR from steel reinforced polyethylene full couplings and taper sockets', () => {
  expect(extractJointTypeFromMaterialDescription(
    'FULL COUPLING STEEL REINFORCED POLYETHYLENE TAPER SOCKET'
  )).toBe('RR');
  expect(extractJointTypeFromMaterialDescription(
    'FULL-COUPLING, SRPE, TAPERED-SOCKET'
  )).toBe('RR');
  expect(extractJointTypeFromMaterialDescription(
    'FULL COUPLING CARBON STEEL SOCKET'
  )).toBe('');
});

test('uses the inferred polyethylene RR type in batch annotation content', () => {
  const result = resolveBatchSplitUpperContent({
    pageNum: 17,
    batchContent: {
      jointTypeSource: 'material',
      materialRowsByPage: {
        17: [{ description: 'FULL COUPLING STEEL REINFORCED POLYETHYLENE TAPER SOCKET' }]
      }
    }
  });
  expect(result.jointType).toBe('RR');
  expect(result.jointTypeExtractionMode).toBe('description');
  expect(result.standardJointTypeCandidates).toEqual([{ code: 'RR', count: 1 }]);
});

test('uses same-page material values and keeps manual values as fallback', () => {
  const result = resolveBatchSplitUpperContent({
    pageNum: 108,
    pipelineNumber: '3025002-FLG-307',
    batchContent: {
      diameterSource: 'material',
      jointTypeSource: 'material',
      manualDiameter: '20',
      manualJointType: 'RR',
      materialRowsByPage: {
        108: [{
          specification: '450',
          description: '90 DEG ELBOW SMLS BW ASME B16.9',
          pipelineNumber: '3025002-FLG-307'
        }]
      }
    }
  });

  expect(result.diameter).toBe('18');
  expect(result.jointType).toBe('BW');
  expect(result.jointTypeExtractionMode).toBe('description');
});

test('keeps a single PIPE diameter when MinerU returns a lowercase size field', () => {
  const result = resolveBatchSplitUpperContent({
    pageNum: 10,
    batchContent: {
      diameterSource: 'material',
      materialRowsByPage: {
        10: [{ size: '100', description: 'PIPE A312 SMLS' }]
      }
    }
  });

  expect(result.diameter).toBe('4');
  expect(result.diameterCandidates).toEqual(['4']);
});

test('collects FITTINGS diameters without overriding the PIPE default', () => {
  const result = resolveBatchSplitUpperContent({
    pageNum: 10,
    batchContent: {
      diameterSource: 'material',
      materialRowsByPage: {
        10: [
          { size: '200', description: 'PIPE A106 SMLS' },
          { size: '100', description: '90 DEG ELBOW BW' },
          { size: '100', description: 'TEE BW' }
        ]
      }
    }
  });

  expect(result.diameter).toBe('8');
  expect(result.diameterCandidates).toEqual(['8', '4']);
  expect(result.pipeMaterialRows).toBe(1);
  expect(result.fittingMaterialRows).toBe(2);
});

test('fills diameter from FITTINGS when no PIPE size is available', () => {
  const result = resolveBatchSplitUpperContent({
    pageNum: 11,
    batchContent: {
      diameterSource: 'material',
      materialRowsByPage: {
        11: [{ specification: '150', description: 'ELBOW SMLS BW' }]
      }
    }
  });

  expect(result.diameter).toBe('6');
  expect(result.diameterCandidates).toEqual(['6']);
});

test('keeps both reducer diameters as selectable candidates', () => {
  const result = resolveBatchSplitUpperContent({
    pageNum: 12,
    batchContent: {
      diameterSource: 'material',
      materialRowsByPage: {
        12: [{ specification: '200x100', description: 'REDUCER BW' }]
      }
    }
  });

  expect(result.diameterCandidates).toEqual(['8', '4']);
});

test('recovers a single PIPE diameter glued to an ASME description', () => {
  const result = resolveBatchSplitUpperContent({
    pageNum: 12,
    batchContent: {
      diameterSource: 'material',
      materialRowsByPage: {
        12: [{ description: 'PIPE A312GR.TP304L SMLS PE ASME B36.19100 S-10S' }]
      }
    }
  });

  expect(result.diameter).toBe('4');
  expect(result.diameterRawValues).toEqual(['100']);
});

test('recovers a single PIPE size from the original MinerU logical rows', () => {
  const supplemental = JSON.stringify([{
    material: [{
      column1: { text: '1' },
      column2: { text: 'ITEM-001' },
      column3: { text: '100' },
      column4: { text: '' },
      column5: { text: 'PIPE A312 SMLS' },
      column6: { text: '36M' }
    }]
  }]);
  expect(extractPipeSizesFromSupplementalText(supplemental)).toEqual(['100']);

  const result = resolveBatchSplitUpperContent({
    pageNum: 10,
    batchContent: {
      diameterSource: 'material',
      materialRowsByPage: {
        10: [{ description: 'PIPE', specification: '' }]
      },
      jointTypeSupplementalTextByPage: { 10: supplemental }
    }
  });
  expect(result.diameter).toBe('4');
  expect(result.diameterExtractionMode).toBe('source-logical-fallback');
});

test('recovers a joint type when MinerU shifts the description into a raw column', () => {
  const result = resolveBatchSplitUpperContent({
    pageNum: 117,
    pipelineNumber: '3035001-LLPC-307',
    batchContent: {
      jointTypeSource: 'material',
      materialRowsByPage: {
        117: [{
          description: '135837989',
          pipelineNumber: '3035001-LLPC-307',
          rawLogicalRow: ['2', '135837989', '250', '', '90 DEG ELBOW A234GR.WPB SMLS BW ASME B16.9', '7']
        }]
      }
    }
  });

  expect(result.jointType).toBe('BW');
  expect(result.jointTypeExtractionMode).toBe('raw-row-fallback');
  expect(result.rawJointTypeCandidates).toEqual([{ code: 'BW', count: 1 }]);
});

test('uses a page-specific manual joint type only for that page', () => {
  const batchContent = {
    jointTypeSource: 'material',
    jointTypeConfirmationsByPage: { 117: 'bw' },
    materialRowsByPage: {
      117: [{ description: 'PSP103' }],
      118: [{ description: 'PSP103' }]
    }
  };

  const confirmed = resolveBatchSplitUpperContent({ pageNum: 117, batchContent });
  const untouched = resolveBatchSplitUpperContent({ pageNum: 118, batchContent });
  expect(confirmed.jointType).toBe('BW');
  expect(confirmed.jointTypeExtractionMode).toBe('page-manual');
  expect(untouched.jointType).toBe('');
});

test('uses MinerU source text only as a joint type fallback without adding material rows', () => {
  const result = resolveBatchSplitUpperContent({
    pageNum: 117,
    batchContent: {
      jointTypeSource: 'material',
      materialRowsByPage: { 117: [{ description: 'PSP103' }] },
      jointTypeSupplementalTextByPage: {
        117: '90 DEG ELBOW A234GR.WPB SMLS BW ASME B16.9'
      }
    }
  });
  expect(result.jointType).toBe('BW');
  expect(result.jointTypeExtractionMode).toBe('source-logical-fallback');
  expect(result.pageMaterialRows).toBe(1);
});

test('defaults to the most frequent PIPE diameter and allows a page override', () => {
  const batchContent = {
    diameterSource: 'material',
    jointTypeSource: 'material',
    materialRowsByPage: {
      110: [
        { specification: '450', description: 'PIPE A106 GR.B SMLS' },
        { specification: '300', description: 'PIPE A106 GR.B SMLS' },
        { specification: '450', description: '90 DEG ELBOW SMLS BW' }
      ]
    }
  };

  const unresolved = resolveBatchSplitUpperContent({
    pageNum: 110,
    batchContent
  });
  expect(unresolved.diameter).toBe('18');
  expect(unresolved.diameterCandidates).toEqual(['18', '12']);
  expect(unresolved.requiresDiameterConfirmation).toBe(false);
  expect(unresolved.diameterConfirmationMode).toBe('auto-majority');

  const confirmed = resolveBatchSplitUpperContent({
    pageNum: 110,
    batchContent: {
      ...batchContent,
      diameterConfirmationsByPage: { 110: '12' }
    }
  });
  expect(confirmed.diameter).toBe('12');
  expect(confirmed.requiresDiameterConfirmation).toBe(false);
});

test('maps material diameters to weld-number ranges during automatic annotation', () => {
  const batchContent = {
    diameterSource: 'material',
    materialRowsByPage: {
      110: [
        { specification: '450', description: 'PIPE A106 GR.B SMLS' },
        { specification: '450', description: 'PIPE A106 GR.B SMLS' },
        { specification: '300', description: 'PIPE A106 GR.B SMLS' }
      ]
    },
    diameterRangesByPage: {
      110: { 12: '67-70' }
    }
  };

  expect(resolveBatchSplitUpperContent({ pageNum: 110, weldNumber: 12, batchContent }).diameter).toBe('18');
  const branch = resolveBatchSplitUpperContent({ pageNum: 110, weldNumber: 68, batchContent });
  expect(branch.diameter).toBe('12');
  expect(branch.diameterConfirmationMode).toBe('number-range');
});

test('allows an ambiguous page to remain blank for per-weld confirmation', () => {
  const result = resolveBatchSplitUpperContent({
    pageNum: 110,
    batchContent: {
      diameterSource: 'material',
      materialRowsByPage: {
        110: [
          { specification: '450', description: 'PIPE A106 GR.B SMLS' },
          { specification: '300', description: 'PIPE A106 GR.B SMLS' }
        ]
      },
      diameterConfirmationsByPage: { 110: '__MANUAL_PER_WELD__' }
    }
  });

  expect(result.diameter).toBe('');
  expect(result.diameterConfirmed).toBe(true);
  expect(result.diameterConfirmationMode).toBe('per-weld');
});
