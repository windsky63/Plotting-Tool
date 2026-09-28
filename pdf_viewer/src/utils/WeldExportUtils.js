import { getVectorSegmentType } from './vectorTypeUtils';

/**
 * 焊点导出工具
 * 导出格式与Python项目保持一致
 */

/**
 * 直接导出选中的对象（不过滤焊点）
 * @param {Set} selectedIndices - 选中的向量索引集合
 * @param {Array} vectors - 所有向量数据
 * @returns {Object} - 选中对象的导出数据
 */
export function exportSelectedObjects(selectedIndices, vectors) {
  // 按 Path ID 分组选中的向量
  const pathGroups = new Map();
  
  selectedIndices.forEach(idx => {
    const vec = vectors[idx];
    if (!vec || vec.length < 8) return;
    
    const [type, x1, y1, x2, y2, color, width, pathId] = vec;
    
    if (!pathGroups.has(pathId)) {
      pathGroups.set(pathId, []);
    }
    
    pathGroups.get(pathId).push({
      vectorIndex: idx,
      type: getVectorSegmentType(type),
      start: { x: x1, y: y1 },
      end: { x: x2, y: y2 },
      color,
      width
    });
  });
  
  const exportData = {
    export_time: new Date().toISOString(),
    total_selected_vectors: selectedIndices.size,
    total_paths: pathGroups.size,
    selected_objects: []
  };
  
  // 为每个 path 计算中心点和边界框
  pathGroups.forEach((segments, pathId) => {
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    
    segments.forEach(seg => {
      minX = Math.min(minX, seg.start.x, seg.end.x);
      minY = Math.min(minY, seg.start.y, seg.end.y);
      maxX = Math.max(maxX, seg.start.x, seg.end.x);
      maxY = Math.max(maxY, seg.start.y, seg.end.y);
    });
    
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    
    exportData.selected_objects.push({
      path_id: pathId,
      segment_count: segments.length,
      center: {
        x: Math.round(centerX * 100) / 100,
        y: Math.round(centerY * 100) / 100
      },
      bounding_box: {
        minX: Math.round(minX * 100) / 100,
        minY: Math.round(minY * 100) / 100,
        maxX: Math.round(maxX * 100) / 100,
        maxY: Math.round(maxY * 100) / 100,
        width: Math.round((maxX - minX) * 100) / 100,
        height: Math.round((maxY - minY) * 100) / 100
      },
      segments: segments.map(seg => ({
        start: {
          x: Math.round(seg.start.x * 100) / 100,
          y: Math.round(seg.start.y * 100) / 100
        },
        end: {
          x: Math.round(seg.end.x * 100) / 100,
          y: Math.round(seg.end.y * 100) / 100
        },
        type: seg.type
      }))
    });
  });
  
  return exportData;
}

/**
 * 导出选中的焊点信息为JSON（仅导出被识别为焊点的对象）
 * @param {Set} selectedIndices - 选中的向量索引集合
 * @param {Array} vectors - 所有向量数据
 * @param {Array} detectedWelds - 检测到的焊点对象
 * @returns {Object} - 焊点导出数据
 */
export function exportSelectedWelds(selectedIndices, vectors, detectedWelds) {
  // 找出选中的焊点（通过检查选中的向量是否属于某个焊点）
  const selectedWeldObjects = detectedWelds.filter(weld => {
    // 如果焊点的任意一个向量被选中，则认为该焊点被选中
    return weld.vectorIndices.some(idx => selectedIndices.has(idx));
  });

  const exportData = {
    export_time: new Date().toISOString(),
    total_welds: selectedWeldObjects.length,
    welds: []
  };

  selectedWeldObjects.forEach((weld, index) => {
    // 获取焊点的所有线段
    const segments = weld.vectorIndices.map(idx => {
      const vec = vectors[idx];
      if (!vec || vec.length < 5) return null;
      
      const [type, x1, y1, x2, y2] = vec;
      return {
        start: { x: x1, y: y1 },
        end: { x: x2, y: y2 }
      };
    }).filter(seg => seg !== null);

    exportData.welds.push({
      id: index + 1,
      path_index: weld.pathId,
      rule_name: weld.ruleName,
      center: weld.center,
      segments: segments,
      bounding_box: weld.boundingBox,
      segment_count: segments.length
    });
  });

  return exportData;
}

/**
 * 导出所有检测到的焊点
 * @param {Array} vectors - 所有向量数据
 * @param {Array} detectedWelds - 检测到的焊点对象
 * @returns {Object} - 焊点导出数据
 */
export function exportAllWelds(vectors, detectedWelds) {
  const exportData = {
    export_time: new Date().toISOString(),
    total_welds: detectedWelds.length,
    welds: []
  };

  detectedWelds.forEach((weld, index) => {
    // 获取焊点的所有线段
    const segments = weld.vectorIndices.map(idx => {
      const vec = vectors[idx];
      if (!vec || vec.length < 5) return null;
      
      const [type, x1, y1, x2, y2] = vec;
      return {
        start: { x: x1, y: y1 },
        end: { x: x2, y: y2 }
      };
    }).filter(seg => seg !== null);

    exportData.welds.push({
      id: index + 1,
      path_index: weld.pathId,
      rule_name: weld.ruleName,
      center: weld.center,
      segments: segments,
      bounding_box: weld.boundingBox,
      segment_count: segments.length
    });
  });

  return exportData;
}

/**
 * 下载焊点数据为JSON文件
 * @param {Object} data - 焊点数据
 * @param {string} filename - 文件名
 */
export function downloadWeldsJSON(data, filename) {
  const jsonStr = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  
  URL.revokeObjectURL(url);
  
  console.log(`✅ 焊点数据已导出: ${filename}`);
  console.log(`📊 导出了 ${data.total_welds} 个焊点`);
}

/**
 * 生成文件名
 * @param {string} prefix - 前缀（'selected'或'all'）
 * @returns {string} - 文件名
 */
export function generateWeldFilename(prefix = 'welds') {
  const now = new Date();
  const dateStr = now.toISOString().replace(/[-:]/g, '').split('.')[0].replace('T', '_');
  return `${prefix}_welds_${dateStr}.json`;
}

