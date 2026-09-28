/**
 * PDF事件处理器模块
 * 负责处理所有PDF查看器的交互事件
 */

import { useCallback, useEffect, useRef } from 'react';
import { shouldStartViewPan } from '../../utils/pdfInteractionUtils';
import { useAnnotationDragSession } from './useAnnotationDragSession';

export const usePDFEventHandlers = ({
  // 基础状态
  containerRef,
  currentPage,
  numPages,
  scale,
  viewMode,
  pipeSegmentMode,
  
  // 拖拽状态
  isDragging,
  setIsDragging,
  dragStart,
  setDragStart,
  viewOffset,
  setViewOffset,
  dragStartOffset,
  setDragStartOffset,
  
  // 注释拖拽状态
  draggingAnnotation,
  setDraggingAnnotation,
  annotationDragStart,
  setAnnotationDragStart,
  annotationStartPos,
  setAnnotationStartPos,
  dragType,
  setDragType,
  
  // 可见范围状态
  visiblePageRange,
  setVisiblePageRange,
  pageSize,
  
  // 回调函数
  onPageChange,
  onScaleChange,
  onAnnotationUpdate,
  onAnnotationMoveCommit,
  onAnnotationDragPreview,
  documentKey,
  annotationDragEnabled = true,
  annotations = [],
  multiSelectedAnnotationIds = [],
  multiAnnotationStartPositions = null,
  
  // OCR相关
  ocrState,
  canvasGeometry,
  setCanvasGeometry,
  ocrUtils
}) => {
  const wheelThrottleRef = useRef(null);
  const scrollTimeoutRef = useRef(null);
  useAnnotationDragSession({
    containerRef, currentPage, scale, documentKey, enabled: annotationDragEnabled,
    draggingAnnotation, setDraggingAnnotation, annotationDragStart,
    annotationStartPos, dragType, setDragType, annotations,
    multiSelectedAnnotationIds, multiAnnotationStartPositions,
    onAnnotationUpdate, onAnnotationMoveCommit, onAnnotationDragPreview,
  });

  // 键盘快捷键支持
  useEffect(() => {
    const handleKeyDown = (e) => {
      // 检查是否在输入框中，如果是则不处理快捷键
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
        return;
      }
      
      switch (e.key) {
        case 'PageUp':
          e.preventDefault();
          {
            const container = containerRef.current;
            if (container) {
              const scrollAmount = container.clientHeight * 0.8;
              container.scrollBy({
                top: -scrollAmount,
                behavior: 'smooth'
              });
            }
          }
          break;
        case 'PageDown':
          e.preventDefault();
          {
            const container = containerRef.current;
            if (container) {
              const scrollAmount = container.clientHeight * 0.8;
              container.scrollBy({
                top: scrollAmount,
                behavior: 'smooth'
              });
            }
          }
          break;
        case 'Home':
          if (e.ctrlKey) {
            e.preventDefault();
            const container = containerRef.current;
            if (container) {
              container.scrollTo({ top: 0, behavior: 'smooth' });
            }
          }
          break;
        case 'End':
          if (e.ctrlKey) {
            e.preventDefault();
            const container = containerRef.current;
            if (container) {
              container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
            }
          }
          break;
      }
    };
    
    document.addEventListener('keydown', handleKeyDown);
    
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [containerRef]);

  // 优化的滚轮事件处理
  const handleWheel = useCallback((e) => {
    // 禁用滚轮按钮（中键）滑动
    if (e.button === 1) {
      e.preventDefault();
      return;
    }
    
    if (e.ctrlKey) {
      // Ctrl+滚轮：丝滑缩放
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.95 : 1.05; // 更小的缩放步长，更丝滑
      const newScale = Math.max(0.25, Math.min(5.0, scale * delta));
      
      onScaleChange?.(newScale);
    } else if (viewMode === 'single') {
      // 单页模式下：滚轮翻页
      e.preventDefault();
      const delta = e.deltaY;
      
      if (delta > 0 && currentPage < numPages) {
        // 向下滚动，下一页
        onPageChange?.(currentPage + 1);
      } else if (delta < 0 && currentPage > 1) {
        // 向上滚动，上一页
        onPageChange?.(currentPage - 1);
      }
    }
    // 连续滚动模式下不阻止普通滚轮事件，让其自然滚动
  }, [scale, onScaleChange, viewMode, currentPage, numPages, onPageChange]);

  // 滚动监听函数 - 检测当前可见页面和可见范围（优化大文档性能）
  const handleScroll = useCallback((e) => {
    // Single-page mode keeps bounded off-screen Page canvases as a cache.
    // visibility:hidden nodes still have layout rectangles, so they must not
    // participate in scroll-based current-page detection.
    if (viewMode === 'single') {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
        scrollTimeoutRef.current = null;
      }
      return;
    }

    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }
    
    // 根据文档大小动态调整防抖时间
    const isLargeDocument = numPages > 500;
    const debounceTime = isLargeDocument ? 150 : 100; // 大文档增加防抖时间
    
    scrollTimeoutRef.current = setTimeout(() => {
      const container = e.target;
      const containerRect = container.getBoundingClientRect();
      const containerTop = containerRect.top;
      const containerBottom = containerRect.bottom;
      const containerCenter = containerTop + containerRect.height / 2;
      
      // 查找最接近视口中心的页面和可见页面范围
      let closestPage = 1;
      let minDistance = Infinity;
      let visibleStart = numPages;
      let visibleEnd = 1;
      
      // 大文档优化：只检查可能可见的页面范围
      const estimatedPageHeight = pageSize.height * scale * 2.0 || 800;
      const estimatedStartPage = Math.max(1, Math.floor(container.scrollTop / estimatedPageHeight));
      const estimatedEndPage = Math.min(numPages, estimatedStartPage + Math.ceil(containerRect.height / estimatedPageHeight) + 2);
      
      const searchStart = isLargeDocument ? estimatedStartPage : 1;
      const searchEnd = isLargeDocument ? estimatedEndPage : numPages;
      
      for (let pageNum = searchStart; pageNum <= searchEnd; pageNum++) {
        const pageElement = container.querySelector(`[data-page-number="${pageNum}"]`);
        if (pageElement) {
          const pageRect = pageElement.getBoundingClientRect();
          const pageTop = pageRect.top;
          const pageBottom = pageRect.bottom;
          const pageCenter = pageTop + pageRect.height / 2;
          
          // 检查页面是否在视口内
          const isVisible = pageBottom > containerTop && pageTop < containerBottom;
          if (isVisible) {
            visibleStart = Math.min(visibleStart, pageNum);
            visibleEnd = Math.max(visibleEnd, pageNum);
          }
          
          // 查找最接近中心的页面
          const distance = Math.abs(pageCenter - containerCenter);
          if (distance < minDistance) {
            minDistance = distance;
            closestPage = pageNum;
          }
        }
      }
      
      // 扩展可见范围以包含预加载页面
      const bufferSize = isLargeDocument ? 1 : 1; // 大文档保持较小的缓冲区
      const rangeStart = Math.max(1, visibleStart - bufferSize);
      const rangeEnd = Math.min(numPages, visibleEnd + bufferSize);
      
      // 更新可见页面范围
      setVisiblePageRange(prev => {
        if (prev.start !== rangeStart || prev.end !== rangeEnd) {
          return { start: rangeStart, end: rangeEnd };
        }
        return prev;
      });
      
      // 更新当前页面
      if (closestPage !== currentPage) {
        onPageChange?.(closestPage);
      }
      
    }, debounceTime);
  }, [numPages, currentPage, onPageChange, pageSize, scale, setVisiblePageRange, viewMode]);

  // 右键拖拽开始
  const handleMouseDown = useCallback((e) => {
    if (e.button === 1) { // 滚轮按钮（中键）
      e.preventDefault(); // 禁用滚轮按钮滑动
      return;
    }

    if (!shouldStartViewPan({ button: e.button, pipeSegmentMode })) {
      return;
    }

    e.preventDefault();
    setIsDragging(true);
    setDragStart({ x: e.clientX, y: e.clientY });
    setDragStartOffset({ ...viewOffset });
  }, [viewOffset, pipeSegmentMode, setIsDragging, setDragStart, setDragStartOffset]);

  // 本地鼠标移动（保留用于标注功能）
  const handleMouseMove = useCallback((e) => {
    // 拖拽由全局事件处理，这里只处理其他逻辑
  }, []);

  // 拖拽结束
  const handleMouseUp = useCallback((e) => {
    if (e.button === 2) { // 右键
      setIsDragging(false);
    }
  }, [setIsDragging]);

  // 禁用右键菜单
  const handleContextMenu = useCallback((e) => {
    e.preventDefault();
  }, []);

  // 添加全局鼠标事件监听，用于拖拽
  useEffect(() => {
    const handleGlobalMouseMove = (e) => {
      if (isDragging) {
        e.preventDefault();
        const deltaX = e.clientX - dragStart.x;
        const deltaY = e.clientY - dragStart.y;
        setViewOffset({
          x: dragStartOffset.x + deltaX,
          y: dragStartOffset.y + deltaY
        });
        
        // 实时更新OCR区域的Canvas几何信息
        if (ocrState && ocrState.isActive && ocrUtils && ocrUtils.getCanvasGeometry) {
          const geometry = ocrUtils.getCanvasGeometry();
          setCanvasGeometry && setCanvasGeometry(geometry);
        }
      }
    };

    const handleGlobalMouseUp = (e) => {
      if (e.button === 2 && isDragging) {
        setIsDragging(false);
      }
    };

    if (isDragging) {
      document.addEventListener('mousemove', handleGlobalMouseMove);
      document.addEventListener('mouseup', handleGlobalMouseUp);
      
      // 设置合适的光标
      if (isDragging) {
        document.body.style.cursor = 'grabbing';
      }
    }

    return () => {
      document.removeEventListener('mousemove', handleGlobalMouseMove);
      document.removeEventListener('mouseup', handleGlobalMouseUp);
      // 拖拽结束时恢复默认光标
      if (isDragging) {
        document.body.style.cursor = '';
      }
    };
  }, [
    isDragging, 
    dragStart, 
    dragStartOffset, 
    containerRef,
    setIsDragging,
    setViewOffset,
    ocrState,
    ocrUtils,
    setCanvasGeometry
  ]);

  // 事件监听器设置
  useEffect(() => {
    const container = containerRef.current;
    if (container) {
      const wheelHandler = (e) => {
        handleWheel(e);
      };
      
      const scrollHandler = (e) => {
        handleScroll(e);
      };
      
      // 添加滚轮事件监听（只处理缩放）
      container.addEventListener('wheel', wheelHandler, { passive: false });
      // 添加滚动事件监听（检测当前页面）
      container.addEventListener('scroll', scrollHandler, { passive: true });
      
      return () => {
        container.removeEventListener('wheel', wheelHandler);
        container.removeEventListener('scroll', scrollHandler);
      };
    }
  }, [handleWheel, handleScroll, containerRef]);

  // 滚轮事件清理
  useEffect(() => {
    return () => {
      if (wheelThrottleRef.current) {
        clearTimeout(wheelThrottleRef.current);
      }
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, []);

  return {
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleContextMenu,
    handleWheel,
    handleScroll
  };
};

export default usePDFEventHandlers;
