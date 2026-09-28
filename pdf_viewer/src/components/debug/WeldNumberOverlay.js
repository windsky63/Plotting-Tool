import React, { useMemo, useState, useEffect, useRef } from 'react';
import { ObjectRecognizer } from '../../utils/ObjectRecognizer';
import { calculateWeldLayout, PDF_LAYOUT_BASE_SCALE } from '../../utils/WeldLayoutEngine';
import { getWeldSelectionKey } from '../../utils/WeldSmartSorter';
import { getCanonicalWeldDisplayNumber } from '../../utils/weldDisplayNumberUtils';

export { calculateWeldLayout } from '../../utils/WeldLayoutEngine';

function getWeldCenter(weld) {
  if (weld?.center && Number.isFinite(weld.center.x) && Number.isFinite(weld.center.y)) {
    return weld.center;
  }

  if (weld?.boundingBox) {
    return {
      x: weld.boundingBox.minX + (weld.boundingBox.width || 0) / 2,
      y: weld.boundingBox.minY + (weld.boundingBox.height || 0) / 2
    };
  }

  return {
    x: weld?.x || 0,
    y: weld?.y || 0
  };
}

/**
 * 焊点编号可视化层
 * 选择阶段只负责高亮起点/终点/已加入区间，不显示编号预览。
 * 最终生成阶段才显示完整编号圆圈、引导线和数字。
 */
