const normalizeTexts = value => (
  (Array.isArray(value) ? value : [value])
    .map(item => String(item?.text ?? item ?? '').trim())
    .filter(Boolean)
);

export const parseSheetPageReference = value => {
  const texts = normalizeTexts(value);
  const candidates = [
    ...texts,
    texts.join(' ')
  ];
  const patterns = [
    /(?:SECT\.?|SHEET|PAGE)?\s*(\d{1,4})\s*OF\s*(\d{1,4})/i,
    /(?:SHEET|PAGE)?\s*(\d{1,4})\s*\/\s*(\d{1,4})/i
  ];
  for (const text of candidates) {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (!match) continue;
      const current = Number(match[1]);
      const total = Number(match[2]);
      if (!Number.isInteger(current) || !Number.isInteger(total) || current < 1 || total < 1 || current > total) {
        continue;
      }
      return { current, total, raw: match[0].trim() };
    }
  }
  return null;
};

export const inferSheetPdfPageRange = ({ pdfPage, reference, pdfPageCount }) => {
  const page = Number(pdfPage);
  const totalPdfPages = Number(pdfPageCount);
  if (!Number.isInteger(page) || !reference) return null;
  const startPage = page - Number(reference.current) + 1;
  const endPage = startPage + Number(reference.total) - 1;
  if (
    startPage < 1 ||
    endPage < startPage ||
    (Number.isInteger(totalPdfPages) && totalPdfPages > 0 && endPage > totalPdfPages)
  ) {
    return null;
  }
  return {
    startPage,
    endPage,
    total: Number(reference.total),
    pages: Array.from({ length: Number(reference.total) }, (_, index) => startPage + index)
  };
};

export const validateSheetPdfPageRange = ({ range, firstReference, lastReference }) => Boolean(
  range &&
  firstReference?.current === 1 &&
  firstReference?.total === range.total &&
  lastReference?.current === range.total &&
  lastReference?.total === range.total
);

