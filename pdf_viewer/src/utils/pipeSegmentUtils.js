const LETTERS_PER_BLOCK = 26;

const normalizeStartText = (startText) => startText || 'A';

const normalizeZeroPadCount = (zeroPadCount = 0) => {
  const parsed = Number.parseInt(zeroPadCount, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(parsed, 8);
};

const formatNumberPart = (number, zeroPadCount = 0) => {
  const text = String(number);
  const zeros = normalizeZeroPadCount(zeroPadCount);
  return zeros > 0 ? text.padStart(zeros + 1, '0') : text;
};

export const letterSequenceToIndex = (text) => {
  let index = 0;

  for (let i = 0; i < text.length; i += 1) {
    index = index * LETTERS_PER_BLOCK + (text.charCodeAt(i) - 64);
  }

  return index - 1;
};

export const indexToLetterSequence = (index) => {
  let current = index;
  let result = '';

  do {
    result = String.fromCharCode(65 + (current % LETTERS_PER_BLOCK)) + result;
    current = Math.floor(current / LETTERS_PER_BLOCK) - 1;
  } while (current >= 0);

  return result;
};

export const getNextPipeSegmentLabel = (startText, counter = 0, zeroPadCount = 0) => {
  const safeStartText = normalizeStartText(startText);

  if (/^\d+$/.test(safeStartText)) {
    const startNumber = parseInt(safeStartText, 10);
    return formatNumberPart(startNumber + counter, zeroPadCount);
  }

  const numberMatch = safeStartText.match(/(.*?)(\d+)(.*)/);
  if (numberMatch) {
    const [, prefix, numberPart, suffix] = numberMatch;
    const startNumber = parseInt(numberPart, 10);
    return `${prefix}${formatNumberPart(startNumber + counter, zeroPadCount)}${suffix}`;
  }

  if (/^[A-Za-z]+$/.test(safeStartText)) {
    const startIndex = letterSequenceToIndex(safeStartText.toUpperCase());
    return indexToLetterSequence(startIndex + counter);
  }

  return counter === 0 ? safeStartText : `${safeStartText}${counter + 1}`;
};

export default getNextPipeSegmentLabel;
