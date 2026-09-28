const getMetrics = weld => {
  const box = weld?.boundingBox;
  if (!box) return null;
  const width = Math.max(0, Number(box.maxX) - Number(box.minX));
  const height = Math.max(0, Number(box.maxY) - Number(box.minY));
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  return {
    width,
    height,
    area: width * height,
    centerX: (Number(box.minX) + Number(box.maxX)) / 2,
    centerY: (Number(box.minY) + Number(box.maxY)) / 2
  };
};

export const filterTextLikeWeldRows = welds => {
  const source = Array.isArray(welds) ? welds : [];
  if (source.length < 8) return { welds: source, removed: [] };
  const candidates = source
    .map(weld => ({ weld, metrics: getMetrics(weld) }))
    .filter(item => item.metrics?.width > 0 && item.metrics?.height > 0)
    .sort((a, b) => a.metrics.centerY - b.metrics.centerY);
  const rows = [];
  const removed = new Set();
  candidates.forEach(item => {
    const row = rows.find(existing => (
      Math.abs(existing.centerY - item.metrics.centerY) <= Math.max(4, Math.min(10, item.metrics.height * 1.6))
    ));
    if (row) {
      row.items.push(item);
      row.centerY = row.items.reduce((sum, current) => sum + current.metrics.centerY, 0) / row.items.length;
    } else {
      rows.push({ centerY: item.metrics.centerY, items: [item] });
    }
  });
  rows.forEach(row => {
    const items = row.items
      .filter(item => item.metrics.width <= 18 && item.metrics.height <= 18)
      .sort((a, b) => a.metrics.centerX - b.metrics.centerX);
    let cluster = [];
    const flush = () => {
      if (cluster.length >= 6) {
        const xs = cluster.map(item => item.metrics.centerX);
        const ys = cluster.map(item => item.metrics.centerY);
        const avgWidth = cluster.reduce((sum, item) => sum + item.metrics.width, 0) / cluster.length;
        const avgHeight = cluster.reduce((sum, item) => sum + item.metrics.height, 0) / cluster.length;
        if (
          Math.max(...xs) - Math.min(...xs) >= avgWidth * 8 &&
          Math.max(...ys) - Math.min(...ys) <= Math.max(6, avgHeight * 2.2)
        ) cluster.forEach(item => removed.add(item.weld));
      }
      cluster = [];
    };
    items.forEach(item => {
      if (cluster.length === 0) {
        cluster.push(item);
        return;
      }
      const previous = cluster[cluster.length - 1];
      const gap = item.metrics.centerX - previous.metrics.centerX;
      const maxGap = Math.max(14, Math.min(34, Math.max(previous.metrics.width, item.metrics.width) * 4));
      const sizeRatio = Math.max(item.metrics.height, previous.metrics.height) /
        Math.max(0.1, Math.min(item.metrics.height, previous.metrics.height));
      if (gap <= maxGap && sizeRatio <= 3.2) cluster.push(item);
      else {
        flush();
        cluster.push(item);
      }
    });
    flush();
  });
  return { welds: source.filter(weld => !removed.has(weld)), removed: Array.from(removed) };
};

export const filterRuleSizeOutliers = welds => {
  const source = Array.isArray(welds) ? welds : [];
  const candidates = source
    .map(weld => ({ weld, metrics: getMetrics(weld) }))
    .filter(item => item.weld?.ruleId === '6_segment_closed_path' && item.metrics?.area > 0);
  if (candidates.length < 4) return { welds: source, removed: [] };
  const areas = candidates.map(item => item.metrics.area).sort((a, b) => a - b);
  const middle = Math.floor(areas.length / 2);
  const median = areas.length % 2 ? areas[middle] : (areas[middle - 1] + areas[middle]) / 2;
  if (!(median > 0)) return { welds: source, removed: [] };
  const removed = new Set(
    candidates
      .filter(item => item.metrics.area / median < 0.45 || item.metrics.area / median > 2.2)
      .map(item => item.weld)
  );
  return { welds: source.filter(weld => !removed.has(weld)), removed: Array.from(removed) };
};

export const selectDominantWeldRuleCandidates = (welds, minimumCandidates = 4) => {
  const source = Array.isArray(welds) ? welds : [];
  if (source.length < minimumCandidates) return { welds: source, removed: [], ruleId: '', applied: false };
  const counts = new Map();
  source.forEach(weld => counts.set(weld.ruleId, (counts.get(weld.ruleId) || 0) + 1));
  const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  const [ruleId, count] = ranked[0] || [];
  const secondCount = ranked[1]?.[1] || 0;
  const dominant = ruleId && count / source.length >= 0.6 && count > secondCount;
  if (!dominant) return { welds: source, removed: [], ruleId: '', applied: false };
  const kept = source.filter(weld => weld.ruleId === ruleId);
  return {
    welds: kept,
    removed: source.filter(weld => weld.ruleId !== ruleId),
    ruleId,
    applied: true
  };
};

export const applySharedWeldCandidateFilters = welds => {
  const textRows = filterTextLikeWeldRows(welds);
  const sizeOutliers = filterRuleSizeOutliers(textRows.welds);
  const dominantRule = selectDominantWeldRuleCandidates(sizeOutliers.welds);
  return {
    welds: dominantRule.welds,
    removed: [...textRows.removed, ...sizeOutliers.removed, ...dominantRule.removed],
    diagnostics: {
      textLikeRemoved: textRows.removed.length,
      sizeOutlierRemoved: sizeOutliers.removed.length,
      nonDominantRuleRemoved: dominantRule.removed.length,
      dominantRuleId: dominantRule.ruleId,
      dominantRuleApplied: dominantRule.applied
    }
  };
};

export const splitWeldsByConnectionConfidence = welds => {
  const scored = (Array.isArray(welds) ? welds : []).map(weld => {
    const metrics = getMetrics(weld);
    const distance = Number(weld?.relatedSegmentDistance);
    const highThreshold = Math.max(2.5, Math.max(metrics?.width || 0, metrics?.height || 0) * 0.75);
    const confidence = weld?.relatedSegment
      ? (Number.isFinite(distance) && distance <= highThreshold ? 'high' : 'medium')
      : 'low';
    return { ...weld, weldRecognitionConfidence: confidence };
  });
  const connectedCount = scored.filter(weld => weld.weldRecognitionConfidence !== 'low').length;
  // Only enforce the connection check when the page proves that vector-to-pipe
  // association is working for a clear majority. Otherwise retain all candidates.
  const enforce = scored.length >= 4 && connectedCount / scored.length >= 0.55;
  return {
    welds: enforce ? scored.filter(weld => weld.weldRecognitionConfidence !== 'low') : scored,
    review: enforce ? scored.filter(weld => weld.weldRecognitionConfidence === 'low') : [],
    enforced: enforce,
    connectedCount
  };
};
