/**
 * WeldTextPositionUtils 使用示例
 * 展示如何判断焊点位置是否在文字识别检测框内
 */

import {
  isWeldInTextRegion,
  batchCheckWeldsInTextRegions,
  filterWeldsInTextRegions,
  filterWeldsOutsideTextRegions,
  generateWeldTextRelationReport,
  findNearestTextForWelds
} from './WeldTextPositionUtils';

// ============================================================
// 示例1：判断单个焊点是否在文字区域内
// ============================================================
function example1_singleWeldCheck() {
  // 焊点数据（从 recognizer.getDetectedWelds() 获取）
  const weld = {
    pathId: 123,
    center: { x: 100, y: 200 },
    boundingBox: {
      minX: 95,
      minY: 195,
      maxX: 105,
      maxY: 205
    },
    ruleName: "圆形焊点"
  };

  // 文字检测框数据（从 textDetections[currentPage].detections 获取）
  const textDetection = {
    text: "材料编号",
    score: 0.98,
    box: [[0.1, 0.2], [0.15, 0.2], [0.15, 0.25], [0.1, 0.25]], // 相对坐标
    confidence: 0.98
  };

  // 页面尺寸
  const pageSize = { width: 1000, height: 1400 };

  // 方式1：检查中心点和包围盒（默认）
  const result1 = isWeldInTextRegion(weld, textDetection, pageSize, 'both');
  console.log('检查结果:', result1);
  // {
  //   isInside: true/false,
  //   mode: 'both',
  //   details: {
  //     centerInside: true/false,
  //     bboxOverlapping: true/false,
  //     overlapArea: 50,
  //     overlapRatio: 0.5
  //   }
  // }

  // 方式2：仅检查中心点
  const result2 = isWeldInTextRegion(weld, textDetection, pageSize, 'center');
  
  // 方式3：仅检查包围盒重叠
  const result3 = isWeldInTextRegion(weld, textDetection, pageSize, 'bbox');
}

// ============================================================
// 示例2：批量检查所有焊点与所有文字区域的关系
// ============================================================
function example2_batchCheck(recognizer, textDetections, pageSize) {
  // 获取所有焊点
  const welds = recognizer.getDetectedWelds();
  
  // 获取当前页的文字检测结果
  const detections = textDetections.detections || [];
  
  // 批量检查
  const results = batchCheckWeldsInTextRegions(welds, detections, pageSize, 'both');
  
  console.log('批量检查结果:', results);
  // results 是一个数组，每个元素对应一个焊点：
  // [
  //   {
  //     weldIndex: 0,
  //     weld: {...},
  //     isInTextRegion: true,
  //     matchedTextRegions: [
  //       {
  //         textIndex: 2,
  //         text: "材料编号",
  //         checkResult: {...}
  //       }
  //     ],
  //     checkMode: 'both'
  //   },
  //   ...
  // ]
  
  // 统计有多少焊点在文字区域内
  const weldsInText = results.filter(r => r.isInTextRegion);
  console.log(`共 ${welds.length} 个焊点，其中 ${weldsInText.length} 个在文字区域内`);
  
  // 找出所有在文字区域内的焊点
  weldsInText.forEach(result => {
    console.log(`焊点 #${result.weldIndex} 在以下文字区域内:`);
    result.matchedTextRegions.forEach(match => {
      console.log(`  - 文字 #${match.textIndex}: "${match.text}"`);
      console.log(`    中心点在内: ${match.checkResult.details.centerInside}`);
      console.log(`    包围盒重叠: ${match.checkResult.details.bboxOverlapping}`);
      console.log(`    重叠面积: ${match.checkResult.details.overlapArea.toFixed(2)}`);
      console.log(`    重叠比例: ${(match.checkResult.details.overlapRatio * 100).toFixed(1)}%`);
    });
  });
}

// ============================================================
// 示例3：过滤焊点
// ============================================================
function example3_filterWelds(recognizer, textDetections, pageSize) {
  const welds = recognizer.getDetectedWelds();
  const detections = textDetections.detections || [];
  
  // 获取在文字区域内的焊点
  const weldsInText = filterWeldsInTextRegions(welds, detections, pageSize);
  console.log('在文字区域内的焊点:', weldsInText);
  
  // 获取在文字区域外的焊点（纯净的焊点）
  const weldsOutside = filterWeldsOutsideTextRegions(welds, detections, pageSize);
  console.log('在文字区域外的焊点:', weldsOutside);
  
  // 如果你想要的是纯净的焊点对象数组（而不是结果对象）
  const pureWelds = weldsOutside.map(result => result.weld);
  return pureWelds;
}

