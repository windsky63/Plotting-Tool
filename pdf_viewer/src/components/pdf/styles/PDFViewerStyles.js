/**
 * PDFViewer 样式组件
 * 包含所有PDF查看器相关的styled-components
 */

import styled from 'styled-components';
import { Input } from 'antd';

// 主容器
export const ViewerContainer = styled.div.attrs({ id: 'pdf-container' })`
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  background: #f5f5f5;
  display: flex;
  flex-direction: column;
  align-items: center;
  position: relative;
  cursor: ${props => 
    props.$annotationMode ? 
    `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64'><defs><style>.cls-2{fill:none;stroke:%23000;stroke-width:2;}</style></defs><line class='cls-2' x1='32' y1='0' x2='32' y2='20'/><line class='cls-2' x1='32' y1='44' x2='32' y2='64'/><line class='cls-2' x1='0' y1='32' x2='20' y2='32'/><line class='cls-2' x1='44' y1='32' x2='64' y2='32'/><rect class='cls-2' x='28' y='28' width='8' height='8' stroke-width='2'/></svg>") 32 32, crosshair` :
    props.$isDragging ? 'grabbing' : 'default'
  };
  user-select: none;
  padding: 20px ${props => props.$rulesPanelVisible ? '380px' : '0'} 20px 0;
  
  &:active {
    cursor: ${props => 
      props.$annotationMode ? 
      `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64'><defs><style>.cls-2{fill:none;stroke:%23000;stroke-width:2;}</style></defs><line class='cls-2' x1='32' y1='0' x2='32' y2='20'/><line class='cls-2' x1='32' y1='44' x2='32' y2='64'/><line class='cls-2' x1='0' y1='32' x2='20' y2='32'/><line class='cls-2' x1='44' y1='32' x2='64' y2='32'/><rect class='cls-2' x='28' y='28' width='8' height='8' stroke-width='2'/></svg>") 32 32, crosshair` :
      'grabbing'
    };
  }
`;

// 页面视口
export const PageViewport = styled.div.attrs(props => ({
  style: {
    transform: `translate(${props.$offsetX}px, ${props.$offsetY}px)`,
    transition: props.$isDragging ? 'none' : 'transform 0.1s ease-out'
  }
}))``;

// 页面容器
export const PageContainer = styled.div`
  position: relative;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  background: white;
  margin-bottom: 20px;
  
  &:last-child {
    margin-bottom: 0;
  }
  
  /* 高DPI优化 */
  & canvas {
    image-rendering: -webkit-optimize-contrast;
    image-rendering: crisp-edges;
    image-rendering: pixelated;
    image-rendering: optimize-contrast;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  /* SVG渲染优化 */
  & svg {
    display: block; /* 消除底部间隙 */
    width: 100%;
    height: 100%;
  }
`;

// 注释层
export const AnnotationLayer = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  pointer-events: ${props => props.$annotationMode ? 'auto' : 'visiblePainted'};
  cursor: ${props => 
    props.$annotationMode ? 
    `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64'><defs><style>.cls-2{fill:none;stroke:%23000;stroke-width:2;}</style></defs><line class='cls-2' x1='32' y1='0' x2='32' y2='20'/><line class='cls-2' x1='32' y1='44' x2='32' y2='64'/><line class='cls-2' x1='0' y1='32' x2='20' y2='32'/><line class='cls-2' x1='44' y1='32' x2='64' y2='32'/><rect class='cls-2' x='28' y='28' width='8' height='8' stroke-width='2'/></svg>") 32 32, crosshair` :
    'default'
  };
  z-index: 2;
`;

// 加载容器
export const LoadingContainer = styled.div`
  display: flex;
  justify-content: center;
  align-items: center;
  height: 400px;
  flex-direction: column;
  gap: 16px;
`;

// 空内容容器
export const EmptyContainer = styled.div`
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100%;
  flex-direction: column;
