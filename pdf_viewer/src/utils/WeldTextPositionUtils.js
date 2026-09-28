/**
 * 焊点与文字区域位置关系判断工具
 * 用于判断焊点是否在文字识别的检测框内
 */

/**
 * 判断焊点是否在文字检测框内
 * @param {Object} weld - 焊点对象，包含 center 和 boundingBox
 * @param {Object} textDetection - 文字检测框对象，包含 box 坐标
 * @param {Object} pageSize - 页面尺寸 {width, height}（用于坐标转换）
 * @param {string} checkMode - 检查模式：'center'(仅中心点) | 'bbox'(仅包围盒) | 'both'(两者都检查，默认)
 * @returns {Object} - 判断结果 {isInside: boolean, mode: string, details: {...}}
 */
export function isWeldInTextRegion(weld, textDetection, pageSize = null, checkMode = 'both') {
  // 转换文字检测框坐标为矩形区域
  const textRegion = convertTextDetectionToRegion(textDetection, pageSize);
  
  const result = {
    isInside: false,
    mode: checkMode,
    details: {
      centerInside: false,
      bboxOverlapping: false,
      overlapArea: 0,
      overlapRatio: 0
    }
  };
  
  // 如果无法转换坐标（页面尺寸不完整），返回默认结果（不在文字区域内）
  if (!textRegion) {
    return result;
  }
  
  // 检查中心点
  if (checkMode === 'center' || checkMode === 'both' || checkMode === 'any') {
    result.details.centerInside = isPointInRegion(weld.center, textRegion);
  }
  
  // 检查包围盒重叠
  if (checkMode === 'bbox' || checkMode === 'both' || checkMode === 'any') {
    const overlapInfo = calculateBboxOverlap(weld.boundingBox, textRegion);
    result.details.bboxOverlapping = overlapInfo.isOverlapping;
    result.details.overlapArea = overlapInfo.overlapArea;
    result.details.overlapRatio = overlapInfo.overlapRatio;
  }
  
  // 综合判断
  switch (checkMode) {
    case 'center':
      result.isInside = result.details.centerInside;
      break;
    case 'bbox':
      result.isInside = result.details.bboxOverlapping;
      break;
    case 'any':
      result.isInside = result.details.centerInside || result.details.bboxOverlapping;
      break;
    case 'both':
    default:
      result.isInside = result.details.centerInside && result.details.bboxOverlapping;
      break;
  }
  
  return result;
}

/**
 * 批量判断多个焊点与多个文字区域的关系
 * @param {Array} welds - 焊点数组
 * @param {Array} textDetections - 文字检测框数组
 * @param {Object} pageSize - 页面尺寸
 * @param {string} checkMode - 检查模式
 * @returns {Array} - 判断结果数组，每个焊点对应一个结果对象
 */
export function batchCheckWeldsInTextRegions(welds, textDetections, pageSize = null, checkMode = 'both') {
  if (!welds || welds.length === 0) {
    return [];
  }
  
  if (!textDetections || textDetections.length === 0) {
    // 没有文字区域，所有焊点都不在文字区域内
    return welds.map(weld => ({
      weld: weld,
      isInTextRegion: false,
      matchedTextRegions: [],
      checkMode: checkMode
    }));
  }
  
  const results = [];
  
  welds.forEach((weld, weldIndex) => {
    const matchedRegions = [];
    let isInTextRegion = false;
    
    textDetections.forEach((textDetection, textIndex) => {
      // 文字框检测接口可能只返回 box，不返回 text；只要有有效 box，就作为焊点屏蔽区。
      if (!textDetection?.box || !Array.isArray(textDetection.box) || textDetection.box.length < 4) return;

      const checkResult = isWeldInTextRegion(weld, textDetection, pageSize, checkMode);
      
      if (checkResult.isInside) {
        isInTextRegion = true;

        // 🔍 调试特定焊点被过滤的原因
        if ([8310, 8518, 8546, '8310', '8518', '8546'].includes(weld.pathId)) {
             const area = checkResult.details.overlapArea;
             const ratio = checkResult.details.overlapRatio;
             const textReg = convertTextDetectionToRegion(textDetection, pageSize);
             console.warn(`🚨 焊点 ${weld.pathId} 过滤详情: 重叠面积=${area?.toFixed(4)}px², 重叠比例=${(ratio*100)?.toFixed(4)}%`);
             console.warn(`🚨 焊点 ${weld.pathId} bbox: minX=${weld.boundingBox?.minX?.toFixed(2)}, minY=${weld.boundingBox?.minY?.toFixed(2)}, maxX=${weld.boundingBox?.maxX?.toFixed(2)}, maxY=${weld.boundingBox?.maxY?.toFixed(2)}`);
             console.warn(`🚨 覆盖的文字框: text="${textDetection.text}", minX=${textReg?.minX?.toFixed(2)}, minY=${textReg?.minY?.toFixed(2)}, maxX=${textReg?.maxX?.toFixed(2)}, maxY=${textReg?.maxY?.toFixed(2)}`);
        }

        matchedRegions.push({
          textIndex: textIndex,
          text: textDetection.text || '',
          checkResult: checkResult
        });
      }
    });
    
    results.push({
      weldIndex: weldIndex,
      weld: weld,
      isInTextRegion: isInTextRegion,
      matchedTextRegions: matchedRegions,
      checkMode: checkMode
    });
  });
  
  return results;
}

