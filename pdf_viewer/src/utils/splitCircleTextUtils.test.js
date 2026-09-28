import { formatSplitCircleTopText } from './splitCircleTextUtils';

describe('formatSplitCircleTopText', () => {
  test.each([
    ['4', 'BW', '4"BW'],
    ['4', '', '4'],
    ['', 'BW', 'BW'],
    ['', '', '']
  ])('formats diameter %p and joint type %p', (diameter, jointType, expected) => {
    expect(formatSplitCircleTopText(diameter, jointType)).toBe(expected);
  });
});
