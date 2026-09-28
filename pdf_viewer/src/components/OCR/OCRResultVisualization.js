/**
 * OCR缁撴灉鍙鍖栫粍浠? * 鐢ㄤ簬鍦≒DF椤甸潰涓婃樉绀鸿瘑鍒粨鏋滅殑鐭╁舰妗? */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import styled from 'styled-components';
import { PlusOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { Button, Tooltip } from 'antd';
import { useOCRContext } from '../../contexts/OCRContext';
import {
  buildScaffoldMaterialLibrary,
  isScaffoldDetection as matchScaffoldDetection
} from '../../utils/scaffoldRecognitionUtils';

const VisualizationLayer = styled.div`
  position: absolute;
  /* top/left/width/height 灏嗗湪杩愯鏃剁敱 style 娉ㄥ叆锛屼笌 Canvas 绮剧‘瀵归綈 */
  pointer-events: none;
  z-index: 3;
`;

const DetectionBox = styled.div.withConfig({
  shouldForwardProp: (prop) => !['isScaffold', 'showAll', 'isSelected'].includes(prop)
})`
  position: absolute;
  border: 2px solid ${props => 
    props.isSelected ? '#ff4d4f' : 
    (props.isScaffold ? '#52c41a' : 
    (props.showAll ? '#faad14' : '#1890ff'))
  };
  background: ${props => 
    props.isSelected ? 'rgba(255, 77, 79, 0.2)' : 
    (props.isScaffold ? 'rgba(82, 196, 26, 0.1)' : 
    (props.showAll ? 'rgba(250, 173, 20, 0.1)' : 'rgba(24, 144, 255, 0.1)'))
  };
  pointer-events: auto;
  /* 浠呭湪棰滆壊鍙樺寲鏃跺仛杩囨浮锛岄伩鍏嶄綅缃?灏哄鍙樺寲浜х敓"椋炲叆"鏁堟灉 */
  transition: all 0.2s ease;
  opacity: ${props => (props.showAll && !props.isScaffold && !props.isSelected) ? 0.8 : 1};
  z-index: ${props => props.isSelected ? 20 : (props.isScaffold ? 5 : 4)};
  cursor: pointer;
  
  &:hover {
    background: ${props => 
      props.isSelected ? 'rgba(255, 77, 79, 0.3)' : 
      (props.isScaffold ? 'rgba(82, 196, 26, 0.2)' : 
      (props.showAll ? 'rgba(250, 173, 20, 0.15)' : 'rgba(24, 144, 255, 0.2)'))
    };
    border-color: ${props => 
      props.isSelected ? '#ff7875' : 
      (props.isScaffold ? '#73d13d' : 
      (props.showAll ? '#ffc53d' : '#40a9ff'))
    };
    opacity: 1;
    z-index: 20;
  }
`;

const AnnotationButton = styled.button`
  position: absolute;
  top: -8px;
  right: -8px;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 50%;
  background: #52c41a;
  color: white;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  opacity: 0;
  transition: opacity 0.2s ease;
  z-index: 10;
  
  &:hover {
    background: #73d13d;
    transform: scale(1.1);
  }
  
  ${DetectionBox}:hover & {
    opacity: 1;
  }
`;

const BatchAnnotationButton = styled.div`
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 20;
  pointer-events: auto;
`;

const ScaffoldDebugPanel = styled.div`
  position: absolute;
  left: 10px;
  bottom: 10px;
  max-width: 420px;
  max-height: 240px;
  overflow: auto;
  z-index: 25;
  pointer-events: auto;
  background: rgba(15, 23, 42, 0.92);
  color: #e5e7eb;
  border: 1px solid rgba(148, 163, 184, 0.4);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
  box-shadow: 0 4px 14px rgba(15, 23, 42, 0.28);

  strong {
    color: #ffffff;
  }

  code {
    color: #bfdbfe;
    white-space: pre-wrap;
    word-break: break-all;
  }
`;

// 娓呮礂鏀灦鏂囨湰锛屾彁鍙?S-鏁板瓧 妯″紡锛堜笌ocrService.js淇濇寔涓€鑷达級
// 馃啎 浼樺寲鐗堬細鏀寔绌烘牸鍒嗚瘝鍜岀嫭绔嬭瘝鍒ゆ柇
const cleanScaffoldText = (text) => {
  if (!text || typeof text !== 'string') return '';
  
  const scaffoldPattern = /[Ss]-?\d{4,}/;
  
  // 馃幆 绛栫暐1: 浼樺厛灏濊瘯鐩存帴鎻愬彇 S-鏁板瓧 妯″紡锛堟鏌ユ槸鍚︿负鐙珛璇嶏級
  const directMatch = text.match(scaffoldPattern);
  
  if (directMatch) {
    // 鎵惧埌浜?S-鏁板瓧 妯″紡锛屾鏌ユ槸鍚︿负鐙珛鐨勮瘝
    const matchedText = directMatch[0];
    const matchIndex = directMatch.index;
    
    // 妫€鏌ュ尮閰嶆枃鏈墠鍚庣殑瀛楃
    const beforeChar = matchIndex > 0 ? text[matchIndex - 1] : ' ';
    const afterIndex = matchIndex + matchedText.length;
    const afterChar = afterIndex < text.length ? text[afterIndex] : ' ';
    
    // 濡傛灉鍓嶅悗鏄┖鏍笺€佹爣鐐规垨瀛楃涓茶竟鐣岋紝璁や负鏄嫭绔嬬殑鏀灦缂栧彿
    const separatorPattern = /[\s,，、:：。.\/\-\(\)\[\]【】]/;
    const beforeIsSeparator = matchIndex === 0 || separatorPattern.test(beforeChar);
    const afterIsSeparator = afterIndex === text.length || separatorPattern.test(afterChar);
    
    if (beforeIsSeparator && afterIsSeparator) {
      // 鏍煎紡鍖栧苟杩斿洖
      let extracted = matchedText;
      extracted = extracted.replace(/^s/i, 'S');
      if (!extracted.includes('-')) {
        extracted = extracted.replace(/^S/, 'S-');
      }
      
      // 妫€鏌ユ枩鏉狅紙鍦ㄥ尮閰嶄綅缃箣鍚庢煡鎵撅級
      const textAfterMatch = text.substring(matchIndex);
      const hasSlash = /[Ss]-?\d{4,}\s*\//.test(textAfterMatch);
      if (hasSlash && !extracted.endsWith('/')) {
        extracted += '/';
      }
      
      return extracted;
    }
  }
  
  return '';
};

// 楠岃瘉鏄惁涓烘湁鏁堢殑鏀灦缂栧彿
const isValidScaffoldNumber = (text) => {
  if (!text || typeof text !== 'string') {
    return false;
  }
  
  const cleanedText = cleanScaffoldText(text);
  
  // 涓ユ牸楠岃瘉锛氭敮鏋剁紪鍙锋牸寮?S-XXXXXX 鎴?S-XXXXXX/
  const scaffoldPattern = /^S-\d{6}\/?$/i;
  if (scaffoldPattern.test(cleanedText)) {
    return true;
  }
  
  // 瀹芥澗楠岃瘉锛歋-寮€澶?鑷冲皯4浣嶆暟瀛?鍙€夋枩鏉狅紙涓巓crService.js淇濇寔涓€鑷达級
  const scaffoldLikePattern = /^S-?\d{4,}\/?$/i;
  return scaffoldLikePattern.test(cleanedText);
};

const OCRResultVisualization = ({
  detections,
  scale = 1,
  pageSize,
  onAddScaffoldAnnotation,
  onBatchAddScaffoldAnnotations,
  debugMode = false,
  showAllDetections = true,
  currentPage,
  isRawDetection = false,
  materialRows = [],
  normalizedArea = null
}) => {
  const { selectedDetectionIndices, setSelectedDetectionIndices } = useOCRContext();
  
  // 鑾峰彇褰撳墠椤电殑閫変腑绱㈠紩闆嗗悎
  const getCurrentPageIndices = () => {
    if (!currentPage) return new Set();
    return selectedDetectionIndices[currentPage] || new Set();
  };

  const [selectedIndices, setSelectedIndices] = useState(getCurrentPageIndices());

  // 褰撻〉鐮佸彉鍖栨垨涓婁笅鏂囩姸鎬佸彉鍖栨椂鏇存柊鏈湴鐘舵€?
  useEffect(() => {
    setSelectedIndices(getCurrentPageIndices());
  }, [currentPage, selectedDetectionIndices]);

  // 濡傛灉娌℃湁璇嗗埆鏁版嵁锛屼笉鏄剧ず
  if (!detections || !Array.isArray(detections) || detections.length === 0) {
    return null;
  }
  const scaffoldMaterialLibrary = buildScaffoldMaterialLibrary(materialRows);
  const scaffoldDebugSummary = !isRawDetection ? {
    page: currentPage,
    materialRowsCount: Array.isArray(materialRows) ? materialRows.length : 0,
    libraryCount: scaffoldMaterialLibrary.length,
    library: scaffoldMaterialLibrary.slice(0, 20).map(item => ({
      description: item.description,
      specification: item.material?.specification || item.material?.diameter || item.material?.ND || '',
      code: item.material?.materialCode || item.material?.ITEM_CODE || item.material?.itemCode || ''
    })),
    detections: detections.slice(0, 40).map((detection) => {
      const text = detection.text || detection.scaffoldInfo || detection.originalText || '';
      const match = matchScaffoldDetection(text, scaffoldMaterialLibrary);
      return {
        text,
        matched: match.matched,
        source: match.source || '',
        libraryDescription: match.libraryMatch?.description || ''
      };
    })
  } : null;

  if (scaffoldDebugSummary && typeof window !== 'undefined') {
    window.__lastScaffoldDebug = scaffoldDebugSummary;
  }
  
  const toggleSelection = (index) => {
    const currentSet = getCurrentPageIndices();
    const newSet = new Set(currentSet);
    
    if (newSet.has(index)) {
      newSet.delete(index);
    } else {
      newSet.add(index);
    }
    
    // 鏇存柊涓婁笅鏂囦腑鐨勭姸鎬?
    setSelectedDetectionIndices(prev => ({
      ...prev,
      [currentPage]: newSet
    }));
    
    // 鏇存柊鏈湴鐘舵€侊紙铏界劧涓婇潰鐨?effect 浼氬鐞嗭紝浣嗕负浜嗘洿蹇殑 UI 鍝嶅簲锛?
    setSelectedIndices(newSet);
  };
  
  // 鎵归噺娣诲姞鍚庢竻闄ら€変腑
  const clearSelection = () => {
    setSelectedDetectionIndices(prev => ({
      ...prev,
      [currentPage]: new Set()
    }));
    setSelectedIndices(new Set());
  };
  
  // 调试模式：输出所有检测结果
  if (debugMode) {
    console.log('OCR可视化调试 - 收到检测结果:', detections.length);
    detections.forEach((detection, index) => {
      const cleanedText = cleanScaffoldText(detection.text);
      const isScaffold = !!cleanedText;
      console.log(`检测${index}: "${detection.text}" | 清洗后: "${cleanedText}" | 是否支架: ${isScaffold}`);
    });
  }
  
  console.log('[OCRResultVisualization] 参数:', {
    isRawDetection: isRawDetection,
    detectionsCount: detections.length,
    showAllDetections: showAllDetections
  });
  
  // 收集所有支架和阀门信息
  const scaffoldAndValveDetections = detections.filter(detection => {
    const detectionText = detection.text || detection.scaffoldInfo || detection.originalText || '';

    if (isRawDetection) {
      console.log('[OCRResultVisualization] 材料表模式，不过滤检测结果');
      return true;
    }

    const isValve = detection.isValveInfo === true || detection.itemType === 'valve';
    if (isValve) {
      console.log(`[OCRVisualization] 识别为阀门: "${detectionText}"`);
      return true;
    }
    
    // 妫€鏌ユ槸鍚︿负鏀灦
    const cleanedText = cleanScaffoldText(detectionText);
    const matchResult = matchScaffoldDetection(detectionText, scaffoldMaterialLibrary);
    const isScaffold = !!cleanedText || matchResult.matched;
    if (matchResult.matched) {
      detection.scaffoldMatchSource = matchResult.source;
      detection.supportMaterial = matchResult.libraryMatch?.material || null;
      detection.supportMaterialDescription = matchResult.libraryMatch?.description || '';
    }
    
    return isScaffold;
  });
  
  // 统计支架和阀门数量
  const valveCount = scaffoldAndValveDetections.filter(d => d.isValveInfo === true || d.itemType === 'valve').length;
  const scaffoldCount = scaffoldAndValveDetections.length - valveCount;
  
  if (isRawDetection) {
    console.log(`[OCRVisualization] 材料表模式 - 显示检测数量: ${scaffoldAndValveDetections.length}/${detections.length}`);
  } else {
    console.log(`[OCRVisualization] 支架模式 - 显示检测数量: ${scaffoldAndValveDetections.length}/${detections.length} (支架:${scaffoldCount}, 阀门:${valveCount})`);
  }
  
  // 批量添加所有支架和阀门标注
  const handleBatchAddAnnotations = () => {
    if (selectedIndices.size > 0) {
      let selectedDetections = detections.filter((_, index) => selectedIndices.has(index));
      
      // 按空间位置排序：从上到下、从左到右
      selectedDetections.sort((a, b) => {
        // 鑾峰彇 y 鍧愭爣 (box[0][1] 涓哄乏涓婅 y)
        const yA = a.box[0][1];
        const yB = b.box[0][1];
        
        // 濡傛灉 y 鍧愭爣鐩稿樊寰堝皬锛堜緥濡?0.5% 鐨勯〉闈㈤珮搴︼級锛屽垯璁や负鍦ㄥ悓涓€琛岋紝鎸?x 鎺掑簭
        if (Math.abs(yA - yB) < 0.005) {
          return a.box[0][0] - b.box[0][0];
        }
        return yA - yB;
      });

      console.log(`[OCRVisualization] 批量添加选中项，共 ${selectedDetections.length} 项`);
      
      const itemInfos = selectedDetections.map((detection, index) => {
        // 计算中心点坐标
        const centerX = detection.box[0][0] + (detection.box[1][0] - detection.box[0][0]) / 2;
        const centerY = detection.box[0][1] + (detection.box[2][1] - detection.box[0][1]) / 2;
        
        if (isRawDetection) {
           return {
            text: detection.text,
            originalText: detection.text,
            x: centerX,
            y: centerY,
            detection: detection,
            isValve: false,
            isRaw: true
           };
        }

        const seqText = `V${index + 1}`;
        
        return {
          text: seqText,                   // 寮哄埗浣跨敤 V1, V2... 缂栧彿
          originalText: detection.text,    // 淇濈暀鍘熷 OCR 鏂囨湰澶囨煡
          x: centerX,
          y: centerY,
          detection: detection,
          isValve: true,
          isManualSelection: true
        };
      });
      
      onBatchAddScaffoldAnnotations(itemInfos);
      clearSelection();
      return;
    }

    const valveCount = scaffoldAndValveDetections.filter(d => d.isValveInfo === true || d.itemType === 'valve').length;
    const scaffoldCount = scaffoldAndValveDetections.length - valveCount;
    console.log(`[OCRVisualization] 开始批量添加，共 ${scaffoldAndValveDetections.length} 项 (支架:${scaffoldCount}, 阀门:${valveCount})`);
    
    if (!onBatchAddScaffoldAnnotations || scaffoldAndValveDetections.length === 0) {
      console.log('[OCRVisualization] 批量添加取消:', {
        hasCallback: !!onBatchAddScaffoldAnnotations,
        totalCount: scaffoldAndValveDetections.length
      });
      return;
    }
    
    const itemInfos = scaffoldAndValveDetections.map((detection, index) => {
      const centerX = detection.box[0][0] + (detection.box[1][0] - detection.box[0][0]) / 2;
      const centerY = detection.box[0][1] + (detection.box[2][1] - detection.box[0][1]) / 2;
      
      // 馃啎 濡傛灉鏄函鏂囨湰妫€娴嬫ā寮忥紝鐩存帴浣跨敤鍘熸枃锛屼笉杩涜鍒嗙被
      if (isRawDetection) {
        return {
          text: detection.text,
          originalText: detection.text,
          x: centerX,
          y: centerY,
          detection: detection,
          isValve: false,
          isRaw: true
        };
      }

      const isValve = detection.isValveInfo === true || detection.itemType === 'valve';
      
      if (isValve) {
        // 闃€闂細浣跨敤鍘熷鍚堝苟鍚庣殑鏂囨湰
        const info = {
          text: detection.text,
          originalText: detection.text,
          x: centerX,
          y: centerY,
          detection: detection,
          isValve: true,
          mergedFrom: detection.mergedFrom
        };
        
        console.log(`[OCRVisualization] 阀门 ${index + 1}/${scaffoldAndValveDetections.length}: "${detection.text}"`);
        return info;
        
      } else {
        const detectionText = detection.text || detection.scaffoldInfo || detection.originalText || '';
        const cleanedText = cleanScaffoldText(detectionText);
        
        const info = {
          text: (cleanedText || detectionText).replace('/', ''), // 浣跨敤娓呮礂鍚庣殑鏂囨湰锛屽苟绉婚櫎鏂滄潬
          originalText: detectionText,
          x: centerX,
          y: centerY,
          detection: detection,
          isValve: false,                 // 鏍囪涓烘敮鏋?
          scaffoldMatchSource: detection.scaffoldMatchSource || '',
          supportMaterial: detection.supportMaterial || null,
          supportMaterialDescription: detection.supportMaterialDescription || ''
        };
        
        console.log(`[OCRVisualization] 支架 ${index + 1}/${scaffoldAndValveDetections.length}: "${cleanedText || detectionText}"`);
        return info;
      }
    });
    
    console.log(`[OCRVisualization] 调用批量添加回调，传递 ${itemInfos.length} 项 (支架:${scaffoldCount}, 阀门:${valveCount})`);
    onBatchAddScaffoldAnnotations(itemInfos);
  };
  
  // 妫€娴嬫暟鎹湁鏁?
  // 閫変腑/楂樹寒鐘舵€佺鐞?  // 绉婚櫎鏃х殑鏈湴鐘舵€佺鐞嗕唬鐮侊紝鏀圭敤涓婇潰鐨勪笂涓嬫枃绠＄悊
  /* 
  const [selectedIndices, setSelectedIndices] = useState(new Set());

  const toggleSelection = (index) => {
    const newSet = new Set(selectedIndices);
    if (newSet.has(index)) {
      newSet.delete(index);
    } else {
      newSet.add(index);
    }
    setSelectedIndices(newSet);
  };
  */

  const layerRef = useRef(null);
  const [overlayRect, setOverlayRect] = useState({ left: 0, top: 0, width: 0, height: 0 });

  useEffect(() => {
    const el = layerRef.current;
    if (!el || !el.parentElement) return;

    const parent = el.parentElement; // PageContainer
    // Bind to the PDF page itself.  When vector debugging is enabled it adds
    // another Canvas; selecting that transient overlay made OCR/material
    // regions suddenly shrink or jump.  Single-page cache mode may show an
    // image snapshot instead of a live PDF Canvas, so support that as well.
    const findPdfSurface = () => (
      parent.querySelector('canvas:not([data-vector-canvas])') ||
      parent.querySelector('img[data-pdf-page-snapshot="true"]')
    );
    let canvas = findPdfSurface();
    let ro = null;
    let mo = null;

    const update = () => {
      if (!canvas) return;
      const pr = parent.getBoundingClientRect();
      const cr = canvas.getBoundingClientRect();
      const next = {
        left: cr.left - pr.left,
        top: cr.top - pr.top,
        width: cr.width,
        height: cr.height
      };
      const prev = overlayRect;
      const diff = Math.abs(next.left - prev.left) + Math.abs(next.top - prev.top) + Math.abs(next.width - prev.width) + Math.abs(next.height - prev.height);
      if (diff > 0.5) setOverlayRect(next);
    };

    const setupObservers = () => {
      if (!canvas) return;
      try {
        ro = new ResizeObserver(update);
        ro.observe(canvas);
        ro.observe(parent);
      } catch (e) {}
      window.addEventListener('resize', update);
      update();
    };

    if (!canvas) {
      // 椤甸潰鍒氬垏鎹㈠洖鏉ユ椂 Canvas 鍙兘灏氭湭鎻掑叆锛岀洃鍚?DOM 鍙樺寲锛岀瓑鍑虹幇鍚庡啀瀵归綈
      mo = new MutationObserver(() => {
        canvas = findPdfSurface();
        if (canvas) {
          setupObservers();
          if (mo) mo.disconnect();
          mo = null;
        }
      });
      mo.observe(parent, { childList: true, subtree: true });
    } else {
      setupObservers();
    }

    return () => {
      try { if (ro) ro.disconnect(); } catch (e) {}
      if (mo) try { mo.disconnect(); } catch (e) {}
      window.removeEventListener('resize', update);
    };
  }, [scale, pageSize?.width, pageSize?.height, detections]);

  // 鍧愭爣杞崲鍑芥暟锛氱浉瀵瑰潗鏍?-> 鍍忕礌瀹氫綅锛堜互 Canvas 涓哄弬鐓э級
  const convertCoordinates = (box) => {
    if (!box || !Array.isArray(box) || box.length !== 4) {
      return null;
    }
    
    // 检查每个点的格式
    for (let i = 0; i < box.length; i++) {
      if (!Array.isArray(box[i]) || box[i].length !== 2) {
        return null;
      }
    }
    
    // box格式: [[x1, y1], [x2, y2], [x3, y3], [x4, y4]]
    const xCoords = box.map(point => point[0]);
    const yCoords = box.map(point => point[1]);
    
    const minX = Math.min(...xCoords);
    const maxX = Math.max(...xCoords);
    const minY = Math.min(...yCoords);
    const maxY = Math.max(...yCoords);
    
    // 鍚庣杩斿洖鐩稿鍧愭爣(0-1)銆傝浆鎹负浠?Canvas 鍍忕礌涓哄崟浣嶇殑瀹氫綅锛岀‘淇濅笌 Canvas 绮剧‘閲嶅悎
    const hasNormalizedArea = normalizedArea &&
      [normalizedArea.x, normalizedArea.y, normalizedArea.width, normalizedArea.height]
        .every(value => Number.isFinite(Number(value)));
    const mappedMinX = hasNormalizedArea ? Number(normalizedArea.x) + minX * Number(normalizedArea.width) : minX;
    const mappedMaxX = hasNormalizedArea ? Number(normalizedArea.x) + maxX * Number(normalizedArea.width) : maxX;
    const mappedMinY = hasNormalizedArea ? Number(normalizedArea.y) + minY * Number(normalizedArea.height) : minY;
    const mappedMaxY = hasNormalizedArea ? Number(normalizedArea.y) + maxY * Number(normalizedArea.height) : maxY;

    // Coordinates are local to VisualizationLayer.  Adding overlayRect.left/
    // top here used to apply the Canvas offset twice.
    const left = mappedMinX * overlayRect.width;
    const top = mappedMinY * overlayRect.height;
    const width = (mappedMaxX - mappedMinX) * overlayRect.width;
    const height = (mappedMaxY - mappedMinY) * overlayRect.height;
    
    return { left, top, width, height };
  };


  
  return (
    <VisualizationLayer
      ref={layerRef}
      style={{
        left: overlayRect.left,
        top: overlayRect.top,
        width: overlayRect.width,
        height: overlayRect.height,
        visibility: overlayRect.width > 0 && overlayRect.height > 0 ? 'visible' : 'hidden'
      }}
    >
      {/* 鎵归噺娣诲姞鏍囨敞鎸夐挳 - 鍙湪鏀灦妯″紡涓嬫樉绀?*/}
      {!isRawDetection && scaffoldDebugSummary && (
        <ScaffoldDebugPanel>
          <div><strong>支架库调试</strong> 第 {currentPage || '-'} 页</div>
          <div>材料行: {scaffoldDebugSummary.materialRowsCount}，支架库: {scaffoldDebugSummary.libraryCount}，识别框: {detections.length}</div>
          <div style={{ marginTop: 4 }}><strong>支架库前几项:</strong></div>
          {(scaffoldDebugSummary.library.length > 0 ? scaffoldDebugSummary.library.slice(0, 6) : [{ description: '无' }]).map((item, index) => (
            <div key={`lib-${index}`}>
              <code>{item.description}</code>
            </div>
          ))}
          <div style={{ marginTop: 4 }}><strong>识别文本前几项:</strong></div>
          {scaffoldDebugSummary.detections.slice(0, 8).map((item, index) => (
            <div key={`det-${index}`}>
              {item.matched ? '✓' : '×'} <code>{item.text || '(空)'}</code>
              {item.libraryDescription ? ` -> ${item.libraryDescription}` : ''}
            </div>
          ))}
        </ScaffoldDebugPanel>
      )}

      {!isRawDetection && (scaffoldAndValveDetections.length > 0 || selectedIndices.size > 0) && onBatchAddScaffoldAnnotations && (
        <BatchAnnotationButton>
          <Tooltip title={
            selectedIndices.size > 0 
              ? `为选中的 ${selectedIndices.size} 个框添加标注`
              : `一键添加 ${scaffoldCount} 个支架和 ${valveCount} 个阀门标注`
          }>
            <Button
              type="primary"
              size="small"
              icon={<ThunderboltOutlined />}
              onClick={handleBatchAddAnnotations}
              style={{
                background: selectedIndices.size > 0 ? '#ff4d4f' : '#52c41a',
                borderColor: selectedIndices.size > 0 ? '#ff4d4f' : '#52c41a',
                boxShadow: selectedIndices.size > 0 
                  ? '0 2px 8px rgba(255, 77, 79, 0.3)' 
                  : '0 2px 8px rgba(82, 196, 26, 0.3)'
              }}
            >
              {selectedIndices.size > 0 
                ? `批量标注选中 (${selectedIndices.size})`
                : `批量标注 (支架:${scaffoldCount} 阀门:${valveCount})`
              }
            </Button>
          </Tooltip>
        </BatchAnnotationButton>
      )}
      {/* 鏉愭枡琛ㄦā寮忔彁绀?- 鏄剧ず鏂囧瓧妫€娴嬩絾涓嶆彁渚涙壒閲忔爣娉?*/}
      {isRawDetection && scaffoldAndValveDetections.length > 0 && (
        <BatchAnnotationButton>
          <Tooltip title="材料表模式：显示识别到的文字检测结果">
            <Button
              type="default"
              size="small"
              disabled
              style={{
                background: '#f0f0f0',
                borderColor: '#d9d9d9',
                color: '#999'
              }}
            >
              材料表模式 ({scaffoldAndValveDetections.length} 个文字)
            </Button>
          </Tooltip>
        </BatchAnnotationButton>
      )}
      {detections.map((detection, index) => {
        const coords = convertCoordinates(detection.box);
        const detectionText = detection.text || detection.scaffoldInfo || detection.originalText || '';
        
        if (!coords) {
          return null;
        }
        
        // 馃敡 鍒ゆ柇鏄惁涓烘敮鏋剁紪鍙凤細鍏堟竻娲楁枃鏈紝鍐嶅垽鏂?        // 濡傛灉娓呮礂鍚庢湁缁撴灉锛岃鏄庢槸鏈夋晥鐨勬敮鏋剁紪鍙凤紙cleanScaffoldText 宸茬粡鍋氫簡鎵€鏈夐獙璇侊級
        const cleanedText = cleanScaffoldText(detectionText);
        const matchResult = matchScaffoldDetection(detectionText, scaffoldMaterialLibrary);
        const isScaffold = !!cleanedText || matchResult.matched;
        // 馃啎 鐜板湪鎵€鏈夋娴嬬粨鏋滈兘鏄剧ず锛氭敮鏋舵樉绀虹豢鑹叉锛岄潪鏀灦鏄剧ず榛勮壊妗?        
        const handleAddAnnotation = (e) => {
          e.preventDefault();
          e.stopPropagation();
          
          if (onAddScaffoldAnnotation && isScaffold) {
            const centerX = detection.box[0][0] + (detection.box[1][0] - detection.box[0][0]) / 2;
            const centerY = detection.box[0][1] + (detection.box[2][1] - detection.box[0][1]) / 2;
            
            onAddScaffoldAnnotation({
              text: (cleanedText || detectionText).replace('/', ''),
              originalText: detectionText,
              x: centerX,
              y: centerY,
              detection: detection,
              scaffoldMatchSource: detection.scaffoldMatchSource || matchResult.source || '',
              supportMaterial: detection.supportMaterial || matchResult.libraryMatch?.material || null,
              supportMaterialDescription: detection.supportMaterialDescription || matchResult.libraryMatch?.description || ''
            });
          }
        };

        // 鑾峰彇娓呮礂鍚庣殑鏂囨湰鐢ㄤ簬鏄剧ず
        const displayText = isScaffold ? (cleanedText || detectionText) : detectionText;
        
        const isSelected = selectedIndices.has(index);

        return (
          <DetectionBox
            key={`detection-${index}`}
            isScaffold={isScaffold}
            showAll={!isScaffold}  // 闈炴敮鏋舵椂鏄剧ず榛勮壊
            isSelected={isSelected}
            onClick={() => toggleSelection(index)}
            style={{
              left: `${coords.left}px`,
              top: `${coords.top}px`,
              width: `${coords.width}px`,
              height: `${coords.height}px`
            }}
            title={isScaffold ? `${displayText} (支架)` : `${detectionText} (非支架)`}
          >
            {isScaffold && onAddScaffoldAnnotation && (
              <AnnotationButton
                onClick={handleAddAnnotation}
                title={`为 ${displayText} 添加标注`}
              >
                <PlusOutlined />
              </AnnotationButton>
            )}
          </DetectionBox>
        );
      })}
    </VisualizationLayer>
  );
};

export default OCRResultVisualization;
