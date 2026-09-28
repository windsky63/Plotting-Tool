/**
 * Path 类型信息面板
 * 显示当前选中 Path 的类型和特征信息
 */

import React from 'react';
import styled from 'styled-components';
import { PathType } from '../../utils/PathTypeClassifier';

const PanelContainer = styled.div`
  position: absolute;
  top: 20px;
  right: 20px;
  background: rgba(255, 255, 255, 0.95);
  border: 2px solid #1890ff;
  border-radius: 8px;
  padding: 16px;
  min-width: 280px;
  max-width: 400px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  z-index: 1000;
  pointer-events: auto;
`;

const Title = styled.div`
  font-size: 16px;
  font-weight: bold;
  color: #1890ff;
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
`;

const TypeBadge = styled.span`
  display: inline-block;
  padding: 4px 12px;
  border-radius: 12px;
  font-size: 13px;
  font-weight: 600;
  background: ${props => getTypeColor(props.type).bg};
  color: ${props => getTypeColor(props.type).text};
`;

const ConfidenceBar = styled.div`
  margin: 12px 0;
`;

const ConfidenceLabel = styled.div`
  font-size: 13px;
  color: #666;
  margin-bottom: 4px;
`;

const ProgressBar = styled.div`
  width: 100%;
  height: 8px;
  background: #f0f0f0;
  border-radius: 4px;
  overflow: hidden;
`;

const ProgressFill = styled.div`
  height: 100%;
  background: ${props => getConfidenceColor(props.confidence)};
  width: ${props => props.confidence * 100}%;
  transition: width 0.3s ease;
`;

const Section = styled.div`
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #e8e8e8;
`;

const SectionTitle = styled.div`
  font-size: 13px;
  font-weight: 600;
  color: #333;
  margin-bottom: 8px;
`;

const FeatureList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
`;

const FeatureItem = styled.div`
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: #666;
  
  .label {
    font-weight: 500;
  }
  
  .value {
    color: #333;
    font-family: 'Courier New', monospace;
  }
`;

const ReasonList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

const ReasonItem = styled.div`
  font-size: 12px;
  color: #666;
  padding-left: 12px;
  position: relative;
  
  &:before {
    content: '•';
    position: absolute;
    left: 0;
    color: #1890ff;
  }
`;

const EmptyState = styled.div`
  text-align: center;
  padding: 24px;
  color: #999;
  font-size: 14px;