/**
 * 过滤出在文字区域内的焊点
 * @param {Array} welds - 焊点数组
 * @param {Array} textDetections - 文字检测框数组
 * @param {Object} pageSize - 页面尺寸
 * @param {string} checkMode - 检查模式
 * @returns {Array} - 在文字区域内的焊点数组
 */
export function filterWeldsInTextRegions(welds, textDetections, pageSize = null, checkMode = 'both') {
  const results = batchCheckWeldsInTextRegions(welds, textDetections, pageSize, checkMode);
  return results.filter(result => result.isInTextRegion);
}

/**
 * 过滤出不在文字区域内的焊点
 * @param {Array} welds - 焊点数组
 * @param {Array} textDetections - 文字检测框数组
 * @param {Object} pageSize - 页面尺寸
 * @param {string} checkMode - 检查模式
 * @returns {Array} - 不在文字区域内的焊点数组
 */
export function filterWeldsOutsideTextRegions(welds, textDetections, pageSize = null, checkMode = 'both') {
  const results = batchCheckWeldsInTextRegions(welds, textDetections, pageSize, checkMode);
  return results.filter(result => !result.isInTextRegion);
}

/**
 * 将文字检测框转换为矩形区域格式
 * @param {Object} textDetection - 文字检测框，包含 box 坐标
 * @param {Object} pageSize - 页面尺寸 {width, height}（用于相对坐标转换）
 * @returns {Object} - 矩形区域 {minX, minY, maxX, maxY, text}
 */
export function convertTextDetectionToRegion(textDetection, pageSize = null) {
  const box = textDetection.box || [[0,0], [0,0], [0,0], [0,0]];

  // 判断坐标是否为相对坐标（0~1）还是绝对坐标
  const allCoords = box.flat();
  const maxCoord = Math.max(...allCoords);
  const isRelative = maxCoord <= 1.1;

  // 如果是相对坐标且提供了页面尺寸，转换为绝对坐标
  let coordinates = box;
  
  // 兼容两种pageSize格式：
  // 1. {width, height}
  // 2. {page_width, page_height} (从page_info来的)
  const pageWidth = pageSize?.width || pageSize?.page_width;
  const pageHeight = pageSize?.height || pageSize?.page_height;
  
  if (isRelative && pageWidth && pageHeight) {
    // 相对坐标，转换为绝对坐标
    coordinates = box.map(point => [
      point[0] * pageWidth,
      point[1] * pageHeight
    ]);
    
    // 调试日志（可选）
    if (window.__weldTextDebug__ && box.length > 0) {
      const firstPoint = box[0];
      console.log(`📐 坐标转换: [${firstPoint[0].toFixed(4)}, ${firstPoint[1].toFixed(4)}] → [${(firstPoint[0] * pageWidth).toFixed(2)}, ${(firstPoint[1] * pageHeight).toFixed(2)}]`);
    }
  } else if (isRelative && (!pageWidth || !pageHeight)) {
    // 🔧 页面尺寸不完整时，只输出一次警告，并返回 null 表示无法转换
    if (!window.__weldTextSizeWarningShown__) {
      console.warn('⚠️ 检测到相对坐标，但页面尺寸信息不完整！文字区域过滤可能不生效。');
      console.warn('   pageSize:', pageSize);
      console.warn('   需要的格式: {width, height} 或 {page_width, page_height}');
      console.warn('   💡 提示：请确保文字识别返回了正确的页面尺寸，或从 PDF 页面获取尺寸');
      window.__weldTextSizeWarningShown__ = true;
    }
    // 返回 null 表示无法转换，让调用方跳过该检测框
    return null;
  }
  
  const xCoords = coordinates.map(point => point[0]);
  const yCoords = coordinates.map(point => point[1]);
  
  const minX = Math.min(...xCoords);
  const maxX = Math.max(...xCoords);
  const minY = Math.min(...yCoords);
  const maxY = Math.max(...yCoords);
  
  return {
    minX,
    minY,
    maxX,
    maxY,
    text: textDetection.text || '',
    _isConverted: isRelative && !!(pageWidth && pageHeight), // 标记是否进行了转换
    _originalBox: box // 保留原始坐标用于调试
  };
}

/**
 * 检查点是否在区域内
 * @param {Object} point - 点坐标 {x, y}
 * @param {Object} region - 区域 {minX, minY, maxX, maxY}
 * @returns {boolean} - 是否在区域内
 */
export function isPointInRegion(point, region) {
  return point.x >= region.minX && 
         point.x <= region.maxX &&
         point.y >= region.minY && 
         point.y <= region.maxY;
}

/**
 * 计算两个包围盒的重叠情况
 * @param {Object} bbox1 - 包围盒1 {minX, minY, maxX, maxY}
 * @param {Object} bbox2 - 包围盒2 {minX, minY, maxX, maxY}
 * @returns {Object} - 重叠信息 {isOverlapping, overlapArea, overlapRatio}
 */
