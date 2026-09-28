/**
 * 详细调试焊点与文字匹配
 * 逐步验证转换和判断过程
 */

export function debugWeldTextMatch() {
  console.log('🔍 ========== 详细匹配调试 ==========\n');
  
  const recognizer = window.__weldRecognizer__;
  const textData = window.__currentTextDetections__;
  
  if (!recognizer || !textData) {
    console.error('❌ 缺少数据');
    return;
  }
  
  const welds = recognizer.getDetectedWelds();
  const detections = textData.detections || [];
  const pageInfo = textData.page_info || {};
  
  // 测试第一个焊点与前10个文字区域
  const testWeld = welds[0];
  console.log('📍 测试焊点 #0:');
  console.log('   中心:', testWeld.center);
  console.log('   包围盒:', testWeld.boundingBox);
  console.log('');
  
  console.log('📝 测试前5个文字区域:\n');
  
  for (let i = 0; i < Math.min(5, detections.length); i++) {
    const textDet = detections[i];
    console.log(`文字 #${i}: "${textDet.text}"`);
    console.log('  原始 box:', textDet.box[0]);
    
    // 手动执行转换
    const box = textDet.box;
    const allCoords = box.flat();
    const maxCoord = Math.max(...allCoords);
    const isRelative = maxCoord <= 1.1;
    
    console.log(`  maxCoord: ${maxCoord.toFixed(4)}`);
    console.log(`  isRelative: ${isRelative}`);
    console.log(`  pageInfo:`, pageInfo);
    
    if (isRelative && pageInfo.page_width && pageInfo.page_height) {
      const converted = box.map(point => [
        point[0] * pageInfo.page_width,
        point[1] * pageInfo.page_height
      ]);
      
      console.log(`  转换后 box[0]: [${converted[0][0].toFixed(2)}, ${converted[0][1].toFixed(2)}]`);
      
      // 计算转换后的区域
      const xCoords = converted.map(p => p[0]);
      const yCoords = converted.map(p => p[1]);
      const region = {
        minX: Math.min(...xCoords),
        minY: Math.min(...yCoords),
        maxX: Math.max(...xCoords),
        maxY: Math.max(...yCoords)
      };
      
      console.log(`  转换后区域: [${region.minX.toFixed(2)}, ${region.minY.toFixed(2)}] → [${region.maxX.toFixed(2)}, ${region.maxY.toFixed(2)}]`);
      
      // 检查焊点中心是否在内
      const centerInside = 
        testWeld.center.x >= region.minX &&
        testWeld.center.x <= region.maxX &&
        testWeld.center.y >= region.minY &&
        testWeld.center.y <= region.maxY;
      
      console.log(`  焊点中心在内: ${centerInside}`);
      
      // 检查包围盒重叠
      const overlapX = Math.max(0, Math.min(testWeld.boundingBox.maxX, region.maxX) - Math.max(testWeld.boundingBox.minX, region.minX));
      const overlapY = Math.max(0, Math.min(testWeld.boundingBox.maxY, region.maxY) - Math.max(testWeld.boundingBox.minY, region.minY));
      const overlapping = overlapX > 0 && overlapY > 0;
      
      console.log(`  包围盒重叠: ${overlapping}`);
      
      if (centerInside || overlapping) {
        console.log(`  ✅ 匹配！`);
      } else {
        console.log(`  ❌ 不匹配`);
      }
    } else {
      console.log(`  ⚠️ 未转换（isRelative: ${isRelative}, hasPageSize: ${!!(pageInfo.page_width && pageInfo.page_height)}）`);
    }
    
    console.log('');
  }
  
  // 现在测试实际的工具函数
  console.log('\n🔧 测试实际工具函数:\n');
  
  import('./WeldTextPositionUtils.js').then(module => {
    const { isWeldInTextRegion, convertTextDetectionToRegion } = module;
    
    console.log('测试 convertTextDetectionToRegion:');
    const region0 = convertTextDetectionToRegion(detections[0], pageInfo);
    console.log('  文字 #0 转换结果:', region0);
    console.log('  _isConverted:', region0._isConverted);
    console.log('');
    
    console.log('测试 isWeldInTextRegion:');
    for (let i = 0; i < Math.min(5, detections.length); i++) {
      const result = isWeldInTextRegion(testWeld, detections[i], pageInfo, 'both');
      console.log(`  文字 #${i} ("${detections[i].text}"): ${result.isInside ? '✅匹配' : '❌不匹配'}`);
      if (result.isInside) {
        console.log(`    详情:`, result.details);
      }
    }
  }).catch(err => {
    console.error('导入模块失败:', err);
  });
  
  console.log('\n' + '='.repeat(50));
}

// 暴露到全局
if (typeof window !== 'undefined') {
  window.debugWeldTextMatch = debugWeldTextMatch;
}

