const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

const normalizeForMatch = (value) => normalizeText(value)
  .toUpperCase()
  .replace(/[^\p{L}\p{N}]+/gu, '');

const normalizeAmbiguousZeroForMatch = (value) => {
  const normalized = normalizeForMatch(value);
  if (!normalized) return '';

  let result = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const prev = normalized[index - 1] || '';
    const next = normalized[index + 1] || '';
    const isZeroLike = char === 'D' || char === 'O';
    const nearDigit = /\d/.test(prev) || /\d/.test(next);

    result += isZeroLike && nearDigit ? '0' : char;
  }
  return result;
};

const SUPPORT_KEYWORD_PATTERN = /支架|\bSUPPORTS?\b|\bPIPE\s+SUPPORTS?\b|\bSUPPORT\s+ASSY\b|\bSUPPORT\s+ITEMS?\b/i;
const SUPPORT_SECTION_HEADER_PATTERN = /^(支架|SUPPORTS?|PIPE\s+SUPPORTS?)$/i;
const MATERIAL_SECTION_HEADER_PATTERN = /^(PIPE|FITTINGS?|FLANGES?|GASKETS?|SUPPORTS?|BOLTS?|NUTS?|VALVES?\s*\/?\s*IN-?LINE\s+ITEMS?|FABRICATION\s+ITEMS?|ERECTION\s+ITEMS?|CUT\s+PIECE\s+LIST|WELD\s+LIST)$/i;

const MATERIAL_DESCRIPTION_KEYS = [
  'description',
  '材料描述',
  'DESCRIPTION',
  'MATERIAL_DESCRIPTION',
  'material_description',
  'materialDescription',
  'text',
  'column2'
];

const getRowColumnValues = (row) => {
  if (!row) return [];
  if (Array.isArray(row)) return row.map(value => normalizeText(value)).filter(Boolean);

  const values = [];
  for (let index = 1; index <= 16; index += 1) {
    const value = row[`column${index}`];
    if (value !== undefined && value !== null) {
      values.push(normalizeText(value));
    }
  }
  return values.filter(Boolean);
};

const getMaterialField = (row, keys) => {
  for (const key of keys) {
    const value = row?.[key];
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value);
    }
  }
  return '';
};

const getMaterialDescription = (row) => getMaterialField(row, MATERIAL_DESCRIPTION_KEYS);

const pickLikelySupportDescription = (row) => {
  const explicit = getMaterialDescription(row);
  if (explicit && !MATERIAL_SECTION_HEADER_PATTERN.test(explicit)) return explicit;

  const ignoredWords = /^(PART\s*NO\.?|PT\s*NO\.?|ITEM\s*CODE|SIZE(?:\s*\(.*\))?|ACC|QTY|QUANTITY|MATERIAL\s+DESCRIPTION|COMPONENT\s+DESCRIPTION|DESCRIPTION|DN|ND)$/i;
  const candidates = getRowColumnValues(row)
    .filter(value => {
      if (!value || ignoredWords.test(value)) return false;
      if (MATERIAL_SECTION_HEADER_PATTERN.test(value)) return false;
      if (/^\d+(?:\.\d+)?(?:\s*[A-Z]+)?$/i.test(value)) return false;
      return /[A-Z]/i.test(value) && /\d/.test(value) && value.length >= 4;
    })
    .map(value => ({
      value,
      score:
        value.length +
        (/[;；,，/]/.test(value) ? 20 : 0) +
        (/-/.test(value) ? 12 : 0) +
        (SUPPORT_KEYWORD_PATTERN.test(value) ? 30 : 0)
    }))
    .sort((left, right) => right.score - left.score);

  return candidates[0]?.value || '';
};

const hasMeaningfulSupportDescription = (row) => {
  const description = pickLikelySupportDescription(row);
  return !!description && !MATERIAL_SECTION_HEADER_PATTERN.test(description);
};

const hasUsableMaterialContent = (row) => {
  const description = getMaterialDescription(row);
  const specification = getMaterialField(row, ['specification', '规格', 'diameter', 'DN', 'ND', 'column3']);
  const materialCode = getMaterialField(row, ['materialCode', '材料代码', '材料编码', 'ITEM_CODE', 'itemCode', 'column4']);
  return !!description && !MATERIAL_SECTION_HEADER_PATTERN.test(description) && (!!specification || !!materialCode);
};

export const isSupportSectionHeader = (rowOrText) => {
  if (typeof rowOrText === 'string') {
    return SUPPORT_SECTION_HEADER_PATTERN.test(normalizeText(rowOrText));
  }

  return getRowColumnValues(rowOrText).some(value => SUPPORT_SECTION_HEADER_PATTERN.test(value)) ||
    SUPPORT_SECTION_HEADER_PATTERN.test(normalizeText(getMaterialDescription(rowOrText)));
};

export const isAnyMaterialSectionHeader = (rowOrText) => {
  if (typeof rowOrText === 'string') {
    return MATERIAL_SECTION_HEADER_PATTERN.test(normalizeText(rowOrText));
  }

  return getRowColumnValues(rowOrText).some(value => MATERIAL_SECTION_HEADER_PATTERN.test(value)) ||
    MATERIAL_SECTION_HEADER_PATTERN.test(normalizeText(getMaterialDescription(rowOrText)));
};

