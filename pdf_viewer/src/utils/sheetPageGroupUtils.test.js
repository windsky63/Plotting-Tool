import {
  inferSheetPdfPageRange,
  parseSheetPageReference,
  validateSheetPdfPageRange
} from './sheetPageGroupUtils';

describe('sheet page grouping', () => {
  test.each([
    [['SECT.', '1', 'OF', '12', 'REV.', '1'], 1, 12],
    ['SHEET 3 OF 17', 3, 17],
    ['4/6', 4, 6]
  ])('parses %p', (source, current, total) => {
    expect(parseSheetPageReference(source)).toMatchObject({ current, total });
  });

  test('rejects an invalid sheet reference', () => {
    expect(parseSheetPageReference('13 OF 12')).toBeNull();
  });

  test('infers and validates the complete PDF page range', () => {
    const range = inferSheetPdfPageRange({
      pdfPage: 9,
      reference: { current: 3, total: 12 },
      pdfPageCount: 80
    });
    expect(range).toMatchObject({ startPage: 7, endPage: 18, total: 12 });
    expect(validateSheetPdfPageRange({
      range,
      firstReference: { current: 1, total: 12 },
      lastReference: { current: 12, total: 12 }
    })).toBe(true);
  });
});

