/**
 * 诊断焊点与文字区域的坐标系统
 * 用于调试坐标不匹配的问题
 */

export function diagnoseCoordinates() {
  console.log('🔍 ========== 坐标系统诊断 ==========\n');
  
  // 获取数据
  const recognizer = window.__weldRecognizer__;
  const textData = window.__currentTextDetections__;
  
  if (!recognizer || !textData) {
    console.error('❌ 缺少必要数据');
    return;
  }
  
  const welds = recognizer.getDetectedWelds();
  const detections = textData.detections || [];
  const pageInfo = textData.page_info || {};
  
  console.log('📊 数据概览:');
  console.log(`  焊点数量: ${welds.length}`);
  console.log(`  文字区域数量: ${detections.length}`);
  console.log(`  页面尺寸: ${pageInfo.page_width} x ${pageInfo.page_height}`);
  console.log(`  坐标格式: ${pageInfo.coordinate_format || 'unknown'}\n`);
  
  // 检查焊点坐标范围
  if (welds.length > 0) {
    console.log('🎯 焊点坐标范围:');
    const weldXs = welds.map(w => w.center.x);
    const weldYs = welds.map(w => w.center.y);
    console.log(`  X 范围: ${Math.min(...weldXs).toFixed(2)} ~ ${Math.max(...weldXs).toFixed(2)}`);
    console.log(`  Y 范围: ${Math.min(...weldYs).toFixed(2)} ~ ${Math.max(...weldYs).toFixed(2)}`);
    console.log(`  示例焊点 #0:`);
    console.log(`    中心: (${welds[0].center.x.toFixed(2)}, ${welds[0].center.y.toFixed(2)})`);
    console.log(`    包围盒: [${welds[0].boundingBox.minX.toFixed(2)}, ${welds[0].boundingBox.minY.toFixed(2)}] → [${welds[0].boundingBox.maxX.toFixed(2)}, ${welds[0].boundingBox.maxY.toFixed(2)}]\n`);
  }
  
  // 检查文字区域坐标范围
  if (detections.length > 0) {
    console.log('📝 文字区域坐标范围:');
    
    // 检查原始坐标
    const firstBox = detections[0].box;
    console.log(`  示例文字 #0 原始坐标:`);
    console.log(`    文本: "${detections[0].text}"`);
    console.log(`    box: [${firstBox[0][0].toFixed(4)}, ${firstBox[0][1].toFixed(4)}] → [${firstBox[2][0].toFixed(4)}, ${firstBox[2][1].toFixed(4)}]`);
    
    // 判断是否为相对坐标
    const isRelative = firstBox[0][0] <= 1 && firstBox[0][1] <= 1;
    console.log(`    坐标类型: ${isRelative ? '相对坐标 (0-1)' : '绝对坐标 (像素)'}`);
    
    if (isRelative) {
      console.log(`\n  ⚠️ 检测到相对坐标，需要转换为绝对坐标`);
      console.log(`  转换公式: 绝对坐标 = 相对坐标 × 页面尺寸`);
      console.log(`  转换后坐标:`);
      console.log(`    X: ${firstBox[0][0].toFixed(4)} × ${pageInfo.page_width} = ${(firstBox[0][0] * pageInfo.page_width).toFixed(2)}`);
      console.log(`    Y: ${firstBox[0][1].toFixed(4)} × ${pageInfo.page_height} = ${(firstBox[0][1] * pageInfo.page_height).toFixed(2)}`);
    }
    
    // 统计所有文字区域的坐标范围
    console.log(`\n  所有文字区域统计:`);
    const allXs = [];
    const allYs = [];
    
    detections.forEach(det => {
      det.box.forEach(point => {
        allXs.push(point[0]);
        allYs.push(point[1]);
      });
    });
    
    console.log(`    X 范围: ${Math.min(...allXs).toFixed(4)} ~ ${Math.max(...allXs).toFixed(4)}`);
    console.log(`    Y 范围: ${Math.min(...allYs).toFixed(4)} ~ ${Math.max(...allYs).toFixed(4)}`);
    
    // 如果是相对坐标，显示转换后的范围
    if (isRelative && pageInfo.page_width && pageInfo.page_height) {
      console.log(`\n    转换为绝对坐标后:`);
      console.log(`    X 范围: ${(Math.min(...allXs) * pageInfo.page_width).toFixed(2)} ~ ${(Math.max(...allXs) * pageInfo.page_width).toFixed(2)}`);
      console.log(`    Y 范围: ${(Math.min(...allYs) * pageInfo.page_height).toFixed(2)} ~ ${(Math.max(...allYs) * pageInfo.page_height).toFixed(2)}`);
    }
  }
  
  // 坐标系统比较
  console.log('\n🔍 坐标系统比较:');
  if (welds.length > 0 && detections.length > 0) {
    const weldX = welds[0].center.x;
    const textX = detections[0].box[0][0];
    
    if (weldX > 10 && textX < 2) {
      console.log('  ✅ 判断: 焊点使用绝对坐标，文字使用相对坐标');
      console.log('  ✅ 需要转换: 文字坐标 × 页面尺寸 = 绝对坐标');
    } else if (weldX > 10 && textX > 10) {
      console.log('  ✅ 判断: 两者都使用绝对坐标');
      console.log('  ✅ 无需转换');
    } else if (weldX < 2 && textX < 2) {
      console.log('  ✅ 判断: 两者都使用相对坐标');
      console.log('  ✅ 无需转换（或都需要转换）');
    } else {
      console.log('  ⚠️ 警告: 坐标系统不一致，可能存在问题');
    }
  }
  
  // 页面尺寸检查
  console.log('\n📏 页面尺寸信息:');
  console.log(`  page_width: ${pageInfo.page_width}`);
  console.log(`  page_height: ${pageInfo.page_height}`);
  console.log(`  coordinate_format: ${pageInfo.coordinate_format}`);
  
  if (!pageInfo.page_width || !pageInfo.page_height) {
    console.error('  ❌ 错误: 缺少页面尺寸信息！');
    console.log('  💡 这会导致相对坐标无法正确转换');
  }
  
  console.log('\n' + '='.repeat(50) + '\n');
  
  // 返回诊断结果
  return {
    welds: {
      count: welds.length,
      xRange: welds.length > 0 ? [Math.min(...welds.map(w => w.center.x)), Math.max(...welds.map(w => w.center.x))] : null,
      yRange: welds.length > 0 ? [Math.min(...welds.map(w => w.center.y)), Math.max(...welds.map(w => w.center.y))] : null,
      coordinateType: 'absolute'
    },
    textRegions: {
      count: detections.length,
      originalXRange: detections.length > 0 ? (() => {
        const xs = detections.flatMap(d => d.box.map(p => p[0]));
        return [Math.min(...xs), Math.max(...xs)];
      })() : null,
      originalYRange: detections.length > 0 ? (() => {
        const ys = detections.flatMap(d => d.box.map(p => p[1]));
        return [Math.min(...ys), Math.max(...ys)];
      })() : null,
      coordinateType: detections.length > 0 && detections[0].box[0][0] <= 1 ? 'relative' : 'absolute'
    },
    pageInfo: pageInfo,
    needsConversion: detections.length > 0 && detections[0].box[0][0] <= 1,
    hasPageSize: !!(pageInfo.page_width && pageInfo.page_height)
  };
}

// 暴露到全局
if (typeof window !== 'undefined') {
  window.diagnoseCoordinates = diagnoseCoordinates;
}

