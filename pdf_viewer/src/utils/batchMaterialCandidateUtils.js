import {
  convertMaterialSizeMmToIntegerInch,
  extractJointTypeFromMaterialDescription,
  extractDiameterMaterialSizesMm,
  isDiameterMaterialRow,
  isFittingMaterialRow
} from './batchAnnotationContentUtils';

const normalize = value => String(value ?? '').normalize('NFKC').trim();

const flattenText = value => {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(flattenText);
  if (typeof value === 'object') return Object.values(value).flatMap(flattenText);
  const text = normalize(value);
  return text ? [text] : [];
};

const materialDescription = row => normalize(
  row?.description || row?.materialDescription || row?.DESCRIPTION ||
  row?.rawMaterial?.DESCRIPTION || row?.rawLogicalRow?.[4] || row?.rawLogicalRow?.[1]
);

const materialCategory = row => normalize(
  row?.category || row?.partType || row?.partNumber || row?.['PART NO.'] ||
  row?.rawMaterial?.['PART NO.'] || row?.rawLogicalRow?.[0]
);

export const isPipeMaterialCandidateRow = row => {
  const text = `${materialCategory(row)} ${materialDescription(row)}`.toUpperCase();
  if (!text) return false;
  if (/\bFITTINGS?\b|\bELBOW\b|\bTEE\b|\bREDUCER\b|\bFLANGE\b|\bSUPPORTS?\b|弯头|弯管|三通|异径|法兰|支架/.test(text)) {
    return false;
  }
  return /\bPIPE\b|\bSMLS\b|\bERW\b|管子|管材|钢管|无缝钢管|焊管/.test(text);
};

const materialJointSearchTexts = row => [
  row?.jointType,
  row?.type,
  row?.description,
  row?.materialDescription,
  row?.DESCRIPTION,
  row?.rawMaterial?.DESCRIPTION,
  ...flattenText(row?.rawLogicalRow),
  ...flattenText(row?.rawMaterial)
].map(normalize).filter(Boolean);

const countCandidates = values => {
  const counts = new Map();
  values.filter(Boolean).forEach(value => counts.set(value, (counts.get(value) || 0) + 1));
  return Array.from(counts.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
};

const countDiameterCandidates = values => countCandidates(values)
  .sort((left, right) => right.count - left.count || Number(right.value) - Number(left.value));

export const collectBatchMaterialCandidates = rows => {
  const pipeDiameterValues = [];
  const fittingDiameterValues = [];
  const jointTypeValues = [];

  (Array.isArray(rows) ? rows : []).forEach(row => {
    if (isDiameterMaterialRow(row)) {
      const target = isFittingMaterialRow(row) ? fittingDiameterValues : pipeDiameterValues;
      extractDiameterMaterialSizesMm(row)
        .map(convertMaterialSizeMmToIntegerInch)
        .filter(Boolean)
        .forEach(diameter => target.push(diameter));
    }

    // Count each code at most once per material row even when it appears in both
    // the normalized description and the original OCR cells.
    const rowJointTypes = new Set(
      materialJointSearchTexts(row)
        .map(extractJointTypeFromMaterialDescription)
        .filter(Boolean)
    );
    rowJointTypes.forEach(value => jointTypeValues.push(value));
  });

  const allDiameterCounts = countDiameterCandidates([...pipeDiameterValues, ...fittingDiameterValues]);
  const countsByValue = new Map(allDiameterCounts.map(item => [item.value, item]));
  const pipeOrder = countDiameterCandidates(pipeDiameterValues).map(item => item.value);
  const orderedDiameterValues = [...pipeOrder, ...allDiameterCounts.map(item => item.value)]
    .filter((value, index, values) => values.indexOf(value) === index);

  return {
    diameters: orderedDiameterValues.map(value => countsByValue.get(value)),
    jointTypes: countCandidates(jointTypeValues)
  };
};
