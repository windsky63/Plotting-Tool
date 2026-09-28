import { convertDnToInch, DN_TO_INCH } from './nominalDiameterUtils';

describe('DN to decimal inch reference conversion', () => {
  test.each([
    [15, '0.5'],
    [20, '0.75'],
    [25, '1'],
    [32, '1.25'],
    [40, '1.5'],
    [50, '2'],
    [65, '2.5'],
    [80, '3'],
    [100, '4'],
    [450, '18'],
    [1200, '48'],
    [2000, '80']
  ])('converts DN%s to %s inch', (dn, inch) => {
    expect(convertDnToInch(dn)).toBe(inch);
  });

  test('contains all 40 rows from the supplied reference image', () => {
    expect(Object.keys(DN_TO_INCH)).toHaveLength(40);
  });

  test('does not guess an unlisted small DN value', () => {
    expect(convertDnToInch(90)).toBe('');
  });
});
