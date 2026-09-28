import {
  buildWeldNumberRangeTokens,
  parseWeldNumberRanges,
  weldNumberInRanges,
  getAnnotationWeldNumber,
  splitWeldNumberRangeTokens
} from './weldNumberRangeUtils';

describe('weld number range utils', () => {
  test('splits discontinuous weld numbers into separate ranges', () => {
    expect(buildWeldNumberRangeTokens([
      1, 2, 3, 30, 29, 28, 52, 53, 58, 54, 55, 56, 57, 2
    ])).toEqual(['1-3', '28-30', '52-58']);
  });

  test('keeps isolated weld numbers as separate tokens', () => {
    expect(buildWeldNumberRangeTokens([1, 3, 4, 9])).toEqual(['1', '3-4', '9']);
  });
  test('parses mixed Chinese and ASCII ranges', () => {
    expect(parseWeldNumberRanges('1～20，67-70, 88')).toEqual({
      valid: true,
      ranges: [
        { start: 1, end: 20 },
        { start: 67, end: 70 },
        { start: 88, end: 88 }
      ],
      invalidParts: []
    });
  });

  test('reports invalid parts and matches only included weld numbers', () => {
    const parsed = parseWeldNumberRanges('1-20,bad');
    expect(parsed.valid).toBe(false);
    expect(parsed.invalidParts).toEqual(['bad']);
    expect(weldNumberInRanges(20, parsed.ranges)).toBe(true);
    expect(weldNumberInRanges(21, parsed.ranges)).toBe(false);
  });

  test('reads a structured number before falling back to display text', () => {
    expect(getAnnotationWeldNumber({ weldData: { weldNumber: 67 }, text: 'F12' })).toBe(67);
    expect(getAnnotationWeldNumber({ text: 'F70' })).toBe(70);
  });

  test('keeps multiple ranges as independent dropdown values', () => {
    expect(splitWeldNumberRangeTokens('1-20,67-70,88')).toEqual(['1-20', '67-70', '88']);
  });
});
