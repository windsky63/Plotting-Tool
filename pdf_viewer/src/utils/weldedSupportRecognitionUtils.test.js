import {
  WELDED_SUPPORT_CODES,
  findWeldedSupportCode,
  extractWeldedSupportWelds,
  extractStaticGroundingNotices,
  isStaticGroundingRetryHint,
  extractPositioningBlockNotices
} from './weldedSupportRecognitionUtils';

describe('static grounding retry hint', () => {
  test('accepts SEE DETAIL A only as a retry candidate', () => {
    expect(isStaticGroundingRetryHint('SEE DETAIL A')).toBe(true);
  });

  test('accepts a dropped SEE only with grounding detail evidence', () => {
    expect(isStaticGroundingRetryHint('DETAIL A\nWELDED EARTHING LUG\nED-000-PIP-SPC-0010')).toBe(true);
    expect(isStaticGroundingRetryHint('DETAIL A')).toBe(false);
  });
});

describe('welded support recognition', () => {
  test('contains every support code from the reference image', () => {
    expect(WELDED_SUPPORT_CODES).toEqual(expect.arrayContaining([
      'S1', 'A1S3', 'D1S4', 'DS1/2', 'DMS1/S2', 'TR1', 'TR2',
      'G2TR1', 'G2TR2', 'PS1', 'ES1', 'LTR1', 'RV3', 'J13', 'TP-002', 'F6', 'R2PS14', 'DSC'
    ]));
  });

  test('matches the longest complete code and does not match S1 inside another code', () => {
    expect(findWeldedSupportCode('支架 DMS1/S2')).toBe('DMS1/S2');
    expect(findWeldedSupportCode('A1S3')).toBe('A1S3');
    expect(findWeldedSupportCode('SUPPORT J13')).toBe('J13');
    expect(findWeldedSupportCode('支架 TP-002')).toBe('TP-002');
    expect(findWeldedSupportCode('SUPPORT R2PS14')).toBe('R2PS14');
    expect(findWeldedSupportCode('支架 DSC')).toBe('DSC');
    expect(findWeldedSupportCode('SUPPORT F6')).toBe('F6');
    expect(findWeldedSupportCode('XS1A')).toBe('');
  });

  test('creates support welds only inside the weld recognition area', () => {
    const boxAt = (x, y) => [[x - 2, y - 2], [x + 2, y - 2], [x + 2, y + 2], [x - 2, y + 2]];
    const results = extractWeldedSupportWelds({
      pageNum: 2,
      pageInfo: { page_width: 1000, page_height: 800 },
      recognitionArea: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
      detections: [
        { text: 'TR1', box: boxAt(200, 200) },
        { text: 'RV3', box: boxAt(900, 700) },
        { text: 'NOT-SUPPORT', box: boxAt(300, 300) }
      ]
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ pageNum: 2, supportCode: 'TR1', isWeldedSupport: true });
  });

  test('declares static grounding from the lower SEG-PIP text only', () => {
    const boxAt = (x, y, width = 80, height = 12) => [
      [x, y], [x + width, y], [x + width, y + height], [x, y + height]
    ];
    const results = extractStaticGroundingNotices({
      pageNum: 7,
      pageInfo: { page_width: 1000, page_height: 800 },
      recognitionArea: { x: 0.1, y: 0.1, width: 0.6, height: 0.6 },
      detections: [
        { text: 'SEQ DETAIL A', box: boxAt(220, 250) },
        { text: 'SEG-PIP', box: boxAt(225, 270) },
        { text: 'SEC-PIPE', box: boxAt(900, 700) }
      ]
    });
    expect(results).toEqual([expect.objectContaining({
      type: 'static-grounding',
      pageNum: 7,
      numberingPrefix: 'E'
    })]);
  });

  test('declares static grounding when OCR recognizes only one bound line', () => {
    const results = extractStaticGroundingNotices({
      pageNum: 3,
      pageInfo: { page_width: 1000, page_height: 800 },
      detections: [{ text: 'SEG-PIP', box: [[200, 200], [280, 200], [280, 212], [200, 212]] }]
    });
    expect(results).toEqual([expect.objectContaining({
      type: 'static-grounding',
      pageNum: 3,
      numberingPrefix: 'E'
    })]);
  });

  test('tolerates common OCR character confusion in either bound line', () => {
    const results = extractStaticGroundingNotices({
      pageNum: 8,
      pageInfo: { page_width: 1000, page_height: 800 },
      detections: [{ text: 'SEG-P1P', box: [[200, 200], [300, 200], [300, 212], [200, 212]] }]
    });
    expect(results).toHaveLength(1);
  });

  test('does not declare grounding from SEQ DETAIL A without SEG-PIP', () => {
    const results = extractStaticGroundingNotices({
      pageNum: 9,
      pageInfo: { page_width: 1000, page_height: 800 },
      detections: [{ text: 'SEQ DETAIL A', box: [[200, 200], [300, 200], [300, 212], [200, 212]] }]
    });
    expect(results).toEqual([]);
  });

  test('declares a positioning block from lower JPLATE text and ignores upper text', () => {
    const results = extractPositioningBlockNotices({
      pageNum: 10,
      pageInfo: { page_width: 1000, page_height: 800 },
      detections: [
        { text: 'ANY UPPER TEXT', box: [[200, 180], [300, 180], [300, 192], [200, 192]] },
        { text: 'JPLATE', box: [[200, 200], [280, 200], [280, 212], [200, 212]] }
      ]
    });
    expect(results).toEqual([expect.objectContaining({
      type: 'positioning-block',
      pageNum: 10,
      label: 'JPLATE'
    })]);
  });

  test('does not declare a positioning block from unrelated upper text', () => {
    const results = extractPositioningBlockNotices({
      pageNum: 11,
      pageInfo: { page_width: 1000, page_height: 800 },
      detections: [{ text: 'SEQ DETAIL A', box: [[200, 200], [300, 200], [300, 212], [200, 212]] }]
    });
    expect(results).toEqual([]);
  });
});
