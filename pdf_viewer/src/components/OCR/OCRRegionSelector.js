/**
 * OCR区域选择器组件
 * 处理OCR区域的选择、调整和交互
 */

import React, { useCallback, useEffect, useState } from 'react';
import { message } from 'antd';
import { OCRUtils } from '../../utils/ocrUtils';
import { useOCRContext } from '../../contexts/OCRContext';

const OCRRegionSelector = ({ 
  pageRefsRef, 
  currentPage, 
  scale, 
  containerRef,
  mousePosition,
  setMousePosition,
  // 添加其他区域的setter函数
  setGlobalPipelineArea,
  setGlobalDrawingNumberArea,
  setGlobalPageNumberArea,
  setGlobalScaffoldArea,
  setGlobalWeldRecognitionArea
}) => {
  const {
    ocrState,
    setOcrState,
    globalOcrRegion,
    setGlobalOcrRegion,
    ocrAreaTarget,
    setOcrAreaTarget
  } = useOCRContext();

  const [canvasGeometry, setCanvasGeometry] = useState(null);
  const [ocrRenderKey, setOcrRenderKey] = useState(0);

  // 创建OCR工具类实例
  const ocrUtils = React.useMemo(() => 
    new OCRUtils(pageRefsRef, currentPage, scale), 
    [pageRefsRef, currentPage, scale]
  );

  // OCR操作函数
  const ocrActions = {
    // 开始区域选择
    startRegionSelection: () => {
      console.log('🎯 startRegionSelection被调用');
      setOcrState(prev => {
        console.log('🎯 当前OCR状态:', prev);
        const newState = {
          ...prev,
          isActive: true,
          mode: 'selecting'
        };
        console.log('🎯 新OCR状态:', newState);
        return newState;
      });
    },

    // 开始拖拽
    startDrag: (startPoint) => {
      console.log('🎯 开始拖拽，起始点:', startPoint);
      setOcrState(prev => ({
        ...prev,
        dragState: {
          isDragging: true,
          startPoint
        }
      }));
    },

    // 结束拖拽
    endDrag: (endPoint) => {
      console.log('🎯 结束拖拽，结束点:', endPoint);
      
      const startPoint = ocrState.dragState.startPoint;
      if (!startPoint) {
        console.error('🎯 没有起始点，无法创建区域');
        return;
      }

      // 创建区域
      const region = {
        x: Math.min(startPoint.x, endPoint.x),
        y: Math.min(startPoint.y, endPoint.y),
        width: Math.abs(endPoint.x - startPoint.x),
        height: Math.abs(endPoint.y - startPoint.y)
      };

      // 验证区域大小
      if (region.width < 10 || region.height < 10) {
        console.log('🎯 区域太小，忽略');
        message.warning('选择的区域太小，请重新选择');
        setOcrState(prev => ({
          ...prev,
          mode: 'idle',
          dragState: { isDragging: false, startPoint: null }
        }));
        return;
      }

      console.log('🎯 创建区域:', region);
      
      // 转换为相对坐标
      const canvasGeometry = ocrUtils.getCanvasGeometry();
      if (!canvasGeometry) {
        console.error('🎯 无法获取Canvas几何信息');
        return;
      }

      // 获取元素的实际宽高（使用统一的内部尺寸属性，避免 SVG 模式下的问题）
      const actualWidth = canvasGeometry.internalWidth || canvasGeometry.rect.width;
      const actualHeight = canvasGeometry.internalHeight || canvasGeometry.rect.height;

      const relativeRegion = {
        x: region.x / actualWidth,
        y: region.y / actualHeight,
        width: region.width / actualWidth,
        height: region.height / actualHeight
      };

      console.log('🎯 OCRRegionSelector创建相对坐标区域:', relativeRegion);
      
      // 保存区域到正确的状态
      if (ocrAreaTarget === 'material') {
        setGlobalOcrRegion(relativeRegion);
        message.success('材料表区域设置成功');
      } else if (ocrAreaTarget === 'pipeline') {
        console.log('🎯 OCRRegionSelector调用setGlobalPipelineArea');
        setGlobalPipelineArea(relativeRegion);
        message.success('管线号区域设置成功');
      } else if (ocrAreaTarget === 'drawingNumber') {
        console.log('🎯 OCRRegionSelector调用setGlobalDrawingNumberArea');
        setGlobalDrawingNumberArea(relativeRegion);
        message.success('图号区域设置成功');
      } else if (ocrAreaTarget === 'pageNumber') {
        console.log('🎯 OCRRegionSelector调用setGlobalPageNumberArea');
        setGlobalPageNumberArea(relativeRegion);
        message.success('页码区域设置成功');
      } else if (ocrAreaTarget === 'scaffold') {
        console.log('🎯 OCRRegionSelector调用setGlobalScaffoldArea');
        setGlobalScaffoldArea(relativeRegion);
        message.success('支架区域设置成功');
      } else if (ocrAreaTarget === 'weldRecognition') {
        console.log('🎯 OCRRegionSelector调用setGlobalWeldRecognitionArea');
        setGlobalWeldRecognitionArea?.(relativeRegion);
        message.success('焊点识别区域设置成功');
      } else {
        message.success(`${ocrAreaTarget}区域设置成功`);
      }

      // 重置状态
      setOcrState(prev => ({
        ...prev,
        mode: 'idle',
        dragState: { isDragging: false, startPoint: null }
      }));
    },

    // 进入分割线模式
    enterSplitLineMode: () => {
      console.log('🎯 进入分割线模式');
      if (!globalOcrRegion) {
        message.warning('请先选择材料表区域');
        return;
      }
      
      setOcrState(prev => ({
        ...prev,
        mode: 'splitLine'
      }));
      message.info('分割线模式：点击区域内部添加分割线');
    },

    // 添加分割线
    addSplitLine: (canvasX) => {
  
      
      if (!globalOcrRegion) {
  
        return;
      }

      // 将Canvas像素坐标转换为相对坐标
      const canvasGeometry = ocrUtils.getCanvasGeometry();
      if (!canvasGeometry) {
  
        return;
      }

      const relativeX = canvasX / canvasGeometry.canvas.width;
  

      // 检查是否在区域内
      if (relativeX < globalOcrRegion.x || relativeX > globalOcrRegion.x + globalOcrRegion.width) {
        message.warning('请在选择的区域内添加分割线');
        return;
      }

      // 添加分割线
      setOcrState(prev => {
        const newSplitLines = [...prev.splitLines, relativeX];
    
        return {
          ...prev,
          splitLines: newSplitLines
        };
      });

      message.success('分割线添加成功');
    },

    // 开始调整大小
    startResize: (handle, startPoint, originalRegion) => {
      console.log('🎯 开始调整大小:', { handle, startPoint, originalRegion });
      setOcrState(prev => ({
        ...prev,
        resizeState: {
          isResizing: true,
          handle,
          startPoint,
          originalRegion: { ...originalRegion }
        }
      }));
    },

    // 更新调整大小
    updateResize: (currentPoint) => {
      if (!ocrState.resizeState.isResizing) return;

      const { handle, startPoint, originalRegion } = ocrState.resizeState;
      const deltaX = currentPoint.x - startPoint.x;
      const deltaY = currentPoint.y - startPoint.y;

      let newRegion = { ...originalRegion };

      switch (handle) {
        case 'tl':
          newRegion.x = originalRegion.x + deltaX;
          newRegion.y = originalRegion.y + deltaY;
          newRegion.width = originalRegion.width - deltaX;
          newRegion.height = originalRegion.height - deltaY;
          break;
        case 'tr':
          newRegion.y = originalRegion.y + deltaY;
          newRegion.width = originalRegion.width + deltaX;
          newRegion.height = originalRegion.height - deltaY;
          break;
        case 'bl':
          newRegion.x = originalRegion.x + deltaX;
          newRegion.width = originalRegion.width - deltaX;
          newRegion.height = originalRegion.height + deltaY;
          break;
        case 'br':
          newRegion.width = originalRegion.width + deltaX;
          newRegion.height = originalRegion.height + deltaY;
          break;
      }

      // 确保区域不会变成负数
      if (newRegion.width > 10 && newRegion.height > 10) {
        setGlobalOcrRegion(newRegion);
      }
    },

    // 结束调整大小
    endResize: () => {
      console.log('🎯 结束调整大小');
      setOcrState(prev => ({
        ...prev,
        resizeState: {
          isResizing: false,
          handle: null,
          originalRegion: null,
          startPoint: null
        }
      }));
    },

    // 清除所有
    clearAll: () => {
      setGlobalOcrRegion(null);
      setOcrState(prev => ({
        ...prev,
        splitLines: [],
        mode: 'idle'
      }));
      message.success('已清除所有OCR区域');
    },

    // 保存模板
    saveTemplate: () => {
      if (!globalOcrRegion) {
        message.warning('请先选择区域');
        return;
      }

      const template = {
        materialArea: {
          ...globalOcrRegion,
          splitLines: ocrState.splitLines
        },
        pipelineArea: null,
        drawingNumberArea: null,
        pageNumberArea: null
      };

      // 保存到本地存储
      localStorage.setItem('ocrTemplate', JSON.stringify(template));
      message.success('模板保存成功');
    }
  };

  // OCR鼠标事件处理
  const handleOcrMouseDown = useCallback((e) => {
    console.log('🖱️ OCR鼠标按下事件', { 
      isActive: ocrState.isActive, 
      mode: ocrState.mode, 
      button: e.button 
    });
    
    if (!ocrState.isActive) {
      console.log('🖱️ OCR未激活，忽略事件');
      return;
    }

    if (e.button !== 0) {
      console.log('🖱️ 非左键点击，忽略事件');
      return;
    }

    const canvasPoint = ocrUtils.clientToCanvas(e.clientX, e.clientY);
    console.log('🖱️ Canvas坐标:', canvasPoint);
    if (!canvasPoint) return;

    e.preventDefault();
    console.log('🖱️ 开始处理OCR鼠标事件');

    // 分割线模式
    if (ocrState.mode === 'splitLine') {
      ocrActions.addSplitLine(canvasPoint.x);
      return;
    }

    // 检查是否点击了调整手柄
    if (globalOcrRegion) {
      const clickedHandle = ocrUtils.getClickedHandle(canvasPoint, globalOcrRegion);
      if (clickedHandle) {
        ocrActions.startResize(clickedHandle, canvasPoint, globalOcrRegion);
        return;
      }

      // 检查是否点击了区域内部（移动功能暂未实现）
      if (ocrUtils.isPointInRegion(canvasPoint, globalOcrRegion)) {
        return;
      }
    }

    // 区域选择模式
    if (ocrState.mode === 'selecting') {
      ocrActions.startDrag(canvasPoint);
    }
  }, [ocrState.isActive, ocrState.mode, globalOcrRegion, ocrUtils, ocrActions]);

  const handleOcrMouseMove = useCallback((e) => {
    if (!ocrState.isActive) return;

    // 在拖拽时更新鼠标位置
    if (ocrState.dragState.isDragging) {
      const canvasPoint = ocrUtils.clientToCanvas(e.clientX, e.clientY);
      if (canvasPoint) {
        setMousePosition(canvasPoint);
      }
      return;
    }

    // 调整区域大小
    if (ocrState.resizeState.isResizing) {
      const canvasPoint = ocrUtils.clientToCanvas(e.clientX, e.clientY);
      if (canvasPoint) {
        ocrActions.updateResize(canvasPoint);
      }
    }
  }, [ocrState.isActive, ocrState.dragState.isDragging, ocrState.resizeState.isResizing, ocrUtils, ocrActions, setMousePosition]);

  const handleOcrMouseUp = useCallback((e) => {
    console.log('🖱️ OCRRegionSelector鼠标松开事件', { 
      isActive: ocrState.isActive, 
      isDragging: ocrState.dragState.isDragging,
      mode: ocrState.mode,
      button: e.button,
      startPoint: ocrState.dragState.startPoint
    });

    if (!ocrState.isActive) {
      console.log('🖱️ OCRRegionSelector未激活，忽略事件');
      return;
    }

    // 结束拖拽 - 检查是否有起始点，即使isDragging为false
    if (ocrState.dragState.isDragging || ocrState.dragState.startPoint) {
      console.log('🖱️ OCRRegionSelector结束拖拽，开始计算结束位置');
      const endPoint = ocrUtils.clientToCanvas(e.clientX, e.clientY);
      console.log('🖱️ OCRRegionSelector拖拽结束位置:', endPoint);
      if (endPoint && ocrState.dragState.startPoint) {
        console.log('🖱️ OCRRegionSelector调用endDrag');
        ocrActions.endDrag(endPoint);
      }
    }

    // 结束调整大小
    if (ocrState.resizeState.isResizing) {
      console.log('🖱️ OCRRegionSelector结束调整大小');
      ocrActions.endResize();
    }
  }, [ocrState.isActive, ocrState.dragState.isDragging, ocrState.dragState.startPoint, ocrState.resizeState.isResizing, ocrUtils, ocrActions]);

  // 键盘事件处理
  const handleOcrKeyDown = useCallback((e) => {
    if (!ocrState.isActive) return;

    switch (e.key) {
      case 'Escape':
        if (ocrState.mode === 'selecting') {
          setOcrState(prev => ({ ...prev, mode: 'idle' }));
        } else if (ocrState.mode === 'splitLine') {
          setOcrState(prev => ({ ...prev, mode: 'idle' }));
          message.info('退出分割线模式');
        }
        e.preventDefault();
        break;

      case 'Delete':
        if (globalOcrRegion) {
          ocrActions.clearAll();
        }
        e.preventDefault();
        break;

      case 'Enter':
        if (globalOcrRegion) {
          message.info('OCR识别功能待实现');
        }
        e.preventDefault();
        break;
    }
  }, [ocrState.isActive, ocrState.mode, globalOcrRegion, ocrActions, setOcrState]);

  // 事件监听设置
  // OCR事件监听器 - 已禁用，由PDFViewer统一处理，避免重复事件导致状态冲突
  // useEffect(() => {
  //   if (ocrState.isActive) {
  //     document.addEventListener('mousedown', handleOcrMouseDown);
  //     document.addEventListener('mousemove', handleOcrMouseMove);
  //     document.addEventListener('mouseup', handleOcrMouseUp);
  //     document.addEventListener('keydown', handleOcrKeyDown);

  //     return () => {
  //       document.removeEventListener('mousedown', handleOcrMouseDown);
  //       document.removeEventListener('mousemove', handleOcrMouseMove);
  //       document.removeEventListener('mouseup', handleOcrMouseUp);
  //       document.removeEventListener('keydown', handleOcrKeyDown);
  //     };
  //   }
  // }, [ocrState.isActive, handleOcrMouseDown, handleOcrMouseMove, handleOcrMouseUp, handleOcrKeyDown]);

  // 监听来自Toolbar的OCR操作
  useEffect(() => {
    const handleOcrAction = (event) => {
      console.log('🎯 收到OCR事件:', event.detail);
      const { action } = event.detail;
      console.log('🎯 执行OCR操作:', action);

      switch (action) {
        case 'startRegion':
          console.log('🎯 开始区域选择');
          setOcrAreaTarget('material');
          ocrActions.startRegionSelection();
          break;
        case 'splitLine':
          ocrActions.enterSplitLineMode();
          break;
        case 'setPipelineArea':
          message.info('请框选"管线号"区域');
          setOcrAreaTarget('pipeline');
          ocrActions.startRegionSelection();
          break;
        case 'setDrawingNumberArea':
          message.info('请框选"图号"区域');
          setOcrAreaTarget('drawingNumber');
          ocrActions.startRegionSelection();
          break;
        case 'setPageNumberArea':
          message.info('请框选"页码"区域');
          setOcrAreaTarget('pageNumber');
          ocrActions.startRegionSelection();
          break;
        case 'setScaffoldArea':
          message.info('请框选"支架"区域');
          setOcrAreaTarget('scaffold');
          ocrActions.startRegionSelection();
          break;
        case 'setWeldRecognitionArea':
          message.info('请框选"焊点识别"区域');
          setOcrAreaTarget('weldRecognition');
          ocrActions.startRegionSelection();
          break;
        case 'saveTemplate':
          ocrActions.saveTemplate();
          break;
        case 'clear':
          ocrActions.clearAll();
          break;
        case 'importTemplate':
          console.log('🎯 导入模板', event.detail.template);
          try {
            const template = event.detail.template;
            // 检查是否至少有一个区域
            const hasAnyArea = template.materialArea || 
                              template.pipelineArea || 
                              template.pipeClassArea ||
                              template.drawingNumberArea || 
                              template.pageNumberArea || 
                              template.scaffoldArea;
            
            if (!hasAnyArea) {
              message.error('模板格式错误：模板中没有任何区域数据');
              return;
            }
            
            // 导入材料表区域（如果存在）
            if (template.materialArea) {
              setGlobalOcrRegion(template.materialArea);
              setOcrState(prev => ({
                ...prev,
                splitLines: template.materialArea.splitLines || []
              }));
            } else {
              // 如果没有材料表区域，清空相关状态
              setGlobalOcrRegion(null);
              setOcrState(prev => ({
                ...prev,
                splitLines: []
              }));
            }
            
            // 移除重复提示，由App.js统一处理
          } catch (error) {
            console.error('导入模板失败:', error);
            message.error('导入模板失败');
          }
          break;
      }
    };

    window.addEventListener('ocr-action', handleOcrAction);
    return () => window.removeEventListener('ocr-action', handleOcrAction);
  }, [ocrActions, setOcrAreaTarget, setGlobalOcrRegion, setOcrState, setGlobalPipelineArea, setGlobalDrawingNumberArea, setGlobalPageNumberArea, setGlobalScaffoldArea, setGlobalWeldRecognitionArea]);

  // 更新Canvas几何信息
  useEffect(() => {
    if (ocrState.isActive) {
      setOcrRenderKey(prev => prev + 1);
      const timer = setTimeout(() => {
        const geometry = ocrUtils.getCanvasGeometry();
        setCanvasGeometry(geometry);
      }, 50);
      return () => clearTimeout(timer);
    } else {
      setCanvasGeometry(null);
    }
  }, [scale, ocrState.isActive, currentPage, ocrUtils]);

  // 这个组件主要负责事件处理，不渲染可见内容
  return null;
};

export default OCRRegionSelector;
