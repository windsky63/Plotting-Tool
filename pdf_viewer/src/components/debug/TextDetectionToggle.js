import React from 'react';
import { Button, Tooltip, Dropdown } from 'antd';
import { FontSizeOutlined, LoadingOutlined, CheckCircleOutlined, DownloadOutlined, DownOutlined } from '@ant-design/icons';

/**
 * 文字识别按钮
 * 对当前页面进行全页文字识别（不需要模板）
 * 识别出的文字区域可用于焊点过滤
 */
export const TextDetectionToggle = ({ 
  detecting = false,
  hasDetections = false,
  detectionCount = 0,
  pipelineNumber = '',
  pipelineStatus = 'unresolved',
  pipelineCandidateCount = 0,
  topPipelineCandidate = '',
  pipelineEngine = 'paddleocr',
  pipelineFallbackUsed = false,
  onDetect,
  onExport, // 新增：导出回调函数
  embedded = false
}) => {
  const pipelineSourceLabel = pipelineEngine === 'mineru'
    ? 'MinerU'
    : (pipelineFallbackUsed ? 'PaddleOCR回退' : 'PaddleOCR');

  const buttonLabel = (() => {
    if (detecting) {
      return '文字识别';
    }

    if (!hasDetections) {
      return '文字识别';
    }

    if (pipelineStatus === 'matched' && pipelineNumber) {
      return `文字识别 · ${pipelineNumber}`;
    }

    if (topPipelineCandidate) {
      return `文字识别 · 候选:${topPipelineCandidate}`;
    }

    return '文字识别 · 未识别';
  })();

  const getTooltipContent = () => {
    if (detecting) {
      return '正在识别文字区域...';
    }
    
    if (hasDetections) {
      return (
        <div>
          <div>✅ 已识别 {detectionCount} 个文字区域</div>
          <div style={{ marginTop: 4, fontSize: '12px', opacity: 0.9 }}>
            {pipelineStatus === 'matched'
              ? `管线号: ${pipelineNumber || '-'}`
              : `管线号: 未识别 (${pipelineCandidateCount} 个候选)`}
          </div>
          <div style={{ marginTop: 4, fontSize: '12px', opacity: 0.9 }}>
            来源: {pipelineSourceLabel}
          </div>
          <div style={{ marginTop: 4, fontSize: '12px', opacity: 0.9 }}>
            点击重新识别 / 下拉导出数据
          </div>
        </div>
      );
    }
    
    return (
        <div>
          <div>📝 识别当前页面的文字区域</div>
          <div style={{ marginTop: 4, fontSize: '12px', opacity: 0.9 }}>
            不需要模板，自动提取文字内容和位置坐标
          </div>
        </div>
      );
  };
  
  const getIcon = () => {
    if (detecting) {
      return <LoadingOutlined spin />;
    }
    if (hasDetections) {
      return <CheckCircleOutlined />;
    }
    return <FontSizeOutlined />;
  };
  
  // 导出菜单项
  const menuItems = [
    {
      key: 'redetect',
      icon: <FontSizeOutlined />,
      label: '重新识别当前页',
      onClick: onDetect
    },
    {
      type: 'divider'
    },
    {
      key: 'export-json',
      icon: <DownloadOutlined />,
      label: `导出JSON (${detectionCount}个检测框)`,
      onClick: () => onExport?.('json')
    },
    {
      key: 'export-csv',
      icon: <DownloadOutlined />,
      label: `导出CSV (${detectionCount}个检测框)`,
      onClick: () => onExport?.('csv')
    }
  ];
  
  const fixedStyle = {
    position: 'fixed',
    top: '160px',
    left: '270px',
    zIndex: 1000,
  };
  
  const embeddedStyle = {
    width: '100%',
  };

  const containerStyle = embedded ? embeddedStyle : fixedStyle;

  const renderPipelineStatus = () => {
    if (detecting) {
      return (
        <div style={{ marginTop: 4, fontSize: '11px', color: '#666', textAlign: 'center' }}>
          正在识别当前页文字与管线号...
        </div>
      );
    }

    if (!hasDetections) {
      return null;
    }

    return (
      <div
        style={{
          marginTop: 4,
          fontSize: '11px',
          color: pipelineStatus === 'matched' ? '#237804' : '#8c8c8c',
          textAlign: 'center',
          wordBreak: 'break-all',
          lineHeight: 1.4
        }}
      >
        {pipelineStatus === 'matched'
          ? `管线号: ${pipelineNumber || '-'}`
          : `管线号: 未识别${topPipelineCandidate ? `，最高候选 ${topPipelineCandidate}` : ''}${pipelineCandidateCount > 0 ? ` (${pipelineCandidateCount} 个候选)` : ''}`}
        <br />
        来源: {pipelineSourceLabel}
      </div>
    );
  };
  
  // 如果有检测结果，使用下拉菜单
  if (hasDetections && !detecting) {
    return (
      <div style={containerStyle}>
        <Dropdown
          menu={{ items: menuItems }}
          placement="bottomRight"
          trigger={['click']}
        >
          <Tooltip title={getTooltipContent()} placement="left">
            <Button
              type="text"
              disabled={detecting}
              style={{
                width: '100%',
                background: 'rgba(82, 196, 26, 0.1)',
                border: '1px solid #52c41a',
                borderRadius: '6px',
                fontSize: '12px',
                color: '#52c41a',
                cursor: 'pointer',
                padding: '4px 12px',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                justifyContent: 'center'
              }}
            >
              <CheckCircleOutlined />
              <span>{buttonLabel}</span>
              <DownOutlined style={{ fontSize: '10px' }} />
            </Button>
          </Tooltip>
        </Dropdown>
        {renderPipelineStatus()}
      </div>
    );
  }
  
  // 默认按钮（无检测结果或正在识别）
  return (
    <div style={containerStyle}>
      <Tooltip title={getTooltipContent()} placement="left">
        <Button
          type="text"
          icon={getIcon()}
          onClick={onDetect}
          disabled={detecting}
          style={{
            width: '100%',
            background: hasDetections 
              ? 'rgba(82, 196, 26, 0.1)' 
              : 'rgba(255, 255, 255, 0.9)',
            border: hasDetections 
              ? '1px solid #52c41a' 
              : '1px solid #d9d9d9',
            borderRadius: '6px',
            fontSize: '12px',
            color: hasDetections ? '#52c41a' : undefined,
            cursor: detecting ? 'wait' : 'pointer'
          }}
        >
          {buttonLabel}
        </Button>
      </Tooltip>
      {renderPipelineStatus()}
    </div>
  );
};