export const cleanScaffoldText = (text) => {
  if (!text || typeof text !== 'string') return '';

  const scaffoldPattern = /[Ss]-?\d{4,}/;
  const directMatch = text.match(scaffoldPattern);

  if (directMatch) {
    const matchedText = directMatch[0];
    const matchIndex = directMatch.index;
    const beforeChar = matchIndex > 0 ? text[matchIndex - 1] : ' ';
    const afterIndex = matchIndex + matchedText.length;
    const afterChar = afterIndex < text.length ? text[afterIndex] : ' ';
    const separatorPattern = /[\s,，、:：。.\/\-\(\)\[\]【】]/;
    const beforeIsSeparator = matchIndex === 0 || separatorPattern.test(beforeChar);
    const afterIsSeparator = afterIndex === text.length || separatorPattern.test(afterChar);

    if (beforeIsSeparator && afterIsSeparator) {
      let extracted = matchedText.replace(/^s/i, 'S');
      if (!extracted.includes('-')) {
        extracted = extracted.replace(/^S/, 'S-');
      }

      const textAfterMatch = text.substring(matchIndex);
      const hasSlash = /[Ss]-?\d{4,}\s*\//.test(textAfterMatch);
      if (hasSlash && !extracted.endsWith('/')) {
        extracted += '/';
      }

      return extracted;
    }
  }

  return '';
};

export const isValidScaffoldNumber = (text) => {
  const cleanedText = cleanScaffoldText(text);
  if (!cleanedText) return false;

  if (/^S-\d{6}\/?$/i.test(cleanedText)) return true;
  return /^S-?\d{4,}\/?$/i.test(cleanedText);
};

export const isSupportMaterialRow = (row) => {
  if (!row) return false;
  if (row.isSupportSectionMaterial === true) return true;

  const description = getMaterialDescription(row);
  const type = getMaterialField(row, ['type', '类型', 'category', 'column7']);
  const combined = `${description} ${type}`;
  return SUPPORT_KEYWORD_PATTERN.test(combined) && !isSupportSectionHeader(description);
};

export const buildScaffoldMaterialLibrary = (materials = []) => {
  const seen = new Set();
  let inSupportSection = false;

  return (materials || [])
    .map((row, index) => {
      const description = inSupportSection
        ? pickLikelySupportDescription(row)
        : getMaterialDescription(row);

      if (isSupportSectionHeader(row) || isSupportSectionHeader(description)) {
        inSupportSection = true;
        return null;
      }

      if (isAnyMaterialSectionHeader(row) || isAnyMaterialSectionHeader(description)) {
        inSupportSection = false;
        return null;
      }

      const isSupportRow = isSupportMaterialRow(row) ||
        (inSupportSection && (hasUsableMaterialContent(row) || hasMeaningfulSupportDescription(row)));
      if (!isSupportRow) return null;

      const normalizedDescription = normalizeForMatch(description);
      if (!normalizedDescription) return null;

      const libraryKey = [
        row.sourceDocument,
        row.pipelineNumber,
        description,
        row.specification || row.ND || row.diameter || row.column3,
        row.materialCode || row.ITEM_CODE || row.itemCode || row.column4
      ].map(normalizeForMatch).join('|');

      if (seen.has(libraryKey)) return null;
      seen.add(libraryKey);

      return {
        key: libraryKey || `support-material-${index}`,
        description,
        normalizedDescription,
        normalizedDescriptionZeroSafe: normalizeAmbiguousZeroForMatch(description),
        material: row
      };
    })
    .filter(Boolean);
};

const getStringSimilarity = (left, right) => {
  if (left === right) return 1;
  if (!left || !right) return 0;

  const a = left.length <= right.length ? left : right;
  const b = left.length <= right.length ? right : left;
  const previous = Array.from({ length: a.length + 1 }, (_, index) => index);

  for (let i = 1; i <= b.length; i += 1) {
    let prevDiagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= a.length; j += 1) {
      const temp = previous[j];
      previous[j] = b[i - 1] === a[j - 1]
        ? prevDiagonal
        : Math.min(previous[j - 1], previous[j], prevDiagonal) + 1;
      prevDiagonal = temp;
    }
  }

  return 1 - previous[a.length] / Math.max(left.length, right.length);
};

export const matchScaffoldLibraryText = (text, library = [], minSimilarity = 0.85) => {
  const normalizedText = normalizeForMatch(text);
  const zeroSafeText = normalizeAmbiguousZeroForMatch(text);
  if (!normalizedText || !Array.isArray(library) || library.length === 0) return null;
  if (/^\d+$/.test(normalizedText) || normalizedText.length < 4) return null;

  let bestMatch = null;
  for (const item of library) {
    const target = item.normalizedDescription;
    const zeroSafeTarget = item.normalizedDescriptionZeroSafe || normalizeAmbiguousZeroForMatch(item.description);
    if (!target) continue;

    const containsMatch = normalizedText.includes(target) || target.includes(normalizedText);
    const zeroSafeContainsMatch = zeroSafeText && zeroSafeTarget &&
      (zeroSafeText.includes(zeroSafeTarget) || zeroSafeTarget.includes(zeroSafeText));
    const similarity = containsMatch || zeroSafeContainsMatch
      ? 1
      : Math.max(
        getStringSimilarity(normalizedText, target),
        zeroSafeText && zeroSafeTarget ? getStringSimilarity(zeroSafeText, zeroSafeTarget) : 0
      );
    if (similarity >= minSimilarity && (!bestMatch || similarity > bestMatch.similarity)) {
      bestMatch = { ...item, similarity };
    }
  }

  return bestMatch;
};

export const isScaffoldDetection = (text, library = []) => {
  const libraryMatch = matchScaffoldLibraryText(text, library);
  if (libraryMatch) {
    return {
      matched: true,
      source: 'material-library',
      text,
      libraryMatch
    };
  }

  if (isValidScaffoldNumber(text)) {
    return { matched: true, source: 'number', text: cleanScaffoldText(text) };
  }

  return { matched: false };
};
