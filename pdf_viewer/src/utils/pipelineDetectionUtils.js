/**
 * 管线号提取与统计工具
 * 基于整页 OCR 文字检测结果自动推断每页最佳管线号，
 * 并为多页焊点编号结果生成核对统计与导出数据。
 */

const UNRESOLVED_GROUP_KEY = '__UNRESOLVED_PIPELINE__';
const PIPELINE_REFERENCE_UNRESOLVED_KEY = '__UNRESOLVED_PIPELINE_COMPARISON__';
const MATCHED_THRESHOLD = 5.2;

const STRONG_PIPELINE_PATTERNS = [
  /^\d{1,4}(?:[-_/][A-Z0-9]{1,10}){2,6}(?:\([A-Z0-9]{2,12}\))?$/,
  /^[A-Z]{1,6}[-_/]\d{1,6}(?:[-_/][A-Z0-9]{1,8}){0,4}(?:\([A-Z0-9]{2,12}\))?$/,
  /^[A-Z]{1,4}\d{1,4}[-_/][A-Z0-9]{1,8}(?:[-_/][A-Z0-9]{1,8}){0,3}(?:\([A-Z0-9]{2,12}\))?$/,
  /^[A-Z]{1,4}[-_/]?[A-Z]{0,4}\d{2,6}(?:[-_/][A-Z0-9]{1,8}){0,4}(?:\([A-Z0-9]{2,12}\))?$/
];

const DRAWING_HINT_PATTERN = /(DWG|DRAWING|图号|ISO|SHT|SHEET|DETAIL|SKETCH)/i;
const PAGE_HINT_PATTERN = /^(第?\d+页?|P(?:AGE)?[-_. ]?\d+|\d+\s*\/\s*\d+|\d+\s*OF\s*\d+)$/i;
const MATERIAL_HINT_PATTERN = /(SCH\d+|DN\d+|A106|ASTM|ELBOW|TEE|VALVE|FLANGE|弯头|阀门|法兰|三通|材料|规格)/i;
const CONTEXT_HINT_PATTERN = /(CONT\.?\s*ON|CONN\.?\s*TO|TO\s+SHEET|FROM\s+SHEET|续接|接至)/i;
const PIPELINE_REFERENCE_PIPELINE_HEADER_ALIASES = ['管线', '管线号', '管道号', 'line', 'pipeline'];
const PIPELINE_REFERENCE_COUNT_HEADER_ALIASES = ['焊缝数量', '焊点数量', '焊口数量', '数量', 'count'];
const PIPELINE_COMPARISON_STATUS_PRIORITY = {
  count_mismatch: 0,
  missing_in_pdf: 1,
  missing_in_excel: 2,
  unresolved_pipeline: 3,
  matched: 4
};

