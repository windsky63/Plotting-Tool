// 焊点导出按钮
import React from 'react';
import { Button } from 'antd';
import { ExportOutlined } from '@ant-design/icons';

export const WeldExportButton = ({ visible, onExport, hasSelection, embedded = false }) => {
  if (!visible && !embedded) return null;
  
  const fixedStyle = {
    position: 'fixed',
    top: '330px',
    left: '270px',
    zIndex: 1000,
  };
  
  const embeddedStyle = {
    width: '100%',
  };
  
  return (
    <Button
      type="text"
      icon={<ExportOutlined />}
      onClick={onExport}
      title={hasSelection ? '导出选中的焊点为JSON' : '导出所有检测到的焊点为JSON'}
      disabled={!visible && embedded}
      style={{
        ...(embedded ? embeddedStyle : fixedStyle),
        background: hasSelection ? 'rgba(255, 165, 0, 0.95)' : 'rgba(255, 255, 255, 0.9)',
        color: hasSelection ? 'white' : 'rgba(0, 0, 0, 0.85)',
        border: hasSelection ? '2px solid #ff8c00' : '1px solid #d9d9d9',
        borderRadius: '6px',
        fontSize: '13px',
        fontWeight: hasSelection ? 'bold' : 'normal',
        boxShadow: hasSelection ? '0 0 10px rgba(255, 165, 0, 0.5)' : '0 2px 8px rgba(0,0,0,0.1)',
        padding: '8px 16px'
      }}
    >
      {hasSelection ? '导出选中' : '导出焊点'}
    </Button>
  );
};

