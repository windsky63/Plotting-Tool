/**
 * OCR工具函数模块 - 提供OCR相关的坐标转换、几何计算等工具函数
 */

/**
 * OCR坐标和几何工具类
 */
export class OCRUtils {
  constructor(pageRefsRef, currentPage, scale, pageObjectsRef) {
    this.pageRefsRef = pageRefsRef;
    this.currentPage = currentPage;
    this.scale = scale;
    this.pageObjectsRef = pageObjectsRef;
  }

  /**
   * 获取视口几何信息 (兼容Canvas和SVG)
   */
  getViewportGeometry() {
    // 首先尝试通过当前页面的ref获取容器
    const pageRef = this.pageRefsRef.current[this.currentPage];
    
    if (!pageRef) {
      // 尝试通用选择器
      const fallback = document.querySelector(`.react-pdf__Page[data-page-number="${this.currentPage}"]`);
      if (!fallback) {
        // console.warn('未找到页面元素');
        return null;
      }
      return this._calculateGeometryFromElement(fallback);
    }
    
    return this._calculateGeometryFromElement(pageRef);
  }

  _calculateGeometryFromElement(element) {
    // 尝试获取内部的 canvas 或 svg
    const canvas = element.querySelector('canvas');
    const snapshot = element.querySelector('img[data-pdf-page-snapshot="true"]');
    const svg = snapshot ? null : element.querySelector('.react-pdf__Page__svg, svg');
    
    let scaleX = 1;
    let scaleY = 1;
    let targetElement = element;
    let rect;
    let internalWidth;
    let internalHeight;
    
    if (canvas) {
      targetElement = canvas;
      // 🔧 Canvas 模式：使用 Canvas 元素自身的 bounding rect
      rect = canvas.getBoundingClientRect();
      // canvas.width 是内部像素尺寸
      internalWidth = canvas.width;
      internalHeight = canvas.height;
      scaleX = rect.width / internalWidth;
      scaleY = rect.height / internalHeight;
    } else if (snapshot) {
      targetElement = snapshot;
      rect = snapshot.getBoundingClientRect();
      internalWidth = Number(snapshot.naturalWidth || snapshot.width || rect.width);
      internalHeight = Number(snapshot.naturalHeight || snapshot.height || rect.height);
      scaleX = internalWidth > 0 ? rect.width / internalWidth : 1;
      scaleY = internalHeight > 0 ? rect.height / internalHeight : 1;
    } else if (svg) {
      targetElement = svg;
      // 🔧 SVG 模式修复：使用 SVG 元素自身的 bounding rect，而不是容器的
      rect = svg.getBoundingClientRect();
      // 在 SVG 模式下，内部坐标系等同于 CSS 像素坐标
      internalWidth = rect.width;
      internalHeight = rect.height;
      scaleX = 1;
      scaleY = 1;
    } else {
      // Fallback：使用容器元素
      rect = element.getBoundingClientRect();
      internalWidth = rect.width;
      internalHeight = rect.height;
      scaleX = 1;
      scaleY = 1;
    }

    return { 
      element: targetElement, 
      rect, 
      scaleX, 
      scaleY, 
      mode: canvas ? 'canvas' : (snapshot ? 'snapshot' : 'svg'),
      // 内部尺寸属性
      internalWidth,
      internalHeight
    };
  }

  /**
   * 获取Canvas几何信息 (兼容旧API)
   */
  getCanvasGeometry() {
    return this.getViewportGeometry();
  }

  /**
   * 获取区域的 Base64 图片数据
   * @param {Object} region - 区域对象 {x, y, width, height} (基于 Canvas/CSS 坐标)
   */
  async getRegionBase64(region) {
    const geo = this.getViewportGeometry();
    if (!geo) throw new Error('无法获取页面几何信息');

    // 模式 1: Canvas 模式 - 直接截图
    if (geo.mode === 'canvas' && geo.element instanceof HTMLCanvasElement) {
        // 创建临时 Canvas 截取区域
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = region.width;
        tempCanvas.height = region.height;
        const ctx = tempCanvas.getContext('2d');
        
        ctx.drawImage(
            geo.element,
            region.x, region.y, region.width, region.height,
            0, 0, region.width, region.height
        );
        
        return tempCanvas.toDataURL('image/png').split(',')[1];
    }
    
    // 模式 2: SVG 模式 (或任何非Canvas模式) - 使用 PDF.js 离屏渲染
    if (!this.pageObjectsRef || !this.pageObjectsRef.current) {
        throw new Error('SVG模式下需要 pageObjectsRef 支持');
    }
    
    const page = this.pageObjectsRef.current.get(this.currentPage);
    if (!page) {
        throw new Error(`未找到页面 ${this.currentPage} 的 PDF 对象`);
    }

    // 计算 PDF 视口
    const targetScale = 2.0; 
    const viewport = page.getViewport({ scale: targetScale });
    
    // 坐标转换: CSS 像素 -> 目标 Canvas 坐标
    const displayWidth = geo.mode === 'snapshot' ? geo.internalWidth : geo.rect.width;
    const displayHeight = geo.mode === 'snapshot' ? geo.internalHeight : geo.rect.height;
    
    const scaleFactorX = viewport.width / displayWidth;
    const scaleFactorY = viewport.height / displayHeight;
    
    const renderX = region.x * scaleFactorX;
    const renderY = region.y * scaleFactorY;
    const renderW = region.width * scaleFactorX;
    const renderH = region.height * scaleFactorY;
    
    // 离屏渲染
    const canvas = document.createElement('canvas');
    canvas.width = renderW;
    canvas.height = renderH;
    const ctx = canvas.getContext('2d');
    
    // 构造变换矩阵：平移 (-renderX, -renderY)
    const transform = [1, 0, 0, 1, -renderX, -renderY];
    
    await page.render({
        canvasContext: ctx,
        viewport: viewport,
        transform: transform
    }).promise;
    
    return canvas.toDataURL('image/png').split(',')[1];
  }

