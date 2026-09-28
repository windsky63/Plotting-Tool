// 矢量元素可视化组件（使用 Canvas 优化性能）
// 📌 代码版本: 2026-01-20-v2 (修复页面尺寸问题)
import React, { useRef, useEffect, useState, useMemo, useCallback, useImperativeHandle, forwardRef } from 'react';
import { VectorSpatialIndex } from '../../utils/VectorSpatialIndex';
import { ObjectRecognizer } from '../../utils/ObjectRecognizer';
import { groupVectorsIntoPathsStructured } from '../../utils/WeldDetector';
import { exportPathsForComparison, generateRuleMatchReport, logDebugInfo, downloadDebugData } from '../../utils/WeldDebugUtils';
import { exportSelectedWelds, exportAllWelds, exportSelectedObjects, downloadWeldsJSON, generateWeldFilename } from '../../utils/WeldExportUtils';
import { exportManualAnnotations, downloadAnnotations } from '../../utils/ManualAnnotationUtils';
import { filterWeldsOutsideTextRegions, filterWeldsInTextRegions, convertTextDetectionToRegion, isPointInRegion } from '../../utils/WeldTextPositionUtils';
import { detectElbowCandidates } from '../../utils/ElbowDetector';
import { detectTeeCandidates, detectBranchOutletCandidates } from '../../utils/TeeDetector';
import { detectValveCandidates } from '../../utils/ValveDetector';
import { PathTypeInfoPanel } from './PathTypeInfoPanel';
import { Button, Modal, Select, Space, Tooltip, message } from 'antd';
import { DeleteOutlined, LinkOutlined, PlusOutlined } from '@ant-design/icons';
import { getMaterialQuotaState, getMaterialUsageCounts } from '../../utils/materialQuotaUtils';
import auditLogService from '../../services/auditLogService';
import { applySharedWeldCandidateFilters } from '../../utils/weldCandidateQualityUtils';

const getWeldBoxMetrics = (weld) => {
  const box = weld?.boundingBox;
  if (!box) return null;
  const width = Math.max(0, box.maxX - box.minX);
  const height = Math.max(0, box.maxY - box.minY);
  return {
    width,
    height,
    centerX: (box.minX + box.maxX) / 2,
    centerY: (box.minY + box.maxY) / 2
  };
};

const filterTextLikeWeldRows = (welds) => {
  if (!Array.isArray(welds) || welds.length < 8) {
    return { welds, removed: [] };
  }

  const candidates = welds
    .map(weld => ({ weld, metrics: getWeldBoxMetrics(weld) }))
    .filter(item => item.metrics && item.metrics.width > 0 && item.metrics.height > 0)
    .sort((a, b) => a.metrics.centerY - b.metrics.centerY);

  const removed = new Set();
  const rows = [];

  candidates.forEach(item => {
    const row = rows.find(existing => Math.abs(existing.centerY - item.metrics.centerY) <= Math.max(4, Math.min(10, item.metrics.height * 1.6)));
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
    const flushCluster = () => {
      if (cluster.length < 6) {
        cluster = [];
        return;
      }

      const xs = cluster.map(item => item.metrics.centerX);
      const ys = cluster.map(item => item.metrics.centerY);
      const widths = cluster.map(item => item.metrics.width);
      const heights = cluster.map(item => item.metrics.height);
      const spanX = Math.max(...xs) - Math.min(...xs);
      const spanY = Math.max(...ys) - Math.min(...ys);
      const avgWidth = widths.reduce((sum, value) => sum + value, 0) / widths.length;
      const avgHeight = heights.reduce((sum, value) => sum + value, 0) / heights.length;

      if (spanX >= avgWidth * 8 && spanY <= Math.max(6, avgHeight * 2.2)) {
        cluster.forEach(item => removed.add(item.weld));
      }
      cluster = [];
    };

    items.forEach(item => {
      if (cluster.length === 0) {
        cluster.push(item);
        return;
      }

      const prev = cluster[cluster.length - 1];
      const maxGap = Math.max(14, Math.min(34, Math.max(prev.metrics.width, item.metrics.width) * 4));
      const gap = item.metrics.centerX - prev.metrics.centerX;
      const sameSizeBand = Math.max(item.metrics.height, prev.metrics.height) / Math.max(0.1, Math.min(item.metrics.height, prev.metrics.height)) <= 3.2;

      if (gap <= maxGap && sameSizeBand) {
        cluster.push(item);
      } else {
        flushCluster();
        cluster.push(item);
      }
    });
    flushCluster();
  });

  return {
    welds: welds.filter(weld => !removed.has(weld)),
    removed: Array.from(removed)
  };
};

const filterJinlingAreaOutliers = (welds) => {
  if (!Array.isArray(welds) || welds.length < 4) {
    return { welds, removed: [] };
  }

  const jinlingWelds = welds
    .map(weld => {
      const metrics = getWeldBoxMetrics(weld);
      return {
        weld,
        area: metrics ? metrics.width * metrics.height : 0
      };
    })
    .filter(item => item.weld?.ruleId === '6_segment_closed_path' && item.area > 0);

  if (jinlingWelds.length < 4) {
    return { welds, removed: [] };
  }

  const sortedAreas = jinlingWelds.map(item => item.area).sort((a, b) => a - b);
  const medianArea = sortedAreas.length % 2 === 0
    ? (sortedAreas[sortedAreas.length / 2 - 1] + sortedAreas[sortedAreas.length / 2]) / 2
    : sortedAreas[Math.floor(sortedAreas.length / 2)];

  if (!medianArea || medianArea <= 0) {
    return { welds, removed: [] };
  }

  const removed = new Set();
  jinlingWelds.forEach(item => {
    const ratio = item.area / medianArea;
    if (ratio < 0.45 || ratio > 2.2) {
      removed.add(item.weld);
    }
  });

  return {
    welds: welds.filter(weld => !removed.has(weld)),
    removed: Array.from(removed)
  };
};

const isWeldInRelativeArea = (weld, area, pageInfo) => {
  if (!area || !pageInfo) return true;

  const pageWidth = pageInfo.page_width || pageInfo.width || 0;
  const pageHeight = pageInfo.page_height || pageInfo.height || 0;
  if (!pageWidth || !pageHeight) return false;

  const minX = area.x * pageWidth;
  const minY = area.y * pageHeight;
  const maxX = (area.x + area.width) * pageWidth;
  const maxY = (area.y + area.height) * pageHeight;

  if (!weld?.center) return false;
  return weld.center.x >= minX &&
    weld.center.x <= maxX &&
    weld.center.y >= minY &&
    weld.center.y <= maxY;
};

const filterWeldsInRelativeArea = (welds, area, pageInfo) => {
  if (!area || !Array.isArray(welds)) {
    return { welds, removed: [] };
  }

  const kept = [];
  const removed = [];
  welds.forEach(weld => {
    if (isWeldInRelativeArea(weld, area, pageInfo)) {
      kept.push(weld);
    } else {
      removed.push(weld);
    }
  });

  return { welds: kept, removed };
};

const normalizeElbowCandidateForFiltering = (candidate) => ({
  ...candidate,
  center: candidate.center,
  boundingBox: candidate.boundingBox || {
    minX: candidate.center?.x || 0,
    minY: candidate.center?.y || 0,
    maxX: candidate.center?.x || 0,
    maxY: candidate.center?.y || 0
  }
});

const filterElbowCandidatesInRelativeArea = (candidates, area, pageInfo) => {
  if (!area || !Array.isArray(candidates)) {
    return { candidates, removed: [] };
  }

  const normalized = candidates.map(normalizeElbowCandidateForFiltering);
  const result = filterWeldsInRelativeArea(normalized, area, pageInfo);
  return {
    candidates: result.welds,
    removed: result.removed
  };
};

const filterElbowCandidatesByTextOverlap = (candidates, textDetections, pageInfo, minOverlapRatio = 0.35) => {
  if (!Array.isArray(candidates) || candidates.length === 0 || !Array.isArray(textDetections) || !pageInfo) {
    return { candidates, removed: [] };
  }

  const normalized = candidates.map(normalizeElbowCandidateForFiltering);
  const removed = new Set();

  normalized.forEach(candidate => {
    const strongMatch = textDetections.some(detection => {
      if (!detection?.box || !Array.isArray(detection.box) || detection.box.length < 4) {
        return false;
      }

      const textRegion = convertTextDetectionToRegion(detection, pageInfo);
      if (!textRegion) return false;
      if (isPointInRegion(candidate.center, textRegion)) return true;

      const markerRadius = candidate.type === 'tee-fitting' ? 10 : candidate.type === 'valve-fitting' ? 10 : 9;
      const markerBox = {
        minX: (candidate.center?.x || 0) - markerRadius,
        minY: (candidate.center?.y || 0) - markerRadius,
        maxX: (candidate.center?.x || 0) + markerRadius,
        maxY: (candidate.center?.y || 0) + markerRadius
      };
      const sourceBox = candidate.boundingBox;
      const box = sourceBox ? {
        minX: Math.min(sourceBox.minX, markerBox.minX),
        minY: Math.min(sourceBox.minY, markerBox.minY),
        maxX: Math.max(sourceBox.maxX, markerBox.maxX),
        maxY: Math.max(sourceBox.maxY, markerBox.maxY)
      } : markerBox;
      if (!box) return false;
      const overlapWidth = Math.max(0, Math.min(box.maxX, textRegion.maxX) - Math.max(box.minX, textRegion.minX));
      const overlapHeight = Math.max(0, Math.min(box.maxY, textRegion.maxY) - Math.max(box.minY, textRegion.minY));
      const candidateArea = Math.max(0, box.maxX - box.minX) * Math.max(0, box.maxY - box.minY);
      const markerOverlapWidth = Math.max(0, Math.min(markerBox.maxX, textRegion.maxX) - Math.max(markerBox.minX, textRegion.minX));
      const markerOverlapHeight = Math.max(0, Math.min(markerBox.maxY, textRegion.maxY) - Math.max(markerBox.minY, textRegion.minY));
      const markerArea = Math.max(0, markerBox.maxX - markerBox.minX) * Math.max(0, markerBox.maxY - markerBox.minY);
      const textWidth = Math.max(0, textRegion.maxX - textRegion.minX);
      const textHeight = Math.max(0, textRegion.maxY - textRegion.minY);
      const textArea = textWidth * textHeight;
      const textCenter = {
        x: (textRegion.minX + textRegion.maxX) / 2,
        y: (textRegion.minY + textRegion.maxY) / 2
      };
      const centerDistance = candidate.center
        ? Math.sqrt((candidate.center.x - textCenter.x) ** 2 + (candidate.center.y - textCenter.y) ** 2)
        : Infinity;
      const centerThreshold = Math.max(textWidth, textHeight) * 0.62 + markerRadius * 0.85;
      const candidateOverlapRatio = candidateArea > 0 ? (overlapWidth * overlapHeight) / candidateArea : 0;
      const markerOverlapRatio = markerArea > 0 ? (markerOverlapWidth * markerOverlapHeight) / markerArea : 0;
      const textOverlapRatio = textArea > 0 ? (markerOverlapWidth * markerOverlapHeight) / textArea : 0;
      return candidateOverlapRatio >= minOverlapRatio ||
        (markerOverlapRatio >= 0.72 && centerDistance <= centerThreshold) ||
        (textOverlapRatio >= 0.45 && centerDistance <= centerThreshold * 1.15);
    });

    if (strongMatch) {
      removed.add(candidate);
    }
  });

  return {
    candidates: normalized.filter(candidate => !removed.has(candidate)),
    removed: Array.from(removed)
  };
};

const getVectorPageBounds = (vectors) => {
  if (!Array.isArray(vectors) || vectors.length === 0) return null;

  let maxX = 0;
  let maxY = 0;
  vectors.forEach(vector => {
    if (Array.isArray(vector)) {
      const [, x1, y1, x2, y2] = vector;
      if (Number.isFinite(x1)) maxX = Math.max(maxX, x1);
      if (Number.isFinite(x2)) maxX = Math.max(maxX, x2);
      if (Number.isFinite(y1)) maxY = Math.max(maxY, y1);
      if (Number.isFinite(y2)) maxY = Math.max(maxY, y2);
      return;
    }

    if (!vector) return;
    ['x', 'x1', 'x2'].forEach(key => {
      if (Number.isFinite(vector[key])) maxX = Math.max(maxX, vector[key]);
    });
    ['y', 'y1', 'y2'].forEach(key => {
      if (Number.isFinite(vector[key])) maxY = Math.max(maxY, vector[key]);
    });
  });

  return maxX > 0 && maxY > 0
    ? { page_width: maxX, page_height: maxY, _fromVectors: true }
    : null;
};

const fitPageInfoToVectorSpace = (pageInfo, vectors) => {
  if (!pageInfo) return null;

  const vectorBounds = getVectorPageBounds(vectors);
  if (!vectorBounds) return pageInfo;

  const pageWidth = pageInfo.page_width || pageInfo.width || 0;
  const pageHeight = pageInfo.page_height || pageInfo.height || 0;
  if (!pageWidth || !pageHeight) return pageInfo;

  // react-pdf 页面尺寸经常是渲染尺寸，而矢量坐标是 PDF 原始尺寸。
  // 当页面尺寸明显约为矢量坐标 2 倍时，先还原到矢量坐标系，否则区域预裁剪会扩大到框外。
  const halfWidth = pageWidth / 2;
  const halfHeight = pageHeight / 2;
  const shouldHalve =
    pageWidth > vectorBounds.page_width * 1.35 &&
    pageHeight > vectorBounds.page_height * 1.35 &&
    halfWidth >= vectorBounds.page_width * 0.85 &&
    halfHeight >= vectorBounds.page_height * 0.85;

  return shouldHalve
    ? {
      page_width: halfWidth,
      page_height: halfHeight,
      _fromPdfRenderSize: true
    }
    : pageInfo;
};

const getPageInfoForElbowFiltering = (textData, pageSize, vectors) => {
  if (textData?.page_info) {
    const pw = textData.page_info.page_width || textData.page_info.width || 0;
    const ph = textData.page_info.page_height || textData.page_info.height || 0;
    if (pw > 0 && ph > 0) {
      // OCR 接口返回的是 PDF 原始坐标尺寸。相对文字框必须直接按这个尺寸换算，
      // 不能再根据矢量内容范围做缩放推断，否则文字框会整体错位。
      return {
        ...textData.page_info,
        _fromOcrPageInfo: true
      };
    }
  }

  if (pageSize && pageSize.width > 0 && pageSize.height > 0) {
    return fitPageInfoToVectorSpace({
      page_width: pageSize.width,
      page_height: pageSize.height,
      _fromPdfPage: true
    }, vectors);
  }

  return getVectorPageBounds(vectors);
};

