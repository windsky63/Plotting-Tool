/**
 * 矢量元素提取工具
 * 提取PDF中的线段、矩形等几何元素（参考 pdf_equipment_app）
 */

export class VectorExtractionUtils {
  static pdfjsApi = null;

  static configurePdfJs(pdfjsApi) {
    if (!pdfjsApi?.OPS) {
      throw new Error('Vector extraction requires a PDF.js API with OPS');
    }
    this.pdfjsApi = pdfjsApi;
  }

  static vectorCache = new Map();

  // 矢量数组可能远大于页面位图索引。使用小型 LRU，避免全页处理时
  // 当前文档的矢量缓存按页数无限增长；被淘汰页面可按需重新提取。
  static vectorCacheMaxEntries = 24;

  static inFlightRequests = new Map();

  static pdfLibSourceCache = new Map();

  static pdfLibReleaseTimers = new Map();

  static activeDocumentKey = null;

  static activateDocument(documentKey) {
    if (!documentKey) return;
    if (this.activeDocumentKey && this.activeDocumentKey !== documentKey) {
      // Vector arrays and parsed pdf-lib documents are large. They only serve
      // the currently opened drawing, so release the previous drawing here.
      this.vectorCache.clear();
      this.inFlightRequests.clear();
      this.pdfLibSourceCache.clear();
      this.pdfLibReleaseTimers.forEach(timer => clearTimeout(timer));
      this.pdfLibReleaseTimers.clear();
    }
    this.activeDocumentKey = documentKey;
  }

  static getDocumentCacheKey() {
    const pdfPath = window.__currentPdfPath__ || window.__lastOpenedPdfPath__;
    const pdfFile = window.__currentPdfFile__ || window.__lastOpenedPdfFile__;

    if (pdfPath) {
      const documentKey = `path:${pdfPath}`;
      this.activateDocument(documentKey);
      return documentKey;
    }

    if (pdfFile) {
      const fileName = pdfFile.name || 'unnamed';
      const fileSize = typeof pdfFile.size === 'number' ? pdfFile.size : 'unknown';
      const lastModified = typeof pdfFile.lastModified === 'number' ? pdfFile.lastModified : 0;
      const documentKey = `file:${fileName}:${fileSize}:${lastModified}`;
      this.activateDocument(documentKey);
      return documentKey;
    }

    return null;
  }

  static getPageCacheKey(page) {
    if (!page) return null;

    const pageNumber = page._pageIndex + 1;
    const documentKey = this.getDocumentCacheKey();

    if (documentKey) {
      return `${documentKey}:page:${pageNumber}`;
    }

    return `page:${pageNumber}`;
  }

  static getCachedVectors(cacheKey) {
    if (!cacheKey || !this.vectorCache.has(cacheKey)) return null;
    const value = this.vectorCache.get(cacheKey);
    this.vectorCache.delete(cacheKey);
    this.vectorCache.set(cacheKey, value);
    return value;
  }

  static cacheVectors(cacheKey, vectors) {
    if (!cacheKey) return;
    if (this.vectorCache.has(cacheKey)) this.vectorCache.delete(cacheKey);
    this.vectorCache.set(cacheKey, vectors);
    while (this.vectorCache.size > this.vectorCacheMaxEntries) {
      const oldestKey = this.vectorCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.vectorCache.delete(oldestKey);
    }
  }

  static clearCacheForCurrentDocument() {
    const documentKey = this.getDocumentCacheKey();
    if (!documentKey) return;

    for (const key of this.vectorCache.keys()) {
      if (key.startsWith(`${documentKey}:page:`)) {
        this.vectorCache.delete(key);
      }
    }

    for (const key of this.inFlightRequests.keys()) {
      if (key.startsWith(`${documentKey}:page:`)) {
        this.inFlightRequests.delete(key);
      }
    }
    this.pdfLibSourceCache.delete(documentKey);
    const releaseTimer = this.pdfLibReleaseTimers.get(documentKey);
    if (releaseTimer) clearTimeout(releaseTimer);
    this.pdfLibReleaseTimers.delete(documentKey);
  }

  static schedulePdfLibSourceRelease(documentKey, delayMs = 2 * 60 * 1000) {
    if (!documentKey) return;
    const previousTimer = this.pdfLibReleaseTimers.get(documentKey);
    if (previousTimer) clearTimeout(previousTimer);
    const timer = setTimeout(() => {
      this.pdfLibReleaseTimers.delete(documentKey);
      this.pdfLibSourceCache.delete(documentKey);
      console.log('[Vector] 已释放空闲的整份 pdf-lib 解析文档');
    }, delayMs);
    this.pdfLibReleaseTimers.set(documentKey, timer);
  }

  static releasePdfLibSourceDocument(documentKey = this.activeDocumentKey) {
    if (!documentKey) return false;
    const timer = this.pdfLibReleaseTimers.get(documentKey);
    if (timer) clearTimeout(timer);
    this.pdfLibReleaseTimers.delete(documentKey);
    return this.pdfLibSourceCache.delete(documentKey);
  }