export function calculateBboxOverlap(bbox1, bbox2) {
  // 计算重叠区域
  const overlapMinX = Math.max(bbox1.minX, bbox2.minX);
  const overlapMaxX = Math.min(bbox1.maxX, bbox2.maxX);
  const overlapMinY = Math.max(bbox1.minY, bbox2.minY);
  const overlapMaxY = Math.min(bbox1.maxY, bbox2.maxY);
  
  // 计算重叠面积
  const overlapWidth = Math.max(0, overlapMaxX - overlapMinX);
  const overlapHeight = Math.max(0, overlapMaxY - overlapMinY);
  const overlapArea = overlapWidth * overlapHeight;
  
  // 计算bbox1的面积
  const bbox1Area = (bbox1.maxX - bbox1.minX) * (bbox1.maxY - bbox1.minY);
  
  // 计算重叠比例（相对于bbox1）
  const overlapRatio = bbox1Area > 0 ? overlapArea / bbox1Area : 0;
  
  const MIN_OVERLAP_RATIO = 0.95;
  
  // 仅使用比例判断，确保小面积但高重叠的情况被正确处理，同时避免大面积低重叠的误判
  const isSignificantOverlap = overlapRatio > MIN_OVERLAP_RATIO;
  
  return {
    isOverlapping: isSignificantOverlap,
    overlapArea: overlapArea,
    overlapRatio: overlapRatio, // 重叠面积占焊点面积的比例
    overlapBounds: overlapArea > 0 ? {
      minX: overlapMinX,
      minY: overlapMinY,
      maxX: overlapMaxX,
      maxY: overlapMaxY
    } : null
  };
}

/**
 * 计算焊点中心与文字区域中心的距离
 * @param {Object} weld - 焊点对象
 * @param {Object} textDetection - 文字检测框
 * @param {Object} pageSize - 页面尺寸
 * @returns {number} - 距离
 */
export function calculateWeldTextDistance(weld, textDetection, pageSize = null) {
  const textRegion = convertTextDetectionToRegion(textDetection, pageSize);
  if (!textRegion) {
    return Infinity;
  }
  
  const textCenterX = (textRegion.minX + textRegion.maxX) / 2;
  const textCenterY = (textRegion.minY + textRegion.maxY) / 2;
  
  const dx = weld.center.x - textCenterX;
  const dy = weld.center.y - textCenterY;
  
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * 为每个焊点找到最近的文字区域
 * @param {Array} welds - 焊点数组
 * @param {Array} textDetections - 文字检测框数组
 * @param {Object} pageSize - 页面尺寸
 * @returns {Array} - 结果数组，每个焊点对应最近的文字区域
 */
export function findNearestTextForWelds(welds, textDetections, pageSize = null) {
  if (!welds || welds.length === 0 || !textDetections || textDetections.length === 0) {
    return [];
  }
  
  return welds.map((weld, weldIndex) => {
    let minDistance = Infinity;
    let nearestText = null;
    let nearestTextIndex = -1;
    
    textDetections.forEach((textDetection, textIndex) => {
      const distance = calculateWeldTextDistance(weld, textDetection, pageSize);
      
      if (distance < minDistance) {
        minDistance = distance;
        nearestText = textDetection;
        nearestTextIndex = textIndex;
      }
    });
    
    return {
      weldIndex: weldIndex,
      weld: weld,
      nearestTextIndex: nearestTextIndex,
      nearestText: nearestText,
      distance: minDistance
    };
  });
}

/**
 * 生成焊点与文字区域关系的统计报告
 * @param {Array} welds - 焊点数组
 * @param {Array} textDetections - 文字检测框数组
 * @param {Object} pageSize - 页面尺寸
 * @param {string} checkMode - 检查模式
 * @returns {Object} - 统计报告
 */
export function generateWeldTextRelationReport(welds, textDetections, pageSize = null, checkMode = 'both') {
  const results = batchCheckWeldsInTextRegions(welds, textDetections, pageSize, checkMode);
  
  const weldsInText = results.filter(r => r.isInTextRegion);
  const weldsOutsideText = results.filter(r => !r.isInTextRegion);
  
  // 统计每个文字区域匹配的焊点数量
  const textRegionStats = textDetections.map((text, index) => {
    const matchingWelds = weldsInText.filter(r => 
      r.matchedTextRegions.some(m => m.textIndex === index)
    );
    
    return {
      textIndex: index,
      text: text.text || '',
      matchingWeldCount: matchingWelds.length,
      matchingWelds: matchingWelds.map(w => w.weldIndex)
    };
  });
  
  return {
    totalWelds: welds.length,
    totalTextRegions: textDetections.length,
    weldsInTextRegion: weldsInText.length,
    weldsOutsideTextRegion: weldsOutsideText.length,
    inTextRatio: welds.length > 0 ? weldsInText.length / welds.length : 0,
    checkMode: checkMode,
    textRegionStats: textRegionStats,
    weldsInTextDetails: weldsInText,
    weldsOutsideTextDetails: weldsOutsideText
  };
}

