/**
 * 快速检查焊点与文字区域关系的工具
 * 可以在浏览器控制台直接调用
 */

import { 
  batchCheckWeldsInTextRegions,
  generateWeldTextRelationReport,
  filterWeldsOutsideTextRegions 
} from './WeldTextPositionUtils';

/**
 * 全局函数：快速分析当前页面的焊点与文字关系
 * 在浏览器控制台输入：window.checkWeldText()
 */
export function quickCheckWeldText() {
  console.log('🔍 开始分析焊点与文字区域关系...\n');
  
  // 1. 获取当前的 recognizer
  let recognizer = window.__weldRecognizer__;
  
  // 如果全局变量不存在，尝试从 visualizerRef 获取
  if (!recognizer) {
    const visualizerRef = window.__firstPageVisualizerRef__;
    
    if (visualizerRef && visualizerRef.current) {
      // 尝试多种方式获取 recognizer
      if (visualizerRef.current.getRecognizer) {
        recognizer = visualizerRef.current.getRecognizer();
      }
      
      if (!recognizer && visualizerRef.current.getRuleManager) {
        const ruleManager = visualizerRef.current.getRuleManager();
        if (ruleManager && ruleManager.__recognizer__) {
          recognizer = ruleManager.__recognizer__;
        }
      }
    }
  }
  
  if (!recognizer) {
    console.error('❌ 未找到 recognizer');
    console.log('\n💡 可能的原因：');
    console.log('   1. 焊点识别功能未启用');
    console.log('   2. 页面尚未完全加载');
    console.log('\n💡 解决方法：');
    console.log('   1. 点击右侧的"焊点识别"按钮（绿色图标）');
    console.log('   2. 等待2-3秒后重试');
    console.log('   3. 如果还不行，刷新页面并重新启用焊点识别');
    console.log('\n💡 调试信息：');
    console.log('   window.__weldRecognizer__:', window.__weldRecognizer__);
    console.log('   window.__firstPageVisualizerRef__:', window.__firstPageVisualizerRef__);
    return null;
  }
  
  // 2. 获取当前页的焊点
  const welds = recognizer.getDetectedWelds();
  console.log(`✅ 找到 ${welds.length} 个焊点\n`);
  
  // 3. 获取当前页的文字识别结果
  const textDetections = window.__currentTextDetections__;
  if (!textDetections || !textDetections.detections || textDetections.detections.length === 0) {
    console.warn('⚠️ 当前页面没有文字识别数据');
    console.log('💡 请先点击"文字识别"按钮进行文字识别\n');
    return { welds, hasTextData: false };
  }
  
  console.log(`✅ 找到 ${textDetections.detections.length} 个文字区域\n`);
  
  // 4. 获取页面尺寸
  const pageInfo = textDetections.page_info;
  if (!pageInfo) {
    console.error('❌ 缺少页面尺寸信息');
    return null;
  }
  
  // 5. 生成分析报告
  const report = generateWeldTextRelationReport(
    welds,
    textDetections.detections,
    pageInfo,
    'center'  // 修改为仅检查中心点模式
  );
  
  // 6. 输出报告
  console.log('📊 ============ 分析报告 ============');
  console.log(`总焊点数: ${report.totalWelds}`);
  console.log(`总文字区域数: ${report.totalTextRegions}`);
  console.log(`在文字区域内的焊点: ${report.weldsInTextRegion} (${(report.inTextRatio * 100).toFixed(1)}%)`);
  console.log(`在文字区域外的焊点: ${report.weldsOutsideTextRegion} (${((1 - report.inTextRatio) * 100).toFixed(1)}%)`);
  console.log(`检查模式: ${report.checkMode}`);
  console.log('=====================================\n');
  
  // 7. 详细列出在文字区域内的焊点
  if (report.weldsInTextDetails.length > 0) {
    console.log('🔍 在文字区域内的焊点详情:');
    report.weldsInTextDetails.forEach(item => {
      console.log(`\n  焊点 #${item.weldIndex} (${item.weld.ruleName})`);
      console.log(`    中心: (${item.weld.center.x.toFixed(1)}, ${item.weld.center.y.toFixed(1)})`);
      console.log(`    匹配的文字区域:`);
      item.matchedTextRegions.forEach(match => {
        console.log(`      - "${match.text}"`);
        console.log(`        中心点在内: ${match.checkResult.details.centerInside}`);
        console.log(`        包围盒重叠: ${match.checkResult.details.bboxOverlapping}`);
        console.log(`        重叠比例: ${(match.checkResult.details.overlapRatio * 100).toFixed(1)}%`);
      });
    });
    console.log('\n');
  }
  
  // 8. 列出纯净的焊点
  if (report.weldsOutsideTextDetails.length > 0) {
    console.log('✨ 纯净的焊点（不在文字区域内）:');
    report.weldsOutsideTextDetails.slice(0, 10).forEach(item => {
      console.log(`  焊点 #${item.weldIndex} (${item.weld.ruleName}) at (${item.weld.center.x.toFixed(1)}, ${item.weld.center.y.toFixed(1)})`);
    });
    if (report.weldsOutsideTextDetails.length > 10) {
      console.log(`  ... 还有 ${report.weldsOutsideTextDetails.length - 10} 个`);
    }
    console.log('\n');
  }
  
  // 9. 返回完整数据
  console.log('💾 完整数据已保存到返回值中，可以使用变量接收:');
  console.log('   const result = window.checkWeldText();');
  console.log('   console.log(result.report);');
  console.log('   console.log(result.pureWelds);');
  
  return {
    report,
    welds,
    textDetections: textDetections.detections,
    pureWelds: report.weldsOutsideTextDetails.map(r => r.weld),
    contaminatedWelds: report.weldsInTextDetails.map(r => r.weld),
    hasTextData: true
  };
}

/**
 * 全局函数：获取纯净的焊点（不在文字区域内）
 * 在浏览器控制台输入：window.getPureWelds()
 */
export function getPureWelds() {
  const result = quickCheckWeldText();
  if (!result || !result.hasTextData) {
    return null;
  }
  
  console.log(`\n✨ 获取到 ${result.pureWelds.length} 个纯净焊点`);
  return result.pureWelds;
}

/**
 * 全局函数：获取在文字区域内的焊点
 * 在浏览器控制台输入：window.getContaminatedWelds()
 */
export function getContaminatedWelds() {
  const result = quickCheckWeldText();
  if (!result || !result.hasTextData) {
    return null;
  }
  
  console.log(`\n⚠️ 获取到 ${result.contaminatedWelds.length} 个在文字区域内的焊点`);
  return result.contaminatedWelds;
}

/**
 * 初始化全局函数（在应用启动时调用）
 */
export function initGlobalWeldTextCheck() {
  window.checkWeldText = quickCheckWeldText;
  window.getPureWelds = getPureWelds;
  window.getContaminatedWelds = getContaminatedWelds;
  
  console.log('✅ 焊点文字检查工具已加载');
  console.log('💡 可用命令:');
  console.log('   - window.checkWeldText()         // 分析焊点与文字关系');
  console.log('   - window.getPureWelds()          // 获取纯净焊点');
  console.log('   - window.getContaminatedWelds()  // 获取在文字区域内的焊点');
}