  static async yieldToMainThread() {
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  static getFileDocumentKey(pdfFile) {
    const fileName = pdfFile?.name || 'unnamed';
    const fileSize = typeof pdfFile?.size === 'number' ? pdfFile.size : 'unknown';
    const lastModified = typeof pdfFile?.lastModified === 'number' ? pdfFile.lastModified : 0;
    return `file:${fileName}:${fileSize}:${lastModified}`;
  }

  static async getPdfLibSourceDocument(pdfFile) {
    // Use the same key as vector extraction (path mode may still also expose a
    // File object). This prevents alternating path/file keys from evicting the
    // parsed source on every page.
    const documentKey = this.getDocumentCacheKey() || this.getFileDocumentKey(pdfFile);
    this.activateDocument(documentKey);
    if (this.pdfLibSourceCache.has(documentKey)) {
      const cached = await this.pdfLibSourceCache.get(documentKey);
      this.schedulePdfLibSourceRelease(documentKey);
      return cached;
    }

    const loadPromise = (async () => {
      const { PDFDocument } = await import('pdf-lib');
      await this.yieldToMainThread();
      const sourceBytes = await pdfFile.arrayBuffer();
      await this.yieldToMainThread();
      const sourceDoc = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });
      return { PDFDocument, sourceDoc };
    })();
    this.pdfLibSourceCache.set(documentKey, loadPromise);
    try {
      const loaded = await loadPromise;
      this.schedulePdfLibSourceRelease(documentKey);
      return loaded;
    } catch (error) {
      this.pdfLibSourceCache.delete(documentKey);
      throw error;
    }
  }

  static async extractSinglePagePdf(pdfFile, pageNumber) {
    if (!pdfFile || !(pdfFile instanceof File || pdfFile instanceof Blob)) {
      return null;
    }

    try {
      const { PDFDocument, sourceDoc } = await this.getPdfLibSourceDocument(pdfFile);
      const totalPages = sourceDoc.getPageCount();
      const sourcePageIndex = Math.max(0, Math.min(totalPages - 1, pageNumber - 1));

      await this.yieldToMainThread();
      const targetDoc = await PDFDocument.create();
      const [copiedPage] = await targetDoc.copyPages(sourceDoc, [sourcePageIndex]);
      targetDoc.addPage(copiedPage);

      await this.yieldToMainThread();
      const outputBytes = await targetDoc.save();
      return new Blob([outputBytes], { type: 'application/pdf' });
    } catch (error) {
      console.warn('[Vector] failed to slice current page PDF, using original file:', error);
      return null;
    }
  }

  
  /**
   * 从 PDF 页面提取矢量元素（线段、矩形等）
   * @param {Object} page - PDF.js 页面对象
   * @returns {Promise<Array>} - 矢量元素数组，格式: [type, x1, y1, x2, y2, color, width, id]
   */
  static async extractVectors(page) {
    if (!page) return [];

    const cacheKey = this.getPageCacheKey(page);

    const cachedVectors = this.getCachedVectors(cacheKey);
    if (cachedVectors) return cachedVectors;

    if (cacheKey && this.inFlightRequests.has(cacheKey)) {
      return this.inFlightRequests.get(cacheKey);
    }

    const extractionPromise = (async () => {
      try {
        // 🎯 方案1：使用后端PyMuPDF的get_drawings() API（推荐）
        // 这个方法会自动处理Form XObject、Pattern等复杂情况
        const pymupdfElements = await this.extractVectorsWithPyMuPDF(page);
        if (pymupdfElements.length > 0) {
          console.log(`🎯 从PyMuPDF提取到 ${pymupdfElements.length} 个矢量元素（完整提取）`);
          if (cacheKey && cacheKey.startsWith(`${this.activeDocumentKey}:page:`)) {
            this.cacheVectors(cacheKey, pymupdfElements);
          }
          return pymupdfElements;
        }
      
        // 🔧 方案2：使用OperatorList方法（分辨率独立，使用scale=1.0归一化坐标）
        // 这样可以确保在不同分辨率的图纸之间矢量坐标保持一致
        const opElements = await this.extractElementsFromOperatorList(page);
        if (opElements.length > 0) {
          console.log(`🎯 从OperatorList提取到 ${opElements.length} 个矢量元素（归一化坐标）`);
          if (cacheKey && cacheKey.startsWith(`${this.activeDocumentKey}:page:`)) {
            this.cacheVectors(cacheKey, opElements);
          }
          return opElements;
        }

        // 降级方案：从SVG DOM提取线段（需要时使用）
        // 注意：SVG方法提取的坐标依赖于渲染scale，可能在不同分辨率下不一致
        let svgElements = [];
        for (let i = 0; i < 3; i++) {
          svgElements = await this.extractElementsFromSVG(page);
          if (svgElements.length > 0) break;
          await new Promise(resolve => setTimeout(resolve, 500)); // 等待500ms
        }
      
        if (svgElements.length > 0) {
          console.warn(`⚠️ 使用SVG提取到 ${svgElements.length} 个矢量元素（坐标可能受渲染scale影响）`);
          if (cacheKey && cacheKey.startsWith(`${this.activeDocumentKey}:page:`)) {
            this.cacheVectors(cacheKey, svgElements);
          }
          return svgElements;
        }

        console.warn('⚠️ 未能提取到任何矢量元素');
        return [];
      
      } catch (error) {
        console.error('Error extracting vector elements:', error);
        return [];
      } finally {
        if (cacheKey) {
          this.inFlightRequests.delete(cacheKey);
        }
      }
    })();

    if (cacheKey) {
      this.inFlightRequests.set(cacheKey, extractionPromise);
    }

    return extractionPromise;
  }

  /**
   * 使用后端PyMuPDF提取矢量（推荐方法）
   * @param {Object} page - PDF.js 页面对象
   * @returns {Promise<Array>} - 矢量元素数组
   */
  static async extractVectorsWithPyMuPDF(page) {
    try {
      // 检查是否有全局PDF文件对象
      const pdfFile = window.__currentPdfFile__ || window.__lastOpenedPdfFile__;
      const pdfPath = window.__currentPdfPath__ || window.__lastOpenedPdfPath__;
      const pageNumber = page._pageIndex + 1;
      
      // 确定OCR服务地址
      const ocrServerUrl = window.__ocrServerUrl__ || 'http://192.168.32.61:8766';
      
      // 方案1：使用文件上传方式（Web模式）
      if (pdfFile) {
        console.log(`🔧 提取矢量（上传方式）: 第${pageNumber}页`);
        
        let uploadFile = pdfFile;
        let uploadFileName = pdfFile.name || 'document.pdf';
        let uploadPageIndex = pageNumber;
        const slicedPdf = await this.extractSinglePagePdf(pdfFile, pageNumber);

        if (slicedPdf) {
          uploadFile = slicedPdf;
          uploadFileName = uploadFileName.replace(/\.pdf$/i, '') + '_page_' + pageNumber + '.pdf';
          uploadPageIndex = 1;
          console.log('[Vector] current page sliced for vector extraction:', {
            originalMB: pdfFile.size ? (pdfFile.size / 1024 / 1024).toFixed(2) : 'unknown',
            uploadMB: uploadFile.size ? (uploadFile.size / 1024 / 1024).toFixed(2) : 'unknown',
            page: pageNumber
          });
        }

        const formData = new FormData();
        formData.append('pdf_file', uploadFile, uploadFileName);
        formData.append('page_index', uploadPageIndex);
        
        const response = await fetch(`${ocrServerUrl}/api/vectors/extract-vectors-upload`, {
          method: 'POST',
          body: formData
        });
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const result = await response.json();
        const method = result.page_info?.method || 'unknown';
        const totalPaths = result.page_info?.total_paths || 'unknown';
        const methodName = method === 'poppler' ? 'Poppler+SVG' : method === 'pymupdf' ? 'PyMuPDF' : method;
        console.log(`✅ ${methodName}提取成功: ${result.vectors.length} 个矢量元素, ${totalPaths} 个独立路径`);
        return result.vectors;
      }
      
      // 方案2：使用文件路径方式（Electron模式）
      if (pdfPath) {
        console.log(`🔧 提取矢量（路径方式）: 第${pageNumber}页`);
        
        const response = await fetch(`${ocrServerUrl}/api/vectors/extract-vectors`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            pdf_path: pdfPath,
            page_index: pageNumber
          })
        });
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const result = await response.json();
        const method = result.page_info?.method || 'unknown';
        const totalPaths = result.page_info?.total_paths || 'unknown';
        const methodName = method === 'poppler' ? 'Poppler+SVG' : method === 'pymupdf' ? 'PyMuPDF' : method;
        console.log(`✅ ${methodName}提取成功: ${result.vectors.length} 个矢量元素, ${totalPaths} 个独立路径`);
        return result.vectors;
      }
      
      console.warn('⚠️ 无法使用PyMuPDF提取：缺少PDF文件或路径');
      return [];
      
    } catch (error) {
      console.warn(`⚠️ PyMuPDF提取失败，将使用降级方案: ${error.message}`);
      return [];
    }
  }

  /**
   * 从SVG DOM中提取线段元素
   */
  static async extractElementsFromSVG(page) {
    try {
      // 尝试多种选择器
      const pageIndex = page._pageIndex + 1;
      let svg = document.querySelector(`.react-pdf__Page[data-page-number="${pageIndex}"] svg`);
      
      if (!svg) {
        // 尝试通过 page 对象的 viewport 查找
        const allSvgs = document.querySelectorAll('.react-pdf__Page svg');
        if (allSvgs.length > 0) {
           // 如果找不到特定页面的SVG，尝试使用第一个（单页模式下通常只有一个）
           svg = allSvgs[0];
        }
      }

      if (!svg) {
        // console.warn('未找到SVG元素');
        return [];
      }

      // 🔧 获取归一化viewport（scale=1.0）以计算坐标缩放比例
      const normalizedViewport = page.getViewport({ scale: 1.0 });
      const pdfWidth = normalizedViewport.width;
      const pdfHeight = normalizedViewport.height;
      
      // 获取SVG实际渲染尺寸
      const svgWidth = parseFloat(svg.getAttribute('width') || svg.viewBox?.baseVal?.width || pdfWidth);
      const svgHeight = parseFloat(svg.getAttribute('height') || svg.viewBox?.baseVal?.height || pdfHeight);
      
      // 计算归一化缩放因子：将SVG坐标转换为PDF原始坐标（scale=1.0）
      const scaleFactorX = pdfWidth / svgWidth;
      const scaleFactorY = pdfHeight / svgHeight;
      
      console.log(`📐 SVG归一化信息:`, {
        PDF原始尺寸: `${pdfWidth.toFixed(0)} × ${pdfHeight.toFixed(0)}`,
        SVG渲染尺寸: `${svgWidth.toFixed(0)} × ${svgHeight.toFixed(0)}`,
        缩放因子: `X=${scaleFactorX.toFixed(4)}, Y=${scaleFactorY.toFixed(4)}`
      });

      const elements = [];
      let elementId = 0;

      // 提取 line 元素
        const lines = svg.querySelectorAll('line');
        lines.forEach(line => {
          // 读取SVG坐标
          const x1_svg = parseFloat(line.getAttribute('x1') || '0');
          const y1_svg = parseFloat(line.getAttribute('y1') || '0');
          const x2_svg = parseFloat(line.getAttribute('x2') || '0');
          const y2_svg = parseFloat(line.getAttribute('y2') || '0');
          const stroke = line.getAttribute('stroke') || '#000000';
          const strokeWidth = parseFloat(line.getAttribute('stroke-width') || '1');

          // 🔧 归一化坐标：转换为PDF原始坐标（scale=1.0）
          const x1 = x1_svg * scaleFactorX;
          const y1 = y1_svg * scaleFactorY;
          const x2 = x2_svg * scaleFactorX;
          const y2 = y2_svg * scaleFactorY;

          // 转换颜色为整数
          const colorInt = this.colorToInt(stroke);

          // 格式: [type, x1, y1, x2, y2, color, width, id]
          elements.push([0, x1, y1, x2, y2, colorInt, strokeWidth, elementId++]);
        });

        // 提取 rect 元素，转换为4条线段
        const rects = svg.querySelectorAll('rect');
        rects.forEach(rect => {
          // 读取SVG坐标
          const x_svg = parseFloat(rect.getAttribute('x') || '0');
          const y_svg = parseFloat(rect.getAttribute('y') || '0');
          const width_svg = parseFloat(rect.getAttribute('width') || '0');
          const height_svg = parseFloat(rect.getAttribute('height') || '0');
          const stroke = rect.getAttribute('stroke') || '#000000';
          const strokeWidth = parseFloat(rect.getAttribute('stroke-width') || '1');

          // 🔧 归一化坐标和尺寸
          const x = x_svg * scaleFactorX;
          const y = y_svg * scaleFactorY;
          const width = width_svg * scaleFactorX;
          const height = height_svg * scaleFactorY;

          const colorInt = this.colorToInt(stroke);
          const rectId = elementId++;

          // 矩形的4条边
          const rectLines = [
            [x, y, x + width, y],           // 上边
            [x + width, y, x + width, y + height], // 右边
            [x + width, y + height, x, y + height], // 下边
            [x, y + height, x, y]           // 左边
          ];

          rectLines.forEach(([x1, y1, x2, y2]) => {
            elements.push([0, x1, y1, x2, y2, colorInt, strokeWidth, rectId]);
          });
        });

        // 提取 path 元素中的线段
        const paths = svg.querySelectorAll('path');
        paths.forEach(path => {
          const d = path.getAttribute('d');
          const stroke = path.getAttribute('stroke') || '#000000';
          const strokeWidth = parseFloat(path.getAttribute('stroke-width') || '1');
          
          if (d && d !== 'none') {
            // 🔧 传入缩放因子进行坐标归一化
            const pathElements = this.parsePathToLines(d, stroke, strokeWidth, elementId, scaleFactorX, scaleFactorY);
            elements.push(...pathElements);
            elementId += pathElements.length;
          }
        });

      return elements;
    } catch (error) {
      console.warn('SVG element extraction failed:', error);
      return [];
    }
  }

  /**
   * 从OperatorList提取线段元素
   */
  static async extractElementsFromOperatorList(page) {
    try {
      const startTime = performance.now();
      const operatorList = await page.getOperatorList();
      const { fnArray, argsArray } = operatorList;
      
      // 🚀 性能优化：如果操作数量过多（可能包含签名等复杂内容），限制处理数量
      const MAX_OPERATIONS = 50000; // 最多处理5万个操作
      const isLargeOperatorList = fnArray.length > MAX_OPERATIONS;
      
      if (isLargeOperatorList) {
        console.warn(`⚠️ 操作数量过多 (${fnArray.length})，可能包含签名等复杂内容，将限制处理数量以提升性能`);
      }
      
      // 获取默认视口以进行坐标转换
      // scale=1.0 保证我们获取的是基础PDF单位，后续显示时再根据缩放比例调整
      const viewport = page.getViewport({ scale: 1.0 });
      const transform = viewport.transform;
      
      // 辅助函数：应用变换矩阵 [a, b, c, d, tx, ty]
      // x' = x*a + y*c + tx
      // y' = x*b + y*d + ty
      const applyTransform = (x, y) => {
        return {
          x: x * transform[0] + y * transform[2] + transform[4],
          y: x * transform[1] + y * transform[3] + transform[5]
        };
      };
      
      console.log(`🔍 页面操作数量: ${fnArray.length}, 变换矩阵:`, transform);
      
      const elements = [];
      const OPS = this.pdfjsApi?.OPS;
      if (!OPS) {
        throw new Error('PDF.js must be configured before vector extraction');
      }
      
      let currentX = 0, currentY = 0;
      let elementId = 0;
      let currentColor = 0; // 黑色
      let lineWidth = 1;
      
      // 🆕 统计各类操作的数量
      const opStats = {
        constructPath: 0,
        lineTo: 0,
        rectangle: 0,
        curveTo: 0,
        curveTo2: 0,
        curveTo3: 0,
        moveTo: 0
      };
      
      // 📊 统计所有操作类型（用于发现未处理的操作）
      const allOpTypes = {};
      
      // 🔍 统计constructPath内部的操作类型
      const pathInternalOps = {};
      
      // 🆕 记录被跳过的未知操作
      const skippedOps = new Set();
      
      // 🚀 性能优化：限制处理的操作数量
      const operationsToProcess = isLargeOperatorList ? 
        Math.min(fnArray.length, MAX_OPERATIONS) : 
        fnArray.length;

      for (let i = 0; i < operationsToProcess; i++) {
        const fn = fnArray[i];
        const args = argsArray[i];
        
        // 📊 统计所有操作类型
        const opName = Object.keys(OPS).find(key => OPS[key] === fn) || `Unknown_${fn}`;
        allOpTypes[opName] = (allOpTypes[opName] || 0) + 1;
        
        // 🚀 性能优化：跳过某些与矢量图形无关的操作（如文字、图像、注释等）
        if (fn === OPS.paintImageXObject || 
            fn === OPS.paintInlineImageXObject ||
            fn === OPS.paintImageMaskXObject ||
            fn === OPS.paintFormXObjectBegin ||
            fn === OPS.paintFormXObjectEnd ||
            fn === OPS.beginMarkedContent ||
            fn === OPS.beginMarkedContentProps ||
            fn === OPS.endMarkedContent ||
            fn === OPS.showText ||
            fn === OPS.showSpacedText ||
            fn === OPS.nextLine ||
            fn === OPS.nextLineShowText ||
            fn === OPS.nextLineSetSpacingShowText) {
          continue; // 跳过这些操作
        }

        if (fn === OPS.constructPath) {
           opStats.constructPath++;
           const pathOps = args[0];
           const pathArgs = args[1];
           let argIndex = 0;
           let pathStartX = 0, pathStartY = 0;
           
           // 🔑 关键修复：为整个 constructPath 分配一个统一的 ID
           const currentPathId = elementId++;
           
           for (let j = 0; j < pathOps.length; j++) {
             const op = pathOps[j];
             
             // 📊 统计内部操作类型
             const opName = Object.keys(OPS).find(key => OPS[key] === op) || `Unknown_${op}`;
             pathInternalOps[opName] = (pathInternalOps[opName] || 0) + 1;
             
             if (op === OPS.moveTo) {
               currentX = pathArgs[argIndex++];
               currentY = pathArgs[argIndex++];
               pathStartX = currentX;
               pathStartY = currentY;
             } else if (op === OPS.lineTo) {
               const rawX2 = pathArgs[argIndex++];
               const rawY2 = pathArgs[argIndex++];
               
               // 转换坐标
               const p1 = applyTransform(currentX, currentY);
               const p2 = applyTransform(rawX2, rawY2);
               
               // ✅ 使用 currentPathId 而不是 elementId++
               elements.push([0, p1.x, p1.y, p2.x, p2.y, currentColor, lineWidth, currentPathId]);
               currentX = rawX2;
               currentY = rawY2;
             } else if (op === OPS.rectangle) {
               const x = pathArgs[argIndex++];
               const y = pathArgs[argIndex++];
               const w = pathArgs[argIndex++];
               const h = pathArgs[argIndex++];
               
               // ✅ 矩形也使用 currentPathId
               // 矩形四个顶点
               const p1 = applyTransform(x, y);
               const p2 = applyTransform(x + w, y);
               const p3 = applyTransform(x + w, y + h);
               const p4 = applyTransform(x, y + h);

               elements.push([0, p1.x, p1.y, p2.x, p2.y, currentColor, lineWidth, currentPathId]);
               elements.push([0, p2.x, p2.y, p3.x, p3.y, currentColor, lineWidth, currentPathId]);
               elements.push([0, p3.x, p3.y, p4.x, p4.y, currentColor, lineWidth, currentPathId]);
               elements.push([0, p4.x, p4.y, p1.x, p1.y, currentColor, lineWidth, currentPathId]);
            } else if (op === OPS.close || op === OPS.closePath) {
               if (currentX !== pathStartX || currentY !== pathStartY) {
                  const p1 = applyTransform(currentX, currentY);
                  const p2 = applyTransform(pathStartX, pathStartY);
                  // ✅ close/closePath 也使用 currentPathId
                  elements.push([0, p1.x, p1.y, p2.x, p2.y, currentColor, lineWidth, currentPathId]);
                  currentX = pathStartX;
                  currentY = pathStartY;
               }
            }
            else if (op === OPS.curveTo) {
              // 三次贝塞尔曲线：curveTo(x1, y1, x2, y2, x3, y3)
              const x1 = pathArgs[argIndex++];
              const y1 = pathArgs[argIndex++];
              const x2 = pathArgs[argIndex++];
              const y2 = pathArgs[argIndex++];
              const x3 = pathArgs[argIndex++];
              const y3 = pathArgs[argIndex++];
              
              // 🔧 将贝塞尔曲线近似为多段直线
              const p0 = applyTransform(currentX, currentY);
              const p1 = applyTransform(x1, y1);
              const p2 = applyTransform(x2, y2);
              const p3 = applyTransform(x3, y3);
              
              // 使用4段直线近似曲线
              const steps = 4;
              for (let t = 0; t < steps; t++) {
                const t1 = t / steps;
                const t2 = (t + 1) / steps;
                
                // 计算贝塞尔曲线上的点
                const pt1 = this.cubicBezier(p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, p3.x, p3.y, t1);
                const pt2 = this.cubicBezier(p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, p3.x, p3.y, t2);
                
                elements.push([0, pt1.x, pt1.y, pt2.x, pt2.y, currentColor, lineWidth, currentPathId]);
              }
              
              currentX = x3;
              currentY = y3;
            }
            else if (op === OPS.curveTo2) {
              // 二次贝塞尔曲线：curveTo2(x1, y1, x2, y2)
              const x1 = pathArgs[argIndex++];
              const y1 = pathArgs[argIndex++];
              const x2 = pathArgs[argIndex++];
              const y2 = pathArgs[argIndex++];
              
              const p0 = applyTransform(currentX, currentY);
              const p1 = applyTransform(x1, y1);
              const p2 = applyTransform(x2, y2);
              
              // 使用3段直线近似曲线
              const steps = 3;
              for (let t = 0; t < steps; t++) {
                const t1 = t / steps;
                const t2 = (t + 1) / steps;
                
                const pt1 = this.quadraticBezier(p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, t1);
                const pt2 = this.quadraticBezier(p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, t2);
                
                elements.push([0, pt1.x, pt1.y, pt2.x, pt2.y, currentColor, lineWidth, currentPathId]);
              }
              
              currentX = x2;
              currentY = y2;
            }
            else if (op === OPS.curveTo3) {
              // 简化贝塞尔曲线：curveTo3(x1, y1, x2, y2)
              const x1 = pathArgs[argIndex++];
              const y1 = pathArgs[argIndex++];
              const x2 = pathArgs[argIndex++];
              const y2 = pathArgs[argIndex++];
              
              const p0 = applyTransform(currentX, currentY);
              const p1 = applyTransform(x1, y1);
              const p2 = applyTransform(x2, y2);
              
              // 使用3段直线近似曲线
              const steps = 3;
              for (let t = 0; t < steps; t++) {
                const t1 = t / steps;
                const t2 = (t + 1) / steps;
                
                const pt1 = this.quadraticBezier(p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, t1);
                const pt2 = this.quadraticBezier(p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, t2);
                
                elements.push([0, pt1.x, pt1.y, pt2.x, pt2.y, currentColor, lineWidth, currentPathId]);
              }
              
              currentX = x2;
              currentY = y2;
            }
            else {
              // ⚠️ 未知的路径操作 - 记录以便分析
              const unknownOpName = Object.keys(OPS).find(key => OPS[key] === op) || `Unknown_${op}`;
              skippedOps.add(unknownOpName);
              
              // 已知但未处理的操作（PDF规范定义的操作）
              // 这些操作通常不影响矢量提取，或者参数数量不确定
            }
           }
        }
        else if (fn === OPS.moveTo && args.length >= 2) {
          opStats.moveTo++;
          currentX = args[0];
          currentY = args[1];
        } 
        else if (fn === OPS.lineTo && args.length >= 2) {
          opStats.lineTo++;
          const rawX2 = args[0];
          const rawY2 = args[1];
          
          const p1 = applyTransform(currentX, currentY);
          const p2 = applyTransform(rawX2, rawY2);
          
          elements.push([0, p1.x, p1.y, p2.x, p2.y, currentColor, lineWidth, elementId++]);
          
          currentX = rawX2;
          currentY = rawY2;
        }
        else if (fn === OPS.rectangle && args.length >= 4) {
          opStats.rectangle++;
          const [x, y, w, h] = args;
          const rectId = elementId++;
          
          const p1 = applyTransform(x, y);
          const p2 = applyTransform(x + w, y);
          const p3 = applyTransform(x + w, y + h);
          const p4 = applyTransform(x, y + h);

          elements.push([0, p1.x, p1.y, p2.x, p2.y, currentColor, lineWidth, rectId]);
          elements.push([0, p2.x, p2.y, p3.x, p3.y, currentColor, lineWidth, rectId]);
          elements.push([0, p3.x, p3.y, p4.x, p4.y, currentColor, lineWidth, rectId]);
          elements.push([0, p4.x, p4.y, p1.x, p1.y, currentColor, lineWidth, rectId]);
        }
        // 🆕 处理独立的曲线操作
        else if (fn === OPS.curveTo && args.length >= 6) {
          opStats.curveTo++;
          // 三次贝塞尔曲线
          const [x1, y1, x2, y2, x3, y3] = args;
          const curveId = elementId++;
          
          const p0 = applyTransform(currentX, currentY);
          const p1 = applyTransform(x1, y1);
          const p2 = applyTransform(x2, y2);
          const p3 = applyTransform(x3, y3);
          
          // 使用4段直线近似曲线
          const steps = 4;
          for (let t = 0; t < steps; t++) {
            const t1 = t / steps;
            const t2 = (t + 1) / steps;
            
            const pt1 = this.cubicBezier(p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, p3.x, p3.y, t1);
            const pt2 = this.cubicBezier(p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, p3.x, p3.y, t2);
            
            elements.push([0, pt1.x, pt1.y, pt2.x, pt2.y, currentColor, lineWidth, curveId]);
          }
          
          currentX = x3;
          currentY = y3;
        }
        else if (fn === OPS.curveTo2 && args.length >= 4) {
          opStats.curveTo2++;
          // 二次贝塞尔曲线
          const [x1, y1, x2, y2] = args;
          const curveId = elementId++;
          
          const p0 = applyTransform(currentX, currentY);
          const p1 = applyTransform(x1, y1);
          const p2 = applyTransform(x2, y2);
          
          // 使用3段直线近似曲线
          const steps = 3;
          for (let t = 0; t < steps; t++) {
            const t1 = t / steps;
            const t2 = (t + 1) / steps;
            
            const pt1 = this.quadraticBezier(p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, t1);
            const pt2 = this.quadraticBezier(p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, t2);
            
            elements.push([0, pt1.x, pt1.y, pt2.x, pt2.y, currentColor, lineWidth, curveId]);
          }
          
          currentX = x2;
          currentY = y2;
        }
        else if (fn === OPS.curveTo3 && args.length >= 4) {
          opStats.curveTo3++;
          // 简化贝塞尔曲线
          const [x1, y1, x2, y2] = args;
          const curveId = elementId++;
          
          const p0 = applyTransform(currentX, currentY);
          const p1 = applyTransform(x1, y1);
          const p2 = applyTransform(x2, y2);
          
          // 使用3段直线近似曲线
          const steps = 3;
          for (let t = 0; t < steps; t++) {
            const t1 = t / steps;
            const t2 = (t + 1) / steps;
            
            const pt1 = this.quadraticBezier(p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, t1);
            const pt2 = this.quadraticBezier(p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, t2);
            
            elements.push([0, pt1.x, pt1.y, pt2.x, pt2.y, currentColor, lineWidth, curveId]);
          }
          
          currentX = x2;
          currentY = y2;
        }
        else if (fn === OPS.setLineWidth && args.length >= 1) {
          lineWidth = args[0];
        }
        else if (fn === OPS.setStrokeRGBColor && args.length >= 3) {
          const r = Math.round(args[0] * 255);
          const g = Math.round(args[1] * 255);
          const b = Math.round(args[2] * 255);
          currentColor = (r << 16) | (g << 8) | b;
        }
      }
      
      const extractTime = performance.now() - startTime;
      
      // 输出操作统计信息
      console.log(`📊 矢量操作统计:`);
      console.log(`   - constructPath: ${opStats.constructPath}`);
      console.log(`   - lineTo: ${opStats.lineTo}`);
      console.log(`   - rectangle: ${opStats.rectangle}`);
      console.log(`   - curveTo: ${opStats.curveTo}`);
      console.log(`   - curveTo2: ${opStats.curveTo2}`);
      console.log(`   - curveTo3: ${opStats.curveTo3}`);
      console.log(`   - moveTo: ${opStats.moveTo}`);
      console.log(`   - 总操作数: ${fnArray.length}`);
      console.log(`   - 已处理操作数: ${operationsToProcess}`);
      console.log(`   - 提取元素数: ${elements.length}`);
      console.log(`   - ⏱️ 提取耗时: ${extractTime.toFixed(2)}ms`);
      
      if (isLargeOperatorList) {
        console.warn(`⚠️ 已跳过 ${fnArray.length - operationsToProcess} 个操作以优化性能`);
      }
      
      // 🔍 输出所有操作类型的完整统计（按数量降序排列）
      const sortedOps = Object.entries(allOpTypes)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 50); // 显示前50个最常见的操作
      
      console.log(`\n🔍 PDF操作类型完整统计（TOP 50，共${Object.keys(allOpTypes).length}种操作）:`);
      console.log('┌────────┬─────────────────────────────────┬──────────┐');
      console.log('│ 排名   │ 操作类型                        │ 数量     │');
      console.log('├────────┼─────────────────────────────────┼──────────┤');
      sortedOps.forEach(([name, count], index) => {
        const rank = String(index + 1).padStart(6, ' ');
        const opName = name.padEnd(31, ' ');
        const countStr = String(count).padStart(8, ' ');
        console.log(`│ ${rank} │ ${opName} │ ${countStr} │`);
      });
      console.log('└────────┴─────────────────────────────────┴──────────┘');
      
      // 📊 输出constructPath内部操作统计
      const sortedPathOps = Object.entries(pathInternalOps)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20);
      
      console.log(`\n🔬 constructPath内部操作统计（TOP 20）:`);
      console.log('┌────────┬─────────────────────────────────┬──────────┐');
      console.log('│ 排名   │ 操作类型                        │ 数量     │');
      console.log('├────────┼─────────────────────────────────┼──────────┤');
      sortedPathOps.forEach(([name, count], index) => {
        const rank = String(index + 1).padStart(6, ' ');
        const opName = name.padEnd(31, ' ');
        const countStr = String(count).padStart(8, ' ');
        console.log(`│ ${rank} │ ${opName} │ ${countStr} │`);
      });
      console.log('└────────┴─────────────────────────────────┴──────────┘');
      
      // ⚠️ 输出被跳过的未知操作
      if (skippedOps.size > 0) {
        console.warn(`\n⚠️ 在constructPath中跳过了 ${skippedOps.size} 种未处理的操作:`);
        console.warn(`   ${Array.from(skippedOps).join(', ')}`);
      }
      
      // 🔧 将完整统计数据保存到全局变量，方便查看
      window.__pdfOpStats__ = {
        basic: opStats,
        allOps: allOpTypes,
        pathInternalOps: pathInternalOps,
        sorted: sortedOps,
        sortedPathOps: sortedPathOps,
        totalOps: fnArray.length,
        extractedElements: elements.length
      };
      console.log('\n💡 统计数据已保存到 window.__pdfOpStats__，可通过以下命令查看：');
      console.log('   window.__pdfOpStats__.sorted         // 查看排序后的操作列表');
      console.log('   window.__pdfOpStats__.pathInternalOps  // 查看constructPath内部操作');
      
      return elements;
      
    } catch (error) {
      console.error('OperatorList element extraction failed:', error);
      return [];
    }
  }

  /**
   * 解析SVG path为线段（完整版，支持所有SVG path命令）
   * 参考 pdf_equipment_app/src/svg_parser.py
   */
  static parsePathToLines(pathData, stroke, strokeWidth, pathId, scaleFactorX = 1.0, scaleFactorY = 1.0) {
    const elements = [];
    const colorInt = this.colorToInt(stroke);
    
    if (!pathData) return elements;
    
    // 📝 完整的path命令正则：支持所有SVG命令
    const commands = pathData.match(/([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g) || [];
    
    let currentX = 0, currentY = 0;
    let startX = 0, startY = 0;
    let lastControlX = 0, lastControlY = 0; // 用于S和T命令

    commands.forEach((cmd) => {
      const type = cmd[0];
      const params = cmd.slice(1).trim();
      const nums = params.match(/[-+]?\d*\.?\d+/g)?.map(Number) || [];
      
      const isRelative = type === type.toLowerCase();
      const cmdUpper = type.toUpperCase();
      
      let i = 0;
      
      switch (cmdUpper) {
        case 'M': // MoveTo
          while (i < nums.length - 1) {
            if (isRelative && (i > 0 || currentX !== 0 || currentY !== 0)) {
              currentX += nums[i];
              currentY += nums[i + 1];
            } else {
              currentX = nums[i] * scaleFactorX;
              currentY = nums[i + 1] * scaleFactorY;
            }
            if (i === 0) {
              startX = currentX;
              startY = currentY;
            }
            i += 2;
          }
          break;
          
        case 'L': // LineTo
          while (i < nums.length - 1) {
            const prevX = currentX, prevY = currentY;
            if (isRelative) {
              currentX += nums[i] * scaleFactorX;
              currentY += nums[i + 1] * scaleFactorY;
            } else {
              currentX = nums[i] * scaleFactorX;
              currentY = nums[i + 1] * scaleFactorY;
            }
            elements.push([0, prevX, prevY, currentX, currentY, colorInt, strokeWidth, pathId]);
            i += 2;
          }
          break;
          
        case 'H': // Horizontal LineTo
          nums.forEach(num => {
            const prevX = currentX;
            if (isRelative) {
              currentX += num * scaleFactorX;
            } else {
              currentX = num * scaleFactorX;
            }
            elements.push([0, prevX, currentY, currentX, currentY, colorInt, strokeWidth, pathId]);
          });
          break;
          
        case 'V': // Vertical LineTo
          nums.forEach(num => {
            const prevY = currentY;
            if (isRelative) {
              currentY += num * scaleFactorY;
            } else {
              currentY = num * scaleFactorY;
            }
            elements.push([0, currentX, prevY, currentX, currentY, colorInt, strokeWidth, pathId]);
          });
          break;
          
        case 'C': // Cubic Bezier Curve
          while (i < nums.length - 5) {
            const p0 = { x: currentX, y: currentY };
            let p1, p2, p3;
            
            if (isRelative) {
              p1 = { x: currentX + nums[i] * scaleFactorX, y: currentY + nums[i + 1] * scaleFactorY };
              p2 = { x: currentX + nums[i + 2] * scaleFactorX, y: currentY + nums[i + 3] * scaleFactorY };
              p3 = { x: currentX + nums[i + 4] * scaleFactorX, y: currentY + nums[i + 5] * scaleFactorY };
            } else {
              p1 = { x: nums[i] * scaleFactorX, y: nums[i + 1] * scaleFactorY };
              p2 = { x: nums[i + 2] * scaleFactorX, y: nums[i + 3] * scaleFactorY };
              p3 = { x: nums[i + 4] * scaleFactorX, y: nums[i + 5] * scaleFactorY };
            }
            
            // 将贝塞尔曲线细分为8段直线
            const steps = 8;
            for (let t = 0; t < steps; t++) {
              const t1 = t / steps;
              const t2 = (t + 1) / steps;
              const pt1 = this.cubicBezier(p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, p3.x, p3.y, t1);
              const pt2 = this.cubicBezier(p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, p3.x, p3.y, t2);
              elements.push([0, pt1.x, pt1.y, pt2.x, pt2.y, colorInt, strokeWidth, pathId]);
            }
            
            lastControlX = p2.x;
            lastControlY = p2.y;
            currentX = p3.x;
            currentY = p3.y;
            i += 6;
          }
          break;
          
        case 'S': // Smooth Cubic Bezier
          while (i < nums.length - 3) {
            const p0 = { x: currentX, y: currentY };
            // 反射上一个控制点
            const p1 = { x: 2 * currentX - lastControlX, y: 2 * currentY - lastControlY };
            let p2, p3;
            
            if (isRelative) {
              p2 = { x: currentX + nums[i] * scaleFactorX, y: currentY + nums[i + 1] * scaleFactorY };
              p3 = { x: currentX + nums[i + 2] * scaleFactorX, y: currentY + nums[i + 3] * scaleFactorY };
            } else {
              p2 = { x: nums[i] * scaleFactorX, y: nums[i + 1] * scaleFactorY };
              p3 = { x: nums[i + 2] * scaleFactorX, y: nums[i + 3] * scaleFactorY };
            }
            
            const steps = 8;
            for (let t = 0; t < steps; t++) {
              const t1 = t / steps;
              const t2 = (t + 1) / steps;
              const pt1 = this.cubicBezier(p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, p3.x, p3.y, t1);
              const pt2 = this.cubicBezier(p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, p3.x, p3.y, t2);
              elements.push([0, pt1.x, pt1.y, pt2.x, pt2.y, colorInt, strokeWidth, pathId]);
            }
            
            lastControlX = p2.x;
            lastControlY = p2.y;
            currentX = p3.x;
            currentY = p3.y;
            i += 4;
          }
          break;
          
        case 'Q': // Quadratic Bezier Curve
          while (i < nums.length - 3) {
            const p0 = { x: currentX, y: currentY };
            let p1, p2;
            
            if (isRelative) {
              p1 = { x: currentX + nums[i] * scaleFactorX, y: currentY + nums[i + 1] * scaleFactorY };
              p2 = { x: currentX + nums[i + 2] * scaleFactorX, y: currentY + nums[i + 3] * scaleFactorY };
            } else {
              p1 = { x: nums[i] * scaleFactorX, y: nums[i + 1] * scaleFactorY };
              p2 = { x: nums[i + 2] * scaleFactorX, y: nums[i + 3] * scaleFactorY };
            }
            
            // 将二次贝塞尔曲线细分为6段直线
            const steps = 6;
            for (let t = 0; t < steps; t++) {
              const t1 = t / steps;
              const t2 = (t + 1) / steps;
              const pt1 = this.quadraticBezier(p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, t1);
              const pt2 = this.quadraticBezier(p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, t2);
              elements.push([0, pt1.x, pt1.y, pt2.x, pt2.y, colorInt, strokeWidth, pathId]);
            }
            
            lastControlX = p1.x;
            lastControlY = p1.y;
            currentX = p2.x;
            currentY = p2.y;
            i += 4;
          }
          break;
          
        case 'T': // Smooth Quadratic Bezier
          while (i < nums.length - 1) {
            const p0 = { x: currentX, y: currentY };
            // 反射上一个控制点
            const p1 = { x: 2 * currentX - lastControlX, y: 2 * currentY - lastControlY };
            let p2;
            
            if (isRelative) {
              p2 = { x: currentX + nums[i] * scaleFactorX, y: currentY + nums[i + 1] * scaleFactorY };
            } else {
              p2 = { x: nums[i] * scaleFactorX, y: nums[i + 1] * scaleFactorY };
            }
            
            const steps = 6;
            for (let t = 0; t < steps; t++) {
              const t1 = t / steps;
              const t2 = (t + 1) / steps;
              const pt1 = this.quadraticBezier(p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, t1);
              const pt2 = this.quadraticBezier(p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, t2);
              elements.push([0, pt1.x, pt1.y, pt2.x, pt2.y, colorInt, strokeWidth, pathId]);
            }
            
            lastControlX = p1.x;
            lastControlY = p1.y;
            currentX = p2.x;
            currentY = p2.y;
            i += 2;
          }
          break;
          
        case 'A': // Elliptical Arc (简化处理：用多段直线近似)
          while (i < nums.length - 6) {
            const rx = nums[i] * scaleFactorX;
            const ry = nums[i + 1] * scaleFactorY;
            const xAxisRotation = nums[i + 2];
            const largeArcFlag = nums[i + 3];
            const sweepFlag = nums[i + 4];
            let endX, endY;
            
            if (isRelative) {
              endX = currentX + nums[i + 5] * scaleFactorX;
              endY = currentY + nums[i + 6] * scaleFactorY;
            } else {
              endX = nums[i + 5] * scaleFactorX;
              endY = nums[i + 6] * scaleFactorY;
            }
            
            // 简化：用12段直线近似圆弧
            const steps = 12;
            const arcPoints = this.approximateArc(currentX, currentY, rx, ry, xAxisRotation, largeArcFlag, sweepFlag, endX, endY, steps);
            
            for (let j = 0; j < arcPoints.length - 1; j++) {
              elements.push([0, arcPoints[j].x, arcPoints[j].y, arcPoints[j + 1].x, arcPoints[j + 1].y, colorInt, strokeWidth, pathId]);
            }
            
            currentX = endX;
            currentY = endY;
            i += 7;
          }
          break;
          
        case 'Z': // ClosePath
          if (Math.abs(currentX - startX) > 0.01 || Math.abs(currentY - startY) > 0.01) {
            elements.push([0, currentX, currentY, startX, startY, colorInt, strokeWidth, pathId]);
          }
          currentX = startX;
          currentY = startY;
          break;
      }
    });

    return elements;
  }
  
  /**
   * 近似椭圆弧为多段直线
   */
  static approximateArc(x1, y1, rx, ry, phi, fA, fS, x2, y2, steps) {
    const points = [];
    points.push({ x: x1, y: y1 });
    
    // 简化处理：在起点和终点之间插值
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      points.push({
        x: x1 + (x2 - x1) * t,
        y: y1 + (y2 - y1) * t
      });
    }
    
    points.push({ x: x2, y: y2 });
    return points;
  }

  /**
   * 将颜色字符串转换为整数
   */
  static colorToInt(colorStr) {
    if (!colorStr || colorStr === 'none') return 0;
    
    // 处理 rgb(r,g,b) 格式
    const rgbMatch = colorStr.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (rgbMatch) {
      const r = parseInt(rgbMatch[1]);
      const g = parseInt(rgbMatch[2]);
      const b = parseInt(rgbMatch[3]);
      return (r << 16) | (g << 8) | b;
    }
    
    // 处理 #rrggbb 格式
    if (colorStr.startsWith('#')) {
      return parseInt(colorStr.slice(1), 16);
    }
    
    // 默认黑色
    return 0;
  }

  /**
   * 计算三次贝塞尔曲线上的点
   * @param {number} x0, y0 - 起点
   * @param {number} x1, y1 - 第一控制点
   * @param {number} x2, y2 - 第二控制点
   * @param {number} x3, y3 - 终点
   * @param {number} t - 参数 (0-1)
   * @returns {Object} {x, y}
   */
  static cubicBezier(x0, y0, x1, y1, x2, y2, x3, y3, t) {
    const mt = 1 - t;
    const mt2 = mt * mt;
    const mt3 = mt2 * mt;
    const t2 = t * t;
    const t3 = t2 * t;
    
    return {
      x: mt3 * x0 + 3 * mt2 * t * x1 + 3 * mt * t2 * x2 + t3 * x3,
      y: mt3 * y0 + 3 * mt2 * t * y1 + 3 * mt * t2 * y2 + t3 * y3
    };
  }

  /**
   * 计算二次贝塞尔曲线上的点
   * @param {number} x0, y0 - 起点
   * @param {number} x1, y1 - 控制点
   * @param {number} x2, y2 - 终点
   * @param {number} t - 参数 (0-1)
   * @returns {Object} {x, y}
   */
  static quadraticBezier(x0, y0, x1, y1, x2, y2, t) {
    const mt = 1 - t;
    const mt2 = mt * mt;
    const t2 = t * t;
    
    return {
      x: mt2 * x0 + 2 * mt * t * x1 + t2 * x2,
      y: mt2 * y0 + 2 * mt * t * y1 + t2 * y2
    };
  }
}
