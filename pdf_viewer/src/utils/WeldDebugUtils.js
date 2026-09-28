/**
 * 焊点识别调试工具
 * 用于对比Python项目和前端实现的数据差异
 */

/**
 * 导出路径数据用于对比
 * @param {Array} paths - 前端提取的路径数据
 * @returns {Object} - 可导出的JSON数据
 */
export function exportPathsForComparison(paths) {
  const exportData = {
    timestamp: new Date().toISOString(),
    totalPaths: paths.length,
    paths: []
  };

  paths.forEach((path, index) => {
    const bbox = calculateBoundingBox(path);
    const firstPoint = path.segments[0]?.p1;
    const lastPoint = path.segments[path.segments.length - 1]?.p2;
    const closeDist = firstPoint && lastPoint ? 
      Math.sqrt(Math.pow(lastPoint.x - firstPoint.x, 2) + Math.pow(lastPoint.y - firstPoint.y, 2)) : 
      null;

    exportData.paths.push({
      index,
      pathId: path.id,
      segmentCount: path.segments.length,
      allLines: path.segments.every(seg => seg.type === 'line'),
      boundingBox: {
        width: bbox.maxX - bbox.minX,
        height: bbox.maxY - bbox.minY,
        minX: bbox.minX,
        minY: bbox.minY,
        maxX: bbox.maxX,
        maxY: bbox.maxY
      },
      aspectRatio: bbox.maxY - bbox.minY > 0 ? 
        (bbox.maxX - bbox.minX) / (bbox.maxY - bbox.minY) : 0,
      closeDistance: closeDist,
      isClosed: closeDist !== null && closeDist < 1.0,
      segments: path.segments.map(seg => ({
        type: seg.type,
        start: { x: seg.x1, y: seg.y1 },
        end: { x: seg.x2, y: seg.y2 }
      }))
    });
  });

  return exportData;
}

/**
 * 计算包围盒
 */
function calculateBoundingBox(path) {
  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;
  
  path.segments.forEach(seg => {
    minX = Math.min(minX, seg.x1, seg.x2);
    minY = Math.min(minY, seg.y1, seg.y2);
    maxX = Math.max(maxX, seg.x1, seg.x2);
    maxY = Math.max(maxY, seg.y1, seg.y2);
  });
  
  return { minX, minY, maxX, maxY };
}

/**
 * 生成详细的规则匹配报告
 * @param {Array} paths - 路径数据
 * @param {Array} enabledRules - 启用的规则
 * @returns {Object} - 规则匹配报告
 */
export function generateRuleMatchReport(paths, enabledRules) {
  const report = {
    timestamp: new Date().toISOString(),
    totalPaths: paths.length,
    enabledRules: enabledRules.map(r => r.name),
    matchedPaths: [],
    unmatchedPaths: [],
    statistics: {}
  };

  // 统计每种边数的路径
  const edgeCountStats = {};
  
  paths.forEach((path, index) => {
    const segmentCount = path.segments.length;
    edgeCountStats[segmentCount] = (edgeCountStats[segmentCount] || 0) + 1;

    let matched = false;
    let matchedRule = null;

    for (const rule of enabledRules) {
      try {
        if (rule.func(path)) {
          matched = true;
          matchedRule = rule.name;
          break;
        }
      } catch (error) {
        // 忽略错误
      }
    }

    const bbox = calculateBoundingBox(path);
    const pathInfo = {
      index,
      pathId: path.id,
      segmentCount,
      width: bbox.maxX - bbox.minX,
      height: bbox.maxY - bbox.minY,
      matchedRule: matchedRule
    };

    if (matched) {
      report.matchedPaths.push(pathInfo);
    } else {
      report.unmatchedPaths.push(pathInfo);
    }
  });

  report.statistics = {
    matchedCount: report.matchedPaths.length,
    unmatchedCount: report.unmatchedPaths.length,
    edgeCountDistribution: edgeCountStats
  };

  return report;
}

/**
 * 在控制台输出友好的调试信息
 * @param {Array} paths - 路径数据
 * @param {Array} detectedWelds - 检测到的焊点
 */
export function logDebugInfo(paths, detectedWelds) {
  console.group('🔍 焊点识别调试信息');
  
  console.log(`📊 总路径数: ${paths.length}`);
  console.log(`✅ 检测到焊点数: ${detectedWelds.length}`);
  
  // 统计边数分布
  const edgeStats = {};
  paths.forEach(path => {
    const count = path.segments.length;
    edgeStats[count] = (edgeStats[count] || 0) + 1;
  });
  
  console.log('📈 边数分布:');
  Object.keys(edgeStats).sort((a, b) => parseInt(b) - parseInt(a)).forEach(count => {
    if (edgeStats[count] > 10) { // 只显示数量>10的
      console.log(`  ${count}边形: ${edgeStats[count]}个`);
    }
  });
  
  // 显示尺寸范围
  if (detectedWelds.length > 0) {
    console.log('📏 检测到的焊点尺寸范围:');
    const widths = detectedWelds.map(w => w.boundingBox.maxX - w.boundingBox.minX);
    const heights = detectedWelds.map(w => w.boundingBox.maxY - w.boundingBox.minY);
    console.log(`  宽度: ${Math.min(...widths).toFixed(2)} ~ ${Math.max(...widths).toFixed(2)}`);
    console.log(`  高度: ${Math.min(...heights).toFixed(2)} ~ ${Math.max(...heights).toFixed(2)}`);
  }
  
  console.groupEnd();
}

/**
 * 下载路径数据为JSON文件（用于与Python项目对比）
 * @param {Object} data - 要导出的数据
 * @param {string} filename - 文件名
 */
export function downloadDebugData(data, filename = 'frontend_paths_debug.json') {
  const jsonStr = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  
  URL.revokeObjectURL(url);
  console.log(`✅ 调试数据已导出: ${filename}`);
}