// ============================================================
// 示例4：生成统计报告
// ============================================================
function example4_generateReport(recognizer, textDetections, pageSize) {
  const welds = recognizer.getDetectedWelds();
  const detections = textDetections.detections || [];
  
  const report = generateWeldTextRelationReport(welds, detections, pageSize, 'both');
  
  console.log('================ 焊点与文字区域关系报告 ================');
  console.log(`总焊点数: ${report.totalWelds}`);
  console.log(`总文字区域数: ${report.totalTextRegions}`);
  console.log(`在文字区域内的焊点: ${report.weldsInTextRegion} (${(report.inTextRatio * 100).toFixed(1)}%)`);
  console.log(`在文字区域外的焊点: ${report.weldsOutsideTextRegion} (${((1 - report.inTextRatio) * 100).toFixed(1)}%)`);
  console.log(`检查模式: ${report.checkMode}`);
  
  console.log('\n每个文字区域匹配的焊点数量:');
  report.textRegionStats.forEach(stat => {
    if (stat.matchingWeldCount > 0) {
      console.log(`  文字区域 #${stat.textIndex} "${stat.text}": ${stat.matchingWeldCount} 个焊点`);
      console.log(`    焊点索引: [${stat.matchingWelds.join(', ')}]`);
    }
  });
  
  return report;
}

// ============================================================
// 示例5：找到每个焊点最近的文字区域
// ============================================================
function example5_findNearestText(recognizer, textDetections, pageSize) {
  const welds = recognizer.getDetectedWelds();
  const detections = textDetections.detections || [];
  
  const nearest = findNearestTextForWelds(welds, detections, pageSize);
  
  console.log('每个焊点最近的文字区域:');
  nearest.forEach(item => {
    console.log(`焊点 #${item.weldIndex} (${item.weld.ruleName}):`);
    console.log(`  最近的文字: "${item.nearestText?.text || 'N/A'}"`);
    console.log(`  距离: ${item.distance.toFixed(2)} 像素`);
  });
  
  return nearest;
}

// ============================================================
// 示例6：在实际应用中使用（React组件示例）
// ============================================================
export function useWeldTextAnalysis(recognizer, textDetections, pageSize) {
  // 在React组件中使用
  const analyzeWeldTextRelation = () => {
    if (!recognizer || !textDetections) {
      console.log('数据未准备好');
      return null;
    }
    
    const welds = recognizer.getDetectedWelds();
    const detections = textDetections.detections || [];
    
    // 1. 生成报告
    const report = generateWeldTextRelationReport(welds, detections, pageSize);
    
    // 2. 获取纯净的焊点（不在文字区域内）
    const pureWelds = filterWeldsOutsideTextRegions(welds, detections, pageSize)
      .map(result => result.weld);
    
    // 3. 获取在文字区域内的焊点（可能需要特殊标注）
    const contaminatedWelds = filterWeldsInTextRegions(welds, detections, pageSize);
    
    return {
      report,
      pureWelds,
      contaminatedWelds,
      pureWeldCount: pureWelds.length,
      contaminatedWeldCount: contaminatedWelds.length
    };
  };
  
  return { analyzeWeldTextRelation };
}

// ============================================================
// 示例7：导出分析结果
// ============================================================
export function exportWeldTextAnalysis(recognizer, textDetections, pageSize, pdfFileName = 'document') {
  const welds = recognizer.getDetectedWelds();
  const detections = textDetections.detections || [];
  
  const report = generateWeldTextRelationReport(welds, detections, pageSize);
  
  // 构建导出数据
  const exportData = {
    metadata: {
      pdfFileName: pdfFileName,
      exportTime: new Date().toISOString(),
      checkMode: report.checkMode
    },
    summary: {
      totalWelds: report.totalWelds,
      totalTextRegions: report.totalTextRegions,
      weldsInTextRegion: report.weldsInTextRegion,
      weldsOutsideTextRegion: report.weldsOutsideTextRegion,
      inTextRatio: report.inTextRatio
    },
    weldsInText: report.weldsInTextDetails.map(item => ({
      weldIndex: item.weldIndex,
      weldCenter: item.weld.center,
      weldBoundingBox: item.weld.boundingBox,
      ruleName: item.weld.ruleName,
      matchedTexts: item.matchedTextRegions.map(m => ({
        text: m.text,
        centerInside: m.checkResult.details.centerInside,
        bboxOverlapping: m.checkResult.details.bboxOverlapping,
        overlapRatio: m.checkResult.details.overlapRatio
      }))
    })),
    weldsOutsideText: report.weldsOutsideTextDetails.map(item => ({
      weldIndex: item.weldIndex,
      weldCenter: item.weld.center,
      weldBoundingBox: item.weld.boundingBox,
      ruleName: item.weld.ruleName
    }))
  };
  
  // 下载JSON文件
  const jsonString = JSON.stringify(exportData, null, 2);
  const blob = new Blob([jsonString], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement('a');
  link.href = url;
  link.download = `weld_text_analysis_${pdfFileName}_${Date.now()}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  
  console.log('分析结果已导出');
  return exportData;
}

