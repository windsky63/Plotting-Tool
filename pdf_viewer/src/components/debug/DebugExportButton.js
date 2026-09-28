// 调试数据导出按钮
import React from 'react';
import { Button } from 'antd';
import { DownloadOutlined, TagsOutlined } from '@ant-design/icons';

export const DebugExportButton = ({ visible, onExport, hasSelection, embedded = false }) => {
  if (!visible && !embedded) return null;
  
  // 如果有选中的内容，显示为"导出标注"（用于手动标注）
  // 如果没有选中，显示为"导出调试"（用于技术调试）
  const isAnnotationMode = hasSelection;
  
  const fixedStyle = {
    position: 'fixed',
    top: '370px',
    left: '270px',
    zIndex: 1000,
  };
  
  const embeddedStyle = {
    width: '100%',
  };
  
  return (
    <Button
      type="text"
      icon={isAnnotationMode ? <TagsOutlined /> : <DownloadOutlined />}
      onClick={onExport}
      disabled={!visible && embedded}
      title={isAnnotationMode ? 
        `✅ 已选中 ${hasSelection} 个对象\n点击导出为焊点标注数据\n用于AI分析生成新识别规则` : 
        '导出技术调试数据（用于对比Python项目）'}
      style={{
        ...(embedded ? embeddedStyle : fixedStyle),
        background: isAnnotationMode ? 'rgba(0, 200, 0, 0.95)' : 'rgba(255, 255, 255, 0.9)',
        color: isAnnotationMode ? 'white' : 'rgba(0, 0, 0, 0.85)',
        border: isAnnotationMode ? '2px solid #00ff00' : '1px solid #d9d9d9',
        borderRadius: '6px',
        fontSize: '13px',
        fontWeight: isAnnotationMode ? 'bold' : 'normal',
        boxShadow: isAnnotationMode ? '0 0 10px rgba(0, 255, 0, 0.5)' : '0 2px 8px rgba(0,0,0,0.1)',
        padding: '8px 16px'
      }}
    >
      {isAnnotationMode ? `导出标注(${hasSelection})` : '导出调试'}
    </Button>
  );
};

