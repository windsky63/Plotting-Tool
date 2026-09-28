import React from 'react';
import { Button } from 'antd';
import { EyeOutlined, EyeInvisibleOutlined } from '@ant-design/icons';

export const VectorDebugToggle = ({ visible, onToggle, embedded = false }) => {
  const fixedStyle = {
    position: 'fixed',
    top: '120px',
    left: '270px',
    zIndex: 1000,
  };
  
  const embeddedStyle = {
    width: '100%',
  };
  
  return (
    <Button
      type="text"
      icon={visible ? <EyeInvisibleOutlined /> : <EyeOutlined />}
      onClick={onToggle}
      title={visible ? 
        '隐藏矢量调试\n\n💡 矢量调试模式下可以手动选择焊点并导出标注' : 
        '显示矢量调试\n\n💡 启用后可以手动选择焊点进行标注'}
      style={{
        ...(embedded ? embeddedStyle : fixedStyle),
        background: 'rgba(255, 255, 255, 0.9)',
        border: '1px solid #d9d9d9',
        borderRadius: '6px',
        fontSize: '12px'
      }}
    >
      矢量调试
    </Button>
  );
};
