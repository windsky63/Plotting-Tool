const normalizeText = (value) => String(value ?? '').trim();

const getMaterialKey = (material) => {
  const sourceDocument = normalizeText(
    material?.sourceDocument
    || material?.documentKey
    || material?.pdfFileName
    || material?.fileName
  ).toUpperCase();
  const pipelineNumber = normalizeText(material?.pipelineNumber).toUpperCase();
  const identity = [
    material?.materialCode || material?.itemCode,
    material?.description,
    material?.specification,
    material?.diameter
  ].map(value => normalizeText(value).normalize('NFKC').toUpperCase()).join('|');
  const scopedIdentity = sourceDocument ? `${sourceDocument}::${identity}` : identity;
  return pipelineNumber ? `${pipelineNumber}::${scopedIdentity}` : scopedIdentity;
};

const getMaterialBindings = (item) => {
  if (Array.isArray(item?.materialBindings)) return item.materialBindings.filter(Boolean);
  return item?.materialBinding ? [item.materialBinding] : [];
};

const getQuantity = (material) => {
  const raw = normalizeText(material?.quantity || material?.['\u6570\u91cf'] || material?.QTY);
  const match = raw.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
};

const isMeterMaterial = (material) => {
  const unit = normalizeText(material?.unit || material?.['\u5355\u4f4d']);
  const quantity = normalizeText(material?.quantity || material?.['\u6570\u91cf'] || material?.QTY);
  return /^M(?:ETER|ETRE|\u7c73)?$/i.test(unit) || /^\d+(?:\.\d+)?\s*M$/i.test(quantity);
};

const getConnectionMultiplier = (material) => {
  const text = [
    material?.description,
    material?.type,
    material?.jointType,
    material?.rawMaterial?.['\u6750\u6599\u63cf\u8ff0'],
    material?.rawMaterial?.DESCRIPTION
  ].map(normalizeText).join(' ').toUpperCase();

  if (/\u4e09\u901a|\bTEE\b/.test(text)) return 3;
  if (/\u5f2f\u5934|\bELBOW\b/.test(text)) return 2;
  return 2;
};

export const getMaterialQuota = (material) => {
  if (isMeterMaterial(material)) return Infinity;
  const quantity = getQuantity(material);
  if (!Number.isFinite(quantity)) return Infinity;
  return quantity * getConnectionMultiplier(material);
};

export const getMaterialUsageCounts = (items = [], excludedItemId = null) => {
  const counts = new Map();
  (items || []).forEach((item) => {
    if (excludedItemId && item?.id === excludedItemId) return;
    getMaterialBindings(item).forEach((material) => {
      const key = getMaterialKey(material);
      if (!key) return;
      counts.set(key, (counts.get(key) || 0) + 1);
    });
  });
  return counts;
};

export const getMaterialQuotaState = (material, usageCounts) => {
  const key = getMaterialKey(material);
  const used = usageCounts.get(key) || 0;
  const quota = getMaterialQuota(material);
  return {
    key,
    used,
    quota,
    remaining: Number.isFinite(quota) ? Math.max(0, quota - used) : Infinity,
    exhausted: Number.isFinite(quota) && used >= quota
  };
};