  /**
   * 客户端坐标转Canvas坐标
   * @param {number} clientX - 客户端X坐标
   * @param {number} clientY - 客户端Y坐标
   */
  clientToCanvas(clientX, clientY) {
    const geo = this.getCanvasGeometry();
    if (!geo) return null;
    
    const { element, rect, scaleX, scaleY } = geo;
    const relativeX = clientX - rect.left;
    const relativeY = clientY - rect.top;
    
    // 检查鼠标是否在Canvas显示区域内
    if (relativeX < 0 || relativeY < 0 || relativeX > rect.width || relativeY > rect.height) {
      return null;
    }
    
    // 转换为Canvas内部坐标（像素坐标）
    const canvasX = relativeX / scaleX;
    const canvasY = relativeY / scaleY;
    
    return {
      x: canvasX,
      y: canvasY
    };
  }

  /**
   * Canvas坐标转客户端坐标
   * @param {number} canvasX - Canvas X坐标
   * @param {number} canvasY - Canvas Y坐标
   */
  canvasToClient(canvasX, canvasY) {
    const geo = this.getCanvasGeometry();
    if (!geo) return null;
    
    const { rect, scaleX, scaleY } = geo;
    return {
      x: rect.left + (canvasX * scaleX),
      y: rect.top + (canvasY * scaleY)
    };
  }

  /**
   * 检查点是否在区域内
   * @param {Object} point - 点坐标 {x, y}
   * @param {Object} region - 区域 {x, y, width, height}
   */
  isPointInRegion(point, region) {
    if (!point || !region) return false;
    
    return (
      point.x >= region.x &&
      point.x <= region.x + region.width &&
      point.y >= region.y &&
      point.y <= region.y + region.height
    );
  }

  /**
   * 获取调整手柄位置
   * @param {Object} region - 区域对象
   */
  getResizeHandles(region) {
    if (!region) return [];
    
    // 获取Canvas几何信息进行坐标转换
    const canvasGeometry = this.getCanvasGeometry();
    if (!canvasGeometry) return [];
    
    const rect = canvasGeometry.rect;
    
    // 将相对坐标转换为屏幕坐标
    const screenX = rect.left + (region.x * rect.width);
    const screenY = rect.top + (region.y * rect.height);
    const screenW = region.width * rect.width;
    const screenH = region.height * rect.height;
    
    const handleSize = 8; // 调整手柄大小
    
    return {
      tl: { x: screenX - handleSize/2, y: screenY - handleSize/2, width: handleSize, height: handleSize },
      tr: { x: screenX + screenW - handleSize/2, y: screenY - handleSize/2, width: handleSize, height: handleSize },
      bl: { x: screenX - handleSize/2, y: screenY + screenH - handleSize/2, width: handleSize, height: handleSize },
      br: { x: screenX + screenW - handleSize/2, y: screenY + screenH - handleSize/2, width: handleSize, height: handleSize }
    };
  }

  /**
   * 检查点击的调整手柄
   * @param {Object} point - 点坐标
   * @param {Object} region - 区域对象
   */
  getClickedHandle(point, region) {
    const handles = this.getResizeHandles(region);
    for (const [handleName, handleRect] of Object.entries(handles)) {
      if (this.isPointInRegion(point, handleRect)) {
        return handleName;
      }
    }
    return null;
  }