// A pipeline number is never represented by digits alone in the drawings we
// process. OCR can return page numbers or isolated strokes such as "1", "12"
// or "307" from the pipeline-number area, so keep those low-confidence values
// out of numbering and export data. NFKC also converts full-width digits.
export function sanitizeRecognizedPipelineNumber(value = '') {
  const rawText = String(value || '').trim();
  const normalized = typeof rawText.normalize === 'function'
    ? rawText.normalize('NFKC')
    : rawText;
  return /^\d+$/.test(normalized) ? '' : normalized;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function escapeCsv(value) {
  if (value === null || value === undefined) {
    return '';
  }

  const text = String(value).replace(/"/g, '""');
  return /[",\n]/.test(text) ? `"${text}"` : text;
}

function normalizeReferenceHeaderText(rawText = '') {
  if (!rawText) {
    return '';
  }

  let normalized = String(rawText);
  if (typeof normalized.normalize === 'function') {
    normalized = normalized.normalize('NFKC');
  }

  return normalized
    .trim()
    .replace(/\s+/g, '')
    .replace(/[()（）【】\[\]{}\-_/.,，。、:：;]/g, '')
    .toUpperCase();
}

function getHeaderMatchScore(header, alias) {
  const normalizedHeader = normalizeReferenceHeaderText(header);
  const normalizedAlias = normalizeReferenceHeaderText(alias);

  if (!normalizedHeader || !normalizedAlias) {
    return -1;
  }

  if (normalizedHeader === normalizedAlias) {
    return 100 + normalizedAlias.length;
  }

  if (normalizedHeader.includes(normalizedAlias)) {
    return 70 + normalizedAlias.length;
  }

  return -1;
}

function buildHeaderCandidates(headers = [], aliases = []) {
  return headers
    .map((header, index) => {
      const bestAlias = aliases.reduce((best, alias) => {
        const score = getHeaderMatchScore(header, alias);
        if (score > best.score) {
          return { alias, score };
        }
        return best;
      }, { alias: '', score: -1 });

      return {
        index,
        header,
        matchedAlias: bestAlias.alias,
        score: bestAlias.score
      };
    })
    .filter(candidate => candidate.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
}

function formatCountText(value) {
  return value === null || value === undefined || value === ''
    ? '—'
    : String(value);
}

function buildNumberRangeText(start, end) {
  return start !== null && start !== undefined && end !== null && end !== undefined
    ? `${start} - ${end}`
    : '-';
}

function buildComparisonStatusText(compareStatus) {
  switch (compareStatus) {
    case 'matched':
      return '一致';
    case 'count_mismatch':
      return '数量不一致';
    case 'missing_in_pdf':
      return 'PDF缺失';
    case 'missing_in_excel':
      return 'Excel缺失';
    case 'unresolved_pipeline':
      return '管线未识别';
    default:
      return '未对账';
  }
}

function buildComparisonMessage(item) {
  const actualText = formatCountText(item.actualWeldCount);

  switch (item.compareStatus) {
    case 'matched':
      return `已识别焊点数量 ${actualText}，与导入基准一致`;
    case 'count_mismatch':
      return `已识别焊点数量 ${actualText}，与导入基准不一致，差值 ${item.delta > 0 ? '+' : ''}${item.delta}`;
    case 'missing_in_pdf':
      return '导入基准中存在该管线，但当前批量处理未识别到焊点';
    case 'missing_in_excel':
      return `已识别焊点数量 ${actualText}，但导入基准中未找到该管线`;
    case 'unresolved_pipeline':
      return item.pages?.length > 0
        ? `第 ${item.pages.join(', ')} 页存在已识别焊点，但管线号未识别，无法完成对账`
        : '存在已识别焊点，但管线号未识别，无法完成对账';
    default:
      return '';
  }
}

function buildPagePipelineAlertMap(items = []) {
  return (items || []).reduce((result, item) => {
    if (!item || item.compareStatus === 'matched' || !Array.isArray(item.pages) || item.pages.length === 0) {
      return result;
    }

    item.pages.forEach(pageNum => {
      if (!result[pageNum]) {
        result[pageNum] = [];
      }
      result[pageNum].push({
        key: item.key,
        pipelineNumber: item.pipelineNumber,
        expectedWeldCount: item.expectedWeldCount,
        actualWeldCount: item.actualWeldCount,
        delta: item.delta,
        compareStatus: item.compareStatus,
        compareStatusText: item.compareStatusText,
        message: item.message,
        pages: item.pages
      });
    });

    return result;
  }, {});
}

function mergeComparisonActualItem(existingItem, nextItem, compareKey) {
  if (!existingItem) {
    return {
      ...nextItem,
      pipelineNumber: compareKey,
      pages: [...(nextItem.pages || [])],
      unresolvedPages: [...(nextItem.unresolvedPages || [])],
      fallbackPages: [...(nextItem.fallbackPages || [])]
    };
  }

  const pages = Array.from(new Set([...(existingItem.pages || []), ...(nextItem.pages || [])])).sort((a, b) => a - b);
  const unresolvedPages = Array.from(new Set([...(existingItem.unresolvedPages || []), ...(nextItem.unresolvedPages || [])])).sort((a, b) => a - b);
  const fallbackPages = Array.from(new Set([...(existingItem.fallbackPages || []), ...(nextItem.fallbackPages || [])])).sort((a, b) => a - b);
  const sourceText = Array.from(new Set([existingItem.sourceText, nextItem.sourceText].filter(Boolean))).join(', ');
  const engineText = Array.from(new Set([existingItem.engineText, nextItem.engineText].filter(Boolean))).join(', ');

  return {
    ...existingItem,
    pipelineNumber: compareKey,
    pages,
    pagesText: pages.join(', '),
    weldCount: (existingItem.weldCount || 0) + (nextItem.weldCount || 0),
    numberStart: [existingItem.numberStart, nextItem.numberStart].filter(value => value !== null && value !== undefined).reduce((min, value) => min === null ? value : Math.min(min, value), null),
    numberEnd: [existingItem.numberEnd, nextItem.numberEnd].filter(value => value !== null && value !== undefined).reduce((max, value) => max === null ? value : Math.max(max, value), null),
    numberRangeText: '',
    unresolvedPages,
    unresolvedPagesText: unresolvedPages.join(', '),
    fallbackPages,
    fallbackPagesText: fallbackPages.join(', '),
    candidateCount: (existingItem.candidateCount || 0) + (nextItem.candidateCount || 0),
    sourceText,
    engineText
  };
}

function downloadTextFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  URL.revokeObjectURL(url);
}

function normalizePageInfo(pageInfo = {}, currentPage = 1) {
  return {
    ...pageInfo,
    page_width: toFiniteNumber(pageInfo.page_width ?? pageInfo.width, 0),
    page_height: toFiniteNumber(pageInfo.page_height ?? pageInfo.height, 0),
    page_index: toFiniteNumber(pageInfo.page_index, currentPage)
  };
}

function getDetectionConfidence(detection) {
  return clamp(
    toFiniteNumber(detection?.score ?? detection?.confidence, 0),
    0,
    1
  );
}

function getBoxCenterRatios(box, pageInfo = {}) {
  if (!Array.isArray(box) || box.length !== 4) {
    return { x: 0.5, y: 0.5 };
  }

  const points = box.filter(point => Array.isArray(point) && point.length >= 2);
  if (!points.length) {
    return { x: 0.5, y: 0.5 };
  }

  const avgX = points.reduce((sum, point) => sum + toFiniteNumber(point[0], 0), 0) / points.length;
  const avgY = points.reduce((sum, point) => sum + toFiniteNumber(point[1], 0), 0) / points.length;
  const maxCoord = Math.max(...points.flat().map(value => toFiniteNumber(value, 0)));

  if (maxCoord <= 1.1) {
    return {
      x: clamp(avgX, 0, 1),
      y: clamp(avgY, 0, 1)
    };
  }

  const pageWidth = toFiniteNumber(pageInfo.page_width ?? pageInfo.width, 0);
  const pageHeight = toFiniteNumber(pageInfo.page_height ?? pageInfo.height, 0);
  if (pageWidth <= 0 || pageHeight <= 0) {
    return { x: 0.5, y: 0.5 };
  }

  return {
    x: clamp(avgX / pageWidth, 0, 1),
    y: clamp(avgY / pageHeight, 0, 1)
  };
}

function getCandidateLengthScore(normalizedText) {
  const length = normalizedText.length;

  if (length >= 5 && length <= 18) return 2.2;
  if (length >= 19 && length <= 28) return 1.2;
  if (length >= 4 && length <= 36) return 0.4;
  return -2.5;
}

function getPositionScore(centerYRatio) {
  if (centerYRatio <= 0.18) return 2.5;
  if (centerYRatio <= 0.35) return 1.3;
  if (centerYRatio <= 0.55) return 0.4;
  return -0.8;
}

function getTitleBlockScore(normalizedText, centerXRatio, centerYRatio) {
  const looksLikeTitleBlockPipeline = /^\d{1,4}(?:[-_/][A-Z0-9]{1,10}){2,6}(?:\([A-Z0-9]{2,12}\))?$/.test(normalizedText)
    || /\([A-Z0-9]{2,12}\)$/.test(normalizedText);

  if (!looksLikeTitleBlockPipeline) {
    return 0;
  }

  let score = 0;

  if (centerYRatio >= 0.8) score += 1.8;
  if (centerYRatio >= 0.88) score += 1.2;
  if (centerXRatio >= 0.28 && centerXRatio <= 0.82) score += 0.8;

  return score;
}

function isLikelyPageMarker(rawText, normalizedText) {
  if (!normalizedText) {
    return true;
  }

  if (PAGE_HINT_PATTERN.test(rawText) || PAGE_HINT_PATTERN.test(normalizedText)) {
    return true;
  }

  return /^\d{1,4}$/.test(normalizedText);
}

function isLikelyDrawingMarker(rawText, normalizedText) {
  return DRAWING_HINT_PATTERN.test(rawText) || DRAWING_HINT_PATTERN.test(normalizedText);
}

function getSeparatorScore(normalizedText) {
  const segmentCount = normalizedText.split(/[-/_.()]/).filter(Boolean).length;

  if (segmentCount >= 2 && segmentCount <= 5) return 1.4;
  if (segmentCount === 1) return 0.2;
  return -0.8;
}

function calculatePipelineCandidate(detection, pageInfo) {
  const rawText = String(detection?.text ?? '').trim();
  if (!rawText) {
    return null;
  }

  const normalizedText = normalizePipelineText(rawText);
  if (!normalizedText) {
    return null;
  }

  if (normalizedText.length < 4 || normalizedText.length > 40) {
    return null;
  }

  if (!/[A-Z]/.test(normalizedText) || !/\d/.test(normalizedText)) {
    return null;
  }

  if (/^[\d\-_/\.]+$/.test(normalizedText)) {
    return null;
  }

  if (isLikelyPageMarker(rawText, normalizedText) || isLikelyDrawingMarker(rawText, normalizedText)) {
    return null;
  }

  const confidence = getDetectionConfidence(detection);
  const centerRatios = getBoxCenterRatios(detection?.box, pageInfo);
  const centerXRatio = centerRatios.x;
  const centerYRatio = centerRatios.y;
  let score = 0;

  if (STRONG_PIPELINE_PATTERNS.some(pattern => pattern.test(normalizedText))) {
    score += 4.8;
  } else if (/^[A-Z0-9]+(?:[-/_.()][A-Z0-9]+)+(?:\([A-Z0-9]{2,12}\))?$/.test(normalizedText)) {
    score += 3.2;
  } else {
    score += 1.5;
  }

  score += getCandidateLengthScore(normalizedText);
  score += getSeparatorScore(normalizedText);
  score += getPositionScore(centerYRatio);
  score += getTitleBlockScore(normalizedText, centerXRatio, centerYRatio);
  score += confidence * 2.4;

  if (/^[A-Z]{1,4}\d{1,6}$/.test(normalizedText)) {
    score += 1.1;
  }

  if (/\([A-Z0-9]{2,12}\)$/.test(normalizedText)) {
    score += 1.2;
  }

  if (/^\d{1,4}-[A-Z]{1,6}-\d{2,8}-[A-Z0-9]{2,12}(?:\([A-Z0-9]{2,12}\))?$/.test(normalizedText)) {
    score += 1.8;
  }

  if (MATERIAL_HINT_PATTERN.test(rawText) || MATERIAL_HINT_PATTERN.test(normalizedText)) {
    score -= 2.2;
  }

  if (CONTEXT_HINT_PATTERN.test(rawText) || CONTEXT_HINT_PATTERN.test(normalizedText)) {
    score -= 1.6;
  }

  if ((rawText.match(/\s/g) || []).length >= 2) {
    score -= 0.8;
  }

  return {
    text: rawText,
    normalizedText,
    score: Number(score.toFixed(4)),
    confidence: Number(confidence.toFixed(4)),
    box: detection?.box || []
  };
}

function getPageNumbersInRange(pageTextDetections, allWelds, startPage, endPage) {
  if (Number.isFinite(startPage) && Number.isFinite(endPage) && endPage >= startPage) {
    return Array.from({ length: endPage - startPage + 1 }, (_, index) => startPage + index);
  }

  const pageNumbers = new Set();

  Object.keys(pageTextDetections || {}).forEach(page => {
    pageNumbers.add(toFiniteNumber(page, 0));
  });

  (allWelds || []).forEach(weld => {
    pageNumbers.add(toFiniteNumber(weld?.pageNum ?? weld?.page, 0));
  });

  return Array.from(pageNumbers)
    .filter(page => page > 0)
    .sort((a, b) => a - b);
}

function getPipelineGroupStatus(pipelineNumber, weldCount, unresolvedPages) {
  if (!pipelineNumber) {
    return weldCount > 0 ? '未识别' : '未识别/空白页';
  }

  if (unresolvedPages.length > 0) {
    return '部分未识别';
  }

  return weldCount > 0 ? '已匹配' : '空白页';
}

export function normalizePipelineText(rawText = '') {
  if (!rawText) {
    return '';
  }

  let normalized = String(rawText);

  if (typeof normalized.normalize === 'function') {
    normalized = normalized.normalize('NFKC');
  }

  normalized = normalized
    .replace(/[\u2010-\u2015\u2212\uff0d]/g, '-')
    .replace(/\uff0f/g, '/')
    .replace(/\uff3f/g, '_')
    .replace(/\uff0e/g, '.')
    .replace(/[（﹙〔]/g, '(')
    .replace(/[）﹚〕]/g, ')')
    .replace(/\s+/g, '')
    .replace(/[^A-Za-z0-9\-\/_.()]/g, '')
    .toUpperCase();

  return normalized;
}

export function normalizePipelineComparisonKey(rawText = '') {
  const normalized = normalizePipelineText(rawText);
  if (!normalized) {
    return '';
  }

  const stripped = normalized.replace(/(?:\([A-Z0-9._-]+\))+$/g, '');
  return stripped || normalized;
}

export function detectPipelineReferenceColumns(headerRow = []) {
  const headers = Array.isArray(headerRow)
    ? headerRow.map(value => String(value ?? '').trim())
    : [];

  const pipelineCandidates = buildHeaderCandidates(headers, PIPELINE_REFERENCE_PIPELINE_HEADER_ALIASES);
  const countCandidates = buildHeaderCandidates(headers, PIPELINE_REFERENCE_COUNT_HEADER_ALIASES);
  const bestPipelineCandidate = pipelineCandidates[0] || null;
  const bestCountCandidate = countCandidates.find(candidate => candidate.index !== bestPipelineCandidate?.index) || null;
  const matched = !!(bestPipelineCandidate && bestCountCandidate);

  return {
    headers,
    matched,
    pipelineColumnIndex: matched ? bestPipelineCandidate.index : null,
    pipelineColumnName: matched ? headers[bestPipelineCandidate.index] : '',
    countColumnIndex: matched ? bestCountCandidate.index : null,
    countColumnName: matched ? headers[bestCountCandidate.index] : '',
    pipelineCandidates,
    countCandidates
  };
}

export function detectPipelineReferenceSheet(sheets = []) {
  for (const sheet of sheets) {
    const rows = Array.isArray(sheet?.rows) ? sheet.rows : [];
    if (rows.length === 0) {
      continue;
    }

    const columnMatch = detectPipelineReferenceColumns(rows[0]);
    if (columnMatch.matched) {
      return {
        sheetName: sheet.name || '',
        rows,
        ...columnMatch
      };
    }
  }

  return null;
}

export function buildPipelineReferenceSummary(rows = [], options = {}) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const headerRow = Array.isArray(normalizedRows[0]) ? normalizedRows[0] : [];
  const {
    pipelineColumnIndex,
    countColumnIndex,
    sheetName = '',
    sourceFileName = ''
  } = options;

  if (!Number.isInteger(pipelineColumnIndex) || !Number.isInteger(countColumnIndex)) {
    throw new Error('Excel列映射无效，请重新选择管线列和数量列');
  }

  const headers = headerRow.map(value => String(value ?? '').trim());
  const pipelineColumnName = headers[pipelineColumnIndex] || `第 ${pipelineColumnIndex + 1} 列`;
  const countColumnName = headers[countColumnIndex] || `第 ${countColumnIndex + 1} 列`;
  const itemsMap = new Map();
  const warnings = [];
  let importedRows = 0;
  let duplicateCount = 0;
  let skippedRows = 0;

  normalizedRows.slice(1).forEach((row, index) => {
    const rowNumber = index + 2;
    const values = Array.isArray(row) ? row : [];
    const rawPipelineValue = values[pipelineColumnIndex];
    const rawCountValue = values[countColumnIndex];
    const pipelineText = String(rawPipelineValue ?? '').trim();
    const countText = String(rawCountValue ?? '').trim();

    if (!pipelineText && !countText) {
      skippedRows += 1;
      return;
    }

    const normalizedPipelineNumber = normalizePipelineText(pipelineText);
    const pipelineNumber = normalizePipelineComparisonKey(normalizedPipelineNumber);
    if (!pipelineNumber) {
      skippedRows += 1;
      warnings.push({
        rowNumber,
        type: 'invalid_pipeline',
        message: `第 ${rowNumber} 行未识别到有效管线号，已跳过`
      });
      return;
    }

    const countNumber = Number(countText);
    if (!countText || !Number.isFinite(countNumber) || countNumber < 0 || !Number.isInteger(countNumber)) {
      skippedRows += 1;
      warnings.push({
        rowNumber,
        type: 'invalid_count',
        pipelineNumber,
        message: `第 ${rowNumber} 行的焊缝数量无效，已跳过`
      });
      return;
    }

    const currentValue = itemsMap.get(pipelineNumber) || 0;
    if (itemsMap.has(pipelineNumber)) {
      duplicateCount += 1;
    }
    itemsMap.set(pipelineNumber, currentValue + countNumber);
    importedRows += 1;
  });

  const items = Array.from(itemsMap.entries())
    .map(([pipelineNumber, expectedWeldCount]) => ({
      key: `reference-${pipelineNumber}`,
      pipelineNumber,
      expectedWeldCount
    }))
    .sort((a, b) => a.pipelineNumber.localeCompare(b.pipelineNumber));

  const totalExpectedWeldCount = items.reduce((sum, item) => sum + item.expectedWeldCount, 0);

  return {
    type: 'PipelineReferenceSummary',
    sheetName,
    sourceFileName,
    headers,
    pipelineColumnIndex,
    pipelineColumnName,
    countColumnIndex,
    countColumnName,
    totalRows: Math.max(normalizedRows.length - 1, 0),
    importedRows,
    skippedRows,
    duplicateCount,
    itemCount: items.length,
    totalExpectedWeldCount,
    warnings,
    warningCount: warnings.length,
    items
  };
}

export function extractPipelineInfoFromDetections(detections = [], pageInfo = {}, currentPage = 1) {
  const normalizedPageInfo = normalizePageInfo(pageInfo, currentPage);
  const pipelineCandidates = (Array.isArray(detections) ? detections : [])
    .map(detection => calculatePipelineCandidate(detection, normalizedPageInfo))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  const bestCandidate = pipelineCandidates[0] || null;
  const pipelineStatus = bestCandidate && bestCandidate.score >= MATCHED_THRESHOLD ? 'matched' : 'unresolved';

  return {
    pipelineNumber: pipelineStatus === 'matched' ? bestCandidate.normalizedText : '',
    pipelineCandidates,
    pipelineConfidence: bestCandidate ? Number(clamp(bestCandidate.score / 12, 0, 1).toFixed(4)) : 0,
    pipelineSource: 'full-page-ocr',
    pipelineStatus
  };
}

export function enrichTextDetectionResult(rawResult = {}, currentPage = 1, pageInfoOverride = null) {
  const detections = Array.isArray(rawResult?.detections) ? rawResult.detections : [];
  const page_info = normalizePageInfo(pageInfoOverride || rawResult?.page_info || {}, currentPage);
  const derivedPipelineInfo = extractPipelineInfoFromDetections(detections, page_info, currentPage);
  const hasExplicitPipelineInfo = [
    'pipelineNumber',
    'pipelineStatus',
    'pipelineCandidates',
    'pipelineConfidence',
    'pipelineSource',
    'pipelineEngine',
    'pipelineFallbackUsed'
  ].some(key => rawResult?.[key] !== undefined);
  const rawExplicitPipelineNumber = String(rawResult?.pipelineNumber || '').trim();
  const explicitPipelineNumber = sanitizeRecognizedPipelineNumber(rawExplicitPipelineNumber);
  const rejectedNumericPipeline = !!rawExplicitPipelineNumber && !explicitPipelineNumber;
  const resolvedPipelineNumber = explicitPipelineNumber || sanitizeRecognizedPipelineNumber(
    derivedPipelineInfo.pipelineNumber
  );

  const pipelineInfo = hasExplicitPipelineInfo
    ? {
        pipelineNumber: resolvedPipelineNumber,
        pipelineCandidates: Array.isArray(rawResult?.pipelineCandidates)
          ? rawResult.pipelineCandidates
          : derivedPipelineInfo.pipelineCandidates,
        pipelineConfidence: rejectedNumericPipeline
          ? derivedPipelineInfo.pipelineConfidence
          : rawResult?.pipelineConfidence ?? derivedPipelineInfo.pipelineConfidence,
        pipelineSource: rejectedNumericPipeline
          ? derivedPipelineInfo.pipelineSource
          : rawResult?.pipelineSource ?? derivedPipelineInfo.pipelineSource,
        pipelineStatus: resolvedPipelineNumber ? 'matched' : 'unresolved',
        pipelineEngine: rejectedNumericPipeline ? 'paddleocr' : rawResult?.pipelineEngine ?? (
          String(rawResult?.pipelineSource || '').includes('mineru') ? 'mineru' : 'paddleocr'
        ),
        pipelineFallbackUsed: rawResult?.pipelineFallbackUsed ?? false
      }
    : {
        ...derivedPipelineInfo,
        pipelineEngine: 'paddleocr',
        pipelineFallbackUsed: false
      };

  return {
    ...rawResult,
    detections,
    page_info,
    ...pipelineInfo
  };
}

export function buildPipelineStats(pageTextDetections = {}, allWelds = [], startPage = null, endPage = null) {
  const weldsByPage = new Map();
  const pageNumbers = getPageNumbersInRange(pageTextDetections, allWelds, startPage, endPage);

  (allWelds || []).forEach(weld => {
    const pageNum = toFiniteNumber(weld?.pageNum ?? weld?.page, 0);
    if (pageNum <= 0) {
      return;
    }

    if (!weldsByPage.has(pageNum)) {
      weldsByPage.set(pageNum, []);
    }

    weldsByPage.get(pageNum).push(weld);
  });

  const groups = new Map();

  pageNumbers.forEach(pageNum => {
    const pageData = pageTextDetections?.[pageNum] || {};
    const pipelineNumber = String(pageData.pipelineNumber || '').trim();
    const groupKey = pipelineNumber || UNRESOLVED_GROUP_KEY;

    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        key: groupKey,
        pipelineNumber,
        pages: new Set(),
        unresolvedPages: new Set(),
        fallbackPages: new Set(),
        weldCount: 0,
        candidateCount: 0,
        numberStart: null,
        numberEnd: null,
        sources: new Set(),
        engines: new Set()
      });
    }

    const group = groups.get(groupKey);
    group.pages.add(pageNum);
    group.candidateCount += Array.isArray(pageData.pipelineCandidates) ? pageData.pipelineCandidates.length : 0;
    if (pageData.pipelineFallbackUsed) {
      group.fallbackPages.add(pageNum);
    }
    if (pageData.pipelineSource) {
      group.sources.add(pageData.pipelineSource);
    }
    if (pageData.pipelineEngine) {
      group.engines.add(pageData.pipelineEngine);
    }

    if (!pipelineNumber) {
      group.unresolvedPages.add(pageNum);
    }

    const pageWelds = weldsByPage.get(pageNum) || [];
    group.weldCount += pageWelds.length;

    pageWelds.forEach(weld => {
      const weldNumber = toFiniteNumber(weld?.weldNumber ?? weld?.number, NaN);
      if (!Number.isFinite(weldNumber)) {
        return;
      }

      group.numberStart = group.numberStart === null ? weldNumber : Math.min(group.numberStart, weldNumber);
      group.numberEnd = group.numberEnd === null ? weldNumber : Math.max(group.numberEnd, weldNumber);
    });
  });

  return Array.from(groups.values())
    .map(group => {
      const pages = Array.from(group.pages).sort((a, b) => a - b);
      const unresolvedPages = Array.from(group.unresolvedPages).sort((a, b) => a - b);
      const fallbackPages = Array.from(group.fallbackPages).sort((a, b) => a - b);
      const sources = Array.from(group.sources);
      const engines = Array.from(group.engines);
      const sourceText = sources.length > 0
        ? sources.join(', ')
        : (fallbackPages.length > 0 ? 'paddleocr-full-page-ocr' : '');
      const engineText = engines.length > 0
        ? engines.join(', ')
        : (fallbackPages.length > 0 ? 'paddleocr' : '');

      return {
        key: group.key,
        pipelineNumber: group.pipelineNumber,
        pages,
        pagesText: pages.join(', '),
        weldCount: group.weldCount,
        numberStart: group.numberStart,
        numberEnd: group.numberEnd,
        numberRangeText: buildNumberRangeText(group.numberStart, group.numberEnd),
        unresolvedPages,
        unresolvedPagesText: unresolvedPages.join(', '),
        fallbackPages,
        fallbackPagesText: fallbackPages.join(', '),
        candidateCount: group.candidateCount,
        sourceText,
        engineText,
        status: getPipelineGroupStatus(group.pipelineNumber, group.weldCount, unresolvedPages)
      };
    })
    .sort((a, b) => {
      const aPriority = a.pipelineNumber ? 1 : 0;
      const bPriority = b.pipelineNumber ? 1 : 0;

      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }

      return (a.pipelineNumber || '').localeCompare(b.pipelineNumber || '');
    });
}