`;

// 材料编号输入框容器
export const MaterialInputContainer = styled.div`
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  background: linear-gradient(135deg, #ffffff 0%, #f8f9fa 100%);
  border: 3px solid #1890ff;
  border-radius: 16px;
  box-shadow: 0 8px 32px rgba(24, 144, 255, 0.3), 0 4px 16px rgba(0, 0, 0, 0.1);
  z-index: 10000;
  padding: 20px 24px;
  min-width: 280px;
  backdrop-filter: blur(10px);
  animation: slideUp 0.3s ease-out;
  
  @keyframes slideUp {
    from {
      opacity: 0;
      transform: translateX(-50%) translateY(20px);
    }
    to {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
  }
`;

// 流畅的加载动画组件
export const SmoothLoader = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
  background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite ease-in-out;
  border-radius: 8px;

  @keyframes shimmer {
    0% {
      background-position: -200% 0;
    }
    100% {
      background-position: 200% 0;
    }
  }

  .ant-spin {
    .ant-spin-dot {
      font-size: 24px;
    }

    .ant-spin-dot-item {
      background-color: #1890ff;
      border-radius: 50%;
      animation: antSpinMove 1s infinite linear alternate;
    }
  }

  @keyframes antSpinMove {
    to {
      opacity: 0.3;
      transform: scale(0.7);
    }
  }
`;

// 页面骨架屏
export const PageSkeleton = styled.div`
  width: 100%;
  height: ${props => props.height || '600px'};
  background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite ease-in-out;
  border-radius: 8px;
  position: relative;

  &::after {
    content: '页面加载中...';
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    color: #999;
    font-size: 14px;
    opacity: 0.7;
  }
`;

// 页面渐入动画
export const FadeInPage = styled.div`
  animation: fadeIn 0.3s ease-in-out;

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
`;

// 材料输入标题
export const MaterialInputTitle = styled.div`
  font-size: 16px;
  font-weight: 600;
  color: #1890ff;
  text-align: center;
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  
  &::before {
    content: '📝';
    font-size: 18px;
  }
`;

// 材料输入行
export const MaterialInputRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-bottom: 16px;
`;

// 材料输入字段
export const MaterialInputField = styled(Input)`
  width: 60px !important;
  height: 40px !important;
  font-size: 18px !important;
  font-weight: 600 !important;
  text-align: center !important;
  border: 2px solid #d9d9d9 !important;
  border-radius: 8px !important;
  transition: all 0.3s ease !important;
  
  &:focus {
    border-color: #1890ff !important;
    box-shadow: 0 0 0 3px rgba(24, 144, 255, 0.2) !important;
    transform: scale(1.05);
  }
  
  &:hover {
    border-color: #40a9ff !important;
  }
`;

// 材料输入分隔符
export const MaterialInputSeparator = styled.span`
  font-size: 20px;
  font-weight: 600;
  color: #1890ff;
  margin: 0 4px;
`;

// 材料输入按钮
export const MaterialInputButton = styled.button`
  background: linear-gradient(135deg, #1890ff 0%, #40a9ff 100%);
  color: white;
  border: none;
  border-radius: 8px;
  padding: 8px 20px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
  box-shadow: 0 2px 8px rgba(24, 144, 255, 0.3);
  
  &:hover {
    background: linear-gradient(135deg, #40a9ff 0%, #1890ff 100%);
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(24, 144, 255, 0.4);
  }
  
  &:active {
    transform: translateY(0);
  }
`;

// 区域选择矩形
export const SelectionRectangle = styled.div`
  position: absolute;
  border: 2px dashed #ff4d4f;
  background: rgba(255, 77, 79, 0.1);
  pointer-events: none;
  z-index: 9999;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.5);
  animation: selectionPulse 1s ease-in-out infinite;
  
  @keyframes selectionPulse {
    0%, 100% {
      opacity: 0.8;
    }
    50% {
      opacity: 1;
    }
  }
`;
