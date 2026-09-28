import React from 'react';
import { Button, Tooltip } from 'antd';
import { FireOutlined, FireFilled, WarningOutlined } from '@ant-design/icons';

export const WeldDebugToggle = ({ visible, onToggle, hasOCRData = false, enableOCRFilter = true, embedded = false }) => {
  // 确定按钮状态和提示信息
  const getTooltipContent = () => {
    if (visible) {
      return '隐藏焊点识别';
    }
    
    if (!hasOCRData && enableOCRFilter) {
      return (
        <div>
          <div>⚠️ 建议先进行OCR识别</div>
          <div style={{ marginTop: 4, fontSize: '12px', opacity: 0.9 }}>
            1. 导入识别模板（材料表或支架模板）<br/>
            2. 点击"开始识别"按钮<br/>
            3. OCR识别完成后，焊点会自动过滤文字区域
          </div>
        </div>
      );
    }
    
    if (hasOCRData && enableOCRFilter) {
      return (
        <div>
          <div>✅ 显示焊点识别（已有OCR数据）</div>
          <div style={{ marginTop: 4, fontSize: '12px', opacity: 0.9 }}>
            将自动过滤OCR识别的文字区域
          </div>
        </div>
      );
    }
    
    return '显示焊点识别';
  };
  
  // 显示警告图标（当没有OCR数据且启用了过滤时）
  const showWarning = !visible && !hasOCRData && enableOCRFilter;
  
  const fixedStyle = {
    position: 'fixed',
    top: '210px',
    left: '270px',
    zIndex: 1000,
  };
  
  const embeddedStyle = {
    width: '100%',
  };
  
  return (
    <Tooltip title={getTooltipContent()} placement="left">
      <Button
        type="text"
        icon={visible ? <FireFilled /> : showWarning ? <WarningOutlined /> : <FireOutlined />}
        onClick={onToggle}
        style={{
          ...(embedded ? embeddedStyle : fixedStyle),
          background: visible ? 'rgba(255, 165, 0, 0.1)' : (showWarning ? 'rgba(255, 248, 225, 0.95)' : 'rgba(255, 255, 255, 0.9)'),
          border: visible ? '1px solid #FFA500' : (showWarning ? '1px solid #faad14' : '1px solid #d9d9d9'),
          borderRadius: '6px',
          fontSize: '12px',
          color: visible ? '#FF8C00' : (showWarning ? '#fa8c16' : undefined)
        }}
      >
        焊点识别
      </Button>
    </Tooltip>
  );
};

