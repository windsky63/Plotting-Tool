import React from 'react';
import { Button, Tooltip } from 'antd';
import { ApartmentOutlined } from '@ant-design/icons';

export const PipelineDebugToggle = ({ visible, onToggle, embedded = false }) => {
  const fixedStyle = {
    position: 'fixed',
    top: '290px',
    left: '270px',
    zIndex: 1000,
  };
  
  const embeddedStyle = {
    width: '100%',
  };
  
  return (
    <Tooltip 
      title="管道识别已临时禁用（避免影响焊点编号）" 
      placement="left"
    >
      <Button
        type="text"
        icon={<ApartmentOutlined />}
        disabled={true}
        style={{
          ...(embedded ? embeddedStyle : fixedStyle),
          background: 'rgba(245, 245, 245, 0.9)',
          border: '1px solid #d9d9d9',
          borderRadius: '6px',
          fontSize: '12px',
          color: '#999'
        }}
      >
        跳过管道识别
      </Button>
    </Tooltip>
  );
};