export function buildPipelineComparison(referenceSummary = null, pipelineStats = []) {
  if (!referenceSummary || !Array.isArray(referenceSummary.items)) {
    return null;
  }

  const actualStats = Array.isArray(pipelineStats) ? pipelineStats : [];
  const actualNamedMap = new Map();
  const referencePipelineSet = new Set(
    referenceSummary.items.map(item => normalizePipelineComparisonKey(item.pipelineNumber) || item.pipelineNumber)
  );
  const comparisonItems = [];

  actualStats.forEach(item => {
    if (item?.pipelineNumber) {
      const compareKey = normalizePipelineComparisonKey(item.pipelineNumber);
      if (compareKey) {
        actualNamedMap.set(
          compareKey,
          mergeComparisonActualItem(actualNamedMap.get(compareKey), item, compareKey)
        );
      }
    }
  });

  actualNamedMap.forEach(item => {
    item.numberRangeText = buildNumberRangeText(item.numberStart, item.numberEnd);
  });

  referenceSummary.items.forEach(referenceItem => {
    const compareKey = normalizePipelineComparisonKey(referenceItem.pipelineNumber) || referenceItem.pipelineNumber;
    const actualItem = actualNamedMap.get(compareKey) || null;
    if (!actualItem) {
      return;
    }

    const actualWeldCount = actualItem ? (actualItem.weldCount || 0) : 0;
    const compareStatus = actualWeldCount === referenceItem.expectedWeldCount ? 'matched' : 'count_mismatch';
    const delta = actualWeldCount - referenceItem.expectedWeldCount;

    comparisonItems.push({
      key: `comparison-${referenceItem.pipelineNumber}`,
      pipelineNumber: referenceItem.pipelineNumber,
      expectedWeldCount: referenceItem.expectedWeldCount,
      actualWeldCount,
      delta,
      compareStatus,
      compareStatusText: buildComparisonStatusText(compareStatus),
      pages: actualItem?.pages || [],
      pagesText: actualItem?.pagesText || '-',
      numberStart: actualItem?.numberStart ?? null,
      numberEnd: actualItem?.numberEnd ?? null,
      numberRangeText: actualItem?.numberRangeText || '-',
      candidateCount: actualItem?.candidateCount ?? 0,
      sourceText: actualItem?.sourceText || '',
      engineText: actualItem?.engineText || '',
      unresolvedPages: actualItem?.unresolvedPages || [],
      unresolvedPagesText: actualItem?.unresolvedPagesText || '',
      fallbackPages: actualItem?.fallbackPages || [],
      fallbackPagesText: actualItem?.fallbackPagesText || '',
      message: '',
      isAbnormal: compareStatus !== 'matched'
    });
  });

  actualNamedMap.forEach((actualItem, compareKey) => {
    if (!referencePipelineSet.has(compareKey)) {
      comparisonItems.push({
        key: `comparison-extra-${compareKey}`,
        pipelineNumber: compareKey,
        expectedWeldCount: null,
        actualWeldCount: actualItem.weldCount || 0,
        delta: null,
        compareStatus: 'missing_in_excel',
        compareStatusText: buildComparisonStatusText('missing_in_excel'),
        pages: actualItem.pages || [],
        pagesText: actualItem.pagesText || '-',
        numberStart: actualItem.numberStart ?? null,
        numberEnd: actualItem.numberEnd ?? null,
        numberRangeText: actualItem.numberRangeText || '-',
        candidateCount: actualItem.candidateCount ?? 0,
        sourceText: actualItem.sourceText || '',
        engineText: actualItem.engineText || '',
        unresolvedPages: actualItem.unresolvedPages || [],
        unresolvedPagesText: actualItem.unresolvedPagesText || '',
        fallbackPages: actualItem.fallbackPages || [],
        fallbackPagesText: actualItem.fallbackPagesText || '',
        message: '',
        isAbnormal: true
      });
    }
  });

  actualStats.forEach(actualItem => {
    if (!actualItem?.pipelineNumber && (actualItem?.weldCount || 0) > 0) {
      comparisonItems.push({
        key: `${PIPELINE_REFERENCE_UNRESOLVED_KEY}-${actualItem.pagesText || 'unknown'}`,
        pipelineNumber: '',
        expectedWeldCount: null,
        actualWeldCount: actualItem.weldCount || 0,
        delta: null,
        compareStatus: 'unresolved_pipeline',
        compareStatusText: buildComparisonStatusText('unresolved_pipeline'),
        pages: actualItem.pages || [],
        pagesText: actualItem.pagesText || '-',
        numberStart: actualItem.numberStart ?? null,
        numberEnd: actualItem.numberEnd ?? null,
        numberRangeText: actualItem.numberRangeText || '-',
        candidateCount: actualItem.candidateCount ?? 0,
        sourceText: actualItem.sourceText || '',
        engineText: actualItem.engineText || '',
        unresolvedPages: actualItem.unresolvedPages || [],
        unresolvedPagesText: actualItem.unresolvedPagesText || '',
        fallbackPages: actualItem.fallbackPages || [],
        fallbackPagesText: actualItem.fallbackPagesText || '',
        message: '',
        isAbnormal: true
      });
    }
  });

  comparisonItems.forEach(item => {
    item.message = buildComparisonMessage(item);
  });

  comparisonItems.sort((a, b) => {
    const priorityA = PIPELINE_COMPARISON_STATUS_PRIORITY[a.compareStatus] ?? 99;
    const priorityB = PIPELINE_COMPARISON_STATUS_PRIORITY[b.compareStatus] ?? 99;
    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }

    return (a.pipelineNumber || '').localeCompare(b.pipelineNumber || '') || (a.pagesText || '').localeCompare(b.pagesText || '');
  });

  return {
    type: 'PipelineComparisonResult',
    referenceSummary,
    items: comparisonItems,
    summary: getPipelineComparisonSummary(comparisonItems),
    alertsByPage: buildPagePipelineAlertMap(comparisonItems)
  };
}

