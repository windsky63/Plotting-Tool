import {
  getCanonicalWeldDisplayNumber,
  getWeldDisplayAffixKey,
  getWeldDisplayAffixes,
  replaceWeldDisplayNumber
} from './weldDisplayNumberUtils';

describe('replaceWeldDisplayNumber', () => {
  test('preserves a weld prefix and suffix', () => {
    expect(replaceWeldDisplayNumber('F12A', 12, 13)).toBe('F13A');
  });

  test('does not replace an unrelated number in the prefix', () => {
    expect(replaceWeldDisplayNumber('AREA2-F12-R1', 12, 13)).toBe('AREA2-F13-R1');
  });

  test('extracts the exact prefix and suffix around the structured weld number', () => {
    expect(getWeldDisplayAffixes('AREA2-F12-R1', 12)).toEqual({
      prefix: 'AREA2-F', suffix: '-R1', key: '["AREA2-F","-R1"]'
    });
    expect(getWeldDisplayAffixes('12', 12)?.key).toBe('["",""]');
  });

  test('falls back to a plain number when the old number is absent', () => {
    expect(replaceWeldDisplayNumber('WELD', 12, 13)).toBe('13');
  });

  test('keeps preview/export display behavior and honors numberless welds', () => {
    expect(getCanonicalWeldDisplayNumber({ displayNumber: 'F12A', weldNumber: 12 })).toBe('F12A');
    expect(getCanonicalWeldDisplayNumber({ weldNumber: 12 })).toBe(12);
    expect(getCanonicalWeldDisplayNumber({ displayNumber: 'F12A', weldNumber: 12, isNumberless: true })).toBe('');
  });

  test('uses stored numeric affixes instead of ambiguously reparsing visible digits', () => {
    const weld = {
      text: 'F1234',
      displayNumber: 'F1234',
      weldNumber: 23,
      prefix: 'F1',
      suffix: '4'
    };
    expect(getWeldDisplayAffixKey(weld)).toBe('["F1","4"]');
    expect(getCanonicalWeldDisplayNumber(weld)).toBe('F1234');
    expect(getCanonicalWeldDisplayNumber({ ...weld, weldNumber: 24 })).toBe('F1244');
  });
});