`;

// 辅助函数：根据类型获取颜色
function getTypeColor(type) {
  const colors = {
    [PathType.PIPELINE]: { bg: '#52c41a', text: '#fff' },
    [PathType.WELD]: { bg: '#ff4d4f', text: '#fff' },
    [PathType.DIMENSION_LINE]: { bg: '#1890ff', text: '#fff' },
    [PathType.SYMBOL]: { bg: '#faad14', text: '#fff' },
    [PathType.FLOW_ARROW]: { bg: '#722ed1', text: '#fff' }, // 紫色
    [PathType.TEXT_ELEMENT]: { bg: '#722ed1', text: '#fff' },
    [PathType.DECORATION]: { bg: '#8c8c8c', text: '#fff' },
    [PathType.UNKNOWN]: { bg: '#d9d9d9', text: '#666' }
  };
  
  return colors[type] || colors[PathType.UNKNOWN];
}

// 辅助函数：根据置信度获取颜色
function getConfidenceColor(confidence) {
  if (confidence >= 0.8) return '#52c41a';
  if (confidence >= 0.5) return '#faad14';
  return '#ff4d4f';
}

// 辅助函数：格式化类型名称
function formatTypeName(type) {
  const names = {
    [PathType.PIPELINE]: '管道',
    [PathType.WELD]: '焊点',
    [PathType.DIMENSION_LINE]: '尺寸线',
    [PathType.SYMBOL]: '符号',
    [PathType.FLOW_ARROW]: '流向箭头',
    [PathType.TEXT_ELEMENT]: '文字元素',
    [PathType.DECORATION]: '装饰线',
    [PathType.UNKNOWN]: '未知'
  };
  
  return names[type] || type;
}

export const PathTypeInfoPanel = ({ pathTypeInfo, visible = true }) => {
  if (!visible || !pathTypeInfo) {
    return null;
  }

  const { type, confidence, features, reasons, pathId } = pathTypeInfo;

  return (
    <PanelContainer>
      <Title>
        <span>🎯 Path 类型识别</span>
      </Title>

      <TypeBadge type={type}>
        {formatTypeName(type)}
      </TypeBadge>

      {(pathId !== null && pathId !== undefined) && (
        <Section>
          <FeatureList>
            <FeatureItem>
              <span className="label">Path ID:</span>
              <span className="value">{String(pathId)}</span>
            </FeatureItem>
          </FeatureList>
        </Section>
      )}

      <ConfidenceBar>
        <ConfidenceLabel>
          置信度: {(confidence * 100).toFixed(0)}%
        </ConfidenceLabel>
        <ProgressBar>
          <ProgressFill confidence={confidence} />
        </ProgressBar>
      </ConfidenceBar>

      {reasons && reasons.length > 0 && (
        <Section>
          <SectionTitle>判断依据</SectionTitle>
          <ReasonList>
            {reasons.map((reason, index) => (
              <ReasonItem key={index}>{reason}</ReasonItem>
            ))}
          </ReasonList>
        </Section>
      )}

      {features && (
        <Section>
          <SectionTitle>几何特征</SectionTitle>
          <FeatureList>
            {type === PathType.PIPELINE && features.segmentCount === 4 ? (
              // 管道专用显示逻辑
              <>
                <FeatureItem>
                  <span className="label">线段数:</span>
                  <span className="value">{features.segmentCount}</span>
                </FeatureItem>
                <FeatureItem>
                  <span className="label">总长度:</span>
                  <span className="value" style={{color: '#52c41a', fontWeight: 'bold'}}>
                    {features.totalLength.toFixed(2)}
                  </span>
                </FeatureItem>
                <FeatureItem>
                  <span className="label">管长(估算):</span>
                  <span className="value">
                    {/* 显示两条长边的平均长度 (总长度 - 2*管径) / 2 */}
                    {features.structuralWidth > 0 
                      ? ((features.totalLength - features.structuralWidth * 2) / 2).toFixed(2)
                      : (features.totalLength / 2).toFixed(2)
                    }
                  </span>
                </FeatureItem>
                <FeatureItem>
                  <span className="label">管径(估算):</span>
                  <span className="value" style={{color: '#1890ff', fontWeight: 'bold'}}>
                    {features.structuralWidth > 0 
                      ? features.structuralWidth.toFixed(2) 
                      : 'N/A'
                    }
                  </span>
                </FeatureItem>
              </>
            ) : (
              // 其他类型保持原样
              <>
                <FeatureItem>
                  <span className="label">线段数:</span>
                  <span className="value">{features.segmentCount}</span>
                </FeatureItem>
                <FeatureItem>
                  <span className="label">平均线宽:</span>
                  <span className="value">{features.avgWidth.toFixed(2)}</span>
                </FeatureItem>
                <FeatureItem>
                  <span className="label">总长度:</span>
                  <span className="value">{features.totalLength.toFixed(1)}</span>
                </FeatureItem>
                <FeatureItem>
                  <span className="label">宽度:</span>
                  <span className="value">{features.bbox.width.toFixed(2)}</span>
                </FeatureItem>
                <FeatureItem>
                  <span className="label">高度:</span>
                  <span className="value">{features.bbox.height.toFixed(2)}</span>
                </FeatureItem>
              </>
            )}
            
            {/* 通用特征 */}
            <FeatureItem>
              <span className="label">闭合:</span>
              <span className="value">{features.isClosed ? '是' : '否'}</span>
            </FeatureItem>
            <FeatureItem>
              <span className="label">连续:</span>
              <span className="value">{features.isContinuous ? '是' : '否'}</span>
            </FeatureItem>
          </FeatureList>
        </Section>
      )}
    </PanelContainer>
  );
};

export default PathTypeInfoPanel;

