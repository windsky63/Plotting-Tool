import { parseWeldNumberRanges, weldNumberInRanges } from './weldNumberRangeUtils';
import { convertDnToInch } from './nominalDiameterUtils';

const normalizeText = (value) => String(value ?? '').normalize('NFKC').trim();

const normalizePipeline = (value) => normalizeText(value)
  .toUpperCase()
  .replace(/\s+/g, '');

const JOINT_TYPE_CODES = [
  'ZBW',
  'SBR',
  'BW',
  'RR',
  'SW',
  'OL',
  'BR',
  'TJ',
  'CP',
  'SO'
];

export const extractJointTypeFromMaterialDescription = (description) => {
  const text = normalizeText(description).toUpperCase();
  if (!text) return '';
  const words = text.replace(/[^A-Z0-9]+/g, ' ').trim();
  const isSteelReinforcedPolyethylene = /\bSTEEL\s+REINFORCED\s+POLYETHYLENE\b|\bSRPE\b/.test(words);
  const isRrCoupling = /\bFULL\s+COUPLING\b|\bTAPER(?:ED)?\s+SOCKET\b/.test(words);
  // This plastic-pipe coupling description normally represents an RR joint even
  // when the material table does not print the short joint code explicitly.
  if (isSteelReinforcedPolyethylene && isRrCoupling) return 'RR';
  for (const code of JOINT_TYPE_CODES) {
    const pattern = new RegExp(`(?:^|[^A-Z0-9])${code}(?=$|[^A-Z0-9])`, 'i');
    if (pattern.test(text)) return code;
  }
  return '';
};

export const convertMaterialSizeMmToIntegerInch = (size) => {
  const text = normalizeText(size).replace(/,/g, '');
  const match = text.match(/\d+(?:\.\d+)?/);
  if (!match) return '';
  const millimetres = Number(match[0]);
  if (!Number.isFinite(millimetres) || millimetres <= 0) return '';
  return convertDnToInch(millimetres);
};

export const convertMaterialSizesMmToIntegerInches = size => Array.from(new Set(
  (normalizeText(size).replace(/,/g, '').match(/\d+(?:\.\d+)?/g) || [])
    .map(convertMaterialSizeMmToIntegerInch)
    .filter(Boolean)
));

const materialDescription = (row) => normalizeText(
  row?.description ||
  row?.materialDescription ||
  row?.DESCRIPTION ||
  row?.['材料描述'] ||
  row?.rawMaterial?.DESCRIPTION ||
  row?.rawMaterial?.['材料描述'] ||
  row?.rawLogicalRow?.[4] ||
  row?.rawLogicalRow?.[1] ||
  ''
);

const flattenMaterialTextValues = (value) => {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(flattenMaterialTextValues);
  if (typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, 'text')) {
      return flattenMaterialTextValues(value.text);
    }
    return Object.values(value).flatMap(flattenMaterialTextValues);
  }
  const text = normalizeText(value);
  return text ? [text] : [];
};

const orderedColumnValues = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const columns = Object.keys(value)
    .map(key => ({ key, match: /^column(\d+)$/i.exec(key) }))
    .filter(item => item.match)
    .sort((left, right) => Number(left.match[1]) - Number(right.match[1]));
  return columns.map(item => value[item.key]);
};

// MinerU occasionally shifts a material description into a neighbouring column.
// Keep the normal description mapping as the first choice, then scan the original
// logical row so a visible code such as BW is not lost solely because of that shift.
const materialRawSearchText = (row) => Array.from(new Set([
  ...flattenMaterialTextValues(row?.rawLogicalRow),
  ...flattenMaterialTextValues(row?.rawMaterial)
])).join(' ');

const countValues = (values) => {
  const counts = new Map();
  values.filter(Boolean).forEach((value) => {
    counts.set(value, (counts.get(value) || 0) + 1);
  });
  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1])
    .map(([code, count]) => ({ code, count }));
};

