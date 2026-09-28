export const WELDED_SUPPORT_CODES = [
  'DMS1/S2',
  'G2TR1',
  'G2TR2',
  'A1S3',
  'D1S4',
  'DS1/2',
  'LTR1',
  'TR1',
  'TR2',
  'PS1',
  'ES1',
  'RV3',
  'J13',
  'TP-002',
  'R2PS14',
  'DSC',
  'F6',
  'S1'
];

const normalizeText = value => String(value ?? '')
  .normalize('NFKC')
  .toUpperCase()
  .replace(/[\\｜|]/g, '/')
  .replace(/\s+/g, ' ')
  .trim();

const compactText = value => normalizeText(value).replace(/[^A-Z0-9]/g, '');

const isGroundingSubtitle = value => /SE[GC]P[I1L]P(?:E)?/.test(compactText(value));
const isPositioningSubtitle = value => /JP[L1I]ATE/.test(compactText(value));

export const isStaticGroundingText = value => isGroundingSubtitle(value);
export const isPositioningBlockText = value => isPositioningSubtitle(value);

// This is only a retry hint.  A page must still contain SEG-PIP before it can
// be declared as a static-grounding page.  MinerU occasionally drops the
// leading "SEE" while retaining the detail title and grounding-detail text,
// so keep that narrowly-scoped fallback for selecting retry candidates.
export const isStaticGroundingRetryHint = value => {
  const compact = compactText(value);
  if (/SEEDETAILA/.test(compact)) return true;
  return /DETAILA/.test(compact)
    && /(EARTH(?:ING)?|PIPSPC0010|YELLOWGREEN)/.test(compact);
};

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const findWeldedSupportCode = text => {
  const normalized = normalizeText(text);
  if (!normalized) return '';
  for (const code of WELDED_SUPPORT_CODES) {
    const pattern = new RegExp(`(^|[^A-Z0-9/])${escapeRegExp(code)}(?=$|[^A-Z0-9/])`, 'i');
    if (pattern.test(normalized)) return code;
  }
  return '';
};

const detectionBox = (detection, pageInfo) => {
  const box = detection?.box;
  if (!Array.isArray(box) || box.length < 4) return null;
  const flat = box.flat().map(Number);
  if (flat.some(value => !Number.isFinite(value))) return null;
  const pageWidth = Number(pageInfo?.page_width || pageInfo?.width || 0);
  const pageHeight = Number(pageInfo?.page_height || pageInfo?.height || 0);
  const relative = Math.max(...flat) <= 1.1;
  if (relative && (!pageWidth || !pageHeight)) return null;
  const xs = box.map(point => Number(point[0]) * (relative ? pageWidth : 1));
  const ys = box.map(point => Number(point[1]) * (relative ? pageHeight : 1));
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
  };
};

const pointInNormalizedArea = (point, area, pageInfo) => {
  if (!area) return true;
  const pageWidth = Number(pageInfo?.page_width || pageInfo?.width || 0);
  const pageHeight = Number(pageInfo?.page_height || pageInfo?.height || 0);
  if (!pageWidth || !pageHeight) return true;
  const minX = Number(area.x || 0) * pageWidth;
  const minY = Number(area.y || 0) * pageHeight;
  const maxX = minX + Number(area.width || 0) * pageWidth;
  const maxY = minY + Number(area.height || 0) * pageHeight;
  return point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY;
};

export const extractWeldedSupportWelds = ({
  detections = [],
  pageInfo = {},
  pageNum = 1,
  recognitionArea = null
}) => {
  const results = [];
  (Array.isArray(detections) ? detections : []).forEach((detection, index) => {
    const supportCode = findWeldedSupportCode(
      detection?.text || detection?.scaffoldInfo || detection?.originalText
    );
    if (!supportCode) return;
    const bbox = detectionBox(detection, pageInfo);
    if (!bbox || !pointInNormalizedArea(bbox.center, recognitionArea, pageInfo)) return;
    const duplicate = results.some(item => (
      item.supportCode === supportCode &&
      Math.hypot(item.center.x - bbox.center.x, item.center.y - bbox.center.y) <= 6
    ));
    if (duplicate) return;
    results.push({
      id: `welded-support-${pageNum}-${supportCode.replace(/\W/g, '-')}-${index}`,
      pathId: null,
      center: bbox.center,
      boundingBox: bbox,
      page: Number(pageNum),
      pageNum: Number(pageNum),
      isWeldedSupport: true,
      supportCode,
      supportSourceText: String(detection?.text || ''),
      supportRecognitionScore: Number(detection?.score || 0)
    });
  });
  return results;
};

const extractLowerTextBlockNotice = ({
  detections = [],
  pageInfo = {},
  pageNum = 1,
  recognitionArea = null,
  matcher,
  type,
  label,
  numberingPrefix
}) => {
  const match = (Array.isArray(detections) ? detections : [])
    .map((detection, index) => {
      const sourceText = String(detection?.text || detection?.scaffoldInfo || detection?.originalText || '');
      const bbox = detectionBox(detection, pageInfo);
      if (!bbox || !pointInNormalizedArea(bbox.center, recognitionArea, pageInfo)) return null;
      return { detection, index, sourceText, bbox };
    })
    .filter(Boolean)
    .find(item => matcher(item.sourceText));

  if (!match) return [];
  return [{
    type,
    pageNum: Number(pageNum),
    label,
    ...(numberingPrefix ? { numberingPrefix } : {}),
    sourceTexts: [match.sourceText],
    boundingBoxes: [match.bbox]
  }];
};

// Special blocks are identified only by their lower text. The upper text is
// intentionally ignored because it varies between drawings.
export const extractStaticGroundingNotices = ({
  detections = [],
  pageInfo = {},
  pageNum = 1,
  recognitionArea = null
}) => extractLowerTextBlockNotice({
  detections,
  pageInfo,
  pageNum,
  recognitionArea,
  matcher: isStaticGroundingText,
  type: 'static-grounding',
  label: 'SEG-PIP',
  numberingPrefix: 'E'
});

export const extractPositioningBlockNotices = ({
  detections = [],
  pageInfo = {},
  pageNum = 1,
  recognitionArea = null
}) => extractLowerTextBlockNotice({
  detections,
  pageInfo,
  pageNum,
  recognitionArea,
  matcher: isPositioningBlockText,
  type: 'positioning-block',
  label: 'JPLATE'
});
