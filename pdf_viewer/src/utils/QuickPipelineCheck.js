/**
 * 快速管道检测工具 - 控制台调试
 * 使用方法：在控制台输入 window.checkPipelines()
 */

import { SimplePipelineDetector } from './SimplePipelineDetector';
import { groupVectorsIntoPathsStructured } from './WeldDetector';
import { filterPipelinesByWelds, calculatePipelineArea } from './PipelineNetworkUtils';

/**
 * 初始化全局管道检查函数
 */
export function initGlobalPipelineCheck() {
  // 快速检查管道（简化版：4线段+闭合）
  window.checkPipelines = function(useWeldFilter = true) {
    const vectors = window.__currentVectors__;
    const recognizer = window.__weldRecognizer__; // 获取焊点识别器
    
    if (!vectors || vectors.length === 0) {
      console.error('❌ 未找到矢量数据。请先加载PDF页面。');
      return;
    }

    console.log(`🔍 开始管道检查... (${vectors.length} 个矢量)`);
    console.log(`   判断逻辑: 4根线段 + 闭合路径 + 管径(1.0~2.0)`);
    
    const detector = new SimplePipelineDetector(vectors);
    const allPipelines = detector.detectPipelines();
    
    let resultPipelines = allPipelines;

    // 🔗 焊点过滤逻辑
    if (useWeldFilter) {
      // 优先获取经过筛选的纯净焊点 (displayedWelds)
      let welds = [];
      const visualizerRef = window.__firstPageVisualizerRef__;
      
      if (visualizerRef && visualizerRef.current && visualizerRef.current.getDisplayedWelds) {
        welds = visualizerRef.current.getDisplayedWelds();
        console.log(`   🔗 使用已过滤的纯净焊点 (数量: ${welds.length})`);
      } else if (recognizer) {
        // 后备方案：使用原始检测到的焊点
        welds = recognizer.getDetectedWelds();
        console.warn(`   ⚠️ 使用原始检测焊点 (未过滤OCR干扰, 数量: ${welds.length})`);
      }

      if (welds.length > 0) {
        resultPipelines = filterPipelinesByWelds(allPipelines, welds, 50); // 50px 阈值
        
        // 计算区域
        const area = calculatePipelineArea(resultPipelines, welds);
        if (area) {
          console.log(`   📐 管线区域(估算): [${area.minX.toFixed(0)}, ${area.minY.toFixed(0)}] - [${area.maxX.toFixed(0)}, ${area.maxY.toFixed(0)}]`);
        }
      } else {
        console.warn(`   ⚠️ 未找到有效焊点，跳过邻域过滤（保留所有候选管道）`);
      }
    }
    
    if (resultPipelines.length === 0) {
      console.log(`\n💡 提示: 没有识别到管道`);
      return [];
    }
    
    console.log(`\n🎯 最终识别管道: ${resultPipelines.length} (原始候选: ${allPipelines.length})`);
    
    // 保存到全局变量
    window.__detectedPipelines__ = resultPipelines;
    
    return resultPipelines;
  };

  // 分析 Path 统计
  window.analyzePaths = function() {
    const vectors = window.__currentVectors__;
    
    if (!vectors || vectors.length === 0) {
      console.error('❌ 未找到矢量数据');
      return;
    }

    console.log(`🔍 分析 Path 特征...`);
    
    const paths = groupVectorsIntoPathsStructured(vectors);
    console.log(`  总 Path 数: ${paths.length}`);
    
    // 按线段数量分组
    const segmentCountGroups = {};
    paths.forEach(path => {
      const count = path.segments.length;
      if (!segmentCountGroups[count]) {
        segmentCountGroups[count] = [];
      }
      segmentCountGroups[count].push(path);
    });
    
    console.log(`\n📊 按线段数量分组:`);
    Object.keys(segmentCountGroups)
      .sort((a, b) => parseInt(a) - parseInt(b))
      .forEach(count => {
        const group = segmentCountGroups[count];
        console.log(`  ${count} 条线段: ${group.length} 个 Path`);
      });
    
    // 保存到全局变量
    window.__pathsBySegmentCount__ = segmentCountGroups;
    
    console.log(`\n✅ 结果已保存到: window.__pathsBySegmentCount__`);
    
    return segmentCountGroups;
  };

  // 高亮显示管道
  window.highlightPipelines = function() {
    const pipelines = window.__detectedPipelines__;
    
    if (!pipelines) {
      console.error('❌ 请先运行 window.checkPipelines()');
      return;
    }
    
    const pathIds = pipelines.map(p => p.pathId);
    
    console.log(`🎨 高亮 ${pathIds.length} 个管道 Path...`);
    console.log(`Path IDs: ${pathIds.join(', ')}`);
    
    return pathIds;
  };

  console.log('✅ 管道检查工具已初始化');
  console.log('   使用方法:');
  console.log('   - window.checkPipelines(true)  : 检测管道（默认开启焊点过滤）');
  console.log('   - window.analyzePaths()        : 分析 Path 统计');
  console.log('   - window.highlightPipelines()  : 高亮管道');
}