const findSemanticSizeValue = (value) => {
  if (!value || typeof value !== 'object') return '';
  for (const [key, cellValue] of Object.entries(value)) {
    if (/^(?:size(?:\s*\(?mm\)?)?|specification|diameter|dn|nd|规格|寸径)$/i.test(normalizeText(key))) {
      const values = flattenMaterialTextValues(cellValue);
      if (values[0]) return values[0];
    }
  }
  return '';
};

// Some MinerU tables glue SIZE to the pipe description instead of returning a
// separate cell, e.g. "ASME B36.19100 S-10S" (B36.19 + SIZE 100 + schedule).
// Only use this fallback for rows already identified as PIPE material.
const extractPipeSizeFromDescription = (description) => {
  const text = normalizeText(description).toUpperCase();
  if (!text) return '';
  const labelled = text.match(/(?:\bDN|\bND|\bNPS|\bSIZE(?:\s*\(\s*MM\s*\))?)\s*[:：=]?\s*(\d{2,4}(?:\.\d+)?)/i);
  if (labelled) return labelled[1];
  const gluedAsme = text.match(/B36\.(?:10|19)\s*(\d{2,4})(?=\s*(?:S\s*[-–]?\s*\d|SCH\b))/i);
  return gluedAsme?.[1] || '';
};

const materialSize = (row) => normalizeText(
  row?.specification ||
  row?.size ||
  row?.sizeMm ||
  row?.nominalSize ||
  row?.diameter ||
  row?.SIZE ||
  row?.['SIZE(MM)'] ||
  row?.['SIZE MM'] ||
  row?.ND ||
  row?.DN ||
  row?.['规格'] ||
  row?.['寸径'] ||
  findSemanticSizeValue(row?.rawMaterial) ||
  row?.rawLogicalRow?.[2] ||
  ''
);

const materialPipeline = (row) => normalizePipeline(
  row?.pipelineNumber ||
  row?.pipeline ||
  row?.['管线号'] ||
  row?.rawMaterial?.pipelineNumber ||
  ''
);

const materialCategory = (row) => normalizeText(
  row?.category ||
  row?.type ||
  row?.partType ||
  row?.partNumber ||
  row?.['PART NO.'] ||
  row?.rawMaterial?.category ||
  row?.rawMaterial?.['PART NO.'] ||
  row?.rawLogicalRow?.[0] ||
  ''
);

const isPipeMaterialRow = (row) => {
  const text = `${materialCategory(row)} ${materialDescription(row)}`.toUpperCase();
  if (!text) return false;
  if (/\bFITTINGS?\b|\bELBOW\b|\bTEE\b|\bREDUCER\b|\bFLANGE\b|\bSUPPORTS?\b|弯头|三通|异径|法兰|支架/.test(text)) {
    return false;
  }
  return /\bPIPE\b|\bSMLS\b|\bERW\b|管子|管材|钢管|无缝钢管|焊管/.test(text);
};

export const isFittingMaterialRow = (row) => {
  const text = `${materialCategory(row)} ${materialDescription(row)}`.toUpperCase();
  if (!text || /\bSUPPORTS?\b|支架/.test(text)) return false;
  return /\bFITTINGS?\b|\bELBOW\b|\bBEND\b|\bTEE\b|\bREDUCER\b|\bCOUPLINGS?\b|\bOUTLETS?\b|\bCAP\b|\bFLANGE\b|弯头|弯管|三通|异径|接头|管帽|法兰/.test(text);
};

export const isDiameterMaterialRow = row => isPipeMaterialRow(row) || isFittingMaterialRow(row);

export const extractPipeMaterialSizeMm = (row) => {
  if (!isPipeMaterialRow(row)) return '';
  return materialSize(row) || extractPipeSizeFromDescription(materialDescription(row));
};