export const WeldNumberOverlay = ({
  welds = [],
  scale = 1,
  visible = false,
  animationSpeed = 100,
  useGlobalSequence = true,
  ocrData = null,
  vectors = [],
  weldRecognitionArea = null,
  selectionMode = false,
  selectionPreviewOnly = false,
  onWeldClick = null,
  selectedStartWeldKey = null,
  selectedEndWeldKey = null,
  highlightedWeldKeys = [],
  hiddenNumberWeldKeys = [],
  orderedWelds = null,
  frameSize = 56.7,
  showPathIdHint = false,
  manualInsertMode = false,
  deleteMode = false,
  onManualPointClick = null
}) => {
  const highlightedWeldKeySet = useMemo(() => new Set(highlightedWeldKeys || []), [highlightedWeldKeys]);
  const hiddenNumberWeldKeySet = useMemo(() => new Set(hiddenNumberWeldKeys || []), [hiddenNumberWeldKeys]);
  const incrementalLayoutCacheRef = useRef([]);
  const incrementalLayoutContextRef = useRef(null);

  const selectableWelds = useMemo(() => (
    (welds || []).map((weld) => {
      const center = getWeldCenter(weld);
      return {
        weld,
        selectionKey: getWeldSelectionKey(weld),
        pathId: weld?.pathId,
        x: center.x * PDF_LAYOUT_BASE_SCALE * scale,
        y: center.y * PDF_LAYOUT_BASE_SCALE * scale
      };
    }).filter(item => item.selectionKey)
  ), [welds, scale]);

  const numberedWelds = useMemo(() => {
    if (!visible || selectionPreviewOnly) {
      return [];
    }

    const sourceWelds = Array.isArray(orderedWelds) && orderedWelds.length > 0 ? orderedWelds : welds;

    if (sourceWelds.length === 0) {
      return [];
    }

    let textRegions = null;
    if (ocrData?.page_info) {
      const pi = ocrData.page_info;
      const pageWidth = pi.page_width || pi.width || 0;
      const pageHeight = pi.page_height || pi.height || 0;
      if (pageWidth > 0 && pageHeight > 0) {
        textRegions = ObjectRecognizer.convertOCRDetectionsToTextRegions(
          ocrData.detections || [],
          { width: pageWidth, height: pageHeight }
        );
      }
    }

    const pipelineNumberingSequence = null; // useGlobalSequence ? window.__pipelineWeldNumberingSequence__ : null;

    if (Array.isArray(orderedWelds) && orderedWelds.length > 0) {
      const placementAreaSignature = JSON.stringify(weldRecognitionArea || null);
      const previousContext = incrementalLayoutContextRef.current;
      const contextChanged = !previousContext ||
        previousContext.vectors !== vectors ||
        previousContext.ocrData !== ocrData ||
        previousContext.frameSize !== frameSize ||
        previousContext.placementAreaSignature !== placementAreaSignature;
      if (contextChanged) {
        incrementalLayoutCacheRef.current = [];
        incrementalLayoutContextRef.current = {
          vectors,
          ocrData,
          frameSize,
          placementAreaSignature
        };
      }

      const fixedLayouts = manualInsertMode
        ? incrementalLayoutCacheRef.current
        : [];
      const layoutOptions = {
        normalizedPlacementArea: weldRecognitionArea,
        graphicVectors: vectors,
        circleDiameter: frameSize,
        allowLeaderThroughGraphics: true,
        allowLeaderCrossing: false,
        fixedLayouts
      };
      let layoutResults = calculateWeldLayout(
        sourceWelds,
        PDF_LAYOUT_BASE_SCALE,
        'KEEP_ORDER',
        null,
        null,
        textRegions,
        layoutOptions
      );

      if (manualInsertMode && fixedLayouts.length > 0) {
        const fixedKeys = new Set(fixedLayouts.map(getWeldSelectionKey).filter(Boolean));
        const newLayouts = layoutResults.filter(
          layout => !fixedKeys.has(getWeldSelectionKey(layout))
        );
        const requiresFullFallback = newLayouts.some(layout => (
          layout?.layoutDiagnostics?.usedFallback ||
          Number(layout?.layoutDiagnostics?.hardCollisionCount || 0) > 0 ||
          Number(layout?.layoutDiagnostics?.constraintViolationCount || 0) > 0
        ));
        if (requiresFullFallback) {
          layoutResults = calculateWeldLayout(
            sourceWelds,
            PDF_LAYOUT_BASE_SCALE,
            'KEEP_ORDER',
            null,
            null,
            textRegions,
            {
              ...layoutOptions,
              fixedLayouts: []
            }
          );
        }
      }

      incrementalLayoutCacheRef.current = layoutResults;
      return layoutResults;
    }

    if (pipelineNumberingSequence && pipelineNumberingSequence.length > 0) {
      const sequenceOrderedWelds = pipelineNumberingSequence.map(item => item.weld);
      const layoutResults = calculateWeldLayout(
        sequenceOrderedWelds,
        PDF_LAYOUT_BASE_SCALE,
        'KEEP_ORDER',
        null,
        null,
        textRegions,
        {
          normalizedPlacementArea: weldRecognitionArea,
          graphicVectors: vectors,
          circleDiameter: frameSize,
          allowLeaderThroughGraphics: true,
          allowLeaderCrossing: false
        }
      );

      return layoutResults.map((layoutItem, index) => {
        const numberingItem = pipelineNumberingSequence[index];
        return {
          ...layoutItem,
          number: numberingItem.number,
          pipelineType: numberingItem.pipelineType,
          pipelineId: numberingItem.pipelineId
        };
      });
    }

    const sortedWelds = [...sourceWelds].sort((a, b) => {
      const coordsA = getWeldCenter(a);
      const coordsB = getWeldCenter(b);
      return (coordsA.x + coordsA.y) - (coordsB.x + coordsB.y);
    });

    return calculateWeldLayout(
      sortedWelds,
      PDF_LAYOUT_BASE_SCALE,
      'KEEP_ORDER',
      null,
      null,
      textRegions,
      {
        normalizedPlacementArea: weldRecognitionArea,
        graphicVectors: vectors,
        circleDiameter: frameSize,
        allowLeaderThroughGraphics: true,
        allowLeaderCrossing: false
      }
    );
  }, [
    welds,
    orderedWelds,
    useGlobalSequence,
    ocrData,
    selectionPreviewOnly,
    visible,
    vectors,
    weldRecognitionArea,
    frameSize,
    manualInsertMode
  ]);

  const renderedWelds = useMemo(() => (
    numberedWelds.map((weld) => ({
      ...weld,
      selectionKey: getWeldSelectionKey(weld),
      startX: weld.startX * scale,
      startY: weld.startY * scale,
      endX: weld.endX * scale,
      endY: weld.endY * scale,
      connectionX: weld.connectionX * scale,
      connectionY: weld.connectionY * scale
    }))
  ), [numberedWelds, scale]);

  const directionPoints = useMemo(() => {
    if (!selectionMode || !Array.isArray(orderedWelds) || orderedWelds.length < 2) return [];
    return orderedWelds.map(weld => {
      const center = getWeldCenter(weld);
      return {
        x: center.x * PDF_LAYOUT_BASE_SCALE * scale,
        y: center.y * PDF_LAYOUT_BASE_SCALE * scale
      };
    });
  }, [orderedWelds, scale, selectionMode]);

  const lightweightNumberedWelds = useMemo(() => {
    if (!selectionPreviewOnly || !Array.isArray(orderedWelds)) return [];
    return orderedWelds.map((weld) => {
      const center = getWeldCenter(weld);
      const number = getCanonicalWeldDisplayNumber(weld);
      return {
        selectionKey: getWeldSelectionKey(weld),
        number: number === undefined || number === null ? '' : String(number),
        isNumberless: weld?.isNumberless === true,
        x: center.x * PDF_LAYOUT_BASE_SCALE * scale,
        y: center.y * PDF_LAYOUT_BASE_SCALE * scale
      };
    }).filter(item => item.selectionKey && (item.number !== '' || item.isNumberless));
  }, [orderedWelds, scale, selectionPreviewOnly]);

  const [visibleCount, setVisibleCount] = useState(0);
  const prevVisibleRef = useRef(false);
  const prevWeldsLengthRef = useRef(0);

  useEffect(() => {
    if (selectionPreviewOnly) {
      setVisibleCount(0);
      prevVisibleRef.current = visible;
      prevWeldsLengthRef.current = renderedWelds.length;
      return;
    }

    const prevVisible = prevVisibleRef.current;
    const prevWeldsLength = prevWeldsLengthRef.current;

    prevVisibleRef.current = visible;
    prevWeldsLengthRef.current = renderedWelds.length;

    if (!visible) {
      setVisibleCount(0);
      return;
    }

    if (renderedWelds.length === 0) {
      setVisibleCount(0);
      return;
    }

    // 手动补点时只增量计算新增点，不再把整页焊点重新做逐个出现动画。
    // 否则第 N 个点加入后，旧的 N-1 个点会在动画重启期间反复隐藏/出现，
    // 界面看起来就像补点数量在 N 与 N-1 之间跳动。
    if (manualInsertMode) {
      setVisibleCount(renderedWelds.length);
      return;
    }

    const shouldStartAnimation = (!prevVisible && visible) || (renderedWelds.length !== prevWeldsLength && renderedWelds.length > 0);

    if (!shouldStartAnimation) {
      setVisibleCount(renderedWelds.length);
      return;
    }

    setVisibleCount(1);
    let currentCount = 1;
    const timer = setInterval(() => {
      currentCount++;
      if (currentCount > renderedWelds.length) {
        clearInterval(timer);
        return;
      }
      setVisibleCount(currentCount);
    }, animationSpeed);

    return () => clearInterval(timer);
  }, [visible, renderedWelds.length, animationSpeed, selectionPreviewOnly, manualInsertMode]);

  if (!visible) {
    return null;
  }

  const hasSelectionLayer = selectionMode && selectableWelds.length > 0;
  const hasNumberLayer = !selectionPreviewOnly && renderedWelds.length > 0;
  const hasLightweightNumberLayer = selectionPreviewOnly && lightweightNumberedWelds.length > 0;

  // 多页处理范围内允许在零焊点页面补入第一个点。
  // 手动补点模式下即使当前没有任何焊点，也必须保留整页透明交互层。
  if (!hasSelectionLayer && !hasNumberLayer && !hasLightweightNumberLayer && !manualInsertMode && !deleteMode) {
    return null;
  }

  const fontSize = 34 * scale;
  const baseDiagonalLength = frameSize * scale;
  const circleRadius = baseDiagonalLength / 2;
  const strokeWidth = 2 * scale;
  const color = '#ff0000';
  const handleManualInsertClick = (event) => {
    if (!manualInsertMode || !onManualPointClick) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const coordinateScale = PDF_LAYOUT_BASE_SCALE * scale;
    if (!coordinateScale) return;
    onManualPointClick({
      x: (event.clientX - rect.left) / coordinateScale,
      y: (event.clientY - rect.top) / coordinateScale
    });
  };

  return (
    <svg
      onClick={handleManualInsertClick}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: (manualInsertMode || deleteMode) ? 'auto' : 'none',
        cursor: manualInsertMode ? 'crosshair' : (deleteMode ? 'pointer' : 'default'),
        zIndex: 1001000,
        overflow: 'visible'
      }}
    >
      {directionPoints.length > 1 && (
        <>
          <defs>
            <marker
              id="weld-sequence-arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#1677ff" />
            </marker>
          </defs>
          {directionPoints.slice(0, -1).map((point, index) => (
            <line
              key={`sequence-direction-${index}`}
              x1={point.x}
              y1={point.y}
              x2={directionPoints[index + 1].x}
              y2={directionPoints[index + 1].y}
              stroke="#1677ff"
              strokeWidth={1.5 * scale}
              strokeDasharray={`${5 * scale} ${4 * scale}`}
              markerEnd="url(#weld-sequence-arrow)"
              opacity="0.72"
              style={{ pointerEvents: 'none' }}
            />
          ))}
        </>
      )}

      {hasLightweightNumberLayer && lightweightNumberedWelds.map((item) => (
        <g
          key={`weld-light-number-${item.selectionKey}`}
          style={{ pointerEvents: 'none' }}
        >
          <circle
            cx={item.x}
            cy={item.y}
            r={10 * scale}
            fill="rgba(255,255,255,0.92)"
            stroke="#1677ff"
            strokeWidth={1.5 * scale}
          />
          {!item.isNumberless && (
            <text
              x={item.x}
              y={item.y}
              textAnchor="middle"
              dominantBaseline="central"
              fill="#0958d9"
              fontSize={11 * scale}
              fontWeight="700"
              style={{ userSelect: 'none' }}
            >
              {item.number}
            </text>
          )}
        </g>
      ))}

      {hasNumberLayer && renderedWelds.slice(0, visibleCount).map((weld, index) => {
        const isNew = index === visibleCount - 1;
        const hideNumber = weld?.isNumberless === true ||
          hiddenNumberWeldKeySet.has(weld.selectionKey);

        return (
          <g key={`weld-number-${weld.selectionKey || weld.number || index}`}>
            <line
              x1={weld.startX}
              y1={weld.startY}
              x2={weld.connectionX}
              y2={weld.connectionY}
              stroke={color}
              strokeWidth={strokeWidth}
              opacity={isNew ? 0 : 1}
            >
              {isNew && (
                <animate
                  attributeName="opacity"
                  from="0"
                  to="1"
                  dur="0.3s"
                  fill="freeze"
                />
              )}
            </line>

            <circle
              cx={weld.startX}
              cy={weld.startY}
              r={isNew ? 0 : 3 * scale}
              fill={color}
            >
              {isNew && (
                <>
                  <animate
                    attributeName="r"
                    from="0"
                    to={String(5 * scale)}
                    dur="0.15s"
                    fill="freeze"
                  />
                  <animate
                    attributeName="r"
                    from={String(5 * scale)}
                    to={String(3 * scale)}
                    begin="0.15s"
                    dur="0.15s"
                    fill="freeze"
                  />
                </>
              )}
            </circle>

            <circle
              cx={weld.endX}
              cy={weld.endY}
              r={circleRadius}
              fill="transparent"
              stroke={color}
              strokeWidth={strokeWidth}
              opacity={isNew ? 0 : 1}
            >
              {isNew && (
                <animate
                  attributeName="opacity"
                  from="0"
                  to="1"
                  dur="0.3s"
                  fill="freeze"
                />
              )}
            </circle>

            {!hideNumber && (
              <text
                x={weld.endX}
                y={weld.endY}
                textAnchor="middle"
                dominantBaseline="central"
                fill={color}
                fontSize={fontSize}
                fontWeight="500"
                opacity={isNew ? 0 : 1}
                style={{
                  userSelect: 'none',
                  textOrientation: 'upright'
                }}
              >
                {weld.number}
                {isNew && (
                  <animate
                    attributeName="opacity"
                    from="0"
                    to="1"
                    dur="0.3s"
                    fill="freeze"
                  />
                )}
              </text>
            )}
          </g>
        );
      })}

      {hasSelectionLayer && selectableWelds.map((item) => {
        const isSelectedStart = item.selectionKey === selectedStartWeldKey;
        const isSelectedEnd = item.selectionKey === selectedEndWeldKey;
        const isHighlighted = highlightedWeldKeySet.has(item.selectionKey);
        const labelColor = isSelectedStart ? '#fa8c16' : (isSelectedEnd ? '#13c2c2' : '#8c8c8c');

        return (
          <g key={`weld-select-${item.selectionKey}`}>
            {deleteMode && item.weld?.isWeldedSupport !== true && (
              <circle
                cx={item.x}
                cy={item.y}
                r={13 * scale}
                fill="rgba(255, 77, 79, 0.2)"
                stroke="#ff4d4f"
                strokeWidth={2.5 * scale}
              />
            )}
            {isHighlighted && (
              <circle
                cx={item.x}
                cy={item.y}
                r={11 * scale}
                fill="rgba(82, 196, 26, 0.16)"
                stroke="#52c41a"
                strokeWidth={2 * scale}
              />
            )}

            {isSelectedStart && (
              <circle
                cx={item.x}
                cy={item.y}
                r={14 * scale}
                fill="rgba(250, 173, 20, 0.18)"
                stroke="#faad14"
                strokeWidth={2.5 * scale}
              />
            )}

            {isSelectedEnd && (
              <circle
                cx={item.x}
                cy={item.y}
                r={14 * scale}
                fill="rgba(19, 194, 194, 0.16)"
                stroke="#13c2c2"
                strokeWidth={2.5 * scale}
              />
            )}

            {showPathIdHint && item.pathId !== undefined && item.pathId !== null && (
              <text
                x={item.x + 10}
                y={item.y - 10}
                fill={labelColor}
                fontSize={12 * scale}
                fontWeight={isSelectedStart || isSelectedEnd ? '700' : '500'}
                stroke="white"
                strokeWidth={0.8}
                paintOrder="stroke"
                style={{ userSelect: 'none', pointerEvents: 'none' }}
              >
                ID:{item.pathId}
              </text>
            )}

            <circle
              cx={item.x}
              cy={item.y}
              r={18 * scale}
              fill="transparent"
              style={{
                pointerEvents: manualInsertMode ? 'none' : 'auto',
                cursor: manualInsertMode ? 'crosshair' : (deleteMode ? 'pointer' : 'pointer')
              }}
              onClick={() => onWeldClick && onWeldClick(item.weld)}
            />
          </g>
        );
      })}
    </svg>
  );
};