export function getPipelineStatsSummary(pipelineStats = []) {
  return (pipelineStats || []).reduce((summary, item) => {
    if (!item.pipelineNumber) {
      summary.unresolvedGroups += 1;
    } else {
      summary.matchedGroups += 1;
    }

    if (item.weldCount === 0) {
      summary.emptyGroups += 1;
    }

    summary.totalGroups += 1;
    summary.totalWelds += item.weldCount || 0;
    summary.totalPages += item.pages?.length || 0;

    return summary;
  }, {
    totalGroups: 0,
    matchedGroups: 0,
    unresolvedGroups: 0,
    emptyGroups: 0,
    totalWelds: 0,
    totalPages: 0
  });
}

export function getPipelineComparisonSummary(comparisonItems = []) {
  const summary = (comparisonItems || []).reduce((result, item) => {
    result.totalItems += 1;

    if (item.compareStatus === 'matched') {
      result.matchedCount += 1;
    } else {
      result.abnormalCount += 1;
    }

    if (item.compareStatus === 'count_mismatch') {
      result.countMismatchCount += 1;
    }
    if (item.compareStatus === 'missing_in_pdf') {
      result.missingInPdfCount += 1;
    }
    if (item.compareStatus === 'missing_in_excel') {
      result.missingInExcelCount += 1;
    }
    if (item.compareStatus === 'unresolved_pipeline') {
      result.unresolvedCount += 1;
    }

    if (Array.isArray(item.pages)) {
      item.pages.forEach(page => result.alertPages.add(page));
    }

    return result;
  }, {
    totalItems: 0,
    matchedCount: 0,
    abnormalCount: 0,
    countMismatchCount: 0,
    missingInPdfCount: 0,
    missingInExcelCount: 0,
    unresolvedCount: 0,
    alertPages: new Set()
  });

  return {
    ...summary,
    alertPageCount: summary.alertPages.size
  };
}

