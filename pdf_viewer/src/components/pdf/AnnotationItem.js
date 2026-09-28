import React, { memo } from 'react';

/**
 * 单个标注组件
 * 使用 React.memo 优化，只有当标注自身属性变化时才重新渲染
 */
const AnnotationItem = memo(({
  annotation,
  scale,
  isSelected,
  annotationMode,
  onAnnotationMouseDown,
  onAnnotationDoubleClick,
  processAnnotationText,
  calculateAnnotationSize,
  annotationStyles
}) => {
  // 检查坐标有效性
  const isValidCoordinate = (x, y) => {
    return typeof x === 'number' && typeof y === 'number' && 
           !isNaN(x) && !isNaN(y) && 
           x >= 0 && y >= 0 && 
           x < 10000 && y < 10000;
  };
  
  if (!isValidCoordinate(annotation.endX, annotation.endY)) {
    console.warn(`⚠️ 标注坐标无效:`, annotation.text, `坐标: (${annotation.endX}, ${annotation.endY})`);
    return null;
  }

  const { displayText, fontSize } = processAnnotationText(annotation);
  const circleRadius = calculateAnnotationSize(displayText, fontSize, annotation).circleRadius;
  const getTextWidth = (text, size) => {
    let width = 0;
    String(text || '').split('').forEach(char => {
      width += /[\u4e00-\u9fa5]/.test(char) ? size : size * 0.62;
    });
    return width;
  };
  const getPipeTagSize = (text, size, ann) => {
    const base = calculateAnnotationSize(text, size, ann).diagonalLength || 56.7;
    const unitPerMm = base / 10;
    return {
      width: 23 * unitPerMm,
      height: 4 * unitPerMm,
      inset: Math.max(1.4, 0.45 * unitPerMm)
    };
  };
  const getRectConnection = (width, height) => {
    const angle = (Number(annotation.rotation) || 0) * Math.PI / 180;
    const toStartX = annotation.startX - annotation.endX;
    const toStartY = annotation.startY - annotation.endY;
    const localX = toStartX * Math.cos(-angle) - toStartY * Math.sin(-angle);
    const localY = toStartX * Math.sin(-angle) + toStartY * Math.cos(-angle);
    const length = Math.sqrt(localX * localX + localY * localY);
    if (!length) return { x: annotation.endX, y: annotation.endY };
    const unitX = localX / length;
    const unitY = localY / length;
    const tx = Math.abs(unitX) > 0.0001 ? (width / 2) / Math.abs(unitX) : Infinity;
    const ty = Math.abs(unitY) > 0.0001 ? (height / 2) / Math.abs(unitY) : Infinity;
    const t = Math.min(tx, ty);
    const hitX = unitX * t;
    const hitY = unitY * t;
    return {
      x: annotation.endX + hitX * Math.cos(angle) - hitY * Math.sin(angle),
      y: annotation.endY + hitX * Math.sin(angle) + hitY * Math.cos(angle)
    };
  };

  return (
    <svg
      key={annotation.id}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        overflow: 'visible'
      }}
    >
      <g 
        style={{ 
          pointerEvents: annotationMode ? 'none' : 'auto',
          cursor: annotationMode ? 'default' : 'move'
        }}
        onMouseDown={onAnnotationMouseDown}
        onDoubleClick={onAnnotationDoubleClick}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onAnnotationMouseDown(e);
        }}
      >
        {/* 标注框和内容 */}
        {annotation.borderShape === 'circle' && (
          <g>
            {annotation.hasLeaderLine && (() => {
              // 计算引导线与圆形边缘的交点
              const dx = annotation.endX - annotation.startX;
              const dy = annotation.endY - annotation.startY;
              const length = Math.sqrt(dx * dx + dy * dy);
              const unitX = dx / length;
              const unitY = dy / length;
              const connectionX = annotation.endX - unitX * circleRadius;
              const connectionY = annotation.endY - unitY * circleRadius;
              
              return (
                <g>
                  <line
                    x1={annotation.startX}
                    y1={annotation.startY}
                    x2={connectionX}
                    y2={connectionY}
                    stroke={annotation.color}
                    strokeWidth={annotationStyles.strokeWidth}
                  />
                  
                  {/* 起点圆点 */}
                  <circle
                    cx={annotation.startX}
                    cy={annotation.startY}
                    r="1"
                    fill={annotation.color}
                  />
                </g>
              );
            })()}
            
            {/* 圆形框 */}
            <circle
              cx={annotation.endX}
              cy={annotation.endY}
              r={circleRadius}
              fill="transparent"
              stroke={annotation.color}
              strokeWidth={annotationStyles.strokeWidth}
            />
            
            {/* 文字 */}
            <text
              x={annotation.endX}
              y={annotation.endY}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={fontSize}
              fill={annotation.color}
              fontWeight={annotationStyles.textFontWeight}
              transform={`rotate(0, ${annotation.endX}, ${annotation.endY})`}
              style={annotationStyles.textStyle}
            >
              {displayText}
            </text>
          </g>
        )}

        {annotation.borderShape === 'field-weld' && (
          <g>
            {annotation.hasLeaderLine && (() => {
              const sizes = calculateAnnotationSize(displayText, fontSize, annotation);
              const diamondRadius = sizes.diamondRadius || sizes.circleRadius;
              const diagonalLength = sizes.diagonalLength || diamondRadius * 2;
              const weldLineOffset = diagonalLength * 0.12;
              const diamondWidthAtOffset = diamondRadius - Math.abs(weldLineOffset);
              
              // 计算连接点
              const dx = annotation.endX - annotation.startX;
              const dy = annotation.endY - annotation.startY;
              const length = Math.sqrt(dx * dx + dy * dy);
              const unitX = dx / length;
              const unitY = dy / length;
              const connectionX = annotation.endX - unitX * diamondRadius;
              const connectionY = annotation.endY - unitY * diamondRadius;
              
              return (
                <g>
                  <line
                    x1={annotation.startX}
                    y1={annotation.startY}
                    x2={connectionX}
                    y2={connectionY}
                    stroke={annotation.color}
                    strokeWidth={annotationStyles.strokeWidth}
                  />
                  
                  <circle
                    cx={annotation.startX}
                    cy={annotation.startY}
                    r="1.5"
                    fill={annotation.color}
                  />
                </g>
              );
            })()}
            
            {/* 现场焊缝符号: 菱形 + 两条平行线 */}
            {(() => {
              const sizes = calculateAnnotationSize(displayText, fontSize, annotation);
              const diamondRadius = sizes.diamondRadius || sizes.circleRadius;
              const diagonalLength = sizes.diagonalLength || diamondRadius * 2;
              const weldLineOffset = diagonalLength * 0.12;
              const diamondWidthAtOffset = diamondRadius - Math.abs(weldLineOffset);
              const weldLineLength = diamondWidthAtOffset * 2;
              const { endX, endY } = annotation;

              // 构建一体化路径
              const pathData = `
                M ${endX},${endY - diamondRadius} 
                L ${endX + diamondRadius},${endY} 
                L ${endX},${endY + diamondRadius} 
                L ${endX - diamondRadius},${endY} 
                Z 
                M ${endX - weldLineLength / 2},${endY - weldLineOffset} 
                L ${endX + weldLineLength / 2},${endY - weldLineOffset} 
                M ${endX - weldLineLength / 2},${endY + weldLineOffset} 
                L ${endX + weldLineLength / 2},${endY + weldLineOffset}
              `;
              
              return (
                <>
                  <path
                    d={pathData}
                    fill="transparent"
                    stroke={annotation.color}
                    strokeWidth={annotationStyles.strokeWidth}
                  />
                  
                  <text
                    x={annotation.endX}
                    y={annotation.endY - weldLineOffset * 0.6 - 13}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={fontSize}
                    fill={annotation.color}
                    fontWeight={annotationStyles.textFontWeight}
                    transform={`rotate(0, ${annotation.endX}, ${annotation.endY})`}
                    style={annotationStyles.textStyle}
                  >
                    {displayText}
                  </text>
                </>
              );
            })()}
          </g>
        )}

        {annotation.borderShape === 'diamond' && (
          <g>
            {annotation.hasLeaderLine && (() => {
              const sizes = calculateAnnotationSize(displayText, fontSize, annotation);
              const diamondRadius = sizes.diamondRadius || sizes.circleRadius;
              
              // 简化版连接点计算
              const dx = annotation.endX - annotation.startX;
              const dy = annotation.endY - annotation.startY;
              const length = Math.sqrt(dx * dx + dy * dy);
              const unitX = dx / length;
              const unitY = dy / length;
              const connectionX = annotation.endX - unitX * diamondRadius;
              const connectionY = annotation.endY - unitY * diamondRadius;
              
              return (
                <g>
                  <line
                    x1={annotation.startX}
                    y1={annotation.startY}
                    x2={connectionX}
                    y2={connectionY}
                    stroke={annotation.color}
                    strokeWidth={annotationStyles.strokeWidth}
                  />
                  
                  <circle
                    cx={annotation.startX}
                    cy={annotation.startY}
                    r="1"
                    fill={annotation.color}
                  />
                </g>
              );
            })()}
            
            {/* 菱形 */}
            {(() => {
              const sizes = calculateAnnotationSize(displayText, fontSize, annotation);
              const diamondRadius = sizes.diamondRadius || sizes.circleRadius;
              
              return (
                <>
                  <polygon
                    points={`${annotation.endX},${annotation.endY - diamondRadius} ${annotation.endX + diamondRadius},${annotation.endY} ${annotation.endX},${annotation.endY + diamondRadius} ${annotation.endX - diamondRadius},${annotation.endY}`}
                    fill="transparent"
                    stroke={annotation.color}
                    strokeWidth={annotationStyles.strokeWidth}
                  />
                  
                  <text
                    x={annotation.endX}
                    y={annotation.endY}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={fontSize}
                    fill={annotation.color}
                    fontWeight={annotationStyles.textFontWeight}
                    transform={`rotate(0, ${annotation.endX}, ${annotation.endY})`}
                    style={annotationStyles.textStyle}
                  >
                    {displayText}
                  </text>
                </>
              );
            })()}
          </g>
        )}

        {annotation.borderShape === 'rectangle' && (
          <g>
            {annotation.hasLeaderLine && (() => {
              const rectangleHalfSide = calculateAnnotationSize(displayText, fontSize, annotation).rectangleHalfSide;
              
              // 简化版连接点计算
              const dx = annotation.endX - annotation.startX;
              const dy = annotation.endY - annotation.startY;
              const length = Math.sqrt(dx * dx + dy * dy);
              const unitX = dx / length;
              const unitY = dy / length;
              const connectionX = annotation.endX - unitX * rectangleHalfSide * Math.sqrt(2);
              const connectionY = annotation.endY - unitY * rectangleHalfSide * Math.sqrt(2);
              
              return (
                <g>
                  <line
                    x1={annotation.startX}
                    y1={annotation.startY}
                    x2={connectionX}
                    y2={connectionY}
                    stroke={annotation.color}
                    strokeWidth={annotationStyles.strokeWidth}
                  />
                  
                  <circle
                    cx={annotation.startX}
                    cy={annotation.startY}
                    r="1"
                    fill={annotation.color}
                  />
                </g>
              );
            })()}
            
            {/* 矩形框 */}
            {(() => {
              const rectangleHalfSide = calculateAnnotationSize(displayText, fontSize, annotation).rectangleHalfSide;
              
              return (
                <>
                  <rect
                    x={annotation.endX - rectangleHalfSide}
                    y={annotation.endY - rectangleHalfSide}
                    width={rectangleHalfSide * 2}
                    height={rectangleHalfSide * 2}
                    fill="transparent"
                    stroke={annotation.color}
                    strokeWidth={annotationStyles.strokeWidth}
                  />
                  
                  <text
                    x={annotation.endX}
                    y={annotation.endY}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={fontSize}
                    fill={annotation.color}
                    fontWeight={annotationStyles.textFontWeight}
                    transform={`rotate(0, ${annotation.endX}, ${annotation.endY})`}
                    style={annotationStyles.textStyle}
                  >
                    {displayText}
                  </text>
                </>
              );
            })()}
          </g>
        )}

        {annotation.borderShape === 'text-rectangle' && (() => {
          const sizes = calculateAnnotationSize(displayText, fontSize, annotation);
          const width = sizes.textRectangleWidth;
          const height = sizes.textRectangleHeight;
          const connection = getRectConnection(width, height);
          return (
            <g>
              {annotation.hasLeaderLine && (
                <g>
                  <line
                    x1={annotation.startX}
                    y1={annotation.startY}
                    x2={connection.x}
                    y2={connection.y}
                    stroke={annotation.color}
                    strokeWidth={annotationStyles.strokeWidth}
                  />
                  <circle cx={annotation.startX} cy={annotation.startY} r="1" fill={annotation.color} />
                </g>
              )}
              <rect
                x={annotation.endX - width / 2}
                y={annotation.endY - height / 2}
                width={width}
                height={height}
                fill="transparent"
                stroke={annotation.color}
                strokeWidth={annotationStyles.strokeWidth}
              />
              <text
                x={annotation.endX}
                y={annotation.endY}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={fontSize}
                fill={annotation.color}
                fontWeight={annotationStyles.textFontWeight}
                style={annotationStyles.textStyle}
              >
                {displayText}
              </text>
            </g>
          );
        })()}

        {annotation.borderShape === 'pipe-tag' && (
          <g>
            {(() => {
              const tag = getPipeTagSize(displayText, fontSize, annotation);
              const x = annotation.endX - tag.width / 2;
              const y = annotation.endY - tag.height / 2;
              const connection = getRectConnection(tag.width, tag.height);
              const rotation = Number(annotation.rotation) || 0;

              return (
                <>
                  {annotation.hasLeaderLine && (
                    <g>
                      <line
                        x1={annotation.startX}
                        y1={annotation.startY}
                        x2={connection.x}
                        y2={connection.y}
                        stroke={annotation.color}
                        strokeWidth={annotationStyles.strokeWidth}
                      />
                      <circle
                        cx={annotation.startX}
                        cy={annotation.startY}
                        r="1"
                        fill={annotation.color}
                      />
                    </g>
                  )}
                  <g transform={`rotate(${rotation}, ${annotation.endX}, ${annotation.endY})`}>
                    <rect
                      x={x}
                      y={y}
                      width={tag.width}
                      height={tag.height}
                      fill="transparent"
                      stroke={annotation.color}
                      strokeWidth={Math.max(1, annotationStyles.strokeWidth * 0.75)}
                    />
                    <rect
                      x={x + tag.inset}
                      y={y + tag.inset}
                      width={tag.width - tag.inset * 2}
                      height={tag.height - tag.inset * 2}
                      fill="transparent"
                      stroke={annotation.color}
                      strokeWidth={Math.max(0.75, annotationStyles.strokeWidth * 0.45)}
                    />
                    <text
                      x={annotation.endX}
                      y={annotation.endY}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={fontSize}
                      fill={annotation.color}
                      fontWeight={annotationStyles.textFontWeight}
                      style={annotationStyles.textStyle}
                    >
                      {displayText}
                    </text>
                  </g>
                </>
              );
            })()}
          </g>
        )}

        {annotation.borderShape === 'shop-weld' && (
          <g>
            {annotation.hasLeaderLine && (() => {
              const sizes = calculateAnnotationSize(displayText, fontSize, annotation);
              const circleRadius = sizes.circleRadius;
              
              // 简化版连接点计算
              const dx = annotation.endX - annotation.startX;
              const dy = annotation.endY - annotation.startY;
              const length = Math.sqrt(dx * dx + dy * dy);
              const unitX = dx / length;
              const unitY = dy / length;
              const connectionX = annotation.endX - unitX * circleRadius;
              const connectionY = annotation.endY - unitY * circleRadius;
              
              return (
                <g>
                  <line
                    x1={annotation.startX}
                    y1={annotation.startY}
                    x2={connectionX}
                    y2={connectionY}
                    stroke={annotation.color}
                    strokeWidth={annotationStyles.strokeWidth}
                  />
                  
                  <circle
                    cx={annotation.startX}
                    cy={annotation.startY}
                    r="1.5"
                    fill={annotation.color}
                  />
                </g>
              );
            })()}
            
            {/* 车间焊缝符号: 圆形 + 两条平行线 */}
            {(() => {
              const sizes = calculateAnnotationSize(displayText, fontSize, annotation);
              const circleRadius = sizes.circleRadius;
              const diagonalLength = sizes.diagonalLength || circleRadius * 2;
              const weldLineOffset = diagonalLength * 0.12;
              const intersectionDistance = Math.sqrt(circleRadius * circleRadius - weldLineOffset * weldLineOffset);
              const weldLineLength = intersectionDistance * 2;
              const { endX, endY } = annotation;

              // 构建一体化路径
              const pathData = `
                M ${endX - circleRadius}, ${endY}
                A ${circleRadius},${circleRadius} 0 1,0 ${endX + circleRadius},${endY}
                A ${circleRadius},${circleRadius} 0 1,0 ${endX - circleRadius},${endY}
                M ${endX - weldLineLength / 2},${endY - weldLineOffset}
                L ${endX + weldLineLength / 2},${endY - weldLineOffset}
                M ${endX - weldLineLength / 2},${endY + weldLineOffset}
                L ${endX + weldLineLength / 2},${endY + weldLineOffset}
              `;
              
              return (
                <>
                  <path
                    d={pathData}
                    fill="transparent"
                    stroke={annotation.color}
                    strokeWidth={annotationStyles.strokeWidth}
                  />
                  
                  <text
                    x={annotation.endX}
                    y={annotation.endY - weldLineOffset * 0.6 - 13}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={fontSize}
                    fill={annotation.color}
                    fontWeight={annotationStyles.textFontWeight}
                    transform={`rotate(0, ${annotation.endX}, ${annotation.endY})`}
                    style={annotationStyles.textStyle}
                  >
                    {displayText}
                  </text>
                </>
              );
            })()}
          </g>
        )}

        {annotation.borderShape === 'none' && (() => {
          // 计算文本宽度（粗略估算）
          const getTextWidth = (text, fontSize) => {
            let width = 0;
            for (let i = 0; i < text.length; i++) {
              const char = text[i];
              if (/[\u4e00-\u9fa5]/.test(char)) {
                width += fontSize;
              } else {
                width += fontSize * 0.6;
              }
            }
            return width;
          };
          
          const textWidth = getTextWidth(displayText, fontSize);
          const maxWidth = 300; // 最大单行宽度，增加到300像素
          
          // 如果文本过长，考虑换行
          if (textWidth > maxWidth) {
            // 智能拆分：优先在标点符号、空格处拆分
            const splitPoints = [' ', '-', '、', '，', '。', '；', '：'];
            const chars = displayText.split('');
            const lines = [];
            let currentLine = '';
            let currentWidth = 0;
            
            for (let i = 0; i < chars.length; i++) {
              const char = chars[i];
              const charWidth = /[\u4e00-\u9fa5]/.test(char) ? fontSize : fontSize * 0.6;
              
              // 检查添加当前字符后是否超出宽度
              if (currentWidth + charWidth > maxWidth && currentLine.length > 0) {
                // 超出宽度，需要换行
                // 尝试在最近的分隔符处断行
                let breakPoint = -1;
                for (let j = currentLine.length - 1; j >= Math.max(0, currentLine.length - 10); j--) {
                  if (splitPoints.includes(currentLine[j])) {
                    breakPoint = j + 1;
                    break;
                  }
                }
                
                if (breakPoint > 0 && breakPoint < currentLine.length) {
                  // 在分隔符处断行
                  lines.push(currentLine.substring(0, breakPoint));
                  currentLine = currentLine.substring(breakPoint) + char;
                  currentWidth = getTextWidth(currentLine, fontSize);
                } else {
                  // 没有合适的分隔符，直接在当前位置断行
                  lines.push(currentLine);
                  currentLine = char;
                  currentWidth = charWidth;
                }
              } else {
                currentLine += char;
                currentWidth += charWidth;
              }
            }
            if (currentLine) {
              lines.push(currentLine);
            }
            
            const lineHeight = fontSize * 1.3;
            const totalHeight = lines.length * lineHeight;
            
            return (
              <g>
                {/* 引导线（如果有） */}
                {annotation.hasLeaderLine && (
                  <g>
                    <line
                      x1={annotation.startX}
                      y1={annotation.startY}
                      x2={annotation.endX}
                      y2={annotation.endY - totalHeight / 2 + lineHeight / 2}
                      stroke={annotation.color}
                      strokeWidth={annotationStyles.strokeWidth}
                    />
                    <circle
                      cx={annotation.startX}
                      cy={annotation.startY}
                      r="1"
                      fill={annotation.color}
                    />
                  </g>
                )}
                
                {/* 多行文字 */}
                {lines.map((line, index) => (
                  <text
                    key={index}
                    x={annotation.endX}
                    y={annotation.endY - totalHeight / 2 + (index + 0.5) * lineHeight}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={fontSize}
                    fill={annotation.color}
                    fontWeight={annotationStyles.textFontWeight}
                    transform={`rotate(0, ${annotation.endX}, ${annotation.endY - totalHeight / 2 + (index + 0.5) * lineHeight})`}
                    style={annotationStyles.textStyle}
                  >
                    {line}
                  </text>
                ))}
              </g>
            );
          }
          
          // 文本不长，正常单行显示
          return (
            <g>
              {/* 引导线（如果有） */}
              {annotation.hasLeaderLine && (
                <g>
                  <line
                    x1={annotation.startX}
                    y1={annotation.startY}
                    x2={annotation.endX}
                    y2={annotation.endY}
                    stroke={annotation.color}
                    strokeWidth={annotationStyles.strokeWidth}
                  />
                  <circle
                    cx={annotation.startX}
                    cy={annotation.startY}
                    r="1"
                    fill={annotation.color}
                  />
                </g>
              )}
              
              {/* 无边框文字 */}
              <text
                x={annotation.endX}
                y={annotation.endY}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={fontSize}
                fill={annotation.color}
                fontWeight={annotationStyles.textFontWeight}
                transform={`rotate(0, ${annotation.endX}, ${annotation.endY})`}
                style={annotationStyles.textStyle}
              >
                {displayText}
              </text>
            </g>
          );
        })()}

        {/* 选中高亮效果 */}
        {isSelected && (
          <g>
            {(annotation.borderShape === 'circle' || annotation.borderShape === 'shop-weld') && (() => {
              const sizes = calculateAnnotationSize(displayText, fontSize, annotation);
              const circleRadius = sizes.circleRadius;
              return (
                <circle
                  cx={annotation.endX}
                  cy={annotation.endY}
                  r={circleRadius + 8}
                  fill="none"
                  stroke="rgba(255, 165, 0, 0.9)"
                  strokeWidth={annotationStyles.strokeWidth}
                  opacity="0.8"
                />
              );
            })()}
            {(annotation.borderShape === 'diamond' || annotation.borderShape === 'field-weld') && (() => {
              const sizes = calculateAnnotationSize(displayText, fontSize, annotation);
              const diamondRadius = sizes.diamondRadius || sizes.circleRadius;
              return (
                <polygon
                  points={`${annotation.endX},${annotation.endY - diamondRadius - 8} ${annotation.endX + diamondRadius + 8},${annotation.endY} ${annotation.endX},${annotation.endY + diamondRadius + 8} ${annotation.endX - diamondRadius - 8},${annotation.endY}`}
                  fill="none"
                  stroke="rgba(255, 165, 0, 0.9)"
                  strokeWidth={annotationStyles.strokeWidth}
                  opacity="0.8"
                />
              );
            })()}
            {annotation.borderShape === 'rectangle' && (() => {
              const rectangleHalfSide = calculateAnnotationSize(displayText, fontSize, annotation).rectangleHalfSide;
              return (
                <rect
                  x={annotation.endX - rectangleHalfSide - 8}
                  y={annotation.endY - rectangleHalfSide - 8}
                  width={(rectangleHalfSide + 8) * 2}
                  height={(rectangleHalfSide + 8) * 2}
                  fill="none"
                  stroke="rgba(255, 165, 0, 0.9)"
                  strokeWidth={annotationStyles.strokeWidth}
                  opacity="0.8"
                />
              );
            })()}
            {annotation.borderShape === 'text-rectangle' && (() => {
              const sizes = calculateAnnotationSize(displayText, fontSize, annotation);
              return (
                <rect
                  x={annotation.endX - sizes.textRectangleWidth / 2 - 8}
                  y={annotation.endY - sizes.textRectangleHeight / 2 - 8}
                  width={sizes.textRectangleWidth + 16}
                  height={sizes.textRectangleHeight + 16}
                  fill="none"
                  stroke="rgba(255, 165, 0, 0.9)"
                  strokeWidth={annotationStyles.strokeWidth}
                  opacity="0.8"
                />
              );
            })()}
            {annotation.borderShape === 'pipe-tag' && (() => {
              const tag = getPipeTagSize(displayText, fontSize, annotation);
              return (
                <rect
                  x={annotation.endX - tag.width / 2 - 8}
                  y={annotation.endY - tag.height / 2 - 8}
                  width={tag.width + 16}
                  height={tag.height + 16}
                  fill="none"
                  stroke="rgba(255, 165, 0, 0.9)"
                  strokeWidth={annotationStyles.strokeWidth}
                  opacity="0.8"
                />
              );
            })()}
          </g>
        )}
      </g>
    </svg>
  );
}, (prevProps, nextProps) => {
  // 自定义比较函数：返回 true 表示props相等，不需要重新渲染
  // 只有当关键属性真正改变时才返回 false 触发重新渲染
  const prev = prevProps.annotation;
  const next = nextProps.annotation;
  
  return (
    prev.id === next.id &&
    prev.text === next.text &&
    prev.materialNumber === next.materialNumber &&
    prev.startX === next.startX &&
    prev.startY === next.startY &&
    prev.endX === next.endX &&
    prev.endY === next.endY &&
    prev.color === next.color &&
    prev.fontSize === next.fontSize &&
    prev.frameSize === next.frameSize &&
    prev.borderShape === next.borderShape &&
    prev.rotation === next.rotation &&
    prev.hasLeaderLine === next.hasLeaderLine &&
    prevProps.scale === nextProps.scale &&
    prevProps.isSelected === nextProps.isSelected &&
    prevProps.annotationMode === nextProps.annotationMode
  );
});

AnnotationItem.displayName = 'AnnotationItem';

export default AnnotationItem;