export const extractDiameterMaterialSizesMm = (row) => {
  if (!isDiameterMaterialRow(row)) return [];
  const rawSize = materialSize(row) || (
    isPipeMaterialRow(row) ? extractPipeSizeFromDescription(materialDescription(row)) : ''
  );
  const values = normalizeText(rawSize).replace(/,/g, '').match(/\d+(?:\.\d+)?/g) || [];
  return Array.from(new Set(values.filter(value => Number(value) > 0)));
};

// The un-repaired MinerU payload is kept as JSON text for joint-type recovery.
// On some single-size pages its material row is the only place where SIZE still
// exists, while the repaired row contains merely "PIPE". Recover sizes from the
// smallest row-like containers instead of scanning all page numbers globally.
export const extractPipeAndFittingSizesFromSupplementalText = (supplementalText) => {
  const text = normalizeText(supplementalText);
  if (!text) return [];
  let root;
  try {
    root = JSON.parse(text);
  } catch {
    return [];
  }

  const sizes = [];
  const inspectRow = (row, orderedValues) => {
    const rowText = flattenMaterialTextValues(orderedValues).join(' ');
    const pseudoRow = { description: rowText };
    if (!isDiameterMaterialRow(pseudoRow)) return;
    const semanticSize = findSemanticSizeValue(row);
    const indexedSize = Array.isArray(orderedValues)
      ? normalizeText(flattenMaterialTextValues(orderedValues[2])[0])
      : '';
    const recovered = semanticSize || indexedSize || extractPipeSizeFromDescription(rowText);
    if (recovered) sizes.push(recovered);
  };

  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      const isRow = value.length >= 3 && value.every(cell => (
        cell === null || typeof cell !== 'object' ||
        (!Array.isArray(cell) && Object.prototype.hasOwnProperty.call(cell, 'text'))
      ));
      if (isRow) inspectRow(value, value);
      value.forEach(visit);
      return;
    }
    const columnValues = orderedColumnValues(value);
    if (columnValues.length >= 3) inspectRow(value, columnValues);
    Object.values(value).forEach(visit);
  };
  visit(root);
  return sizes;
};

export const extractPipeSizesFromSupplementalText = extractPipeAndFittingSizesFromSupplementalText;

const mostFrequent = (values) => {
  const counts = new Map();
  values.filter(Boolean).forEach((value) => {
    counts.set(value, (counts.get(value) || 0) + 1);
  });
  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1])[0]?.[0] || '';
};

const countedDiameters = (values) => {
  const counts = new Map();
  values.filter(Boolean).forEach(value => counts.set(value, (counts.get(value) || 0) + 1));
  return Array.from(counts.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || Number(right.value) - Number(left.value));
};

export const buildJointTypeConfirmationsByPipeline = ({
  pages = [],
  pipelineNumberByPage = {},
  materialJointTypeByPage = {},
  manualJointTypeByPage = {}
} = {}) => {
  const groups = new Map();
  (Array.isArray(pages) ? pages : []).forEach(rawPage => {
    const page = Number(rawPage);
    if (!Number.isFinite(page)) return;
    const pipeline = normalizePipeline(
      pipelineNumberByPage?.[page] ?? pipelineNumberByPage?.[String(page)]
    );
    if (!pipeline) return;
    if (!groups.has(pipeline)) groups.set(pipeline, []);
    groups.get(pipeline).push(page);
  });

  const result = {};
  groups.forEach(groupPages => {
    const manualValues = groupPages.map(page => normalizeText(
      manualJointTypeByPage?.[page] ?? manualJointTypeByPage?.[String(page)]
    ).toUpperCase()).filter(Boolean);
    const materialValues = groupPages.map(page => normalizeText(
      materialJointTypeByPage?.[page] ?? materialJointTypeByPage?.[String(page)]
    ).toUpperCase()).filter(Boolean);
    // A manual confirmation represents the engineering decision for the whole
    // line. Otherwise use the most frequent recognized value from that line.
    const resolved = mostFrequent(manualValues) || mostFrequent(materialValues);
    if (!resolved) return;
    groupPages.forEach(page => {
      result[page] = resolved;
    });
  });
  return result;
};