const isVectorInRelativeArea = (vector, area, pageInfo, padding = 2) => {
  if (!area || !pageInfo || !Array.isArray(vector)) return true;

  const pageWidth = pageInfo.page_width || pageInfo.width || 0;
  const pageHeight = pageInfo.page_height || pageInfo.height || 0;
  if (!pageWidth || !pageHeight) return true;

  const [, x1, y1, x2, y2] = vector;
  if (![x1, y1, x2, y2].every(value => typeof value === 'number' && Number.isFinite(value))) {
    return false;
  }

  const minX = area.x * pageWidth - padding;
  const minY = area.y * pageHeight - padding;
  const maxX = (area.x + area.width) * pageWidth + padding;
  const maxY = (area.y + area.height) * pageHeight + padding;
  const vectorMinX = Math.min(x1, x2);
  const vectorMinY = Math.min(y1, y2);
  const vectorMaxX = Math.max(x1, x2);
  const vectorMaxY = Math.max(y1, y2);

  return vectorMaxX >= minX &&
    vectorMinX <= maxX &&
    vectorMaxY >= minY &&
    vectorMinY <= maxY;
};

const filterVectorsInRelativeArea = (vectors, area, pageInfo) => {
  if (!area || !pageInfo || !Array.isArray(vectors)) {
    return vectors || [];
  }

  return vectors.filter(vector => isVectorInRelativeArea(vector, area, pageInfo));
};

const getVectorEndpoints = (vector) => {
  if (!Array.isArray(vector) || vector.length < 5) return null;
  const [, x1, y1, x2, y2] = vector;
  if (![x1, y1, x2, y2].every(value => typeof value === 'number' && Number.isFinite(value))) {
    return null;
  }
  return { x1, y1, x2, y2 };
};

const getVectorLength = (vector) => {
  const endpoints = getVectorEndpoints(vector);
  if (!endpoints) return 0;
  return Math.hypot(endpoints.x2 - endpoints.x1, endpoints.y2 - endpoints.y1);
};

const pointToSegmentDistance = (point, vector) => {
  const endpoints = getVectorEndpoints(vector);
  if (!point || !endpoints) return Infinity;

  const dx = endpoints.x2 - endpoints.x1;
  const dy = endpoints.y2 - endpoints.y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 0) return Math.hypot(point.x - endpoints.x1, point.y - endpoints.y1);

  const t = Math.max(0, Math.min(1, ((point.x - endpoints.x1) * dx + (point.y - endpoints.y1) * dy) / lenSq));
  const projX = endpoints.x1 + t * dx;
  const projY = endpoints.y1 + t * dy;
  return Math.hypot(point.x - projX, point.y - projY);
};

const normalizeDetectionText = (detection) => {
  const text = detection?.text ?? detection?.value ?? detection?.content ?? detection?.label ?? '';
  return String(text).replace(/\s+/g, '').trim();
};

const normalizePipeLengthValue = (text) => {
  const compact = String(text || '')
    .replace(/\s+/g, '')
    .replace(/[，,]/g, '')
    .replace(/[－–—]/g, '-')
    .trim();
  const match = compact.match(/^[+\-]?(\d{2,6})$/);
  if (!match) return '';
  return match[1];
};

const isLikelyPipeLengthText = (text) => {
  const normalized = normalizePipeLengthValue(text);
  if (!normalized) return false;
  const value = Number(normalized);
  if (!Number.isFinite(value)) return false;
  return value >= 10 && value <= 999999;
};

const getDetectionCenter = (detection, pageInfo) => {
  if (detection?.box && Array.isArray(detection.box) && detection.box.length >= 4) {
    const region = convertTextDetectionToRegion(detection, pageInfo);
    if (region) {
      return {
        x: (region.minX + region.maxX) / 2,
        y: (region.minY + region.maxY) / 2,
        region
      };
    }
  }

  const x = detection?.x ?? detection?.left;
  const y = detection?.y ?? detection?.top;
  const width = detection?.width ?? detection?.w;
  const height = detection?.height ?? detection?.h;
  if ([x, y, width, height].every(value => typeof value === 'number' && Number.isFinite(value))) {
    return {
      x: x + width / 2,
      y: y + height / 2,
      region: { minX: x, minY: y, maxX: x + width, maxY: y + height }
    };
  }

  return null;
};

const getDetectionBoxPoints = (detection) => {
  const box = detection?.box || detection?.bbox || detection?.points || detection?.polygon;
  if (!Array.isArray(box)) return [];
  if (box.length === 4 && box.every(value => typeof value === 'number')) {
    const [x, y, width, height] = box;
    return [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
  }
  return box
    .map(point => {
      if (Array.isArray(point)) return [Number(point[0]), Number(point[1])];
      if (point && typeof point === 'object') return [Number(point.x), Number(point.y)];
      return null;
    })
    .filter(point => point && Number.isFinite(point[0]) && Number.isFinite(point[1]));
};

const getDetectionTextAngle = (detection) => {
  const points = getDetectionBoxPoints(detection);
  if (points.length < 2) return null;
  let longest = null;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!longest || length > longest.length) {
      longest = { a, b, length };
    }
  }
  if (!longest || longest.length <= 0) return null;
  const rawAngle = Math.abs(Math.atan2(longest.b[1] - longest.a[1], longest.b[0] - longest.a[0]) * 180 / Math.PI);
  const normalized = rawAngle > 90 ? 180 - rawAngle : rawAngle;
  return Math.min(normalized, 90 - normalized);
};

const isPointInRelativeArea = (point, area, pageInfo) => {
  if (!area || !pageInfo || !point) return true;
  const pageWidth = pageInfo.page_width || pageInfo.width || 0;
  const pageHeight = pageInfo.page_height || pageInfo.height || 0;
  if (!pageWidth || !pageHeight) return true;
  return point.x >= area.x * pageWidth &&
    point.x <= (area.x + area.width) * pageWidth &&
    point.y >= area.y * pageHeight &&
    point.y <= (area.y + area.height) * pageHeight;
};

const isLikelyPipeLengthPose = (detection, center) => {
  const region = center?.region;
  if (!region) return false;
  const width = Math.max(1, region.maxX - region.minX);
  const height = Math.max(1, region.maxY - region.minY);
  if (height >= width * 1.25) return true;
  const angle = getDetectionTextAngle(detection);
  return angle !== null && angle >= 18;
};

const expandRegion = (region, padding) => {
  if (!region) return null;
  return {
    minX: region.minX - padding,
    minY: region.minY - padding,
    maxX: region.maxX + padding,
    maxY: region.maxY + padding
  };
};

const regionsOverlap = (a, b) => {
  if (!a || !b) return false;
  return a.maxX >= b.minX && a.minX <= b.maxX && a.maxY >= b.minY && a.minY <= b.maxY;
};

const isCoordinateLabelText = (text) => /^(E|N|S|EL)$/i.test(String(text || '').replace(/[^A-Za-z]/g, ''));

const buildCoordinateExclusionRegions = (textDetections, pageInfo) => {
  if (!Array.isArray(textDetections)) return [];
  const pageWidth = pageInfo?.page_width || pageInfo?.width || 0;
  const pageHeight = pageInfo?.page_height || pageInfo?.height || 0;
  const pageDiagonal = pageWidth > 0 && pageHeight > 0 ? Math.hypot(pageWidth, pageHeight) : 1400;
  const padding = Math.max(14, Math.min(36, pageDiagonal * 0.012));

  return textDetections
    .map(detection => {
      const text = normalizeDetectionText(detection);
      if (!isCoordinateLabelText(text) && !/^EL[+-]?\d+$/i.test(text)) return null;
      const center = getDetectionCenter(detection, pageInfo);
      return center?.region ? expandRegion(center.region, padding) : null;
    })
    .filter(Boolean);
};

const isDetectionInCoordinateBlock = (detection, center, coordinateRegions) => {
  if (!center?.region || !Array.isArray(coordinateRegions) || coordinateRegions.length === 0) {
    return false;
  }
  const raw = String(detection?.text ?? detection?.value ?? detection?.content ?? detection?.label ?? '').trim();
  if (/^[+-]?\d{2,6}$/.test(raw) || /^\+\d{2,6}$/.test(raw)) {
    return coordinateRegions.some(region => regionsOverlap(center.region, region));
  }
  return false;
};

const getVectorAngle = (vector) => {
  const endpoints = getVectorEndpoints(vector);
  if (!endpoints) return null;
  const angle = Math.abs(Math.atan2(endpoints.y2 - endpoints.y1, endpoints.x2 - endpoints.x1) * 180 / Math.PI);
  return angle > 90 ? 180 - angle : angle;
};

const isDimensionLikeVector = (vector, length) => {
  if (length < 18) return false;
  const endpoints = getVectorEndpoints(vector);
  if (!endpoints) return false;
  const dx = Math.abs(endpoints.x2 - endpoints.x1);
  const dy = Math.abs(endpoints.y2 - endpoints.y1);
  if (dx < 2 && dy < 2) return false;
  const angle = getVectorAngle(vector);
  if (angle === null) return false;
  return angle <= 8 || angle >= 18;
};

const getAngleDiff = (a, b) => {
  if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b)) return 90;
  const diff = Math.abs(a - b);
  return Math.min(diff, 180 - diff);
};

const findPipeVectorForLengthLabel = (allVectors, labelCenter, dimensionVector, pageDiagonal) => {
  if (!Array.isArray(allVectors) || !labelCenter || !dimensionVector) return null;
  const dimensionAngle = getVectorAngle(dimensionVector);
  const dimensionLength = getVectorLength(dimensionVector);
  if (dimensionAngle === null || !Number.isFinite(dimensionLength)) return null;

  const labelRegion = labelCenter.region;
  const labelHeight = labelRegion ? Math.max(1, labelRegion.maxY - labelRegion.minY) : 10;
  const labelWidth = labelRegion ? Math.max(1, labelRegion.maxX - labelRegion.minX) : 24;
  const minPipeLength = Math.max(120, Math.min(320, pageDiagonal * 0.075), dimensionLength * 2.2, labelWidth * 7);
  // The dimension line is usually very close to the length text. The pipe centerline
  // is parallel but offset farther away, so near parallel lines are treated as dimension carriers.
  const minDistance = Math.max(24, Math.min(46, pageDiagonal * 0.018), labelHeight * 2.2);
  const maxDistance = Math.max(55, Math.min(140, pageDiagonal * 0.055));

  let best = null;
  allVectors.forEach((vector, index) => {
    const length = getVectorLength(vector);
    if (!Number.isFinite(length) || length < minPipeLength) return;
    const angle = getVectorAngle(vector);
    const angleDiff = getAngleDiff(angle, dimensionAngle);
    if (angleDiff > 14) return;
    const distance = pointToSegmentDistance(labelCenter, vector);
    if (distance < minDistance || distance > maxDistance) return;

    const distanceFromIdealOffset = Math.abs(distance - Math.max(minDistance + 16, 40));
    const score = distanceFromIdealOffset + angleDiff * 2 - Math.min(length, 1400) * 0.014;
    if (!best || score < best.score) {
      best = { vector, index, length, distance, angleDiff, score };
    }
  });

  return best;
};

const summarizePipeLengthDebug = (debug) => ({
  time: debug.time,
  textCount: debug.textCount,
  vectorCount: debug.vectorCount,
  area: debug.area,
  candidateCount: debug.candidateCount || 0,
  coordinateExclusionCount: debug.coordinateExclusionCount || 0,
  dimensionVectorCount: debug.dimensionVectorCount || 0,
  rawTexts: (debug.rawTexts || []).slice(0, 160),
  accepted: (debug.accepted || []).slice(0, 120),
  rejected: (debug.rejected || []).slice(0, 160)
});

const writePipeLengthDebugLog = (debug, meta = {}) => {
  if (typeof window === 'undefined') return;
  try {
    const summary = summarizePipeLengthDebug(debug);
    const signature = JSON.stringify({
      documentKey: meta.documentKey || '',
      pageNumber: meta.pageNumber || '',
      textCount: summary.textCount,
      vectorCount: summary.vectorCount,
      candidateCount: summary.candidateCount,
      accepted: (summary.accepted || []).map(item => `${item.text}:${item.source}:${item.confidence}`).join('|'),
      rejectedReasons: (summary.rejected || []).reduce((counts, item) => {
        counts[item.reason || 'unknown'] = (counts[item.reason || 'unknown'] || 0) + 1;
        return counts;
      }, {})
    });
    if (window.__lastPipeLengthServerLogSignature === signature) return;
    window.__lastPipeLengthServerLogSignature = signature;

    auditLogService.log('pipe_length_debug', {
      pdfFileName: meta.documentKey || '',
      page: meta.pageNumber || '',
      pipelineNumber: meta.pipelineNumber || '',
      count: debug.candidateCount || 0,
      ...summary
    });
  } catch {
    // 调试日志不能影响识别流程。
  }
};

