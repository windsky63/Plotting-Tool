// DN-to-inch values from the supplied project reference table.
// Fractional inch values are represented as decimals for annotation display.
export const DN_TO_INCH = Object.freeze({
  15: '0.5',
  20: '0.75',
  25: '1',
  32: '1.25',
  40: '1.5',
  50: '2',
  65: '2.5',
  80: '3',
  100: '4',
  125: '5',
  150: '6',
  200: '8',
  250: '10',
  300: '12',
  350: '14',
  400: '16',
  450: '18',
  500: '20',
  550: '22',
  600: '24',
  650: '26',
  700: '28',
  750: '30',
  800: '32',
  850: '34',
  900: '36',
  950: '38',
  1000: '40',
  1050: '42',
  1100: '44',
  1150: '46',
  1200: '48',
  1300: '52',
  1400: '56',
  1500: '60',
  1600: '64',
  1700: '68',
  1800: '72',
  1900: '76',
  2000: '80'
});

export const convertDnToInch = value => {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) return '';

  const exactValue = DN_TO_INCH[numericValue];
  if (exactValue) return exactValue;

  // Preserve compatibility for uncommon large values while keeping small DN
  // strict because a simple division is incorrect there.
  if (numericValue >= 100) {
    return String(Math.max(1, Math.round(numericValue / 25)));
  }
  return '';
};