export const resolveBatchSplitUpperContent = ({
  batchContent = {},
  pageNum,
  pipelineNumber = '',
  weldNumber
}) => {
  const pageRows = batchContent.materialRowsByPage?.[pageNum] ||
    batchContent.materialRowsByPage?.[String(pageNum)] ||
    [];
  const normalizedPipeline = normalizePipeline(pipelineNumber);
  const exactPipelineRows = normalizedPipeline
    ? pageRows.filter(row => materialPipeline(row) === normalizedPipeline)
    : [];
  const materialRows = exactPipelineRows.length > 0 ? exactPipelineRows : pageRows;

  const pipeRows = materialRows.filter(isPipeMaterialRow);
  const fittingRows = materialRows.filter(isFittingMaterialRow);
  const diameterRows = materialRows.filter(isDiameterMaterialRow);
  const pipeDiameterRawValues = pipeRows.flatMap(extractDiameterMaterialSizesMm);
  const fittingDiameterRawValues = fittingRows.flatMap(extractDiameterMaterialSizesMm);
  const rowDiameterRawValues = [...pipeDiameterRawValues, ...fittingDiameterRawValues];
  const supplementalDiameterText = normalizeText(
    batchContent.jointTypeSupplementalTextByPage?.[pageNum] ??
    batchContent.jointTypeSupplementalTextByPage?.[String(pageNum)] ??
    ''
  );
  const supplementalDiameterRawValues = rowDiameterRawValues.length === 0
    ? extractPipeAndFittingSizesFromSupplementalText(supplementalDiameterText)
    : [];
  const diameterRawValues = rowDiameterRawValues.length > 0
    ? rowDiameterRawValues
    : supplementalDiameterRawValues;
  const diameterCandidateCounts = countedDiameters(
    diameterRawValues.flatMap(convertMaterialSizesMmToIntegerInches)
  );
  const pipeDiameterCandidateCounts = countedDiameters(
    pipeDiameterRawValues.flatMap(convertMaterialSizesMmToIntegerInches)
  );
  // Keep PIPE evidence first for the default/main diameter, but retain every
  // FITTINGS diameter in the candidate list for branches and range mapping.
  const diameterCandidates = [
    ...pipeDiameterCandidateCounts.map(item => item.value),
    ...diameterCandidateCounts.map(item => item.value)
  ].filter((value, index, values) => values.indexOf(value) === index);
  const pageOverride = batchContent.diameterConfirmationsByPage?.[pageNum] ??
    batchContent.diameterConfirmationsByPage?.[String(pageNum)];
  const isManualPerWeld = pageOverride === '__MANUAL_PER_WELD__';
  const confirmedDiameter = diameterCandidates.includes(String(pageOverride || ''))
    ? String(pageOverride)
    : '';
  const diameterAmbiguous = diameterRows.length > 0 && diameterCandidates.length > 1;
  const materialDiameter = diameterAmbiguous
    ? (confirmedDiameter || diameterCandidates[0] || '')
    : (diameterCandidates[0] || '');
  const pageDiameterRanges = batchContent.diameterRangesByPage?.[pageNum] ??
    batchContent.diameterRangesByPage?.[String(pageNum)] ??
    {};
  const numericWeldNumber = Number(weldNumber);
  const rangeDiameter = Number.isFinite(numericWeldNumber)
    ? diameterCandidates.find(diameter => {
      const parsed = parseWeldNumberRanges(pageDiameterRanges?.[diameter]);
      return parsed.valid && weldNumberInRanges(numericWeldNumber, parsed.ranges);
    }) || ''
    : '';
  const standardJointTypeValues = materialRows
    .map(row => extractJointTypeFromMaterialDescription(materialDescription(row)))
    .filter(Boolean);
  const rawJointTypeValues = materialRows
    .map(row => extractJointTypeFromMaterialDescription(materialRawSearchText(row)))
    .filter(Boolean);
  const standardMaterialJointType = mostFrequent(standardJointTypeValues);
  const rawMaterialJointType = mostFrequent(rawJointTypeValues);
  const supplementalJointTypeText = normalizeText(
    batchContent.jointTypeSupplementalTextByPage?.[pageNum] ??
    batchContent.jointTypeSupplementalTextByPage?.[String(pageNum)] ??
    ''
  );
  const supplementalMaterialJointType = extractJointTypeFromMaterialDescription(supplementalJointTypeText);
  const materialJointType = standardMaterialJointType || rawMaterialJointType || supplementalMaterialJointType;
  const manualDiameter = normalizeText(batchContent.manualDiameter);
  const manualJointType = normalizeText(batchContent.manualJointType).toUpperCase();
  const pageManualJointType = normalizeText(
    batchContent.jointTypeConfirmationsByPage?.[pageNum] ??
    batchContent.jointTypeConfirmationsByPage?.[String(pageNum)] ??
    ''
  ).toUpperCase();
  const resolvedJointType = batchContent.jointTypeSource === 'material'
    ? (pageManualJointType || materialJointType || manualJointType)
    : manualJointType;
  const jointTypeExtractionMode = batchContent.jointTypeSource !== 'material'
    ? (manualJointType ? 'manual' : 'missing')
    : pageManualJointType
      ? 'page-manual'
      : standardMaterialJointType
      ? 'description'
      : rawMaterialJointType
        ? 'raw-row-fallback'
        : supplementalMaterialJointType
          ? 'source-logical-fallback'
        : manualJointType
          ? 'manual-fallback'
          : 'missing';

  return {
    diameter: batchContent.diameterSource === 'material'
      ? (
        diameterAmbiguous
          ? (isManualPerWeld ? '' : (rangeDiameter || materialDiameter))
          : (materialDiameter || manualDiameter)
      )
      : manualDiameter,
    jointType: resolvedJointType,
    materialDiameter,
    materialJointType,
    standardMaterialJointType,
    rawMaterialJointType,
    supplementalMaterialJointType,
    pageManualJointType,
    jointTypeExtractionMode,
    standardJointTypeCandidates: countValues(standardJointTypeValues),
    rawJointTypeCandidates: countValues(rawJointTypeValues),
    materialDescriptionSamples: materialRows
      .map(row => materialDescription(row) || materialRawSearchText(row))
      .filter(Boolean)
      .slice(0, 3)
      .map(text => text.slice(0, 180)),
    usedMaterialRows: materialRows.length,
    pageMaterialRows: pageRows.length,
    exactPipelineRows: exactPipelineRows.length,
    usedExactPipelineMatch: exactPipelineRows.length > 0,
    pipeMaterialRows: pipeRows.length,
    fittingMaterialRows: fittingRows.length,
    diameterMaterialRows: diameterRows.length,
    pipeDiameterRawValues,
    fittingDiameterRawValues,
    diameterRawValues: diameterRawValues.filter(Boolean),
    diameterExtractionMode: rowDiameterRawValues.length > 0
      ? 'material-row'
      : (supplementalDiameterRawValues.length > 0 ? 'source-logical-fallback' : 'missing'),
    diameterCandidates,
    diameterCandidateCounts,
    pipeDiameterCandidateCounts,
    diameterAmbiguous,
    rangeDiameter,
    diameterConfirmed: true,
    requiresDiameterConfirmation: batchContent.diameterSource === 'material' &&
      diameterAmbiguous &&
      !isManualPerWeld &&
      !materialDiameter,
    diameterConfirmationMode: isManualPerWeld
      ? 'per-weld'
      : (rangeDiameter ? 'number-range' : (confirmedDiameter ? 'page' : (diameterAmbiguous ? 'auto-majority' : '')))
  };
};