const detectPipeLengthCandidates = (vectors, textDetections, pageInfo, area, meta = {}) => {
  const debug = {
    time: new Date().toISOString(),
    textCount: Array.isArray(textDetections) ? textDetections.length : 0,
    vectorCount: Array.isArray(vectors) ? vectors.length : 0,
    area: area || null,
    rawTexts: [],
    accepted: [],
    rejected: []
  };

  if (!Array.isArray(textDetections) || textDetections.length === 0) {
    if (typeof window !== 'undefined') {
      window.__lastPipeLengthDebug = debug;
      console.log('[管道长度识别] 无文字识别结果', debug);
      writePipeLengthDebugLog(debug, meta);
    }
    return [];
  }

  const sourceVectors = filterVectorsInRelativeArea(vectors || [], area, pageInfo)
    .map((vector, index) => ({ vector, index, length: getVectorLength(vector) }))
    .filter(item => isDimensionLikeVector(item.vector, item.length));

  const pageWidth = pageInfo?.page_width || pageInfo?.width || 0;
  const pageHeight = pageInfo?.page_height || pageInfo?.height || 0;
  const pageDiagonal = pageWidth > 0 && pageHeight > 0 ? Math.hypot(pageWidth, pageHeight) : 1400;
  const maxDistance = Math.max(14, Math.min(45, pageDiagonal * 0.016));

  const candidates = [];
  const usedVectorIndices = new Set();
  const coordinateExclusionRegions = buildCoordinateExclusionRegions(textDetections, pageInfo);

  textDetections.forEach((detection, textIndex) => {
    const rawNormalizedText = normalizeDetectionText(detection);
    const text = normalizePipeLengthValue(rawNormalizedText);
    const rawText = String(detection?.text ?? detection?.value ?? detection?.content ?? detection?.label ?? '').trim();
    debug.rawTexts.push({
      index: textIndex,
      rawText,
      normalizedText: rawNormalizedText,
      pipeLengthText: text,
      source: detection?._detectionSource || '',
      hasBox: !!(detection?.box || detection?.bbox || detection?.points || detection?.polygon)
    });

    if (!isLikelyPipeLengthText(rawNormalizedText)) {
      debug.rejected.push({ index: textIndex, text: rawNormalizedText, reason: 'not_pure_length_number' });
      return;
    }

    const center = getDetectionCenter(detection, pageInfo);
    if (!center) {
      debug.rejected.push({ index: textIndex, text, reason: 'no_box_or_center' });
      return;
    }
    if (!isPointInRelativeArea(center, area, pageInfo)) {
      debug.rejected.push({ index: textIndex, text, reason: 'outside_weld_area', center: { x: center.x, y: center.y } });
      return;
    }
    if (isDetectionInCoordinateBlock(detection, center, coordinateExclusionRegions)) {
      debug.rejected.push({ index: textIndex, text, reason: 'coordinate_block', center: { x: center.x, y: center.y } });
      return;
    }

    let best = null;
    sourceVectors.forEach(item => {
      if (usedVectorIndices.has(item.index)) return;
      const distance = pointToSegmentDistance(center, item.vector);
      if (distance > maxDistance) return;

      const score = distance - Math.min(item.length, 600) * 0.006;
      if (!best || score < best.score) {
        best = { ...item, distance, score };
      }
    });

    if (!best) {
      debug.rejected.push({
        index: textIndex,
        text,
        rawText: rawNormalizedText,
        reason: 'no_near_dimension_vector',
        center: { x: center.x, y: center.y },
        poseLike: isLikelyPipeLengthPose(detection, center)
      });
      return;
    }
    usedVectorIndices.add(best.index);
    const pipeVector = findPipeVectorForLengthLabel(sourceVectors.map(item => item.vector), center, best.vector, pageDiagonal);
    candidates.push({
      id: `pipe-length:${textIndex}:${best.index}:${text}`,
      text,
      center: { x: center.x, y: center.y },
      region: center.region,
      vector: pipeVector?.vector || null,
      vectorIndex: pipeVector?.index ?? null,
      dimensionVector: best.vector,
      dimensionVectorIndex: best.index,
      distance: best.distance,
      length: pipeVector?.length || null,
      source: pipeVector ? 'pipe' : 'vector',
      confidence: pipeVector ? 'high' : 'medium'
    });
    debug.accepted.push({
      index: textIndex,
      text,
      source: pipeVector ? 'pipe' : 'vector',
      confidence: pipeVector ? 'high' : 'medium',
      distance: best.distance,
      dimensionVectorLength: best.length,
      pipeVectorLength: pipeVector?.length || null,
      pipeVectorDistance: pipeVector?.distance || null,
      pipeVectorAngleDiff: pipeVector?.angleDiff || null,
      center: { x: center.x, y: center.y }
    });
  });

  if (typeof window !== 'undefined') {
    debug.candidateCount = candidates.length;
    debug.coordinateExclusionCount = coordinateExclusionRegions.length;
    debug.dimensionVectorCount = sourceVectors.length;
    window.__lastPipeLengthDebug = debug;
    console.log('[管道长度识别] 调试结果', debug);
    writePipeLengthDebugLog(debug, meta);
  }

  return candidates;
};

const createElbowCandidateId = (candidate) => {
  if (candidate?.id) return candidate.id;
  const x = Math.round((candidate?.center?.x || 0) * 10) / 10;
  const y = Math.round((candidate?.center?.y || 0) * 10) / 10;
  const paths = (candidate?.pathIds || []).map(String).sort().join('-');
  return `${candidate?.type || 'elbow'}:${x}:${y}:${paths}`;
};

const updateElbowEditState = (state, id, updates) => {
  const manualIndex = (state.manual || []).findIndex(item => item.id === id);
  if (manualIndex >= 0) {
    const manual = [...state.manual];
    manual[manualIndex] = { ...manual[manualIndex], ...updates };
    return { ...state, manual };
  }
  return {
    ...state,
    overrides: {
      ...state.overrides,
      [id]: { ...(state.overrides?.[id] || {}), ...updates }
    }
  };
};

const normalizeFittingMaterialText = (value) => String(value ?? '')
  .normalize('NFKC')
  .trim()
  .replace(/[×＊*]/g, 'X')
  .replace(/\s+/g, ' ')
  .toUpperCase();

