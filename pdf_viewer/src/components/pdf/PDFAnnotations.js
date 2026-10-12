/**
 * PDF注释功能模块
 * 负责处理所有PDF注释相关的创建、编辑、渲染功能
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { getNextPipeSegmentLabel } from '../../utils/pipeSegmentUtils';
import { shouldCreatePipeSegmentOnMouseDown } from '../../utils/pdfInteractionUtils';
import { getSquareLeaderConnection } from '../../utils/squareLeaderConnection';
import {
  getFixedA3TenMmFrameSize,
  isFixedA3TenMmShape,
  scaleAnnotationValue
} from '../../utils/pageAnnotationScale';
import {
  DEFAULT_TEXT_RECTANGLE_FRAME_SIZE,
  getAnnotationFrameSize
} from '../../utils/textRectangleFrame';

export const usePDFAnnotations = ({
  // 基础状态
  annotationMode,
  pipeSegmentMode,
  scale,
  pageSize,
  getPageSize,
  
  // 注释配置
  annotationColor,
  annotationFontSize,
  annotationTopFontSize,
  annotationBottomFontSize,
  annotationFrameSize,
  annotationBorderShape,
  annotationPipeTagRotation = 0,
  annotationPipeTagZeroPadCount = 0,
  activeAnnotationRule,
  pipeSegmentCounter,
  pipeSegmentFontSize,
  pipeSegmentZeroPadWidth = 0,
  annotations = [],
  
  // 材料输入相关
  materialInputVisible,
  showMaterialInput,
  savePendingAnnotation,
  closeMaterialInput,
  
  // 回调函数
  onAnnotationAdd,
  onAnnotationUpdate,
  onAnnotationClick,
  onPipeSegmentCounterUpdate,
  generatePipeSegmentLetter,
  
  // DOM引用
  containerRef
}) => {
  
  // 绘图状态
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentAnnotation, setCurrentAnnotation] = useState(null);
  
  // 注释拖拽状态
  const [draggingAnnotation, setDraggingAnnotation] = useState(null);
  const [annotationDragStart, setAnnotationDragStart] = useState({ x: 0, y: 0 });
  const [annotationStartPos, setAnnotationStartPos] = useState({ startX: 0, startY: 0, endX: 0, endY: 0 });
  const [dragType, setDragType] = useState(null); // 'leader' | 'annotation' | 'whole'
  const previousPipeSegmentCounterRef = useRef(pipeSegmentCounter || 0);
  const pipeSegmentResetModeRef = useRef(false);
  const currentAnnotationRef = useRef(null);
  const pendingMoveAnnotationRef = useRef(null);
  const moveAnimationFrameRef = useRef(null);

  useEffect(() => () => {
    if (moveAnimationFrameRef.current !== null) {
      cancelAnimationFrame(moveAnimationFrameRef.current);
    }
  }, []);

  const normalizedPipeSegmentCounter = pipeSegmentCounter || 0;
  if (normalizedPipeSegmentCounter === 0 && previousPipeSegmentCounterRef.current > 0) {
    pipeSegmentResetModeRef.current = true;
  }
  previousPipeSegmentCounterRef.current = normalizedPipeSegmentCounter;

  // 生成规则预览文本
  const formatAnnotationRuleNumber = useCallback((value, zeroPadCount = 0) => {
    const text = String(value);
    const parsed = Number.parseInt(zeroPadCount, 10);
    const zeros = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 8) : 0;
    return zeros > 0 ? text.padStart(zeros + 1, '0') : text;
  }, []);

  const generateRulePreview = useCallback((rule, options = {}) => {
    if (!rule) return '';
    // 如果startNumber和currentNumber都是undefined或null，则不显示数字
    const currentNum = rule.currentNumber !== undefined && rule.currentNumber !== null 
      ? rule.currentNumber 
      : rule.startNumber;
    // 检查是否为 null、undefined 或者不是有效数字
    if (currentNum === undefined || currentNum === null || currentNum === '') {
      return `${rule.prefix || ''}${rule.suffix || ''}`;
    }
    return `${rule.prefix || ''}${formatAnnotationRuleNumber(currentNum, options.zeroPadCount)}${rule.suffix || ''}`;
  }, [formatAnnotationRuleNumber]);

  // 处理文本显示的函数
  const processAnnotationText = useCallback((annotation) => {
    let displayText = annotation.text || '';
    let fontSize = annotation.fontSize || 34; // 默认字体大小为34px
    
    // 如果文本为空，直接返回空内容和默认字号
    if (!displayText || displayText === '标注信息') {
       return { displayText: '', fontSize };
    }

    // 长方形框通过改变框宽适配文字，字号始终保持用户设置值。
    if (annotation.borderShape === 'text-rectangle') {
      return { displayText, fontSize };
    }
    
    // 当文本长度大于等于2个字符时，缩小字体以适应固定的标注框
    if (displayText.length >= 2) {
      // 根据字符数量动态调整字体大小
      if (displayText.length === 2) {
         fontSize = Math.max(fontSize * 0.85, 12); // 缩小到85%，最小12px
       } else if (displayText.length === 3) {
         fontSize = Math.max(fontSize * 0.70, 12); // 缩小到70%，最小12px
      } else if (displayText.length === 4) {
        fontSize = Math.max(fontSize * 0.50, 12); // 缩小到50%，最小12px
      } else if (displayText.length >= 5) {
        fontSize = Math.max(fontSize * 0.40, 10); // 缩小到40%，最小10px
      }
    }
    
    return { displayText, fontSize };
  }, []);

  // 计算标注大小的函数
  const calculateAnnotationSize = useCallback((textOrAnnotation, fontSizeOrText = 34, annotationOverride = null) => {
    let annotation = annotationOverride;
    let text = textOrAnnotation;
    let fontSize = fontSizeOrText;

    // 兼容旧调用：calculateAnnotationSize(annotation, displayText)
    if (textOrAnnotation && typeof textOrAnnotation === 'object') {
      annotation = textOrAnnotation;
      text = typeof fontSizeOrText === 'string' ? fontSizeOrText : (annotation.text || '');
      fontSize = typeof fontSizeOrText === 'number' ? fontSizeOrText : (annotation.fontSize || 34);
    }

    text = String(text || '');
    // In continuous/multi-page views `pageSize` belongs to the currently
    // active page.  A fixed-A3 annotation must instead use the dimensions of
    // the page it is actually drawn on, otherwise turning to a differently
    // sized page makes already-rendered circles/diamonds jump in size.
    const annotationPageSize = typeof getPageSize === 'function'
      ? (getPageSize(annotation?.page) || pageSize)
      : pageSize;
    const fixedA3Shape = isFixedA3TenMmShape(annotation?.borderShape);
    const baseFrameSize = fixedA3Shape
      ? getFixedA3TenMmFrameSize(annotationPageSize)
      : getAnnotationFrameSize(annotation, annotationFrameSize || 56.7);

    // 计算文本的显示宽度（考虑中英文字符）
    const getTextWidth = (text, fontSize) => {
      let width = 0;
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (/[\u4e00-\u9fa5]/.test(char)) {
          // 中文字符
          width += fontSize;
        } else {
          // 英文字符和数字
          width += fontSize * 0.6;
        }
      }
      return width;
    };

    const textWidth = getTextWidth(text, fontSize);
    const textHeight = fontSize;
    const padding = 6; // 减小文本边距
    
    // 计算基于字体大小的基准尺寸（34px字体为基准，对角线约1cm）
    const baseFontSize = 34;
    const baseDiagonalLength = baseFrameSize; // 默认1cm，可由工具栏或单个标注自定义
    // 固定标注框大小，不随字体大小而改变
    const scaledDiagonalLength = baseDiagonalLength; // 固定为基准大小
    
    // 计算基于文本内容的最小尺寸需求（更保守的计算）
    const textRequiredWidth = textWidth + padding * 2;
    const textRequiredHeight = textHeight + padding * 2;
    
    // 只有当文本确实需要更大空间时才放大标注框
    const textBasedRadius = Math.max(textRequiredWidth, textRequiredHeight) / 2;
    const textBasedDiagonalLength = textBasedRadius * 2;
    
    // 固定标注框尺寸，当文本长度大于等于2个字符时保持固定大小
    const finalDiagonalLength = !fixedA3Shape && (text.length < 2 && textBasedDiagonalLength > scaledDiagonalLength)
      ? textBasedDiagonalLength 
      : scaledDiagonalLength;
    
    // 对于所有形状，外接圆直径等于对角线长度
    const circumscribedRadius = finalDiagonalLength / 2;
    
    // 圆形：半径就是外接圆半径
    const circleRadius = circumscribedRadius;
    
    // 菱形：从中心到顶点的距离等于外接圆半径
    const diamondRadius = circumscribedRadius;
    
    // 矩形：对角线长度等于finalDiagonalLength，所以半边长为对角线/2√2
    const rectangleHalfSide = finalDiagonalLength / (2 * Math.sqrt(2));

    // 长方形框按实际文字宽度扩展；留出细小但足够的描边间距。
    const textRectangleFrameScale = Math.max(0.35, baseFrameSize / 56.7);
    const textRectangleWidth = Math.max(
      textWidth + 2,
      (textWidth + Math.max(2, fontSize * 0.18)) * textRectangleFrameScale
    );
    const textRectangleHeight = Math.max(
      fontSize * 1.02,
      fontSize * 1.1 * textRectangleFrameScale
    );
    
    // 水平线长度：与对角线长度相等
    const lineLength = finalDiagonalLength;
    
    return {
      circleRadius,
      diamondRadius,
      rectangleHalfSide,
      textRectangleWidth,
      textRectangleHeight,
      lineLength,
      diagonalLength: finalDiagonalLength
    };
  }, [annotationFrameSize, getPageSize, pageSize]);

  // 计算引导线与标注框的最佳连接点
  const calculateConnectionPoint = useCallback((annotation, shapeType, shapeSize) => {
    if (!annotation.hasLeaderLine) return null;
    
    const dx = annotation.endX - annotation.startX;
    const dy = annotation.endY - annotation.startY;
    const length = Math.sqrt(dx * dx + dy * dy);
    
    if (length === 0) return { connectionX: annotation.endX, connectionY: annotation.endY };
    
    const unitX = dx / length;
    const unitY = dy / length;
    
    let connectionX, connectionY;
    
    switch (shapeType) {
      case 'circle':
        // 圆形：连接到圆周上最接近引导线方向的点
        connectionX = annotation.endX - unitX * shapeSize;
        connectionY = annotation.endY - unitY * shapeSize;
        break;
        
      case 'diamond':
        // 菱形：连接到最接近引导线方向的顶点
        const vertices = [
          { x: annotation.endX, y: annotation.endY - shapeSize, name: 'top' },
          { x: annotation.endX + shapeSize, y: annotation.endY, name: 'right' },
          { x: annotation.endX, y: annotation.endY + shapeSize, name: 'bottom' },
          { x: annotation.endX - shapeSize, y: annotation.endY, name: 'left' }
        ];
        
        // 找到距离引导线起点最近的顶点
        let closestVertex = vertices[0];
        let minDistance = Infinity;
        
        vertices.forEach(vertex => {
          const distanceToStart = Math.sqrt(
            Math.pow(vertex.x - annotation.startX, 2) + 
            Math.pow(vertex.y - annotation.startY, 2)
          );
          if (distanceToStart < minDistance) {
            minDistance = distanceToStart;
            closestVertex = vertex;
          }
        });
        
        connectionX = closestVertex.x;
        connectionY = closestVertex.y;
        break;
        
      case 'rectangle':
        ({ connectionX, connectionY } = getSquareLeaderConnection(annotation, shapeSize));
        break;

      case 'text-rectangle':
      case 'pipe-tag': {
        const tagWidth = shapeSize?.width || 130;
        const tagHeight = shapeSize?.height || 23;
        const angle = (Number(annotation.rotation) || 0) * Math.PI / 180;
        const toStartX = annotation.startX - annotation.endX;
        const toStartY = annotation.startY - annotation.endY;
        const localX = toStartX * Math.cos(-angle) - toStartY * Math.sin(-angle);
        const localY = toStartX * Math.sin(-angle) + toStartY * Math.cos(-angle);
        const localLength = Math.sqrt(localX * localX + localY * localY);
        if (!localLength) {
          connectionX = annotation.endX;
          connectionY = annotation.endY;
          break;
        }
        const localUnitX = localX / localLength;
        const localUnitY = localY / localLength;
        const tx = Math.abs(localUnitX) > 0.0001 ? (tagWidth / 2) / Math.abs(localUnitX) : Infinity;
        const ty = Math.abs(localUnitY) > 0.0001 ? (tagHeight / 2) / Math.abs(localUnitY) : Infinity;
        const t = Math.min(tx, ty);
        const hitX = localUnitX * t;
        const hitY = localUnitY * t;
        connectionX = annotation.endX + hitX * Math.cos(angle) - hitY * Math.sin(angle);
        connectionY = annotation.endY + hitX * Math.sin(angle) + hitY * Math.cos(angle);
        break;
      }
        
      default:
        // 默认使用简单的半径计算
        connectionX = annotation.endX - unitX * shapeSize;
        connectionY = annotation.endY - unitY * shapeSize;
    }
    
    return { connectionX, connectionY };
  }, []);

  // 标注样式配置
  const annotationStyles = useMemo(() => ({
    strokeWidth: 2,
    textFontWeight: '500',
    textStyle: {
      textOrientation: 'upright',
      transition: 'none',
      pointerEvents: 'none',
      userSelect: 'none'
    }
  }), []);

  // 处理标注绘制开始
  const handleAnnotationStart = useCallback((event, pageNumber) => {
    const t0 = performance.now();
    
    if (!annotationMode || event.button !== 0) return; // 只处理左键点击
    
    // 如果有材料编号输入对话框打开，先保存材料编号再关闭
    if (materialInputVisible) {
      savePendingAnnotation();
      closeMaterialInput();
    }
    
    event.preventDefault();
    event.stopPropagation(); // 阻止事件冒泡，避免与拖拽冲突
    
    const t1 = performance.now();
    setIsDrawing(true);
    const t2 = performance.now();
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / scale;
    const y = (event.clientY - rect.top) / scale;
    
    // 根据当前的标注形状设置默认字体大小
    let finalFontSize = annotationFontSize;
    if (annotationBorderShape === 'field-weld') {
      finalFontSize = 20; // 现场焊缝的默认字体大小
    } else if (annotationBorderShape === 'shop-weld') {
      finalFontSize = 22; // 车间焊缝的默认字体大小
    }
    const isTextRectangle = annotationBorderShape === 'text-rectangle';
    // Rectangle annotations use one document-wide pixel convention. Scaling
    // them from each PDF page size made page 1 look correct while later pages
    // received different font/frame values.
    const scaledFontSize = isTextRectangle
      ? (Number(finalFontSize) || 34)
      : scaleAnnotationValue(finalFontSize, pageSize, finalFontSize);
    const baseTopFontSize = annotationTopFontSize || finalFontSize;
    const baseBottomFontSize = annotationBottomFontSize || finalFontSize;
    const drawingPageSize = typeof getPageSize === 'function'
      ? (getPageSize(pageNumber) || pageSize)
      : pageSize;
    const scaledTopFontSize = scaleAnnotationValue(baseTopFontSize, drawingPageSize, baseTopFontSize);
    const scaledBottomFontSize = scaleAnnotationValue(baseBottomFontSize, drawingPageSize, baseBottomFontSize);
    const scaledFrameSize = isFixedA3TenMmShape(annotationBorderShape)
      ? getFixedA3TenMmFrameSize(drawingPageSize)
      : isTextRectangle
      ? DEFAULT_TEXT_RECTANGLE_FRAME_SIZE
      : scaleAnnotationValue(annotationFrameSize || 56.7, drawingPageSize, 56.7);
    const annotation = {
      page: pageNumber,
      type: 'text',
      startX: x,
      startY: y,
      endX: x,
      endY: y,
      color: annotationColor || '#FF0000',
      fontSize: scaledFontSize,
      topFontSize: annotationBorderShape === 'split-circle' ? scaledTopFontSize : undefined,
      bottomFontSize: annotationBorderShape === 'split-circle' ? scaledBottomFontSize : undefined,
      frameSize: scaledFrameSize,
      borderShape: annotationBorderShape,
      rotation: annotationBorderShape === 'pipe-tag' ? (Number(annotationPipeTagRotation) || 0) : undefined,
      isDragged: false,
      hasLeaderLine: false
    };

    // 如果有激活的规则，预设文字内容
    if (activeAnnotationRule) {
      annotation.text = generateRulePreview(activeAnnotationRule, {
        zeroPadCount: annotationBorderShape === 'pipe-tag' ? annotationPipeTagZeroPadCount : 0
      });
      if (annotationBorderShape === 'split-circle') {
        const jointTypeText = String(activeAnnotationRule.jointTypeText || '').trim();
        annotation.jointTypeText = jointTypeText;
        annotation.topText = '';
      }
    } else {
      annotation.text = ''; // 默认为空，不显示"标注信息"
    }

    currentAnnotationRef.current = annotation;
    pendingMoveAnnotationRef.current = null;
    setCurrentAnnotation(annotation);
    const t3 = performance.now();
    
    console.log(`⏱️ [性能] 鼠标按下 -> 开始绘制:
  - 事件处理: ${(t1 - t0).toFixed(2)}ms
  - setIsDrawing: ${(t2 - t1).toFixed(2)}ms
  - 创建标注对象: ${(t3 - t2).toFixed(2)}ms
  - 总耗时: ${(t3 - t0).toFixed(2)}ms`);
  }, [
    annotationMode, scale, pageSize, annotationColor, annotationFontSize, annotationTopFontSize, annotationBottomFontSize, annotationFrameSize, annotationPipeTagRotation, annotationPipeTagZeroPadCount,
    annotationBorderShape, activeAnnotationRule, generateRulePreview, getPageSize,
    materialInputVisible, savePendingAnnotation, closeMaterialInput
  ]);

  // 处理标注绘制过程
  const handleAnnotationMove = useCallback((event, pageNumber) => {
    const t0 = performance.now();
    const drawingAnnotation = currentAnnotationRef.current;
    if (!isDrawing || !drawingAnnotation || event.buttons !== 1) return;
    
    event.preventDefault();
    event.stopPropagation();
    
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / scale;
    const y = (event.clientY - rect.top) / scale;
    
    // 计算拖拽距离，判断是否为拖拽操作
    const dragDistance = Math.sqrt(
      Math.pow(x - drawingAnnotation.startX, 2) +
      Math.pow(y - drawingAnnotation.startY, 2)
    );
    
    const isDragOperation = dragDistance > 10; // 超过10像素认为是拖拽
    
    const nextAnnotation = {
      ...drawingAnnotation,
      endX: x,
      endY: y,
      isDragged: isDragOperation,
      hasLeaderLine: isDragOperation
    };
    currentAnnotationRef.current = nextAnnotation;
    pendingMoveAnnotationRef.current = nextAnnotation;
    if (moveAnimationFrameRef.current === null) {
      moveAnimationFrameRef.current = requestAnimationFrame(() => {
        moveAnimationFrameRef.current = null;
        const pending = pendingMoveAnnotationRef.current;
        pendingMoveAnnotationRef.current = null;
        if (pending) setCurrentAnnotation(pending);
      });
    }
    
    const t1 = performance.now();
    if (t1 - t0 > 5) { // 只记录耗时>5ms的情况
      console.log(`⏱️ [性能] 鼠标移动耗时: ${(t1 - t0).toFixed(2)}ms`);
    }
  }, [isDrawing, currentAnnotation, scale]);

  // 处理标注绘制结束
  const handleAnnotationEnd = useCallback(() => {
    const t0 = performance.now();
    const drawingAnnotation = currentAnnotationRef.current;
    if (!isDrawing || !drawingAnnotation) return;

    if (moveAnimationFrameRef.current !== null) {
      cancelAnimationFrame(moveAnimationFrameRef.current);
      moveAnimationFrameRef.current = null;
    }
    pendingMoveAnnotationRef.current = null;
    
    setIsDrawing(false);
    
    // 准备要保存的标注数据
    const finalAnnotation = { ...drawingAnnotation };
    
    // 如果是点击操作（没有拖拽），在点击位置创建文本标注
    if (!drawingAnnotation.isDragged) {
      finalAnnotation.endX = finalAnnotation.startX;
      finalAnnotation.endY = finalAnnotation.startY;
      finalAnnotation.hasLeaderLine = false;
    } else {
      // 拖拽操作，保留引导线
      finalAnnotation.hasLeaderLine = true;
    }
    
    // 移除临时属性
    delete finalAnnotation.isDragged;
    
    // 显示材料编号输入对话框
    showMaterialInput(finalAnnotation);
    
    currentAnnotationRef.current = null;
    setCurrentAnnotation(null);
    
    const t1 = performance.now();
    console.log(`⏱️ [性能] 鼠标释放 -> 完成标注: ${(t1 - t0).toFixed(2)}ms`);
  }, [isDrawing, currentAnnotation, showMaterialInput]);

  // 处理管段号点击
  const handlePipeSegmentClick = useCallback((event, pageNumber) => {
    if (!shouldCreatePipeSegmentOnMouseDown({
      pipeSegmentMode,
      button: event.button
    })) {
      return;
    }
    
    event.preventDefault();
    event.stopPropagation();
    
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / scale;
    const y = (event.clientY - rect.top) / scale;
    
    const makePipeSegmentLabel = (counter) => (
      generatePipeSegmentLetter
        ? generatePipeSegmentLetter(counter)
        : getNextPipeSegmentLabel('A', counter, pipeSegmentZeroPadWidth)
    );
    const usedLabels = new Set(
      (annotations || [])
        .filter(annotation => annotation?.remark === '管段号')
        .map(annotation => String(annotation.text || '').trim())
        .filter(Boolean)
    );
    let nextCounter = pipeSegmentResetModeRef.current ? (pipeSegmentCounter || 0) : 0;
    if (!pipeSegmentResetModeRef.current) {
      const maxProbe = Math.max(usedLabels.size + 100, nextCounter + 100, 100);
      while (nextCounter <= maxProbe && usedLabels.has(makePipeSegmentLabel(nextCounter))) {
        nextCounter += 1;
      }
      if (nextCounter > maxProbe) {
        nextCounter = pipeSegmentCounter || 0;
      }
    }
    const letter = makePipeSegmentLabel(nextCounter);
    
    // 创建管段号标注
    const pipeSegmentAnnotation = {
      page: pageNumber,
      type: 'text',
      startX: x,
      startY: y,
      endX: x,
      endY: y,
      text: letter,
      color: '#000000',
      fontSize: pipeSegmentFontSize || 16,
      borderShape: 'none',
      hasLeaderLine: false,
      remark: '管段号'
    };
    
    // 添加标注；计数器由 App 层的撤销命令统一更新
    onAnnotationAdd(pipeSegmentAnnotation);
    onPipeSegmentCounterUpdate?.(nextCounter + 1);
  }, [
    pipeSegmentMode, scale, pipeSegmentCounter, onAnnotationAdd,
    onPipeSegmentCounterUpdate, generatePipeSegmentLetter, pipeSegmentFontSize,
    pipeSegmentZeroPadWidth, annotations
  ]);

  return {
    // 状态
    isDrawing,
    currentAnnotation,
    draggingAnnotation,
    annotationDragStart,
    annotationStartPos,
    dragType,
    
    // 状态设置器
    setDraggingAnnotation,
    setAnnotationDragStart,
    setAnnotationStartPos,
    setDragType,
    setCurrentAnnotation,
    
    // 事件处理函数
    handleAnnotationStart,
    handleAnnotationMove,
    handleAnnotationEnd,
    handlePipeSegmentClick,
    
    // 工具函数
    processAnnotationText,
    calculateAnnotationSize,
    calculateConnectionPoint,
    generateRulePreview,
    annotationStyles
  };
};

export default usePDFAnnotations;
