/**
 * OCR进度模态框组件
 * 显示OCR识别进度和状态
 */

import React from 'react';
import { Modal, Progress, Button, Space } from 'antd';
import { StopOutlined } from '@ant-design/icons';
import { useOCRContext } from '../../contexts/OCRContext';

const OCRProgressModal = ({ visible, onCancel }) => {
  const {
    ocrProgress,
    ocrStatus,
    ocrStopping,
    currentOcrProcess,
    handleStopOCR
  } = useOCRContext();

  const handleStop = () => {
    if (handleStopOCR) {
      handleStopOCR();
    }
  };

  const getProgressStatus = () => {
    if (ocrProgress === 100) return 'success';
    if (ocrStopping && ocrProgress < 100) return 'exception';
    if (ocrProgress > 0) return 'active';
    return 'normal';
  };

  const getProgressColor = () => {
    if (ocrProgress === 100) return '#52c41a';
    if (ocrStopping && ocrProgress < 100) return '#ff4d4f';
    return '#1890ff';
  };

  return (
    <Modal
      title="OCR识别进度"
      open={visible}
      onCancel={null}
      footer={[
        <Button 
          key="stop"
          type="primary"
          danger
          icon={<StopOutlined />}
          onClick={handleStop}
          disabled={ocrStopping || !currentOcrProcess}
          loading={ocrStopping}
        >
          {ocrStopping ? '正在停止...' : '停止识别'}
        </Button>
      ]}
      closable={false}
      maskClosable={false}
      width={480}
    >
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <div>
          <div style={{ marginBottom: 8 }}>
            <span>识别进度：</span>
            <span style={{ fontWeight: 'bold' }}>
              {Math.round(ocrProgress)}%
            </span>
          </div>
          <Progress
            percent={Math.round(ocrProgress)}
            status={getProgressStatus()}
            strokeColor={getProgressColor()}
            trailColor="#f0f0f0"
            size={{
              height: 8
            }}
            format={(percent) => `${percent}%`}
          />
        </div>
        
        <div>
          <div style={{ 
            padding: '8px 12px',
            backgroundColor: '#f6f6f6',
            borderRadius: '4px',
            border: '1px solid #d9d9d9',
            minHeight: '32px',
            display: 'flex',
            alignItems: 'center'
          }}>
            <span style={{ 
              color: (ocrStopping && ocrProgress < 100) ? '#ff4d4f' : '#666',
              fontSize: '14px'
            }}>
              {ocrStatus}
            </span>
          </div>
        </div>

        {ocrStopping && ocrProgress < 100 && (
          <div style={{
            padding: '8px 12px',
            backgroundColor: '#fff2e8',
            borderRadius: '4px',
            border: '1px solid #ffec3d',
            color: '#fa8c16'
          }}>
            <span>⚠️ 正在停止OCR识别，请稍候...</span>
          </div>
        )}

        {ocrProgress === 100 && (
          <div style={{
            padding: '8px 12px',
            backgroundColor: '#f6ffed',
            borderRadius: '4px',
            border: '1px solid #b7eb8f',
            color: '#52c41a'
          }}>
            <span>✅ OCR识别已完成！</span>
          </div>
        )}
      </Space>
    </Modal>
  );
};

export default OCRProgressModal;