const normalizeFittingMaterialSignaturePart = (value) => normalizeFittingMaterialText(value)
  .replace(/[|,;:：，；。.'"`~!@#$%^&()_+=[\]{}<>?/\\\-\s]+/g, '');

const getFittingMaterialDescription = (material) => normalizeFittingMaterialText(
  material?.description ||
  material?.rawMaterial?.DESCRIPTION ||
  material?.rawMaterial?.['材料描述'] ||
  material?.type ||
  material?.label ||
  ''
);

const getMaterialElbowNominalAngle = (material) => {
  const text = [
    getFittingMaterialDescription(material),
    normalizeFittingMaterialText(material?.type),
    normalizeFittingMaterialText(material?.rawMaterial?.DESCRIPTION),
    normalizeFittingMaterialText(material?.rawMaterial?.['材料描述'])
  ].join(' ');
  const match = text.match(/(?:^|\D)(45|90)\s*(?:°|DEG(?:REE)?S?|度)/i);
  return match ? Number(match[1]) : null;
};

const getFittingMaterialSpec = (material) => normalizeFittingMaterialText(
  material?.specification ||
  material?.diameter ||
  material?.ND ||
  material?.DN ||
  material?.['\u89c4\u683c'] ||
  material?.['\u7ba1\u5f84'] ||
  material?.rawMaterial?.specification ||
  material?.rawMaterial?.['\u89c4\u683c'] ||
  material?.rawMaterial?.['\u7ba1\u5f84'] ||
  material?.rawMaterial?.ND ||
  material?.rawMaterial?.DN ||
  ''
);

const getFittingMaterialSignature = (material) => {
  const description = normalizeFittingMaterialSignaturePart(getFittingMaterialDescription(material));
  const specification = normalizeFittingMaterialSignaturePart(getFittingMaterialSpec(material));
  const materialCode = normalizeFittingMaterialSignaturePart(
    material?.materialCode ||
    material?.itemCode ||
    material?.rawMaterial?.ITEM_CODE ||
    material?.rawMaterial?.itemCode ||
    material?.rawMaterial?.['材料代码'] ||
    material?.rawMaterial?.['材料编码'] ||
    ''
  );
  return `${description}|${specification}|${materialCode}`;
};

const getFittingMaterialQuantity = (material) => {
  const getCellText = (value) => {
    if (value && typeof value === 'object') {
      return value.text ?? value.value ?? '';
    }
    return value ?? '';
  };
  const hasFittingDescription = (value) => (
    /弯头|弯管|三通|法兰|阀|ELBOW|TEE|FLANGE|VALVE/i.test(String(getCellText(value) || ''))
  );
  const parseStrictQuantity = (value) => {
    const text = String(getCellText(value) || '')
      .normalize('NFKC')
      .replace(/,/g, '')
      .trim();
    if (!text || /(?:°|DEG(?:REE)?S?|度)/i.test(text)) return null;
    const match = text.match(/^(\d+(?:\.\d+)?)\s*(?:PCS?|EA|SET|件|个)?$/i);
    if (!match) return null;
    const quantity = Number(match[1]);
    // 管件 QTY 是计数，不应出现百万级 ITEM CODE。保留较宽上限以兼容大型项目。
    if (!Number.isFinite(quantity) || quantity < 0 || quantity > 100000) return null;
    return quantity;
  };

  const rawRow = Array.isArray(material?.rawLogicalRow) ? material.rawLogicalRow : [];
  const rawMaterial = material?.rawMaterial || {};
  const rawColumn = (index) => getCellText(rawMaterial?.[`column${index}`]);
  const isSixColumnRow = hasFittingDescription(rawRow[4]) || hasFittingDescription(rawColumn(5));
  const isFiveColumnRow = hasFittingDescription(rawRow[1]) || hasFittingDescription(rawColumn(2));

  // 标准申远材料表：PART NO. | ITEM CODE | SIZE | ACC | DESCRIPTION | QTY。
  // 原始第6列优先级最高，避免已归一化字段偶尔被远端返回的 ITEM CODE 污染。
  const candidates = [
    isSixColumnRow ? rawRow[5] : null,
    isSixColumnRow ? rawColumn(6) : null,
    material?.quantity,
    material?.QTY,
    rawMaterial?.QTY,
    rawMaterial?.quantity,
    rawMaterial?.['数量'],
    material?.['数量'],
    isFiveColumnRow ? rawRow[4] : null,
    isFiveColumnRow ? rawColumn(5) : null
  ];

  for (const candidate of candidates) {
    const quantity = parseStrictQuantity(candidate);
    if (Number.isFinite(quantity)) return quantity;
  }
  return Infinity;
};

const normalizeFittingPipelineNumber = (value) => String(value || '')
  .normalize('NFKC')
  .replace(/\s+/g, '')
  .toUpperCase();

const getFittingMaterialPipelineNumber = (material) => normalizeFittingPipelineNumber(
  material?.pipelineNumber ||
  material?.rawMaterial?.pipelineNumber ||
  material?.rawMaterial?.['管线号'] ||
  ''
);

const isMaterialForFittingType = (material, fittingType) => {
  const text = [
    getFittingMaterialDescription(material),
    normalizeFittingMaterialText(material?.type),
    normalizeFittingMaterialText(material?.jointType),
    normalizeFittingMaterialText(material?.rawMaterial?.DESCRIPTION),
    normalizeFittingMaterialText(material?.rawMaterial?.['材料描述'])
  ].join(' ');
  const isTee = /三通|\bTEE\b/.test(text);
  const isBranchOutlet = /支管台|焊接支管座|\bWELD(?:ING)?\s*OUTLET\b|\bWELDOLET\b|\bOLET\b/.test(text);
  const isElbow = /弯头|弯管|\bELBOW\b/.test(text);
  const isValve = /阀|阀门|\bVALVE\b/.test(text);
  if (fittingType === 'valve-fitting') {
    return isValve;
  }
  if (fittingType === 'tee-fitting') {
    return isTee && !isBranchOutlet;
  }
  if (fittingType === 'branch-outlet') {
    return isBranchOutlet;
  }
  return isElbow && !isTee && !isValve;
};

const getFittingMaterialGroup = (candidate) => {
  if (candidate?.branchOutlet) return 'branch-outlet';
  const type = candidate?.type === 'tee-fitting'
    ? 'tee-fitting'
    : candidate?.type === 'valve-fitting'
      ? 'valve-fitting'
      : 'elbow';
  if (type !== 'elbow') return type;
  const nominalAngle = Number(candidate?.nominalAngle || candidate?.elbowAngle);
  return Number.isFinite(nominalAngle) ? `elbow-${nominalAngle}` : 'elbow';
};

const isMaterialForFittingCandidate = (material, candidate) => {
  if (candidate?.branchOutlet) return isMaterialForFittingType(material, 'branch-outlet');
  const fittingType = candidate?.type === 'tee-fitting'
    ? 'tee-fitting'
    : candidate?.type === 'valve-fitting'
      ? 'valve-fitting'
      : 'elbow';
  if (!isMaterialForFittingType(material, fittingType)) return false;
  if (fittingType !== 'elbow') return true;

  const candidateAngle = Number(candidate?.nominalAngle || candidate?.elbowAngle);
  const materialAngle = getMaterialElbowNominalAngle(material);
  return !Number.isFinite(candidateAngle) || materialAngle === null || materialAngle === candidateAngle;
};

const isPipeMaterial = (material) => {
  const text = [
    getFittingMaterialDescription(material),
    normalizeFittingMaterialText(material?.type),
    normalizeFittingMaterialText(material?.category),
    normalizeFittingMaterialText(material?.rawMaterial?.DESCRIPTION),
    normalizeFittingMaterialText(material?.rawMaterial?.['材料描述'])
  ].join(' ');
  const isExcludedFitting = /三通|\bTEE\b|弯头|弯管|\bELBOW\b|法兰|\bFLANGE\b|垫片|\bGASKET\b|阀|\bVALVE\b|螺栓|\bBOLT\b|支架|\bSUPPORT\b/.test(text);
  return !isExcludedFitting && (/管子|管材|钢管|无缝钢管|焊管|\bPIPE\b|\bSMLS\b|\bERW\b/.test(text));
};

const getMaterialAutoRecognitionType = (material) => {
  if (isMaterialForFittingType(material, 'branch-outlet')) {
    return { text: '支管台', color: '#d46b08', bg: '#fff7e6' };
  }
  if (isMaterialForFittingType(material, 'valve-fitting')) {
    return { text: '阀门', color: '#c41d7f', bg: '#fff0f6' };
  }
  if (isMaterialForFittingType(material, 'tee-fitting')) {
    return { text: '三通', color: '#722ed1', bg: '#f9f0ff' };
  }
  if (isMaterialForFittingType(material, 'elbow')) {
    const nominalAngle = getMaterialElbowNominalAngle(material);
    return { text: nominalAngle ? `${nominalAngle}°弯头` : '弯头', color: '#08979c', bg: '#e6fffb' };
  }
  if (isPipeMaterial(material)) {
    return { text: '管子', color: '#237804', bg: '#f6ffed' };
  }
  return { text: '手动', color: '#8c8c8c', bg: '#f5f5f5' };
};

const getFittingType = (candidate) => {
  if (candidate?.type === 'tee-fitting') return 'tee-fitting';
  if (candidate?.type === 'valve-fitting') return 'valve-fitting';
  return 'elbow';
};

const getFittingTypeLabel = (type) => {
  if (type === 'branch-outlet') return '支管台';
  if (type === 'tee-fitting') return '三通';
  if (type === 'valve-fitting') return '阀门';
  return '弯头';
};

const renderMaterialOptionLabel = (label, material) => {
  const type = getMaterialAutoRecognitionType(material);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%' }}>
      <span
        style={{
          flex: '0 0 auto',
          minWidth: 34,
          padding: '1px 5px',
          borderRadius: 4,
          fontSize: 11,
          lineHeight: '16px',
          color: type.color,
          background: type.bg,
          border: `1px solid ${type.color}`
        }}
      >
        {type.text}
      </span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
    </span>
  );
};

const resolveSingleFittingMaterial = (materialRows, fittingType, candidateCount = 0, nominalAngle = null) => {
  let matchedRows = (materialRows || []).filter(row => isMaterialForFittingType(row, fittingType));
  if (fittingType === 'elbow' && Number.isFinite(nominalAngle)) {
    const exactRows = matchedRows.filter(row => getMaterialElbowNominalAngle(row) === nominalAngle);
    const angleUnknownRows = matchedRows.filter(row => getMaterialElbowNominalAngle(row) === null);
    matchedRows = exactRows.length > 0 ? exactRows : angleUnknownRows;
  }
  const bySignature = new Map();
  matchedRows.forEach(row => {
    const signature = getFittingMaterialSignature(row);
    if (!signature || signature === '|') return;
    if (!bySignature.has(signature)) {
      bySignature.set(signature, { material: row, quantity: 0, hasFiniteQuantity: false });
    }
    const item = bySignature.get(signature);
    const quantity = getFittingMaterialQuantity(row);
    if (Number.isFinite(quantity)) {
      item.quantity += quantity;
      item.hasFiniteQuantity = true;
    }
  });

  if (bySignature.size === 1) {
    const item = Array.from(bySignature.values())[0];
    if (item.hasFiniteQuantity && candidateCount > item.quantity) {
      return { status: 'overLimit', material: item.material, quantity: item.quantity, candidateCount };
    }
    return { status: 'matched', material: item.material, quantity: item.hasFiniteQuantity ? item.quantity : Infinity };
  }
  if (bySignature.size > 1) {
    return { status: 'ambiguous', count: bySignature.size };
  }
  return { status: 'missing' };
};

const summarizeFittingMaterialQuantity = (materialRows, fittingType, nominalAngle = null) => {
  let matchedRows = (materialRows || []).filter(row => isMaterialForFittingType(row, fittingType));
  if (fittingType === 'elbow' && Number.isFinite(nominalAngle)) {
    matchedRows = matchedRows.filter(row => getMaterialElbowNominalAngle(row) === nominalAngle);
  }
  let totalQuantity = 0;
  let hasFiniteQuantity = false;
  const signatures = new Set();

  matchedRows.forEach(row => {
    const signature = getFittingMaterialSignature(row);
    if (signature && signature !== '|') {
      signatures.add(signature);
    }
    const quantity = getFittingMaterialQuantity(row);
    if (Number.isFinite(quantity)) {
      totalQuantity += quantity;
      hasFiniteQuantity = true;
    }
  });

  return {
    rowCount: matchedRows.length,
    signatureCount: signatures.size,
    materialCount: hasFiniteQuantity ? totalQuantity : null
  };
};

const getFittingCountDiffColor = (diff) => {
  if (!Number.isFinite(diff)) return '#8c8c8c';
  if (diff > 0) return '#cf1322';
  if (diff < 0) return '#d48806';
  return '#237804';
};

const getFittingCountStorageKey = (documentKey) => `luotu-fitting-counts:${String(documentKey || 'document')}`;

const readFittingCountCache = (documentKey) => {
  try {
    const parsed = JSON.parse(localStorage.getItem(getFittingCountStorageKey(documentKey)) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
};

const writeFittingCountCache = (documentKey, pageNumber, pipelineNumber, counts) => {
  const storageKey = getFittingCountStorageKey(documentKey);
  const cache = readFittingCountCache(documentKey);
  cache[String(pageNumber)] = {
    pageNumber,
    pipelineNumber: normalizeFittingPipelineNumber(pipelineNumber),
    counts: {
      elbow: counts?.elbow || 0,
      'tee-fitting': counts?.['tee-fitting'] || 0,
      'valve-fitting': counts?.['valve-fitting'] || 0
    },
    updatedAt: Date.now()
  };
  localStorage.setItem(storageKey, JSON.stringify(cache));
  window.dispatchEvent(new CustomEvent('luotu-fitting-counts-updated', { detail: { storageKey } }));
};

export const VectorVisualizer = forwardRef(({ 
  vectors, 
  scale = 1, 
  visible = false, 
  showWeldDebug = false, 
  rulesVersion = 0,
  ocrDetections = null,  // OCR识别结果（已废弃，不再使用）
  pageSize = null,       // 页面尺寸（已废弃，不再使用）
  enableOCRFilter = true, // 是否启用OCR文字过滤（已废弃，不再使用）
  weldRecognitionArea = null,
  showFittingDebug = false,
  showPipeLengthDebug = false,
  materialRows = [],
  materialScope = 'pipeline',
  documentKey = 'document',
  pageNumber = 1,
  pipelineNumber = '',
  onExecuteUndoableCommand = null,
  onAutoBindFittingMaterials = null,
  onDisplayedWeldsChange = null
}, ref) => {
  const canvasRef = useRef(null);
  const [renderStats, setRenderStats] = useState({ count: 0, time: 0, weldCount: 0 });
  const [vectorRefreshVersion, setVectorRefreshVersion] = useState(0);
  const [hoveredIndex, setHoveredIndex] = useState(null);
  const [selectedIndices, setSelectedIndices] = useState(new Set());
  const [selectedPathTypeInfo, setSelectedPathTypeInfo] = useState(null); // Path 类型信息
  const [selectedPathId, setSelectedPathId] = useState(null); // 当前点击对象的 Path ID
  const [pathIdLabelPosition, setPathIdLabelPosition] = useState(null); // Path ID 标签位置（CSS像素）
  const [elbowEdits, setElbowEdits] = useState({ deleted: {}, overrides: {}, manual: [] });
  const [selectedElbowId, setSelectedElbowId] = useState(null);
  const [addingElbow, setAddingElbow] = useState(false);
  const [addingFittingType, setAddingFittingType] = useState('elbow');
  const [materialModalVisible, setMaterialModalVisible] = useState(false);
  const [selectedMaterialKeys, setSelectedMaterialKeys] = useState([]);
  const [fittingCountCache, setFittingCountCache] = useState(() => readFittingCountCache(documentKey));
  const elbowDragRef = useRef(null);
  const elbowEditsRef = useRef(elbowEdits);
  const loadedElbowStorageKeyRef = useRef(null);
  const showPipeLengthOverlay = visible || showPipeLengthDebug;
  const elbowStorageKey = useMemo(
    () => `luotu-elbow-edits:${String(documentKey || 'document')}:${pageNumber}`,
    [documentKey, pageNumber]
  );
  const normalizedPipelineNumber = useMemo(
    () => normalizeFittingPipelineNumber(pipelineNumber),
    [pipelineNumber]
  );

  useEffect(() => {
    loadedElbowStorageKeyRef.current = null;
    try {
      const saved = JSON.parse(localStorage.getItem(elbowStorageKey) || 'null');
      const nextEdits = saved && typeof saved === 'object'
        ? { deleted: saved.deleted || {}, overrides: saved.overrides || {}, manual: saved.manual || [] }
        : { deleted: {}, overrides: {}, manual: [] };
      elbowEditsRef.current = nextEdits;
      setElbowEdits(nextEdits);
    } catch (error) {
      console.warn('[ElbowEditor] failed to load edits', error);
      const nextEdits = { deleted: {}, overrides: {}, manual: [] };
      elbowEditsRef.current = nextEdits;
      setElbowEdits(nextEdits);
    }
    setSelectedElbowId(null);
    setAddingElbow(false);
  }, [elbowStorageKey]);

  useEffect(() => {
    if (loadedElbowStorageKeyRef.current !== elbowStorageKey) {
      loadedElbowStorageKeyRef.current = elbowStorageKey;
      return;
    }
    localStorage.setItem(elbowStorageKey, JSON.stringify(elbowEdits));
  }, [elbowEdits, elbowStorageKey]);

  useEffect(() => {
    if (!showFittingDebug) {
      setSelectedElbowId(null);
      setAddingElbow(false);
      setMaterialModalVisible(false);
    }
  }, [showFittingDebug]);

  const replaceElbowEdits = useCallback((nextEdits) => {
    elbowEditsRef.current = nextEdits;
    setElbowEdits(nextEdits);
  }, []);

  const executeElbowCommand = useCallback((description, updater, beforeOverride = null) => {
    const before = beforeOverride || elbowEditsRef.current;
    const after = typeof updater === 'function' ? updater(before) : updater;
    if (!after || after === before) return;
    const command = {
      description,
      execute: () => replaceElbowEdits(after),
      undo: () => replaceElbowEdits(before)
    };
    if (onExecuteUndoableCommand) {
      onExecuteUndoableCommand(command);
    } else {
      command.execute();
    }
  }, [onExecuteUndoableCommand, replaceElbowEdits]);
  
  const { spatialIndex, recognizer, weldIndices, filteredWeldCount, textFilterApplied, displayedWeldCount, totalWeldCount, displayedWelds } = useMemo(() => {
    // 🔧 只有在焊点识别面板显示时才构建识别器
    if (!showWeldDebug) {
      return { spatialIndex: null, recognizer: null, weldIndices: new Set(), filteredWeldCount: 0, textFilterApplied: false, displayedWeldCount: 0, totalWeldCount: 0, displayedWelds: [] };
    }
    
    if (!vectors || vectors.length === 0) {
      console.log('⚠️ VectorVisualizer: 没有矢量数据');
      return { spatialIndex: null, recognizer: null, weldIndices: new Set(), filteredWeldCount: 0, textFilterApplied: false, displayedWeldCount: 0, totalWeldCount: 0, displayedWelds: [] };
    }
    
    const textData = window.__currentTextDetections__;
    const sourceVectors = vectors;
    const areaPrefilterApplied = false;
    if (weldRecognitionArea) {
      console.log('[Vector] weld recognition area will be applied after weld detection.');
    }

    console.log(`🔨 VectorVisualizer: 开始构建识别器 (${sourceVectors.length} 个矢量)`);
    
    const index = new VectorSpatialIndex(sourceVectors, 10000, 10000, 50);
    const rec = new ObjectRecognizer(sourceVectors, index);
    
    // 焊点识别
    rec.detectWelds(null);
    
    // 获取所有焊点
    let allWelds = rec.getDetectedWelds();
    const totalWeldCount = allWelds.length;
    
    // 🆕 如果有文字识别数据，过滤掉在文字区域内的焊点
    let filteredCount = 0;
    let textFilterWasApplied = false;

    const sharedFilterResult = applySharedWeldCandidateFilters(allWelds);
    if (sharedFilterResult.removed.length > 0) {
      allWelds = sharedFilterResult.welds;
      filteredCount += sharedFilterResult.removed.length;
      textFilterWasApplied = true;
      console.log('[Vector] shared weld candidate filters', sharedFilterResult.diagnostics);
    }
    
    // 优先使用 window.__currentTextDetections__（与控制台测试一致的数据源）
    const actualOcrDetections = ocrDetections || textData?.detections;
    const usesRelativeTextBoxes = Array.isArray(actualOcrDetections) && actualOcrDetections.some(detection => {
      if (!detection?.box || !Array.isArray(detection.box)) return false;
      const coords = detection.box.flat().filter(value => typeof value === 'number');
      return coords.length > 0 && Math.max(...coords) <= 1.1;
    });
    
    // 获取页面尺寸（优先级：textData.page_info > props.pageSize）
    // 🔧 确保 page_info 有效（page_width 和 page_height 都 > 0）
    let actualPageInfo = null;
    
    // 🔍 调试：打印所有可能的页面尺寸来源
    console.log('🔍 页面尺寸调试:', {
      'textData?.page_info': textData?.page_info,
      'props.pageSize': pageSize,
      'window.__pdfPageSize__': window.__pdfPageSize__
    });
    
    // 1. 首先尝试从 textData.page_info 获取（如果有效）
    if (textData?.page_info) {
      const pw = textData.page_info.page_width || textData.page_info.width || 0;
      const ph = textData.page_info.page_height || textData.page_info.height || 0;
      if (pw > 0 && ph > 0) {
        actualPageInfo = textData.page_info;
        console.log(`📐 使用 textData.page_info: ${pw} x ${ph}`);
      }
    }
    
    // 2. 如果 textData.page_info 无效，使用 props.pageSize（来自 PDF 页面）
    if (!actualPageInfo && pageSize && pageSize.width > 0 && pageSize.height > 0) {
      actualPageInfo = fitPageInfoToVectorSpace({
        page_width: pageSize.width, 
        page_height: pageSize.height,
        _fromPdfPage: true
      }, sourceVectors);
      console.log(
        `📐 使用 props.pageSize (PDF): ${actualPageInfo.page_width} x ${actualPageInfo.page_height}` +
        (actualPageInfo._fromPdfRenderSize ? `（由渲染尺寸 ${pageSize.width} x ${pageSize.height} 还原）` : '')
      );
    }
    
    // 3. 🆕 如果仍然没有有效的页面尺寸，尝试从全局变量获取
    // 注意：window.__pdfPageSize__ 是渲染后的尺寸（乘以 scale=2.0），需要除以 scale
    if (!actualPageInfo && window.__pdfPageSize__) {
      const gps = window.__pdfPageSize__;
      if (gps.width > 0 && gps.height > 0) {
        const PDF_RENDER_SCALE = 2.0;
        const originalWidth = Math.round(gps.width / PDF_RENDER_SCALE);
        const originalHeight = Math.round(gps.height / PDF_RENDER_SCALE);
        actualPageInfo = {
          page_width: originalWidth,
          page_height: originalHeight,
          _fromGlobal: true
        };
        console.log(`📐 使用 window.__pdfPageSize__ (还原原始尺寸): ${originalWidth} x ${originalHeight} (渲染尺寸: ${gps.width} x ${gps.height})`);
      }
    }
    
    // 4. 🆕🆕 最后备用：从 vectors 数据推断页面尺寸
    if (!actualPageInfo && sourceVectors && sourceVectors.length > 0) {
      let maxX = 0, maxY = 0;
      sourceVectors.forEach(v => {
        if (v.x1 !== undefined) maxX = Math.max(maxX, v.x1);
        if (v.x2 !== undefined) maxX = Math.max(maxX, v.x2);
        if (v.y1 !== undefined) maxY = Math.max(maxY, v.y1);
        if (v.y2 !== undefined) maxY = Math.max(maxY, v.y2);
        if (v.cx !== undefined) maxX = Math.max(maxX, v.cx + (v.r || 0));
        if (v.cy !== undefined) maxY = Math.max(maxY, v.cy + (v.r || 0));
      });
      
      if (maxX > 0 && maxY > 0) {
        // 添加 10% 的边距
        actualPageInfo = {
          page_width: maxX * 1.1,
          page_height: maxY * 1.1,
          _fromVectors: true
        };
        console.log(`📐 从 vectors 推断页面尺寸: ${maxX.toFixed(0)} x ${maxY.toFixed(0)} (加10%边距: ${actualPageInfo.page_width.toFixed(0)} x ${actualPageInfo.page_height.toFixed(0)})`);
      }
    }
    
    // 如果没有有效的页面尺寸，但有文字检测数据，打印警告
    if (actualOcrDetections && actualOcrDetections.length > 0 && !actualPageInfo) {
      console.warn('⚠️ 有文字检测数据但没有有效的页面尺寸，文字过滤将被跳过');
      console.warn('   请确保 PDF 页面已正确加载');
    }
    
    if (!areaPrefilterApplied && weldRecognitionArea && actualPageInfo) {
      const areaFilterResult = filterWeldsInRelativeArea(allWelds, weldRecognitionArea, actualPageInfo);
      if (areaFilterResult.removed.length > 0) {
        allWelds = areaFilterResult.welds;
        filteredCount += areaFilterResult.removed.length;
        textFilterWasApplied = true;
        console.log(`[Vector] weld recognition area filter removed ${areaFilterResult.removed.length} candidates`);
      }
    }
    
    if (actualOcrDetections && actualOcrDetections.length > 0 && actualPageInfo) {
      textFilterWasApplied = true;
      const sourceLabel = actualPageInfo._fromPdfPage ? ' (PDF)' : actualPageInfo._fromGlobal ? ' (全局)' : actualPageInfo._fromVectors ? ' (矢量推断)' : ' (OCR)';
      console.log(`📝 检测到 ${actualOcrDetections.length} 个文字区域，开始过滤焊点...`);
      console.log(`📐 页面尺寸: ${actualPageInfo.page_width || actualPageInfo.width} x ${actualPageInfo.page_height || actualPageInfo.height}${sourceLabel}`);
      
      // 调试：打印第一个焊点的坐标
      if (allWelds[0]?.center) {
        console.log(`🔥 第一个焊点中心坐标: (${allWelds[0].center.x.toFixed(2)}, ${allWelds[0].center.y.toFixed(2)})`);
      }
      
      // 调试：打印第一个文字区域
      if (actualOcrDetections[0]) {
        console.log(`📍 第一个文字区域: "${actualOcrDetections[0].text}"`);
      }
      
      const filteredResults = filterWeldsOutsideTextRegions(
        allWelds,
        actualOcrDetections,
        actualPageInfo,
        'any'
      );
      
      const pureWelds = filteredResults.map(r => r.weld);
      filteredCount = totalWeldCount - pureWelds.length;
      
      // 找出被过滤的焊点（用于调试）
      const filteredOutWelds = allWelds.filter(w => !pureWelds.includes(w));
      
      // 🔍 检查特定焊点是否被过滤
      const targetIds = [8310, 8518, 8546];
      targetIds.forEach(targetId => {
        const targetWeld = filteredOutWelds.find(w => w.pathId === targetId || w.pathId === `${targetId}`);
        if (targetWeld) {
          console.warn(`🚨 确认：焊点 ${targetId} 已被过滤！中心点: (${targetWeld.center.x.toFixed(2)}, ${targetWeld.center.y.toFixed(2)})`);
        } else {
          const keptWeld = pureWelds.find(w => w.pathId === targetId || w.pathId === `${targetId}`);
          if (keptWeld) {
               console.log(`✅ 焊点 ${targetId} 未被过滤，应该显示。`);
          } else {
               console.log(`❓ 焊点 ${targetId} 不在过滤列表也不在保留列表中（可能未被检测到）。`);
          }
        }
      });

      if (filteredOutWelds.length > 0 && filteredOutWelds.length <= 20) {
        console.log('🚫 被过滤的焊点:');
        filteredOutWelds.forEach((w, i) => {
          console.log(`   ${i + 1}. 中心点: (${w.center.x.toFixed(1)}, ${w.center.y.toFixed(1)})`);
        });
      } else if (filteredOutWelds.length > 20) {
        console.log(`🚫 被过滤的焊点: ${filteredOutWelds.length} 个 (太多，不逐一显示)`);
      }
      
      allWelds = pureWelds;
      
      console.log(`✅ 焊点过滤完成: 总数 ${totalWeldCount}, 文字框 ${actualOcrDetections.length}, 过滤 ${filteredCount}, 保留 ${pureWelds.length}`);
    } else if (ocrDetections && ocrDetections.length > 0) {
      console.log(`⚠️ 使用 props 传入的 ocrDetections (${ocrDetections.length} 个)，可能与控制台测试结果不一致`);
    }
    
    // 获取保留的焊点的向量索引
    const weldSet = new Set();
    const weldIds = new Set();
    const duplicateIds = new Set();
    
    allWelds.forEach(weld => {
      weld.vectorIndices.forEach(idx => weldSet.add(idx));
      
      // 检查重复ID
      if (weld.pathId) {
        if (weldIds.has(weld.pathId)) {
          duplicateIds.add(weld.pathId);
        }
        weldIds.add(weld.pathId);
      }
    });
    
    if (duplicateIds.size > 0) {
      console.warn(`⚠️ 发现 ${duplicateIds.size} 个重复的焊点 ID!`, Array.from(duplicateIds));
      console.warn('   这可能导致统计数量翻倍。请检查 vectors 数据源是否包含重复数据。');
    }

    rec.detectedWelds = allWelds;
    if (rec.weldIndicesSet && typeof rec.weldIndicesSet.clear === 'function') {
      rec.weldIndicesSet.clear();
      allWelds.forEach(weld => {
        (weld.vectorIndices || []).forEach(idx => rec.weldIndicesSet.add(idx));
      });
    }
    
    console.log(`✅ VectorVisualizer: 识别器构建完成，显示焊点数: ${allWelds.length} (唯一ID: ${weldIds.size})`);
    
    return { 
      spatialIndex: index, 
      recognizer: rec, 
      weldIndices: weldSet,
      filteredWeldCount: filteredCount,
      textFilterApplied: textFilterWasApplied,
      displayedWeldCount: allWelds.length,  // 实际显示的焊点数量
      totalWeldCount: totalWeldCount,       // 过滤前的总焊点数量
      displayedWelds: allWelds              // 过滤后的焊点列表
    };
  }, [vectors, rulesVersion, showWeldDebug, ocrDetections, pageSize, weldRecognitionArea]); // 当OCR结果改变时重新过滤

  // Publish page-scoped weld data; PDFViewer keeps each page in an independent slot.
  useEffect(() => {
    if (!showWeldDebug || typeof onDisplayedWeldsChange !== 'function') return;
    onDisplayedWeldsChange({
      pageNumber,
      welds: displayedWelds,
      pipelineNumber: normalizedPipelineNumber
    });
  }, [displayedWelds, normalizedPipelineNumber, onDisplayedWeldsChange, pageNumber, showWeldDebug]);

  const rawElbowCandidates = useMemo(() => {
    if (!showFittingDebug || !vectors || vectors.length === 0) {
      return [];
    }

    const pageInfo = getPageInfoForElbowFiltering(null, pageSize, vectors);
    const sourceVectors = filterVectorsInRelativeArea(vectors, weldRecognitionArea, pageInfo);
    const candidates = [
      ...detectElbowCandidates(sourceVectors, {
        includeSharpElbows: true,
        elbowGeometryMode: 'auto-exclusive',
        welds: displayedWelds
      }),
      ...detectTeeCandidates(sourceVectors),
      ...detectBranchOutletCandidates(sourceVectors, { welds: displayedWelds }),
      ...detectValveCandidates(sourceVectors)
    ];
    console.log(`[FittingDetector] raw candidates from vector debug: ${candidates.length}`, {
      sourceVectors: vectors.length,
      scannedVectors: sourceVectors.length,
      hasAreaPrefilter: !!(weldRecognitionArea && pageInfo),
      elbowGeometryModes: Array.from(new Set(
        candidates
          .map(candidate => candidate.geometryRuleMode)
          .filter(Boolean)
      ))
    });
    return candidates;
  }, [showFittingDebug, vectors, pageSize, weldRecognitionArea, displayedWelds]);

  const detectedElbowCandidates = useMemo(() => {
    if (!showFittingDebug || rawElbowCandidates.length === 0) {
      window.__elbowCandidates__ = [];
      return [];
    }

    let candidates = rawElbowCandidates;
    const totalCandidates = candidates.length;
    const textData = window.__currentTextDetections__;
    const actualOcrDetections = ocrDetections || textData?.detections;
    const actualPageInfo = getPageInfoForElbowFiltering(textData, pageSize, vectors);

    if (weldRecognitionArea && actualPageInfo) {
      const areaFilterResult = filterElbowCandidatesInRelativeArea(candidates, weldRecognitionArea, actualPageInfo);
      if (areaFilterResult.removed.length > 0) {
        candidates = areaFilterResult.candidates;
        console.log(`[FittingDetector] area filter removed ${areaFilterResult.removed.length} candidates`);
      }
    }

    if (actualOcrDetections && actualOcrDetections.length > 0 && actualPageInfo) {
      const textFilterResult = filterElbowCandidatesByTextOverlap(candidates, actualOcrDetections, actualPageInfo, 0.75);
      if (textFilterResult.removed.length > 0) {
        candidates = textFilterResult.candidates;
        console.log(`[FittingDetector] text overlap filter removed ${textFilterResult.removed.length} candidates`);
      }
    }

    window.__elbowCandidates__ = candidates;
    console.log(`[FittingDetector] filtered ${candidates.length} candidates`, {
      total: totalCandidates,
      kept: candidates.length,
      hasAreaFilter: !!weldRecognitionArea,
      hasTextFilter: !!(actualOcrDetections && actualOcrDetections.length > 0 && actualPageInfo),
      textFilterOrder: 'candidate -> area -> OCR text overlap',
      elbowGeometryModes: Array.from(new Set(
        candidates
          .map(candidate => candidate.geometryRuleMode)
          .filter(Boolean)
      )),
      sample: candidates.slice(0, 10)
    });
    return candidates;
  }, [showFittingDebug, rawElbowCandidates, ocrDetections, pageSize, weldRecognitionArea, vectors, vectorRefreshVersion]);

  const elbowCandidates = useMemo(() => {
    const detected = detectedElbowCandidates
      .map(candidate => {
        const id = createElbowCandidateId(candidate);
        if (elbowEdits.deleted[id]) return null;
        const override = elbowEdits.overrides[id] || {};
        return { ...candidate, ...override, id, center: override.center || candidate.center };
      })
      .filter(Boolean);
    return [...detected, ...(elbowEdits.manual || [])];
  }, [detectedElbowCandidates, elbowEdits]);

  useEffect(() => {
    window.__elbowCandidates__ = elbowCandidates;
  }, [elbowCandidates]);

  const fittingCandidateCountByType = useMemo(() => {
    return (elbowCandidates || []).reduce((counts, candidate) => {
      const type = getFittingType(candidate);
      counts[type] = (counts[type] || 0) + 1;
      return counts;
    }, { elbow: 0, 'tee-fitting': 0, 'valve-fitting': 0 });
  }, [elbowCandidates]);

  const fittingCandidateCountByGroup = useMemo(() => (
    (elbowCandidates || []).reduce((counts, candidate) => {
      const group = getFittingMaterialGroup(candidate);
      counts[group] = (counts[group] || 0) + 1;
      return counts;
    }, {})
  ), [elbowCandidates]);

  useEffect(() => {
    if (!showFittingDebug) return;
    writeFittingCountCache(documentKey, pageNumber, normalizedPipelineNumber, fittingCandidateCountByType);
  }, [documentKey, fittingCandidateCountByType, normalizedPipelineNumber, pageNumber, showFittingDebug]);

  const pipeLengthCandidates = useMemo(() => {
    if (!showPipeLengthOverlay) {
      return [];
    }

    const textData = window.__currentTextDetections__;
    const actualOcrDetections = ocrDetections || textData?.detections;
    if (!Array.isArray(actualOcrDetections) || actualOcrDetections.length === 0) {
      return [];
    }
    const actualPageInfo = getPageInfoForElbowFiltering(textData, pageSize, vectors);
    const candidates = detectPipeLengthCandidates(
      vectors,
      actualOcrDetections,
      actualPageInfo,
      weldRecognitionArea,
      { documentKey, pageNumber, pipelineNumber: normalizedPipelineNumber }
    );

    window.__pipeLengthCandidates__ = candidates;
    if (candidates.length > 0) {
      console.log(`[PipeLengthDetector] detected ${candidates.length} pipe length candidates`, candidates.slice(0, 12));
    }
    return candidates;
  }, [showPipeLengthOverlay, vectors, ocrDetections, pageSize, weldRecognitionArea, vectorRefreshVersion]);

  useEffect(() => {
    const refresh = () => setFittingCountCache(readFittingCountCache(documentKey));
    refresh();
    const handleCustomEvent = (event) => {
      const storageKey = getFittingCountStorageKey(documentKey);
      if (!event?.detail?.storageKey || event.detail.storageKey === storageKey) {
        refresh();
      }
    };
    const handleStorage = (event) => {
      if (event.key === getFittingCountStorageKey(documentKey)) {
        refresh();
      }
    };
    window.addEventListener('luotu-fitting-counts-updated', handleCustomEvent);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('luotu-fitting-counts-updated', handleCustomEvent);
      window.removeEventListener('storage', handleStorage);
    };
  }, [documentKey]);

  const crossPageFittingCandidateCountByType = useMemo(() => {
    const fallback = fittingCandidateCountByType;
    if (materialScope === 'page') return fallback;
    if (!normalizedPipelineNumber) return fallback;
    const total = { elbow: 0, 'tee-fitting': 0, 'valve-fitting': 0 };
    Object.values(fittingCountCache || {}).forEach((entry) => {
      if (!entry || entry.pipelineNumber !== normalizedPipelineNumber) return;
      total.elbow += entry.counts?.elbow || 0;
      total['tee-fitting'] += entry.counts?.['tee-fitting'] || 0;
      total['valve-fitting'] += entry.counts?.['valve-fitting'] || 0;
    });
    return (total.elbow || total['tee-fitting'] || total['valve-fitting']) ? total : fallback;
  }, [fittingCandidateCountByType, fittingCountCache, materialScope, normalizedPipelineNumber]);

  const materialRowsForCurrentPipeline = useMemo(() => {
    const allRows = materialRows || [];
    const pageRows = materialScope === 'page'
      ? allRows.filter(row => {
        const rowPage = Number(
          row?.sourcePage ??
          row?.page ??
          row?.calculatedPage ??
          row?.ocrPage
        );
        return !Number.isFinite(rowPage) || rowPage === Number(pageNumber);
      })
      : allRows;
    if (materialScope === 'page' || !normalizedPipelineNumber) return pageRows;
    const matched = pageRows.filter(row => getFittingMaterialPipelineNumber(row) === normalizedPipelineNumber);
    return matched.length > 0 ? matched : pageRows;
  }, [materialRows, materialScope, normalizedPipelineNumber, pageNumber]);

  const fittingMaterialStatusByType = useMemo(() => ({
    elbow: resolveSingleFittingMaterial(materialRowsForCurrentPipeline, 'elbow', crossPageFittingCandidateCountByType.elbow || 0),
    'elbow-45': resolveSingleFittingMaterial(materialRowsForCurrentPipeline, 'elbow', fittingCandidateCountByGroup['elbow-45'] || 0, 45),
    'elbow-90': resolveSingleFittingMaterial(materialRowsForCurrentPipeline, 'elbow', fittingCandidateCountByGroup['elbow-90'] || 0, 90),
    'tee-fitting': resolveSingleFittingMaterial(materialRowsForCurrentPipeline, 'tee-fitting', crossPageFittingCandidateCountByType['tee-fitting'] || 0),
    'branch-outlet': resolveSingleFittingMaterial(materialRowsForCurrentPipeline, 'branch-outlet', fittingCandidateCountByGroup['branch-outlet'] || 0),
    'valve-fitting': resolveSingleFittingMaterial(materialRowsForCurrentPipeline, 'valve-fitting', crossPageFittingCandidateCountByType['valve-fitting'] || 0)
  }), [crossPageFittingCandidateCountByType, fittingCandidateCountByGroup, materialRowsForCurrentPipeline]);

  const fittingCountComparisonByType = useMemo(() => {
    const buildComparison = (type, detectedCount, nominalAngle = null) => {
      const materialSummary = summarizeFittingMaterialQuantity(
        materialRowsForCurrentPipeline,
        type,
        nominalAngle
      );
      const materialCount = materialSummary.materialCount;
      return {
        detectedCount,
        materialCount,
        diff: Number.isFinite(materialCount) ? detectedCount - materialCount : null,
        ...materialSummary
      };
    };
    return {
      elbow: buildComparison('elbow', crossPageFittingCandidateCountByType.elbow || 0),
      'elbow-45': buildComparison('elbow', fittingCandidateCountByGroup['elbow-45'] || 0, 45),
      'elbow-90': buildComparison('elbow', fittingCandidateCountByGroup['elbow-90'] || 0, 90),
      'tee-fitting': buildComparison('tee-fitting', crossPageFittingCandidateCountByType['tee-fitting'] || 0),
      'valve-fitting': buildComparison('valve-fitting', crossPageFittingCandidateCountByType['valve-fitting'] || 0)
    };
  }, [crossPageFittingCandidateCountByType, fittingCandidateCountByGroup, materialRowsForCurrentPipeline]);

  const fittingCountDisplayRows = useMemo(() => {
    const angleRows = [
      ['45°弯头', fittingCountComparisonByType['elbow-45']],
      ['90°弯头', fittingCountComparisonByType['elbow-90']]
    ];
    const hasAngleBreakdown = angleRows.some(([, item]) => (
      item.detectedCount > 0 || item.rowCount > 0
    ));
    return [
      ...(hasAngleBreakdown ? angleRows : [['弯头', fittingCountComparisonByType.elbow]]),
      ['三通', fittingCountComparisonByType['tee-fitting']],
      ['阀门', fittingCountComparisonByType['valve-fitting']]
    ];
  }, [fittingCountComparisonByType]);

  const updateElbow = useCallback((id, updates) => {
    replaceElbowEdits(updateElbowEditState(elbowEditsRef.current, id, updates));
  }, [replaceElbowEdits]);

  const findNearestElbow = useCallback((x, y) => {
    const tolerance = 16 / Math.max(scale, 0.01);
    let nearest = null;
    let nearestDistance = Infinity;
    elbowCandidates.forEach(candidate => {
      const dx = candidate.center.x - x;
      const dy = candidate.center.y - y;
      const candidateDistance = Math.sqrt(dx * dx + dy * dy);
      if (candidateDistance <= tolerance && candidateDistance < nearestDistance) {
        nearest = candidate;
        nearestDistance = candidateDistance;
      }
    });
    return nearest;
  }, [elbowCandidates, scale]);

  const handleDeleteSelectedElbow = useCallback(() => {
    if (!selectedElbowId) return;
    executeElbowCommand('删除管件', prev => {
      const isManual = (prev.manual || []).some(item => item.id === selectedElbowId);
      if (isManual) {
        return { ...prev, manual: prev.manual.filter(item => item.id !== selectedElbowId) };
      }
      return { ...prev, deleted: { ...prev.deleted, [selectedElbowId]: true } };
    });
    setSelectedElbowId(null);
    message.success('已删除管件');
  }, [executeElbowCommand, selectedElbowId]);

  const handleAutoBindFittingMaterials = useCallback(() => {
    if (!onAutoBindFittingMaterials) {
      message.warning('当前页面不支持自动绑定管件材料');
      return;
    }
    const materialByType = fittingMaterialStatusByType;
    let ambiguousCount = 0;
    let unmatchedCount = 0;
    let newlyBoundCount = 0;

    const nextCandidates = (elbowCandidates || []).map(candidate => {
      if (Array.isArray(candidate.materialBindings) && candidate.materialBindings.length > 0) {
        return candidate;
      }
      const group = getFittingMaterialGroup(candidate);
      const resolved = materialByType[group];
      if (resolved?.status === 'ambiguous' || resolved?.status === 'overLimit') {
        ambiguousCount += 1;
        return candidate;
      }
      if (resolved?.status !== 'matched' || !resolved.material) {
        unmatchedCount += 1;
        return candidate;
      }
      newlyBoundCount += 1;
      return {
        ...candidate,
        materialBindings: [{ ...resolved.material }]
      };
    });

    const before = elbowEditsRef.current;
    const after = nextCandidates.reduce((state, candidate) => {
      if (!Array.isArray(candidate.materialBindings) || candidate.materialBindings.length === 0) {
        return state;
      }
      return updateElbowEditState(state, candidate.id, { materialBindings: candidate.materialBindings });
    }, before);

    if (after !== before) {
      executeElbowCommand('自动绑定管件材料', after, before);
    }
    if (newlyBoundCount > 0 && ambiguousCount > 0) {
      message.info(`已自动匹配 ${newlyBoundCount} 个管件，另有 ${ambiguousCount} 个需手动选择材料`);
    } else if (newlyBoundCount === 0 && ambiguousCount > 0) {
      message.warning(`有 ${ambiguousCount} 个管件材料存在歧义或数量超限，需手动处理`);
    } else if (newlyBoundCount === 0 && unmatchedCount > 0) {
      message.warning('未找到可自动匹配的弯头、三通或阀门材料');
    }
    onAutoBindFittingMaterials(nextCandidates, pageNumber);
  }, [elbowCandidates, executeElbowCommand, fittingMaterialStatusByType, onAutoBindFittingMaterials, pageNumber]);

  const selectedElbow = elbowCandidates.find(item => item.id === selectedElbowId) || null;
  const materialOptions = useMemo(() => {
    const usageCounts = getMaterialUsageCounts(elbowCandidates, selectedElbowId);
    const selectedKeys = new Set((selectedElbow?.materialBindings || []).map(item => item?.key).filter(Boolean));
    return (materialRowsForCurrentPipeline || []).map((row, index) => {
      if (selectedElbow && !isMaterialForFittingCandidate(row, selectedElbow)) return null;
      const quotaState = getMaterialQuotaState(row, usageCounts);
      if (quotaState.exhausted && !selectedKeys.has(row.key)) return null;
      const labelParts = [
        row.diameter || row.specification,
        row.description,
        row.materialCode
      ].filter(Boolean);
      if (Number.isFinite(quotaState.quota)) {
        labelParts.push(`剩余 ${quotaState.remaining}/${quotaState.quota}`);
      }
      const label = labelParts.join(' | ');
      return {
        value: row.key || `${row.sourcePage || pageNumber}-${index}`,
        label: renderMaterialOptionLabel(label, row),
        searchText: label,
        row
      };
    }).filter(Boolean);
  }, [elbowCandidates, materialRowsForCurrentPipeline, pageNumber, selectedElbow, selectedElbowId]);

  // 暴露方法给父组件
  useImperativeHandle(ref, () => ({
    getRuleManager: () => {
      const manager = recognizer ? recognizer.getRuleManager() : null;
      // 同时暴露recognizer到manager（用于全局访问）
      if (manager && recognizer) {
        const filteredRecognizer = Object.create(recognizer);
        filteredRecognizer.getDetectedWelds = () => displayedWelds || [];
        manager.__recognizer__ = filteredRecognizer;
      }
      return manager;
    },
    getRecognizer: () => {
      if (!recognizer) return null;
      const filteredRecognizer = Object.create(recognizer);
      filteredRecognizer.getDetectedWelds = () => displayedWelds || [];
      return filteredRecognizer;
    }, // 新增：直接获取recognizer（对外只暴露过滤后的焊点）
    getDisplayedWeldCount: () => displayedWeldCount || 0, // 获取显示的焊点数量
    getDisplayedWelds: () => displayedWelds || [], // 获取显示的焊点列表
    getElbowCandidates: () => elbowCandidates || [],
    redetectWelds: () => {
      if (recognizer) {
        recognizer.redetectWelds();
      }
    },
    isReady: () => !!recognizer,
    exportDebugData: () => {
      if (!vectors || vectors.length === 0) {
        console.warn('没有矢量数据可导出');
        return;
      }
      
      const paths = groupVectorsIntoPathsStructured(vectors);
      const pathsData = exportPathsForComparison(paths);
      const weldsData = displayedWelds || [];
      const ruleManager = recognizer ? recognizer.getRuleManager() : null;
      const enabledRules = ruleManager ? ruleManager.getEnabledRules() : [];
      
      const fullReport = {
        ...pathsData,
        detectedWelds: weldsData.length,
        elbowCandidates: (elbowCandidates || []).map(candidate => ({
          type: candidate.type,
          center: candidate.center,
          angle: candidate.angle,
          score: candidate.score,
          segmentIndices: candidate.segmentIndices,
          pathIds: candidate.pathIds,
          segmentLengths: candidate.segmentLengths,
          connectorCount: candidate.connectorCount,
          boundingBox: candidate.boundingBox
        })),
        weldDetails: weldsData.map(w => ({
          pathId: w.pathId,
          ruleName: w.ruleName,
          segmentCount: w.vectorIndices.length,
          center: w.center,
          boundingBox: w.boundingBox
        })),
        ruleMatchReport: generateRuleMatchReport(paths, enabledRules)
      };
      
      downloadDebugData(fullReport, `frontend_debug_${Date.now()}.json`);
      logDebugInfo(paths, weldsData);
    },
    exportSelectedWelds: () => {
      if (!vectors || vectors.length === 0) {
        console.warn('没有矢量数据');
        alert('没有矢量数据可导出');
        return;
      }
      
      if (selectedIndices.size === 0) {
        // 未选中任何对象，导出所有检测到的焊点
        const weldsData = displayedWelds || [];
        if (weldsData.length === 0) {
          console.warn('⚠️ 没有检测到任何焊点');
          alert('没有检测到任何焊点！\n\n请检查：\n1. 是否启用了焊点识别规则？\n2. 当前规则是否匹配PDF中的焊点特征？\n\n可以在"配置识别规则"中启用/调整规则。');
          return;
        }
        console.log('💡 未选中任何对象，导出所有检测到的焊点');
        const data = exportAllWelds(vectors, weldsData);
        downloadWeldsJSON(data, generateWeldFilename('all'));
        alert(`✅ 成功导出 ${data.total_welds} 个检测到的焊点！`);
      } else {
        // 选中了对象，直接导出选中的对象（不过滤焊点）
        console.log(`📦 导出选中的对象 (选中了 ${selectedIndices.size} 个向量)`);
        
        const data = exportSelectedObjects(selectedIndices, vectors);
        
        if (data.total_paths === 0) {
          console.warn('⚠️ 选中的向量无法导出');
          alert('选中的向量数据无效，无法导出！');
          return;
        }
        
        console.log(`✅ 成功整理出 ${data.total_paths} 个对象（共 ${data.total_selected_vectors} 个向量）`);
        downloadWeldsJSON(data, generateWeldFilename('selected'));
        alert(`✅ 成功导出 ${data.total_paths} 个选中的对象！\n共 ${data.total_selected_vectors} 个向量`);
      }
    },
    getSelectionInfo: () => ({
      selectedCount: selectedIndices.size,
      totalVectors: vectors.length,
      totalWelds: displayedWelds ? displayedWelds.length : 0
    }),
    exportManualAnnotations: () => {
      if (!vectors || vectors.length === 0) {
        console.warn('没有矢量数据');
        return;
      }
      
      if (selectedIndices.size === 0) {
        console.warn('⚠️ 请先选择要标注为焊点的对象！');
        console.log('💡 提示：');
        console.log('  1. 启用矢量调试（红色按钮）');
        console.log('  2. 点击你认为是焊点的对象（会变成红色）');
        console.log('  3. 可以按住Ctrl多选');
        console.log('  4. 再次点击"导出标注"按钮');
        return;
      }
      
      console.log(`📝 导出 ${selectedIndices.size} 个选中的向量作为焊点标注`);
      const data = exportManualAnnotations(selectedIndices, vectors);
      
      if (data) {
        downloadAnnotations(data, `manual_weld_annotations_${Date.now()}.json`);
        
        // 在控制台显示分析摘要
        console.group('📊 标注数据摘要');
        console.log(`标注的路径数: ${data.total_selected_paths}`);
        console.log(`总向量数: ${data.total_selected_vectors}`);
        if (data.statistics) {
          const stats = data.statistics;
          console.log('\n边数分布:');
          Object.entries(stats.segmentCounts).forEach(([count, num]) => {
            console.log(`  ${count}边形: ${num}个`);
          });
          console.log(`\n尺寸范围:`);
          console.log(`  宽度: ${stats.sizeRange.widthMin.toFixed(2)} ~ ${stats.sizeRange.widthMax.toFixed(2)}`);
          console.log(`  高度: ${stats.sizeRange.heightMin.toFixed(2)} ~ ${stats.sizeRange.heightMax.toFixed(2)}`);
          console.log(`\n形状特征:`);
          console.log(`  闭合: ${stats.closedCount}/${data.total_selected_paths}`);
          console.log(`  圆形: ${stats.circularCount}/${data.total_selected_paths}`);
          console.log(`  规则: ${stats.regularCount}/${data.total_selected_paths}`);
        }
        console.groupEnd();
      }
    }
  }), [recognizer, vectors, selectedIndices, displayedWelds, elbowCandidates]);

  // 处理鼠标点击
  const handleClick = (e) => {
    if (!visible && !addingElbow) return;
    
    const rect = canvasRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / scale; // 转换为PDF坐标
    const y = (e.clientY - rect.top) / scale;

    const clickedElbow = findNearestElbow(x, y);
    if (clickedElbow) {
      setSelectedElbowId(clickedElbow.id);
      setAddingElbow(false);
      return;
    }

    if (addingElbow) {
      const isTee = addingFittingType === 'tee-fitting';
      const isValve = addingFittingType === 'valve-fitting';
      const id = `${isTee ? 'manual-tee' : isValve ? 'manual-valve' : 'manual-elbow'}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      const manualFitting = {
        id,
        type: isTee ? 'tee-fitting' : isValve ? 'valve-fitting' : 'manual-elbow',
        center: { x, y },
        score: 1,
        pathIds: [],
        segmentIndices: [],
        materialBindings: []
      };
      executeElbowCommand(`添加${getFittingTypeLabel(getFittingType(manualFitting))}`, prev => ({ ...prev, manual: [...(prev.manual || []), manualFitting] }));
      setSelectedElbowId(id);
      setAddingElbow(false);
      message.success(`已添加${getFittingTypeLabel(getFittingType(manualFitting))}`);
      return;
    }

    if (!spatialIndex) return;
    
    const nearby = spatialIndex.findNearby(x, y, 5 / scale); // 5px 点击容差
    
    if (nearby.length > 0) {
      const clickedIndex = nearby[0]; // 选择最近的一个
      const clickedVector = vectors[clickedIndex];
      const clickedPathId = Array.isArray(clickedVector) && clickedVector.length >= 8 ? clickedVector[7] : null;
      setSelectedPathId(clickedPathId);
      setPathIdLabelPosition({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      });
      
      if (clickedPathId !== null && clickedPathId !== undefined) {
        console.log(`🏷️ 当前点击 Path ID: ${clickedPathId}`);
      }
      
      // 使用智能识别器扩展选择
      const objectIndices = recognizer ? recognizer.recognizeObject(clickedIndex) : new Set([clickedIndex]);
      
      // 获取并显示 Path 类型信息
      if (recognizer) {
        const pathTypeInfo = recognizer.getPathTypeByVectorIndex(clickedIndex);
        if (pathTypeInfo) {
          setSelectedPathTypeInfo({
            ...pathTypeInfo,
            pathId: clickedPathId
          }); // 更新面板显示
          
          console.log('🎯 Path 类型信息:');
          console.log(`  Path ID: ${clickedPathId}`);
          console.log(`  类型: ${pathTypeInfo.type}`);
          console.log(`  置信度: ${pathTypeInfo.confidence.toFixed(2)}`);
          console.log(`  判断依据: ${pathTypeInfo.reasons.join(', ')}`);
          if (pathTypeInfo.features) {
            console.log(`  特征:`);
            console.log(`    - 线段数: ${pathTypeInfo.features.segmentCount}`);
            console.log(`    - 平均线宽: ${pathTypeInfo.features.avgWidth.toFixed(2)}`);
            console.log(`    - 总长度: ${pathTypeInfo.features.totalLength.toFixed(1)}`);
            console.log(`    - 闭合: ${pathTypeInfo.features.isClosed ? '是' : '否'}`);
            console.log(`    - 连续: ${pathTypeInfo.features.isContinuous ? '是' : '否'}`);
          }
        } else {
          setSelectedPathTypeInfo(null);
        }
      }
      
      const newSelection = new Set(selectedIndices);
      
      // 如果点击的是已选中的对象的一部分，则取消选择该对象
      if (selectedIndices.has(clickedIndex)) {
        objectIndices.forEach(idx => newSelection.delete(idx));
      } else {
        // 单选模式：清除其他
        newSelection.clear();
        objectIndices.forEach(idx => newSelection.add(idx));
      }
      setSelectedIndices(newSelection);
    } else {
      // 点击空白处取消选择
      setSelectedIndices(new Set());
      setSelectedPathTypeInfo(null);
      setSelectedPathId(null);
      setPathIdLabelPosition(null);
    }
  };

  // 处理鼠标移动（Hover效果）
  const handleMouseMove = (e) => {
    if (!visible) return;
    
    const rect = canvasRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;

    if (elbowDragRef.current) {
      updateElbow(elbowDragRef.current.id, { center: { x, y } });
      canvasRef.current.style.cursor = 'grabbing';
      return;
    }

    if (findNearestElbow(x, y)) {
      canvasRef.current.style.cursor = 'grab';
      return;
    }

    if (!spatialIndex) return;
    
    const nearby = spatialIndex.findNearby(x, y, 5 / scale);
    
    if (nearby.length > 0) {
      setHoveredIndex(nearby[0]);
      canvasRef.current.style.cursor = 'pointer';
    } else {
      setHoveredIndex(null);
      canvasRef.current.style.cursor = 'default';
    }
  };

  const beginElbowDrag = useCallback((e, clickedElbow) => {
    if (!visible || e.button !== 0 || !clickedElbow) return;
    elbowDragRef.current = { id: clickedElbow.id, before: elbowEditsRef.current };
    setSelectedElbowId(clickedElbow.id);
    e.preventDefault();
    e.stopPropagation();
  }, [visible]);

  const handleMouseDown = (e) => {
    if (!visible || e.button !== 0) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;
    beginElbowDrag(e, findNearestElbow(x, y));
  };

  const handleMouseUp = useCallback(() => {
    if (!elbowDragRef.current) return;
    const { before } = elbowDragRef.current;
    const after = elbowEditsRef.current;
    elbowDragRef.current = null;
    if (after !== before) {
      executeElbowCommand('移动管件', after, before);
    }
    if (canvasRef.current) canvasRef.current.style.cursor = 'grab';
  }, [executeElbowCommand]);

  useEffect(() => {
    const handleWindowMouseMove = (e) => {
      if (!elbowDragRef.current || !canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const x = (e.clientX - rect.left) / scale;
      const y = (e.clientY - rect.top) / scale;
      updateElbow(elbowDragRef.current.id, { center: { x, y } });
    };
    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseUp, scale, updateElbow]);

  // 监听矢量测试更新事件
  useEffect(() => {
    const handleVectorTestUpdate = () => {
      setVectorRefreshVersion(prev => prev + 1);
    };
    
    window.addEventListener('vectorTestUpdate', handleVectorTestUpdate);
    return () => {
      window.removeEventListener('vectorTestUpdate', handleVectorTestUpdate);
    };
  }, []);

  useEffect(() => {
    if (!visible || !vectors || vectors.length === 0 || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    
    // 🔧 关键修复：获取PDF Canvas的实际渲染尺寸，而不是父容器尺寸
    const parent = canvas.parentElement;
    let pdfCanvas = parent.querySelector('canvas:not([data-vector-canvas])');
    
    // 如果没有找到PDF Canvas，使用父容器尺寸（降级方案）
    let cssWidth = parent.clientWidth;
    let cssHeight = parent.clientHeight;
    let pdfCanvasPixelWidth = cssWidth;
    let pdfCanvasPixelHeight = cssHeight;
    
    if (pdfCanvas) {
      // 使用PDF Canvas的实际CSS尺寸
      const pdfRect = pdfCanvas.getBoundingClientRect();
      cssWidth = pdfRect.width;
      cssHeight = pdfRect.height;
      
      // 获取PDF Canvas的实际像素尺寸（用于计算坐标缩放）
      pdfCanvasPixelWidth = pdfCanvas.width;
      pdfCanvasPixelHeight = pdfCanvas.height;
      
      console.log(`📐 [VectorVisualizer] PDF Canvas信息:`, {
        'CSS尺寸': `${cssWidth.toFixed(0)} × ${cssHeight.toFixed(0)}`,
        '像素尺寸': `${pdfCanvasPixelWidth} × ${pdfCanvasPixelHeight}`,
        '传入scale': scale
      });
    }

    // 🔧 关键修复：让矢量Canvas的像素尺寸与PDF Canvas完全一致
    // 策略：Canvas像素尺寸 = PDF Canvas像素尺寸，CSS尺寸也相同
    // 这样矢量坐标 * scale 就能直接映射到正确的Canvas像素位置
    
    const targetPixelWidth = pdfCanvasPixelWidth;
    const targetPixelHeight = pdfCanvasPixelHeight;
    
    // 只有在尺寸变化时才重置 canvas.width/height，避免闪烁
    if (canvas.width !== targetPixelWidth || canvas.height !== targetPixelHeight) {
      canvas.width = targetPixelWidth;
      canvas.height = targetPixelHeight;
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
      
      console.log(`✅ [VectorVisualizer] Canvas已对齐PDF Canvas:`, {
        '像素': `${canvas.width} × ${canvas.height}`,
        'CSS': `${cssWidth.toFixed(0)}px × ${cssHeight.toFixed(0)}px`,
        '传入scale': scale
      });
    }
    
    // 标记这是矢量Canvas，避免被当作PDF Canvas
    canvas.setAttribute('data-vector-canvas', 'true');
    
    // 设置Canvas绘图上下文
    // 不使用DPR缩放，因为Canvas像素尺寸已经与PDF Canvas匹配
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // 调试：绘制边框
    // ctx.strokeStyle = 'blue';
    // ctx.lineWidth = 2;
    // ctx.strokeRect(0, 0, width, height);

    // 性能计时开始
    const startTime = performance.now();
    let drawCount = 0;

    // 获取临时高亮的路径ID集合
    const highlightedPathIds = new Set();
    if (window.__highlightedPaths__) {
      window.__highlightedPaths__.forEach(p => {
        highlightedPathIds.add(String(p.pathId));
      });
    }
    
    // 1. 绘制普通线条 (红色半透明) - 仅在矢量调试启用时
    if (visible) {
      ctx.lineWidth = 1;
      ctx.lineCap = 'round';
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
      ctx.beginPath();

      const BATCH_SIZE = 10000;
      let currentBatch = 0;

      for (let i = 0; i < vectors.length; i++) {
        const element = vectors[i];
        if (!Array.isArray(element) || element.length < 5) continue;
        
        const pathId = element[7];
        const isHighlighted = pathId !== undefined && highlightedPathIds.has(String(pathId));
        
        // 跳过焊点、被选中的、Hover的和高亮的，稍后单独绘制
        if (weldIndices.has(i) || selectedIndices.has(i) || i === hoveredIndex || isHighlighted) continue;

        const [type, x1, y1, x2, y2] = element;
        
        const sx1 = x1 * scale;
        const sy1 = y1 * scale;
        const sx2 = x2 * scale;
        const sy2 = y2 * scale;

        ctx.moveTo(sx1, sy1);
        ctx.lineTo(sx2, sy2);
        drawCount++;

        currentBatch++;
        if (currentBatch >= BATCH_SIZE) {
          ctx.stroke();
          ctx.beginPath();
          currentBatch = 0;
        }
      }
      if (currentBatch > 0) ctx.stroke();
    }

    // 1.5. 绘制焊点 (橙色加粗，模仿 Python 项目) - 仅在 showWeldDebug 启用时
    if (showWeldDebug && weldIndices.size > 0) {
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = 'rgba(255, 165, 0, 0.9)'; // 橙色
      ctx.beginPath();
      
      const BATCH_SIZE = 10000;
      let currentBatch = 0;
      weldIndices.forEach(i => {
        // 跳过被选中的和Hover的
        if (selectedIndices.has(i) || i === hoveredIndex) return;
        
        const element = vectors[i];
        if (!Array.isArray(element) || element.length < 5) return;

        const [type, x1, y1, x2, y2] = element;
        ctx.moveTo(x1 * scale, y1 * scale);
        ctx.lineTo(x2 * scale, y2 * scale);
        drawCount++;

        currentBatch++;
        if (currentBatch >= BATCH_SIZE) {
          ctx.stroke();
          ctx.beginPath();
          currentBatch = 0;
        }
      });
      
      if (currentBatch > 0) ctx.stroke();
    }

    // 2. 绘制 Hover 状态 (黄色高亮)
    if (hoveredIndex !== null && !selectedIndices.has(hoveredIndex)) {
       const vec = vectors[hoveredIndex];
       if (vec) {
         ctx.globalAlpha = 1.0;
         ctx.lineWidth = 3;
         ctx.strokeStyle = 'rgba(255, 255, 0, 1.0)'; // 黄色
         ctx.beginPath();
         const [t, x1, y1, x2, y2] = vec;
         ctx.moveTo(x1 * scale, y1 * scale);
         ctx.lineTo(x2 * scale, y2 * scale);
         ctx.stroke();
       }
    }

    // 3. 绘制选中状态 (绿色高亮，模仿 Python 项目中的选中色)
    if (selectedIndices.size > 0) {
       ctx.globalAlpha = 1.0;
       ctx.lineWidth = 3;
       ctx.strokeStyle = 'rgba(0, 255, 0, 1.0)'; // 绿色
       ctx.beginPath();
       
       selectedIndices.forEach(index => {
         const vec = vectors[index];
         if (vec) {
            const [t, x1, y1, x2, y2] = vec;
            ctx.moveTo(x1 * scale, y1 * scale);
            ctx.lineTo(x2 * scale, y2 * scale);
         }
       });
       ctx.stroke();
    }
    
    // 4. 绘制临时高亮的路径 (紫色加粗)
    if (highlightedPathIds.size > 0) {
       ctx.globalAlpha = 1.0;
       ctx.lineWidth = 4;
       ctx.strokeStyle = 'rgba(147, 51, 234, 1.0)'; // 紫色
       ctx.beginPath();
       
       for (let i = 0; i < vectors.length; i++) {
         const vec = vectors[i];
         if (!vec || !Array.isArray(vec) || vec.length < 8) continue;
         
         const pathId = vec[7];
         if (pathId !== undefined && highlightedPathIds.has(String(pathId))) {
            const [t, x1, y1, x2, y2] = vec;
            ctx.moveTo(x1 * scale, y1 * scale);
            ctx.lineTo(x2 * scale, y2 * scale);
         }
       }
       ctx.stroke();
    }

    if (showPipeLengthOverlay && pipeLengthCandidates.length > 0) {
      ctx.globalAlpha = 1.0;
      pipeLengthCandidates.forEach(candidate => {
        const tx = candidate.center.x * scale;
        const ty = candidate.center.y * scale;

        ctx.save();
        if (candidate.vector) {
          const [t, x1, y1, x2, y2] = candidate.vector;
          const sx1 = x1 * scale;
          const sy1 = y1 * scale;
          const sx2 = x2 * scale;
          const sy2 = y2 * scale;
          ctx.lineCap = 'round';
          ctx.lineWidth = 4;
          ctx.strokeStyle = 'rgba(14, 165, 233, 0.88)';
          ctx.beginPath();
          ctx.moveTo(sx1, sy1);
          ctx.lineTo(sx2, sy2);
          ctx.stroke();
        } else if (candidate.region) {
          const rx = candidate.region.minX * scale;
          const ry = candidate.region.minY * scale;
          const rw = (candidate.region.maxX - candidate.region.minX) * scale;
          const rh = (candidate.region.maxY - candidate.region.minY) * scale;
          ctx.lineWidth = 2;
          const isLowConfidence = candidate.confidence === 'low';
          ctx.strokeStyle = isLowConfidence ? 'rgba(148, 163, 184, 0.78)' : 'rgba(14, 165, 233, 0.95)';
          ctx.fillStyle = isLowConfidence ? 'rgba(148, 163, 184, 0.10)' : 'rgba(14, 165, 233, 0.12)';
          ctx.beginPath();
          ctx.roundRect(rx - 3, ry - 3, rw + 6, rh + 6, 4);
          ctx.fill();
          ctx.stroke();
        }

        ctx.lineWidth = 1.5;
        const isLowConfidenceLabel = candidate.confidence === 'low';
        ctx.strokeStyle = isLowConfidenceLabel ? 'rgba(100, 116, 139, 0.75)' : 'rgba(2, 132, 199, 0.95)';
        ctx.fillStyle = 'rgba(240, 249, 255, 0.94)';
        const label = candidate.source === 'pipe'
          ? `L${candidate.text}`
          : candidate.source === 'vector'
          ? `L${candidate.text}`
          : candidate.source === 'ocr'
            ? `L${candidate.text} OCR`
            : `N${candidate.text}`;
        ctx.font = '12px sans-serif';
        const textWidth = ctx.measureText(label).width;
        const labelX = tx + 6;
        const labelY = ty - 18;
        ctx.beginPath();
        ctx.roundRect(labelX, labelY, textWidth + 10, 18, 4);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = isLowConfidenceLabel ? 'rgba(71, 85, 105, 1)' : 'rgba(3, 105, 161, 1)';
        ctx.fillText(label, labelX + 5, labelY + 13);
        ctx.restore();
        drawCount++;
      });
    }

    if (showFittingDebug && elbowCandidates.length > 0) {
      ctx.globalAlpha = 1.0;
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(0, 188, 212, 0.95)';
      ctx.fillStyle = 'rgba(0, 188, 212, 0.18)';

      elbowCandidates.forEach((candidate, index) => {
        const x = candidate.center.x * scale;
        const y = candidate.center.y * scale;
        // Display marker only. Fitting detection/judgement radii are intentionally
        // kept in the detector and are not affected by this larger visual radius.
        const radius = Math.max(8, Math.min(18, 10 + candidate.score * 6));
        const isSelected = candidate.id === selectedElbowId;
        const fittingType = getFittingType(candidate);
        const isTee = fittingType === 'tee-fitting';
        const isValve = fittingType === 'valve-fitting';
        const hasMaterialBinding = Array.isArray(candidate.materialBindings) && candidate.materialBindings.length > 0;
        const materialStatus = fittingMaterialStatusByType[getFittingMaterialGroup(candidate)]?.status;
        const needsManualMaterial = !hasMaterialBinding && materialStatus !== 'matched';
        const strokeColor = needsManualMaterial
          ? 'rgba(17, 24, 39, 1)'
          : (isValve ? 'rgba(196, 29, 127, 0.95)' : isTee ? 'rgba(114, 46, 209, 0.95)' : 'rgba(0, 188, 212, 0.95)');
        const fillColor = needsManualMaterial
          ? 'rgba(255, 235, 0, 0.72)'
          : (isValve ? 'rgba(196, 29, 127, 0.14)' : isTee ? 'rgba(114, 46, 209, 0.16)' : 'rgba(0, 188, 212, 0.18)');
        const textColor = needsManualMaterial
          ? 'rgba(17, 24, 39, 1)'
          : (isValve ? 'rgba(158, 16, 104, 0.95)' : isTee ? 'rgba(83, 29, 171, 0.95)' : 'rgba(0, 124, 145, 0.95)');

        ctx.lineWidth = needsManualMaterial || isSelected ? 3 : 2;
        ctx.setLineDash(needsManualMaterial ? [5, 3] : []);
        ctx.beginPath();
        if (isTee) {
          ctx.moveTo(x, y - radius);
          ctx.lineTo(x + radius, y);
          ctx.lineTo(x, y + radius);
          ctx.lineTo(x - radius, y);
          ctx.closePath();
        } else if (isValve) {
          ctx.moveTo(x - radius, y - radius * 0.55);
          ctx.lineTo(x + radius, y - radius * 0.55);
          ctx.lineTo(x + radius * 0.55, y);
          ctx.lineTo(x + radius, y + radius * 0.55);
          ctx.lineTo(x - radius, y + radius * 0.55);
          ctx.lineTo(x - radius * 0.55, y);
          ctx.closePath();
        } else {
          ctx.arc(x, y, radius, 0, Math.PI * 2);
        }
        ctx.strokeStyle = needsManualMaterial
          ? strokeColor
          : (isSelected ? 'rgba(255, 77, 79, 1)' : strokeColor);
        ctx.fillStyle = needsManualMaterial
          ? fillColor
          : (isSelected ? 'rgba(255, 77, 79, 0.22)' : fillColor);
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);

        if (needsManualMaterial) {
          ctx.save();
          ctx.fillStyle = textColor;
          ctx.font = `bold ${Math.max(13, Math.round(radius * 1.05))}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('!', x, y + 1);
          ctx.restore();
        }
        if (isSelected) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(x, y, radius + 4, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255, 77, 79, 1)';
          ctx.lineWidth = 2;
          ctx.setLineDash([]);
          ctx.stroke();
          ctx.restore();
        }

        if (index < 80) {
          ctx.fillStyle = textColor;
          ctx.font = 'bold 12px sans-serif';
          const nominalAngle = Number(candidate?.nominalAngle || candidate?.elbowAngle);
          const fittingLabel = isValve
            ? 'V'
            : isTee
              ? 'T'
              : (Number.isFinite(nominalAngle) ? `E${nominalAngle}` : 'E');
          ctx.fillText(fittingLabel, x + radius + 2, y - radius - 2);
          ctx.fillStyle = fillColor;
        }
      });
    }

    const endTime = performance.now();
    
    setRenderStats({
      count: drawCount,
      time: Math.round(endTime - startTime),
      weldCount: displayedWeldCount || 0,           // 过滤后显示的焊点数
      totalWeldCount: totalWeldCount || 0,          // 过滤前的总焊点数
      filteredWeldCount: filteredWeldCount || 0,
      textFilterApplied: !!textFilterApplied,    // 被过滤掉的焊点数
      highlightedPathCount: highlightedPathIds.size, // 高亮路径数
      elbowCount: elbowCandidates.length,
      pipeLengthCount: pipeLengthCandidates.length
    });

  }, [vectors, scale, visible, showWeldDebug, showFittingDebug, showPipeLengthOverlay, hoveredIndex, selectedIndices, weldIndices, recognizer, textFilterApplied, elbowCandidates, selectedElbowId, fittingMaterialStatusByType, fittingCandidateCountByType, pipeLengthCandidates, vectorRefreshVersion]); // 添加交互状态依赖

  // 只要矢量调试或焊点识别任一启用，就渲染组件
  const hasVectors = Array.isArray(vectors) && vectors.length > 0;
  const shouldRender = ((visible || showWeldDebug || showFittingDebug) && hasVectors) || (showPipeLengthDebug && pipeLengthCandidates.length > 0);
  
  if (!shouldRender) {
    if (showWeldDebug && (!vectors || vectors.length === 0)) {
      console.warn('⚠️ 焊点识别已启用，但没有矢量数据！请确保PDF已加载完成。');
    }
    return null;
  }

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', zIndex: 999, pointerEvents: 'none' }}>
      <canvas 
        ref={canvasRef}
        style={{ position: 'absolute', top: 0, left: 0, pointerEvents: (visible || addingElbow) ? 'auto' : 'none' }}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={handleClick}
        onMouseMove={handleMouseMove}
      />

      {showFittingDebug && elbowCandidates.map(candidate => {
        const hitSize = 28;
        return (
          <div
            key={`elbow-hit-${candidate.id}`}
            title="拖动调整管件位置"
            style={{
              position: 'absolute',
              left: candidate.center.x * scale - hitSize / 2,
              top: candidate.center.y * scale - hitSize / 2,
              width: hitSize,
              height: hitSize,
              borderRadius: '50%',
              cursor: 'grab',
              pointerEvents: 'auto',
              zIndex: 2
            }}
            onMouseDown={(e) => beginElbowDrag(e, candidate)}
            onClick={(e) => {
              e.stopPropagation();
              setSelectedElbowId(candidate.id);
              setAddingElbow(false);
            }}
          />
        );
      })}

      {showFittingDebug && (
        <div style={{
          position: 'absolute',
          bottom: '10px',
          left: '10px',
          zIndex: 3,
          pointerEvents: 'auto',
          padding: '10px 12px',
          background: 'rgba(255, 255, 255, 0.96)',
          border: '1px solid #d9d9d9',
          borderRadius: '8px',
          boxShadow: '0 6px 18px rgba(0, 0, 0, 0.16)'
        }}>
          <Space size={8} wrap>
            <Select
              size="middle"
              value={addingFittingType}
              style={{ width: 92 }}
              disabled={addingElbow}
              onChange={setAddingFittingType}
              options={[
                { value: 'elbow', label: '弯头' },
                { value: 'tee-fitting', label: '三通' },
                { value: 'valve-fitting', label: '阀门' }
              ]}
            />
            <Tooltip title={addingElbow ? '点击图纸放置管件' : '手动添加管件'}>
              <Button
                size="middle"
                type={addingElbow ? 'primary' : 'default'}
                icon={<PlusOutlined />}
                onClick={() => setAddingElbow(prev => !prev)}
              >
                添加
              </Button>
            </Tooltip>
            <Tooltip title="删除选中的管件">
              <Button
                size="middle"
                danger
                disabled={!selectedElbowId}
                icon={<DeleteOutlined />}
                onClick={handleDeleteSelectedElbow}
              >
                删除
              </Button>
            </Tooltip>
            <Tooltip title="绑定材料">
              <Button
                size="middle"
                disabled={!selectedElbowId}
                icon={<LinkOutlined />}
                onClick={() => {
                  const optionValues = new Set(materialOptions.map(option => option.value));
                  const currentKeys = (selectedElbow?.materialBindings || [])
                    .slice(0, 1)
                    .map(item => {
                      if (item?.key && optionValues.has(item.key)) return item.key;
                      const signature = getFittingMaterialSignature(item);
                      return materialOptions.find(option => getFittingMaterialSignature(option.row) === signature)?.value;
                    })
                    .filter(Boolean);
                  setSelectedMaterialKeys(currentKeys);
                  setMaterialModalVisible(true);
                }}
              >
                材料
              </Button>
            </Tooltip>
            <Tooltip title="按最近焊口自动绑定材料">
              <Button
                size="middle"
                type="primary"
                disabled={!onAutoBindFittingMaterials}
                icon={<LinkOutlined />}
                onClick={handleAutoBindFittingMaterials}
              >
              自动绑定
            </Button>
          </Tooltip>
          </Space>
          <div style={{
            marginTop: 8,
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 8,
            fontSize: 12,
            color: '#334155'
          }}>
            {fittingCountDisplayRows.map(([label, item]) => {
              const hasMaterialCount = Number.isFinite(item.materialCount);
              const diffText = hasMaterialCount ? `${item.diff > 0 ? '+' : ''}${item.diff}` : '-';
              return (
                <div key={label} style={{ padding: '5px 7px', border: '1px solid #eef2f7', borderRadius: 6, background: '#fafafa' }}>
                  <strong>{label}</strong>
                  <span style={{ marginLeft: 6 }}>识别 {item.detectedCount}</span>
                  <span style={{ marginLeft: 6 }}>材料 {hasMaterialCount ? item.materialCount : '-'}</span>
                  <span style={{ marginLeft: 6, color: getFittingCountDiffColor(item.diff), fontWeight: 600 }}>
                    差值 {diffText}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <Modal
        title="绑定管件材料"
        open={materialModalVisible}
        onCancel={() => setMaterialModalVisible(false)}
        onOk={() => {
          const bindings = selectedMaterialKeys.slice(0, 1)
            .map(key => materialOptions.find(option => option.value === key)?.row)
            .filter(Boolean)
            .map(row => ({ ...row }));
          executeElbowCommand(
            `绑定${getFittingTypeLabel(getFittingType(selectedElbow))}材料`,
            prev => updateElbowEditState(prev, selectedElbowId, { materialBindings: bindings })
          );
          setMaterialModalVisible(false);
          message.success(bindings.length > 0 ? '已绑定 1 项材料' : '已清空材料绑定');
        }}
        okText="保存"
        cancelText="取消"
      >
        <Select
          allowClear
          showSearch
          style={{ width: '100%' }}
          placeholder={materialOptions.length > 0 ? '选择材料表行' : '请先识别材料表'}
          options={materialOptions}
          value={selectedMaterialKeys[0]}
          onChange={(value) => setSelectedMaterialKeys(value ? [value] : [])}
          optionFilterProp="searchText"
        />
      </Modal>
      
      {/* Path 类型信息面板 */}
      {showWeldDebug && <PathTypeInfoPanel pathTypeInfo={selectedPathTypeInfo} visible={!!selectedPathTypeInfo} />}
      
      {/* 点击后直接可视化 Path ID */}
      {selectedPathId !== null && selectedPathId !== undefined && pathIdLabelPosition && (
        <div style={{
          position: 'absolute',
          left: `${pathIdLabelPosition.x + 10}px`,
          top: `${pathIdLabelPosition.y - 28}px`,
          background: 'rgba(24, 144, 255, 0.92)',
          color: '#fff',
          padding: '4px 8px',
          borderRadius: '4px',
          fontSize: '12px',
          fontFamily: 'monospace',
          fontWeight: 'bold',
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
          boxShadow: '0 2px 6px rgba(0, 0, 0, 0.25)'
        }}>
          Path ID: {String(selectedPathId)}
        </div>
      )}
      
      {/* 显示统计信息 */}
      {(visible || showWeldDebug || showPipeLengthOverlay) && (
        <div style={{
          position: 'absolute',
          top: '10px',
          left: '10px',
          background: 'rgba(0, 0, 0, 0.7)',
          color: 'white',
          padding: '8px 12px',
          borderRadius: '4px',
          fontSize: '12px',
          fontFamily: 'monospace',
          pointerEvents: 'none',
          lineHeight: '1.6'
        }}>
          {visible && <div>矢量元素: {vectors.length} (绘制: {renderStats.count})</div>}
          {showWeldDebug && (
            <div>
              🔥 焊点: <span style={{color: '#FFA500', fontWeight: 'bold'}}>{renderStats.weldCount}</span>
              {renderStats.textFilterApplied ? (
                <span style={{marginLeft: '8px', color: '#888', fontSize: '12px'}}>
                  (总数 {renderStats.totalWeldCount}, 文字过滤 {renderStats.filteredWeldCount})
                </span>
              ) : renderStats.totalWeldCount > 0 ? (
                <span style={{marginLeft: '8px', color: '#888', fontSize: '12px'}}>
                  (无文字过滤)
                </span>
              ) : null}
            </div>
          )}
          {renderStats.highlightedPathCount > 0 && (
            <div>
              🎯 高亮路径: <span style={{color: '#9333ea', fontWeight: 'bold'}}>{renderStats.highlightedPathCount}</span>
            </div>
          )}
          {showPipeLengthOverlay && (
            <div>
              管段候选: <span style={{color: '#0ea5e9', fontWeight: 'bold'}}>{renderStats.pipeLengthCount}</span>
              {renderStats.pipeLengthCount === 0 && (
                <span style={{marginLeft: '8px', color: '#94a3b8', fontSize: '12px'}}>
                  (未匹配到长度数字与管段)
                </span>
              )}
            </div>
          )}
          {showFittingDebug && (
            <>
              <div>
                管件候选: <span style={{color: '#00bcd4', fontWeight: 'bold'}}>{renderStats.elbowCount}</span>
              </div>
              <div style={{color: materialScope === 'page' ? '#73d13d' : '#94a3b8'}}>
                材料范围: {materialScope === 'page' ? `当前页（第 ${pageNumber} 页）` : '同管线汇总'}
              </div>
              {fittingCountDisplayRows.map(([label, item]) => {
                const hasMaterialCount = Number.isFinite(item.materialCount);
                const diffText = hasMaterialCount ? `${item.diff > 0 ? '+' : ''}${item.diff}` : '-';
                return (
                  <div key={label}>
                    {label}: 识别 <span style={{fontWeight: 'bold'}}>{item.detectedCount}</span>
                    {' / '}材料 <span style={{fontWeight: 'bold'}}>{hasMaterialCount ? item.materialCount : '-'}</span>
                    {' / '}差值 <span style={{color: getFittingCountDiffColor(item.diff), fontWeight: 'bold'}}>{diffText}</span>
                  </div>
                );
              })}
            </>
          )}
          {visible && <div>选中元素: {selectedIndices.size}</div>}
          {visible && selectedPathId !== null && selectedPathId !== undefined && (
            <div>当前 Path ID: {String(selectedPathId)}</div>
          )}
          <div>渲染耗时: {renderStats.time}ms</div>
        </div>
      )}
    </div>
  );
});


