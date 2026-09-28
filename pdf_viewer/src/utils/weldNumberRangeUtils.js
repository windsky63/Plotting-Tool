const normalizeRangeText = value => String(value ?? '')
  .normalize('NFKC')
  .replace(/[，、；;]/g, ',')
  .replace(/[～~—–至]/g, '-')
  .trim();

export const splitWeldNumberRangeTokens = value => normalizeRangeText(value)
  .split(',')
  .map(part => part.trim())
  .filter(Boolean);

export const parseWeldNumberRanges = value => {
  const text = normalizeRangeText(value);
  if (!text) return { valid: true, ranges: [], invalidParts: [] };
  const ranges = [];
  const invalidParts = [];
  splitWeldNumberRangeTokens(text).forEach(part => {
    const single = part.match(/^(\d+)$/);
    if (single) {
      const number = Number(single[1]);
      ranges.push({ start: number, end: number });
      return;
    }
    const interval = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (!interval) {
      invalidParts.push(part);
      return;
    }
    const left = Number(interval[1]);
    const right = Number(interval[2]);
    ranges.push({ start: Math.min(left, right), end: Math.max(left, right) });
  });
  return { valid: invalidParts.length === 0, ranges, invalidParts };
};

export const weldNumberInRanges = (number, ranges) => {
  const numeric = Number(number);
  if (!Number.isFinite(numeric)) return false;
  return (ranges || []).some(range => numeric >= range.start && numeric <= range.end);
};

export const getAnnotationWeldNumber = annotation => {
  const structured = annotation?.weldData?.weldNumber ?? annotation?.weldNumber ?? annotation?.number;
  if (structured !== undefined && structured !== null && structured !== '') {
    const numeric = Number(structured);
    if (Number.isFinite(numeric)) return numeric;
  }
  const match = String(annotation?.text || '').match(/\d+/);
  return match ? Number(match[0]) : NaN;
};

export const buildWeldNumberRangeTokens = values => {
  const numbers = Array.from(new Set((Array.isArray(values) ? values : [])
    .map(Number)
    .filter(value => Number.isInteger(value) && value > 0)))
    .sort((left, right) => left - right);
  if (!numbers.length) return [];

  const ranges = [];
  let start = numbers[0];
  let end = numbers[0];
  for (let index = 1; index < numbers.length; index += 1) {
    const current = numbers[index];
    if (current === end + 1) {
      end = current;
      continue;
    }
    ranges.push(start === end ? String(start) : `${start}-${end}`);
    start = current;
    end = current;
  }
  ranges.push(start === end ? String(start) : `${start}-${end}`);
  return ranges;
};