  /**
   * 生成唯一ID
   */
  static generateId() {
    return `ocr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 计算两点之间的距离
   * @param {Object} point1 - 点1 {x, y}
   * @param {Object} point2 - 点2 {x, y}
   */
  static getDistance(point1, point2) {
    const dx = point2.x - point1.x;
    const dy = point2.y - point1.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * 标准化区域坐标（确保width和height为正数）
   * @param {Object} region - 区域对象
   */
  static normalizeRegion(region) {
    const x = Math.min(region.x, region.x + region.width);
    const y = Math.min(region.y, region.y + region.height);
    const width = Math.abs(region.width);
    const height = Math.abs(region.height);
    
    return { x, y, width, height };
  }

  /**
   * 将Canvas坐标转换为相对坐标（0-1范围）
   * @param {Object} canvasRegion - Canvas坐标区域
   * @param {HTMLCanvasElement} canvas - Canvas元素
   */
  static canvasToRelative(canvasRegion, canvas) {
    if (!canvas || !canvasRegion) return null;
    
    return {
      x: canvasRegion.x / canvas.width,
      y: canvasRegion.y / canvas.height,
      width: canvasRegion.width / canvas.width,
      height: canvasRegion.height / canvas.height
    };
  }

  /**
   * 将相对坐标转换为Canvas坐标
   * @param {Object} relativeRegion - 相对坐标区域
   * @param {HTMLCanvasElement} canvas - Canvas元素
   */
  static relativeToCanvas(relativeRegion, canvas) {
    if (!canvas || !relativeRegion) return null;
    
    return {
      x: relativeRegion.x * canvas.width,
      y: relativeRegion.y * canvas.height,
      width: relativeRegion.width * canvas.width,
      height: relativeRegion.height * canvas.height
    };
  }

  /**
   * 验证区域是否有效
   * @param {Object} region - 区域对象
   * @param {number} minSize - 最小尺寸
   */
  static isValidRegion(region, minSize = 10) {
    if (!region) return false;
    
    return (
      typeof region.x === 'number' &&
      typeof region.y === 'number' &&
      typeof region.width === 'number' &&
      typeof region.height === 'number' &&
      Math.abs(region.width) >= minSize &&
      Math.abs(region.height) >= minSize
    );
  }
}

/**
 * 计算寸径
 * @param {string} spec - 规格字符串（如 "DN100", "DN100×80", "100", "100×80"）
 * @returns {string} 寸径值
 */
function calculateInchDiameter(spec) {
  if (!spec || typeof spec !== 'string') return '';
  
  // 移除空格
  const cleanSpec = spec.trim();
  
  // 异径判断（包含×或x或X）
  const isDifferentDiameter = cleanSpec.includes('×') || cleanSpec.includes('x') || cleanSpec.includes('X');
  
  if (isDifferentDiameter) {
    // 提取所有数字
    const numbers = cleanSpec.match(/\d+/g);
    if (numbers && numbers.length >= 2) {
      // 取较小的一端
      const smaller = Math.min(...numbers.map(n => parseInt(n)));
      return convertToInch(smaller);
    }
  }
  
  // 同径：提取第一个数字
  const match = cleanSpec.match(/\d+/);
  if (match) {
    return convertToInch(parseInt(match[0]));
  }
  
  return '';
}

/**
 * 规格数值转换为寸径
 * @param {number} value - 规格数值
 * @returns {string} 寸径值
 */
function convertToInch(value) {
  // 小于100的对照表
  const conversionTable = {
    6: '0.125',
    8: '0.25',
    10: '0.375',
    15: '0.5',
    20: '0.75',
    25: '1',
    32: '1.25',
    40: '1.5',
    50: '2',
    65: '2.5',
    80: '3',
    90: '3.5'
  };
  
  // 大于等于100，除以25
  if (value >= 100) {
    const result = value / 25;
    // 保留2位小数，去掉末尾的0
    return parseFloat(result.toFixed(2)).toString();
  }
  
  // 小于100，查表
  return conversionTable[value] || '';
}

/**
 * 计算壁厚号
 * @param {string} wallThickness - 壁厚值（如 "4mm", "SCH40", "4"）
 * @returns {string} 壁厚号值（格式：T=壁厚）
 */
function calculateScheduleNumber(wallThickness) {
  if (!wallThickness || typeof wallThickness !== 'string') return '';
  
  // 移除空格并检查
  const cleanValue = wallThickness.trim();
  
  // 空值或占位符返回空
  if (!cleanValue || cleanValue === '-' || cleanValue === 'N/A') return '';
  
  // 格式：T=壁厚值
  return `T=${cleanValue}`;
}

/**
 * 从材料描述中提取接头类型
 * @param {string} materialDesc - 材料描述
 * @returns {string} 接头类型代码（如 BW, SW, OL等）
 */
function extractJointType(materialDesc) {
  if (!materialDesc || typeof materialDesc !== 'string') return '';
  
  // 转换为大写便于匹配
  const desc = materialDesc.toUpperCase();
  
  // 接头类型列表（按长度排序，优先匹配长代码避免误匹配）
  const jointTypes = [
    'ZBW',  // 3字符，优先匹配
    'SBR',  // 3字符
    'BW',   // 2字符
    'SW',   // 2字符
    'OL',   // 2字符
    'BR',   // 2字符
    'TJ',   // 2字符
    'CP',   // 2字符
    'SO'    // 2字符
  ];
  
  // 按顺序匹配（使用单词边界避免误匹配）
  for (const type of jointTypes) {
    // 使用单词边界或空格/标点分隔
    const regex = new RegExp(`\\b${type}\\b|(?:^|[\\s,.-])${type}(?:[\\s,.-]|$)`);
    if (regex.test(desc)) {
      return type;
    }
  }
  
  return ''; // 未找到返回空
}

/**
 * 构建焊口主导的数据结构 - 焊口表+材料信息
 * @param {Array} ocrData - OCR数据行
 * @param {boolean} enableEncoding - 是否启用编码
 * @returns {Array} 以焊口为主体的数据
 */
async function addWeldSeamAssociation(ocrData, enableEncoding = false) {
  try {
    // 获取当前页面的标注数据（焊口数据）
    const annotations = window.currentAnnotations || [];
    
    if (!annotations || annotations.length === 0) {
      // 如果没有焊口数据，返回原有材料数据结构
      return ocrData;
    }

    // 处理标注数据，构建焊口数据
    const weldSeamData = annotations
      .filter(annotation => annotation.text) // 只处理有焊口号的标注
      .filter(annotation => annotation.materialNumber) // 🆕 只保留绑定了材料编号的焊口
      .map(annotation => ({
        weldSeam: annotation.text || '',
        page: String(annotation.page || '').trim(),
        remark: annotation.remark || '',
        borderShape: annotation.borderShape || 'none',
        // 支持手动指定材料编号范围
        materialNumber: annotation.materialNumber ? String(annotation.materialNumber).trim() : null
      }));

    if (weldSeamData.length === 0) {
      console.log('⚠️ 没有找到绑定材料编号的焊口，返回原有材料数据结构');
      return ocrData;
    }

    console.log(`🔍 开始构建焊口主导的数据结构: 焊口${weldSeamData.length}条（仅绑定材料编号）, 材料${ocrData.length}条`);

    // 形状映射函数
    const getWeldShape = (borderShape) => {
      switch (borderShape) {
        case 'circle':
          return 'S';  // 圆形框 -> S
        case 'split-circle':
          return 'S';  // 分栏圆形 -> S
        case 'diamond':
          return 'F';  // 菱形框 -> F
        case 'field-weld':
          return 'F';  // 现场焊缝 -> F
        case 'shop-weld':
          return 'S';  // 车间焊缝 -> S
        default:
          return '';   // 无特定形状
      }
    };

    // 构建材料映射表：页码_序号 -> 材料数据
    const materialMap = new Map();
    ocrData.forEach(row => {
      const calculatedPage = row[10] ? String(row[10]).trim() : ''; // 🆕 计算页码移到第11列（索引10）
      const sequence = row[0] ? String(row[0]).trim() : '';
      const key = `${calculatedPage}_${sequence}`;
      materialMap.set(key, {
        序号: row[0] || '',
        材料描述: row[1] || '',
        接头类型: row[2] || '', // 🆕 新增接头类型字段
        规格: row[3] || '',
        寸径: row[4] || '',
        材料代码: row[5] || '',
        数量: row[6] || '',
        单位: row[7] || '',
        类型: row[8] || '',
        OCR页码: row[9] || '',
        计算页码: row[10] || '',
        // 如果有编码信息，也会包含在这里
        原始数据: row
      });
    });
    
    console.log(`📋 材料映射表构建完成: 共${materialMap.size}个材料`);
    console.log(`📋 映射表示例key:`, Array.from(materialMap.keys()).slice(0, 10));

    // 构建焊口主导的数据结构
    const weldCentricData = [];
    
    weldSeamData.forEach(weldSeam => {
      const weldShape = getWeldShape(weldSeam.borderShape);
      const weldPage = weldSeam.page;
      
      // 查找匹配的材料
      const matchedMaterials = [];
      
      // 🆕 由于已经过滤了未绑定的焊口，这里只处理绑定材料编号的情况
      if (weldSeam.materialNumber) {
        // 手动指定材料编号范围
        const materialNumbers = parseMaterialNumbers(weldSeam.materialNumber);
        
        console.log(`🔍 焊口 ${weldSeam.weldSeam}: 页码=${weldPage}, 原始材料编号="${weldSeam.materialNumber}", 解析结果=[${materialNumbers.join(', ')}]`);
        
        materialNumbers.forEach(num => {
          const key = `${weldPage}_${num}`;
          const material = materialMap.get(key);
          console.log(`   尝试匹配 key="${key}" -> ${material ? '✅找到' : '❌未找到'}`);
          if (material) {
            matchedMaterials.push(material);
          } else {
            console.warn(`   ⚠️ 未找到材料: 页码=${weldPage}, 序号=${num}`);
          }
        });
        
        console.log(`🔍 焊口 ${weldSeam.weldSeam}: 指定材料序号 [${materialNumbers.join(', ')}] -> 匹配到 ${matchedMaterials.length} 个材料`);
      }
      
      // 构建焊口行数据
      const weldRow = {
        焊口号: weldSeam.weldSeam,
        焊口形状: weldShape,
        页码: weldPage,
        材料数量: matchedMaterials.length,
        匹配材料: matchedMaterials
      };
      
      weldCentricData.push(weldRow);
    });

    // 解析材料编号的辅助函数
    // 支持多种分隔符：逗号、短横线、空格
    function parseMaterialNumbers(materialNumbers) {
      let numbers = [];
      
      // 优先使用逗号分隔
      if (materialNumbers.includes(',')) {
        numbers = materialNumbers.split(',').map(n => n.trim()).filter(n => n);
      } 
      // 其次使用短横线分隔（不再作为范围符号）
      else if (materialNumbers.includes('-')) {
        numbers = materialNumbers.split('-').map(n => n.trim()).filter(n => n);
      } 
      // 再次使用空格分隔
      else if (materialNumbers.includes(' ')) {
        numbers = materialNumbers.split(' ').map(n => n.trim()).filter(n => n);
      } 
      // 单个材料编号
      else {
        numbers = [materialNumbers.trim()];
      }
      
      return numbers.filter(n => n); // 过滤空值
    }

    // 转换为平面数据结构（供 Excel 导出）- 每个焊口一行
    const flatData = [];
    
    // 计算最大材料数量，用于动态生成表头
    const maxMaterialCount = Math.max(...weldCentricData.map(w => w.匹配材料.length), 1);
    const colsPerMaterial = 21; // 🆕 每个材料总是21列（11基础+10编码，编码含壁厚号）
    console.log(`📊 最大材料数量: ${maxMaterialCount}, 每个材料${colsPerMaterial}列（含编码位）`);
    
    weldCentricData.forEach(weldRow => {
      // 每个焊口一行，包含所有匹配的材料信息
      const row = [
        weldRow.焊口号,
        weldRow.焊口形状,
        weldRow.页码
      ];
      
      // 添加所有匹配的材料信息（预留编码位置）
      for (let i = 0; i < maxMaterialCount; i++) {
        const material = weldRow.匹配材料[i];
        
        if (material) {
          // 有材料数据 - 基础信息
          const originalData = material.原始数据 || [];
          
          row.push(
            material.序号 || '',
            material.材料描述 || '',
            material.接头类型 || '', // 🆕 添加接头类型
            material.规格 || '',
            material.寸径 || '',
            material.材料代码 || '',
            material.数量 || '',
            originalData[7] || '', // 🆕 管线号（从原始数据第8列获取）
            originalData[8] || '', // 🆕 图号（从原始数据第9列获取）
            material.OCR页码 || '',
            material.计算页码 || ''
          );
          
          // 🆕 总是预留编码位置（后面会填入实际数据，即使未启用编码也保留空位）
          row.push('', '', '', '', '', '', '', '', '', ''); // 10个编码列（含壁厚号）
        } else {
          // 🆕 无材料数据，填入空值（总是21列）
          for (let j = 0; j < 21; j++) {
            row.push('');
          }
        }
      }
      
      flatData.push(row);
    });
    
    // 储存最大材料数量和是否启用编码，供后续使用
    flatData.maxMaterialCount = maxMaterialCount;
    flatData.enableEncoding = enableEncoding; // 传递编码状态

    const totalWeldSeams = weldSeamData.length;
    const weldSeamsWithMaterials = weldCentricData.filter(w => w.匹配材料.length > 0).length;
    const totalMatchedMaterials = weldCentricData.reduce((sum, w) => sum + w.匹配材料.length, 0);
    
    console.log(`\n📊 焊口主导数据结构统计:`);
    console.log(`   总焊口数: ${totalWeldSeams}`);
    console.log(`   有材料的焊口: ${weldSeamsWithMaterials}/${totalWeldSeams} (${((weldSeamsWithMaterials/totalWeldSeams)*100).toFixed(1)}%)`);
    console.log(`   匹配材料总数: ${totalMatchedMaterials}`);
    console.log(`   平均每个焊口: ${(totalMatchedMaterials/weldSeamsWithMaterials || 0).toFixed(1)} 个材料`);

    return flatData;
  } catch (error) {
    console.error('❌ 焊口关联失败:', error);
    return ocrData;
  }
}

/**
 * OCR数据处理工具函数
 */
export const ocrDataUtils = {
  /**
   * 导出OCR逻辑行到Excel（增强版：集成材料编码）
   * @param {Array} logicalRows - 逻辑行数据
   * @param {string} pdfFileName - PDF文件名
   * @param {boolean} enableEncoding - 是否启用材料编码
   */
  async exportLogicalRowsToExcel(logicalRows, pdfFileName = null, enableEncoding = false) {
    // 动态导入xlsx库
    const XLSX = await import('xlsx');
    
    // 保存OCR结果到全局变量，供关联功能使用
    window.lastOcrLogicalRows = logicalRows;

    // 转换数据格式
    const exportData = [];
    let currentPageNumber = 1; // 初始化计算页码为1

    for (let i = 0; i < logicalRows.length; i++) {
      const row = logicalRows[i];
      
      // 新的页码计算逻辑：当材料编号（第一列）为1且不是第一行时，页码加1
      if (i > 0 && Number(row[0]) === 1) {
        currentPageNumber++;
      }
      
      const calculatedPage = currentPageNumber;
      
      // 将计算的页码添加到行数据的第9列（第8列是OCR识别的页码）
      const rowWithPage = [...row, calculatedPage];
      exportData.push(rowWithPage);
    }

    // 🆕 步骤2.5：计算寸径（在页码计算之后、焊口关联之前）
    const exportDataWithInchDiameter = exportData.map(row => {
      const spec = row[2]; // 规格在第3列（索引2）
      const inchDiameter = calculateInchDiameter(spec);
      
      // 插入寸径到规格之后（位置3）
      return [
        row[0], // 序号
        row[1], // 材料描述
        row[2], // 规格
        inchDiameter, // 🆕 寸径
        ...row.slice(3) // 其余列（材料代码、数量、管线号、图号、OCR页码、计算页码）
      ];
    });

    // 🆕 步骤2.6：提取接头类型（在寸径计算之后）
    const exportDataWithJointType = exportDataWithInchDiameter.map(row => {
      const materialDesc = row[1]; // 材料描述在第2列（索引1）
      const jointType = extractJointType(materialDesc);
      
      // 插入接头类型到材料描述之后（位置2）
      return [
        row[0], // 序号
        row[1], // 材料描述
        jointType, // 🆕 接头类型
        ...row.slice(2) // 其余列（规格、寸径、材料代码、数量、管线号、图号、OCR页码、计算页码）
      ];
    });

    let finalExportData = exportDataWithJointType;
    let headers = ['材料编号', '材料描述', '接头类型', '规格', '寸径', '材料代码', '数量', '管线号', '图号', 'OCR页码', '计算页码'];

    // 构建焊口主导的数据结构
    const weldCentricData = await addWeldSeamAssociation(finalExportData, enableEncoding);
    
    // 检查是否有焊口数据
    const hasWeldSeamData = weldCentricData.length > 0 && 
                           window.currentAnnotations && 
                           window.currentAnnotations.length > 0;
    
    if (hasWeldSeamData) {
      finalExportData = weldCentricData;
      
      // 动态生成表头：每个材料包含完整信息（基础+编码）
      const maxMaterialCount = finalExportData.maxMaterialCount || 1;
      headers = ['焊口号', '焊口形状', '页码'];
      
      for (let i = 1; i <= maxMaterialCount; i++) {
        // 🆕 基础材料信息（增加接头类型和寸径列）
        headers.push(
          `材料${i}序号`,
          `材料${i}描述`,
          `材料${i}接头类型`, // 🆕 新增接头类型列
          `材料${i}规格`,
          `材料${i}寸径`,
          `材料${i}代码`,
          `材料${i}数量`,
          `材料${i}管线号`,
          `材料${i}图号`,
          `材料${i}OCR页码`,
          `材料${i}计算页码`
        );
        
        // 如果启用编码，立即添加编码列
        if (enableEncoding) {
          headers.push(
            `材料${i}种类`,
            `材料${i}尺寸`,
            `材料${i}壁厚`,
            `材料${i}壁厚号`, // 🆕 新增壁厚号列
            `材料${i}磅级`,
            `材料${i}材质`,
            `材料${i}规范`,
            `材料${i}编码`,
            `材料${i}置信度`,
            `材料${i}编码来源`
          );
        }
      }
      
      const colsPerMaterial = 11 + (enableEncoding ? 10 : 0); // 🆕 11基础列 + 10编码列
      console.log(`📊 动态表头生成: 支持最多 ${maxMaterialCount} 个材料, 每个材料${colsPerMaterial}列, 总列数: ${headers.length}`);
    }

    // 如果启用材料编码，调用外部API进行处理
    if (enableEncoding && finalExportData.length > 0) {
      try {
        let encodingInputData = [];
        
        if (hasWeldSeamData) {
          // 焊口主导结构：提取所有材料描述（新的单行格式）
          const maxMaterialCount = finalExportData.maxMaterialCount || 1;
          
          finalExportData.forEach(row => {
            // 遍历每个材料列
            for (let i = 0; i < maxMaterialCount; i++) {
              // 🆕 此时数据结构中每个材料包含21列（因为已经为编码预留了位置，含壁厚号和接头类型）
              const colsPerMaterial = 21; // 🆕 此时已经是21列的结构
              const materialStartIndex = 3 + (i * colsPerMaterial); // 材料数据开始位置
              const materialDesc = row[materialStartIndex + 1]; // 材料描述
              
              if (materialDesc && materialDesc.trim()) {
                encodingInputData.push([
                  row[materialStartIndex] || '',     // 材料序号
                  materialDesc,                       // 材料描述
                  row[materialStartIndex + 3] || '', // 🆕 规格（索引+1，因为插入了接头类型）
                  row[materialStartIndex + 5] || '', // 🆕 材料代码（索引+2）
                  row[materialStartIndex + 6] || '', // 🆕 数量（索引+2）
                  row[2] || '',                       // 页码
                  row[materialStartIndex + 7] || '', // 🆕 管线号（索引+2）
                  row[materialStartIndex + 8] || ''  // 🆕 图号（索引+2）
                ]);
              }
            }
          });
        } else {
          // 原有材料主导结构
          encodingInputData = exportData;
        }

        if (encodingInputData.length > 0) {
          // 动态导入ocrService
          const { ocrService } = await import('../services/ocrService.js');
          
          // 调用材料编码API
          const encodingResults = await ocrService.processMaterialEncoding(encodingInputData, pdfFileName || 'result');
          
          if (encodingResults && encodingResults.results) {
            // 合并编码结果到导出数据（编码信息紧跟每个材料）
            let encodingIndex = 0;
            const maxMaterialCount = finalExportData.maxMaterialCount || 1;
            
            finalExportData = finalExportData.map((row) => {
              const newRow = [...row];
              
            if (hasWeldSeamData) {
              // 焊口主导结构：将编码信息插入到每个材料的编码位置
              for (let i = 0; i < maxMaterialCount; i++) {
              // 🆕 数据结构中每个材料总是21列（基础11列+编码10列，含接头类型和壁厚号）
              const colsPerMaterial = 21;
                const materialStartIndex = 3 + (i * colsPerMaterial); // 材料数据开始位置
                const materialDesc = row[materialStartIndex + 1]; // 材料描述
                
                if (materialDesc && materialDesc.trim() && encodingIndex < encodingResults.results.length) {
                  const encodingResult = encodingResults.results[encodingIndex];
                  encodingIndex++;
                  
                  if (encodingResult) {
                    // 🆕 编码信息开始位置（第11-20列是编码列）
                    const encodingStartIndex = materialStartIndex + 11;
                    
                    const wallThickness = encodingResult.wall_thickness || '';
                    const scheduleNumber = calculateScheduleNumber(wallThickness); // 🆕 计算壁厚号
                    
                    newRow[encodingStartIndex] = encodingResult.category || '';        // 种类
                    newRow[encodingStartIndex + 1] = encodingResult.size || '';            // 尺寸
                    newRow[encodingStartIndex + 2] = wallThickness;  // 壁厚
                    newRow[encodingStartIndex + 3] = scheduleNumber; // 🆕 壁厚号
                    newRow[encodingStartIndex + 4] = encodingResult.pressure_rating || ''; // 磅级
                    newRow[encodingStartIndex + 5] = encodingResult.material || '';        // 材质
                    newRow[encodingStartIndex + 6] = encodingResult.standard || '';        // 规范
                    newRow[encodingStartIndex + 7] = encodingResult.code || '';            // 编码
                    newRow[encodingStartIndex + 8] = (encodingResult.confidence * 100).toFixed(1) + '%' || ''; // 置信度
                    newRow[encodingStartIndex + 9] = encodingResult.source || '';           // 🆕 来源（索引+1）
                  }
                }
              }
              } else {
                // 原有材料主导结构
                const materialDesc = row[1]; // 材料描述列
                
                if (materialDesc && materialDesc.trim() && encodingIndex < encodingResults.results.length) {
                  const encodingResult = encodingResults.results[encodingIndex];
                  encodingIndex++;
                  
                  if (encodingResult) {
                    const wallThickness = encodingResult.wall_thickness || '';
                    const scheduleNumber = calculateScheduleNumber(wallThickness); // 🆕 计算壁厚号
                    
                    newRow.push(
                      encodingResult.category || '',        // 种类
                      encodingResult.size || '',            // 尺寸
                      wallThickness,                        // 壁厚
                      scheduleNumber,                       // 🆕 壁厚号
                      encodingResult.pressure_rating || '', // 磅级
                      encodingResult.material || '',        // 材质
                      encodingResult.standard || '',        // 规范
                      encodingResult.code || '',            // 编码
                      (encodingResult.confidence * 100).toFixed(1) + '%' || '', // 置信度
                      encodingResult.source || ''           // 来源
                    );
                  }
                }
              }
              
              return newRow;
            });
            
            // 标记已启用编码
            finalExportData.enableEncoding = true;
            
            // 更新表头（编码信息已在表头生成时包含）
            if (!hasWeldSeamData) {
              // 🆕 原有材料主导结构才需要添加编码列（含壁厚号）
              headers = [...headers, '种类', '尺寸', '壁厚', '壁厚号', '磅级', '材质', '规范', '编码', '置信度', '编码来源'];
            }
            // 焊口主导结构的编码列已在上面表头生成时包含了
          }
        } else {
          console.warn('⚠️ 没有有效的材料描述数据，跳过编码处理');
        }
      } catch (error) {
        console.error('❌ 材料编码API调用失败:', error);
        // 编码失败时给用户明确提示，但不影响基础导出功能
        const { message } = await import('antd');
        message.error(`材料编码服务不可用: ${error.message}。将导出基础识别结果。`);
      }
    }

    // 如果没有启用编码，需要过滤掉编码列的数据
    let filteredExportData = finalExportData;
    if (hasWeldSeamData && !enableEncoding) {
      // 🆕 过滤掉每个材料的编码列（第11-20列）
      const maxMaterialCount = finalExportData.maxMaterialCount || 1;
      
      filteredExportData = finalExportData.map(row => {
        const newRow = [...row.slice(0, 3)]; // 保留焊口信息（3列）
        
        for (let i = 0; i < maxMaterialCount; i++) {
          const materialStartIndex = 3 + (i * 21); // 🆕 每个材料21列
          // 🆕 只取基础材料信息（前11列），过滤掉编码信息（后10列）
          const materialBasicData = row.slice(materialStartIndex, materialStartIndex + 11);
          newRow.push(...materialBasicData);
        }
        
        return newRow;
      });
      
      console.log(`📎 已过滤掉编码列，每行从 ${finalExportData[0]?.length || 0} 列减少到 ${filteredExportData[0]?.length || 0} 列`);
    }
    
    const wsData = [headers, ...filteredExportData];

    const ws = XLSX.utils.aoa_to_sheet(wsData);
    
    // 设置列宽（根据是否为焊口主导结构调整）
    let baseColumns;
    
    if (hasWeldSeamData) {
      // 焊口主导结构的列宽：动态生成
      baseColumns = [
        { wch: 15 }, // 焊口号
        { wch: 10 }, // 焊口形状
        { wch: 8 }   // 页码
      ];
      
      // 为每个材料添加列宽（基础信息 + 编码信息）
      const maxMaterialCount = finalExportData.maxMaterialCount || 1;
      
      for (let i = 1; i <= maxMaterialCount; i++) {
        // 🆕 基础材料列宽（增加接头类型和寸径列）
        baseColumns.push(
          { wch: 8 },  // 材料序号
          { wch: 25 }, // 材料描述
          { wch: 10 }, // 🆕 接头类型
          { wch: 15 }, // 规格
          { wch: 10 }, // 寸径
          { wch: 12 }, // 材料代码
          { wch: 8 },  // 数量
          { wch: 12 }, // 管线号
          { wch: 12 }, // 图号
          { wch: 10 }, // OCR页码
          { wch: 10 }  // 计算页码
        );
        
        // 如果启用了编码，添加编码列宽
        if (enableEncoding) {
          baseColumns.push(
            { wch: 12 }, // 种类
            { wch: 12 }, // 尺寸
            { wch: 10 }, // 壁厚
            { wch: 12 }, // 🆕 壁厚号
            { wch: 12 }, // 磅级
            { wch: 12 }, // 材质
            { wch: 15 }, // 规范
            { wch: 18 }, // 编码
            { wch: 10 }, // 置信度
            { wch: 15 }  // 编码来源
          );
        }
      }
    } else {
      // 🆕 原有材料主导结构的列宽（增加接头类型和寸径列）
      baseColumns = [
        { wch: 10 }, // 材料编号
        { wch: 25 }, // 材料描述
        { wch: 10 }, // 🆕 接头类型
        { wch: 15 }, // 规格
        { wch: 10 }, // 寸径
        { wch: 12 }, // 材料代码
        { wch: 8 },  // 数量
        { wch: 15 }, // 管线号
        { wch: 15 }, // 图号
        { wch: 12 }, // OCR页码
        { wch: 12 }  // 计算页码
      ];
    }

    // 焊口信息列（已包含在baseColumns中）
    const weldSeamColumns = [];

    // 编码列宽已在上面包含，不需要单独处理
    const encodingColumns = []; // 空数组，因为编码列宽已在baseColumns中

    ws['!cols'] = baseColumns; // 编码列宽已包含在baseColumns中

    const wb = XLSX.utils.book_new();
    
    // 检查是否真的包含编码数据（检查动态生成的编码列名）
    const actualHasEncodingData = headers.some(header => header.includes('编码')) && headers.some(header => header.includes('置信度'));
    
    let sheetName;
    if (hasWeldSeamData) {
      sheetName = actualHasEncodingData ? '焊口表_已编码' : '焊口表';
    } else {
      sheetName = actualHasEncodingData ? 'OCR识别结果_已编码' : 'OCR识别结果';
    }
    XLSX.utils.book_append_sheet(wb, ws, sheetName);

    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    let suffix = '';
    if (hasWeldSeamData) {
      suffix = actualHasEncodingData ? '_焊口表_已编码' : '_焊口表';
    } else if (enableEncoding) {
      suffix = actualHasEncodingData ? '_已编码' : '_编码失败';
    }
    const baseName = pdfFileName ? `result_${pdfFileName}${suffix}_${timestamp}` : `result${suffix}_${timestamp}`;
    const fileName = `${baseName}.xlsx`;

    XLSX.writeFile(wb, fileName);
    
    // 根据实际情况显示成功消息
    
    if (hasWeldSeamData) {
      if (enableEncoding) {
        if (actualHasEncodingData) {
          console.log(`✅ 已导出包含编码信息的焊口表: ${fileName}`);
        } else {
          console.log(`⚠️ 编码服务不可用，已导出基础焊口表: ${fileName}`);
        }
      } else {
        console.log(`✅ 已导出焊口表: ${fileName}`);
      }
    } else {
      if (enableEncoding) {
        if (actualHasEncodingData) {
          console.log(`✅ 已导出包含编码信息的材料表: ${fileName}`);
        } else {
          console.log(`⚠️ 编码服务不可用，已导出基础材料表: ${fileName}`);
        }
      } else {
        console.log(`✅ 已导出材料表: ${fileName}`);
      }
    }
    
    return { fileName, exportData, hasEncodingData: actualHasEncodingData };
  },

  /**
   * 为OCR数据添加计算页码和寸径
   * @param {Array} originalOcrRows - 原始OCR数据
   */
  addCalculatedPageNumbers(originalOcrRows) {
    const ocrLogicalRowsWithPageNumbers = [];
    let currentPageNumber = 1; // 初始化计算页码为1

    for (let i = 0; i < originalOcrRows.length; i++) {
      const row = originalOcrRows[i];
      
      // 新的页码计算逻辑：当材料编号（第一列）为1且不是第一行时，页码加1
      if (i > 0 && Number(row[0]) === 1) {
        currentPageNumber++;
      }
      
      const calculatedPage = currentPageNumber;
      
      // 将计算的页码添加到行数据的第9列
      const rowWithPage = [...row, calculatedPage];
      ocrLogicalRowsWithPageNumbers.push(rowWithPage);
    }

    // 🆕 添加寸径计算
    const ocrLogicalRowsWithInchDiameter = ocrLogicalRowsWithPageNumbers.map(row => {
      const spec = row[2]; // 规格在第3列（索引2）
      const inchDiameter = calculateInchDiameter(spec);
      
      // 插入寸径到规格之后（位置3）
      return [
        row[0], // 序号
        row[1], // 材料描述
        row[2], // 规格
        inchDiameter, // 🆕 寸径
        ...row.slice(3) // 其余列
      ];
    });

    // 🆕 添加接头类型提取
    const ocrLogicalRowsWithJointType = ocrLogicalRowsWithInchDiameter.map(row => {
      const materialDesc = row[1]; // 材料描述在第2列（索引1）
      const jointType = extractJointType(materialDesc);
      
      // 插入接头类型到材料描述之后（位置2）
      return [
        row[0], // 序号
        row[1], // 材料描述
        jointType, // 🆕 接头类型
        ...row.slice(2) // 其余列（规格、寸径、材料代码、数量、管线号、图号、OCR页码、计算页码）
      ];
    });

    return ocrLogicalRowsWithJointType;
  },

  /**
   * 验证OCR结果数据格式
   * @param {Array} ocrResults - OCR结果数组
   */
  validateOcrResults(ocrResults) {
    if (!Array.isArray(ocrResults)) {
      return { valid: false, error: 'OCR结果必须是数组格式' };
    }

    if (ocrResults.length === 0) {
      return { valid: false, error: 'OCR结果为空' };
    }

    // 检查每行数据格式
    for (let i = 0; i < ocrResults.length; i++) {
      const row = ocrResults[i];
      if (!Array.isArray(row)) {
        return { valid: false, error: `第${i + 1}行数据格式错误，应为数组` };
      }
      
      if (row.length < 7) {
        return { valid: false, error: `第${i + 1}行数据不完整，至少需要7列` };
      }
    }

    return { valid: true };
  }
};

export default OCRUtils;
