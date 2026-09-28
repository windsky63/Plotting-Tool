/**
 * PDF文档管理模块
 * 负责PDF文档的加载、页面管理、缓存机制和预加载功能
 */

import { useState, useCallback, useRef } from 'react';

export const usePDFDocumentManager = ({
  currentPage,
  onTotalPagesChange,
  onPageSizeChange
}) => {
  // 基础状态
  const [numPages, setNumPages] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [pageRefs, setPageRefs] = useState({});
  
  // 页面缓存和预加载状态
  const [pageCache, setPageCache] = useState(new Map()); // 缓存已渲染的页面
  const [preloadedPages, setPreloadedPages] = useState(new Set()); // 记录已预加载的页面
  const [isPreloading, setIsPreloading] = useState(false); // 预加载状态
  const preloadRangeRef = useRef(2); // 预加载范围（前后2页）
  
  // 页面尺寸信息状态
  const [pageSize, setPageSize] = useState({ width: 0, height: 0, widthMM: 0, heightMM: 0 });
  const pageSizeRef = useRef({ width: 0, height: 0, widthMM: 0, heightMM: 0 });
  const currentPageRef = useRef(Number(currentPage) || 1);
  const onPageSizeChangeRef = useRef(onPageSizeChange);
  currentPageRef.current = Number(currentPage) || 1;
  onPageSizeChangeRef.current = onPageSizeChange;
  
  // Refs
  const pageRefsRef = useRef({});
  const pageRefCallbacksRef = useRef(new Map());
  const pageObjectsRef = useRef(new Map()); // Store native PDF page objects
  const scrollTimeoutRef = useRef(null);

  // 优化ref回调以避免无限渲染
  const setPageRef = useCallback((pageNum, element) => {
    if (element && pageRefsRef.current[pageNum] !== element) {
      pageRefsRef.current[pageNum] = element;
      // 只在需要时更新状态
      setPageRefs(prev => {
        if (prev[pageNum] !== element) {
          return { ...prev, [pageNum]: element };
        }
        return prev;
      });
      return;
    }

    // React calls the ref with null when a single-page Canvas is unmounted.
    // Keeping that detached DOM node retained the old full-resolution Canvas
    // pixel buffer for every visited page, even though its PNG snapshot was
    // already safely persisted in IndexedDB.
    if (!element && pageRefsRef.current[pageNum]) {
      delete pageRefsRef.current[pageNum];
      const pageObject = pageObjectsRef.current.get(pageNum);
      try { pageObject?.cleanup?.(); } catch (error) { /* already released */ }
      pageObjectsRef.current.delete(pageNum);
      setPageRefs(prev => {
        if (!prev[pageNum]) return prev;
        const next = { ...prev };
        delete next[pageNum];
        return next;
      });
    }
  }, []);

  // 创建稳定的ref回调函数
  const createPageRefCallback = useCallback((pageNum) => {
    const normalizedPage = Number(pageNum);
    if (!pageRefCallbacksRef.current.has(normalizedPage)) {
      pageRefCallbacksRef.current.set(
        normalizedPage,
        element => setPageRef(normalizedPage, element)
      );
    }
    return pageRefCallbacksRef.current.get(normalizedPage);
  }, [setPageRef]);

  // PDF文档加载成功回调
  const onDocumentLoadSuccess = useCallback(({ numPages }) => {
    setNumPages(numPages);
    setError(null);
    setLoading(false);
    onTotalPagesChange?.(numPages);
  }, [onTotalPagesChange]);

  // PDF文档加载错误回调
  const onDocumentLoadError = useCallback((error) => {
    console.error('PDF加载失败:', error);
    setError('PDF文件加载失败，请检查文件是否损坏或格式是否正确。');
    setLoading(false);
  }, []);

  // 页面渲染成功回调（增强缓存功能）
  const onPageLoadSuccess = useCallback((page) => {
    const pageNumber = page._pageIndex + 1;
    
    // Store native PDF page object for SVG rendering support
    if (page && pageObjectsRef.current) {
      pageObjectsRef.current.set(pageNumber, page);
    }

    // 提取矢量数据 (异步) - 仅在矢量调试启用时
    if (window.currentRenderMode === 'svg' && window.enableVectorDebug) {
      // 🚀 性能优化：使用 requestIdleCallback 在空闲时提取，避免阻塞UI
      const extractVectors = async () => {
        try {
          const { VectorExtractionUtils } = await import('../../utils/vectorExtractionUtils');
          const vectors = await VectorExtractionUtils.extractVectors(page);
          console.log(`✅ 第 ${pageNumber} 页提取到 ${vectors.length} 个矢量路径`);
          
          // 通知全局状态更新
          if (window.setPageVectors) {
            window.setPageVectors(prev => ({
              ...prev,
              [pageNumber]: vectors
            }));
          }
        } catch (err) {
          console.warn(`❌ 第 ${pageNumber} 页矢量提取失败:`, err);
        }
      };
      
      // 使用 requestIdleCallback（如果支持）或 setTimeout 延迟执行
      if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(() => extractVectors(), { timeout: 2000 });
      } else {
        setTimeout(() => extractVectors(), 300);
      }
    }

    // 页面渲染完成后的处理
    // 获取页面的分辨率信息
    const viewport = page.getViewport({ scale: 1.0 });

    // 检测PDF页面旋转角度（带调试日志）
    const rotation = page.rotate || page.rotation || 0;
    const rotationDegrees = typeof rotation === 'object' ? (rotation.angle || 0) : rotation;
    
    // 调试日志：输出页面旋转信息
    if (rotationDegrees !== 0) {
      console.log(`🔄 [PDFViewer] 页面 ${pageNumber} 检测到旋转角度:`, {
        原始旋转值: rotation,
        计算后角度: rotationDegrees,
        旋转方向: rotationDegrees === 90 ? '顺时针90°' : 
                 rotationDegrees === 180 ? '180°翻转' : 
                 rotationDegrees === 270 ? '逆时针90°' : '未知角度'
      });
    } else {
      console.log(`📄 [PDFViewer] 页面 ${pageNumber} 无旋转 (0°)`);
    }

    // 检测页面方向（带调试日志）
    const isLandscape = viewport.width > viewport.height;
    const orientation = isLandscape ? '横向' : '纵向';
    
    // 调试日志：输出页面基本信息
    console.log(`📐 [PDFViewer] 页面 ${pageNumber} 基本信息:`, {
      尺寸: `${Math.round(viewport.width)} × ${Math.round(viewport.height)}`,
      方向: orientation,
      旋转角度: `${rotationDegrees}°`,
      是否横向: isLandscape
    });

    const resolution = {
      width: Math.round(viewport.width),
      height: Math.round(viewport.height),
      // PDF.js默认使用72 DPI作为基准
      dpi: 72,
      rotation: rotationDegrees,
      orientation: orientation
    };
    
    // 计算实际尺寸（考虑我们的2.0缩放）
    const actualScale = 2.0; // 我们应用的缩放
    const displayWidth = viewport.width * actualScale;
    const displayHeight = viewport.height * actualScale;
    
    // 转换为毫米（1英寸 = 25.4mm，72点 = 1英寸）
    const pointsToMM = 25.4 / 72;
    const widthMM = Math.round(viewport.width * pointsToMM * 10) / 10; // 保留1位小数
    const heightMM = Math.round(viewport.height * pointsToMM * 10) / 10;
    
    // 更新页面尺寸状态（仅当前页面）
    if (pageNumber === currentPageRef.current) {
      const newPageSize = {
        width: Math.round(displayWidth),
        height: Math.round(displayHeight),
        widthMM: widthMM,
        heightMM: heightMM
      };
      const previousPageSize = pageSizeRef.current;
      const pageSizeChanged = (
        previousPageSize.width !== newPageSize.width
        || previousPageSize.height !== newPageSize.height
        || previousPageSize.widthMM !== newPageSize.widthMM
        || previousPageSize.heightMM !== newPageSize.heightMM
      );
      if (pageSizeChanged) {
        pageSizeRef.current = newPageSize;
        setPageSize(newPageSize);
        // Only notify the parent when dimensions really changed. Most pages in
        // one drawing share a size; repeated identical updates used to rebuild
        // all visible vector recognizers while paging.
        if (onPageSizeChangeRef.current) {
          onPageSizeChangeRef.current(newPageSize);
        }
      }
    }
    
    // 将页面信息缓存起来
    const pageInfo = {
      resolution,
      viewport,
      size: {
        width: Math.round(displayWidth),
        height: Math.round(displayHeight),
        widthMM: widthMM,
        heightMM: heightMM
      },
      loadTime: Date.now()
    };
    
    setPageCache(prev => {
      const existing = prev.get(pageNumber);
      const unchanged = Boolean(
        existing &&
        existing.resolution?.width === pageInfo.resolution.width &&
        existing.resolution?.height === pageInfo.resolution.height &&
        existing.resolution?.rotation === pageInfo.resolution.rotation &&
        existing.size?.width === pageInfo.size.width &&
        existing.size?.height === pageInfo.size.height &&
        existing.size?.widthMM === pageInfo.size.widthMM &&
        existing.size?.heightMM === pageInfo.size.heightMM
      );
      if (unchanged) return prev;
      const newCache = new Map(prev);
      newCache.set(pageNumber, pageInfo);
      return newCache;
    });
    
    // 将分辨率信息保存到全局状态
    if (window.pdfResolution) {
      window.pdfResolution[pageNumber] = resolution;
    } else {
      window.pdfResolution = {
        [pageNumber]: resolution
      };
    }
  }, []);

  // 页面预加载函数（优化大文档性能）
  const preloadPages = useCallback(async (centerPage) => {
    if (!numPages || isPreloading) return;
    
    setIsPreloading(true);
    
    // 根据文档大小动态调整预加载策略
    const isLargeDocument = numPages > 500;
    const range = isLargeDocument ? 1 : preloadRangeRef.current; // 大文档减少预加载范围
    const maxPreloadCount = isLargeDocument ? 3 : 5; // 大文档限制预加载数量
    
    const pagesToPreload = [];
    
    // 计算需要预加载的页面范围
    for (let i = Math.max(1, centerPage - range); i <= Math.min(numPages, centerPage + range); i++) {
      if (!preloadedPages.has(i) && !pageCache.has(i) && pagesToPreload.length < maxPreloadCount) {
        pagesToPreload.push(i);
      }
    }
    
    // 优先预加载当前页面的相邻页面
    const priorityPages = [centerPage - 1, centerPage + 1].filter(p => 
      p >= 1 && p <= numPages && !preloadedPages.has(p) && !pageCache.has(p)
    );
    
    const finalPreloadList = [...priorityPages, ...pagesToPreload.filter(p => !priorityPages.includes(p))]
      .slice(0, maxPreloadCount);
    
    // 批量预加载页面
    for (const pageNum of finalPreloadList) {
      try {
        // 创建隐藏的页面元素进行预加载
        const preloadContainer = document.createElement('div');
        preloadContainer.style.position = 'absolute';
        preloadContainer.style.left = '-9999px';
        preloadContainer.style.top = '-9999px';
        preloadContainer.style.visibility = 'hidden';
        document.body.appendChild(preloadContainer);
        
        // 标记为已预加载
        setPreloadedPages(prev => new Set([...prev, pageNum]));
        
        // 清理预加载容器
        setTimeout(() => {
          if (preloadContainer.parentNode) {
            document.body.removeChild(preloadContainer);
          }
        }, isLargeDocument ? 500 : 1000); // 大文档更快清理
        
      } catch (error) {
        console.warn(`预加载页面 ${pageNum} 失败:`, error);
      }
    }
    
    setIsPreloading(false);
  }, [numPages, isPreloading, preloadedPages, pageCache]);
  
  // 清理过期缓存（优化大文档性能）
  const cleanupCache = useCallback((currentPage) => {
    // 根据文档大小动态调整缓存策略
    const isLargeDocument = numPages > 500;
    const maxCacheSize = isLargeDocument ? 15 : 10; // 大文档增加缓存
    const cacheRange = isLargeDocument ? 3 : 5; // 大文档减少缓存范围以节省内存
    
    if (pageCache.size > maxCacheSize) {
      const newCache = new Map();
      const newPreloaded = new Set();
      
      // 保留当前页面附近的缓存
      const startPage = Math.max(1, currentPage - cacheRange);
      const endPage = Math.min(numPages || 1, currentPage + cacheRange);
      
      for (let i = startPage; i <= endPage; i++) {
        if (pageCache.has(i)) {
          newCache.set(i, pageCache.get(i));
        }
        if (preloadedPages.has(i)) {
          newPreloaded.add(i);
        }
      }
      
      // 记录清理的页面数量
      const cleanedPages = pageCache.size - newCache.size;
      if (cleanedPages > 0) {
        console.log(`🗑️ [PDF缓存] 清理了 ${cleanedPages} 个页面缓存`);
      }
      
      setPageCache(newCache);
      setPreloadedPages(newPreloaded);
      
      // 强制垃圾回收（如果浏览器支持）
      if (window.gc && isLargeDocument) {
        setTimeout(() => window.gc(), 100);
      }
    }
  }, [pageCache, preloadedPages, numPages]);

  return {
    // 状态
    numPages,
    loading,
    error,
    pageRefs,
    pageCache,
    preloadedPages,
    isPreloading,
    pageSize,
    
    // 状态设置器
    setNumPages,
    setLoading,
    setError,
    setPageSize,
    
    // 方法
    onDocumentLoadSuccess,
    onDocumentLoadError,
    onPageLoadSuccess,
    setPageRef,
    createPageRefCallback,
    preloadPages,
    cleanupCache,
    
    // Refs
    pageRefsRef,
    pageObjectsRef,
    scrollTimeoutRef
  };
};

export default usePDFDocumentManager;