export function exportPipelineStatsCSV(pipelineStats = [], pdfFileName = 'document') {
  const rows = [
    ['管线号', '页码列表', '焊点数', '起始编号', '结束编号', '未识别页', '回退页', '候选数', '来源', '引擎', '状态']
  ];

  (pipelineStats || []).forEach(item => {
    rows.push([
      item.pipelineNumber || '',
      item.pagesText || '',
      item.weldCount || 0,
      item.numberStart ?? '',
      item.numberEnd ?? '',
      item.unresolvedPagesText || '',
      item.fallbackPagesText || '',
      item.candidateCount || 0,
      item.sourceText || '',
      item.engineText || '',
      item.status || ''
    ]);
  });

  const csvContent = rows
    .map(row => row.map(escapeCsv).join(','))
    .join('\n');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const fileName = `pipeline_stats_${pdfFileName}_${timestamp}.csv`;

  downloadTextFile(csvContent, fileName, 'text/csv;charset=utf-8;');

  return {
    fileName,
    csvContent
  };
}

export function exportPipelineComparisonCSV(comparisonResult = null, pdfFileName = 'document') {
  const items = comparisonResult?.items || [];
  const rows = [
    ['管线号', '页码列表', '已识别焊点数量', '差值', '状态', '异常说明', '候选数', '来源']
  ];

  items.forEach(item => {
    rows.push([
      item.pipelineNumber || '未识别',
      item.pagesText || '',
      item.actualWeldCount ?? '',
      item.delta ?? '',
      item.compareStatusText || '',
      item.message || '',
      item.candidateCount ?? 0,
      item.sourceText || item.engineText || ''
    ]);
  });

  const csvContent = rows
    .map(row => row.map(escapeCsv).join(','))
    .join('\n');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const fileName = `pipeline_comparison_${pdfFileName}_${timestamp}.csv`;

  downloadTextFile(csvContent, fileName, 'text/csv;charset=utf-8;');

  return {
    fileName,
    csvContent
  };
}
