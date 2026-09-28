import React from 'react';
import { Modal, Progress, Typography, Space, Button } from 'antd';
import { LoadingOutlined, StopOutlined, CheckCircleTwoTone } from '@ant-design/icons';
import styled from 'styled-components';

const { Text } = Typography;

const ProgressContainer = styled.div`
  padding: 20px 0;
  text-align: center;
`;

const StatusText = styled(Text)`
  display: block;
  margin-bottom: 16px;
  font-size: 14px;
  color: #666;
`;

const ProgressWrapper = styled.div`
  margin: 20px 0;
`;

const TimeInfo = styled.div`
  display: flex;
  justify-content: space-between;
  margin-top: 12px;
  font-size: 12px;
  color: #999;
`;

const ProgressModal = ({
  visible,
  progress = 0,
  status = '准备中...',
  currentPage = 0,
  totalPages = 0,
  onCancel,
  cancelable = true,
  onStop
}) => {
  const getProgressStatus = () => {
    if (progress === 100) return 'success';
    if (progress > 0) return 'active';
    return 'normal';
  };

  const formatTime = (seconds) => {
    if (seconds < 60) {
      return `${seconds}秒`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}分${remainingSeconds}秒`;
  };

  const estimatedTime = totalPages > 0 && progress > 0 
    ? Math.round((100 - progress) * totalPages / progress * 2) // 估算剩余时间
    : 0;

  return (
    <Modal
      title="OCR识别进度"
      open={visible}
      onCancel={cancelable ? onCancel : undefined}
      footer={progress < 100 ? [
        <Button 
          key="stop" 
          icon={<StopOutlined />} 
          onClick={onStop || onCancel}
          danger
        >
          结束识别
        </Button>
      ] : null}
      closable={cancelable}
      maskClosable={false}
      width={480}
      centered
    >
      <ProgressContainer>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <div style={{ textAlign: 'center' }}>
            {progress === 100 ? (
              <CheckCircleTwoTone twoToneColor="#52c41a" style={{ fontSize: 24, marginRight: 8 }} />
            ) : (
              <LoadingOutlined 
                style={{ 
                  fontSize: 24, 
                  color: '#1890ff',
                  marginRight: 8
                }} 
                spin 
              />
            )}
            <StatusText>{status}</StatusText>
          </div>
          
          <ProgressWrapper>
            <Progress
              percent={progress}
              status={getProgressStatus()}
              size={{
                height: 8
              }}
              showInfo={true}
              format={(percent) => `${percent.toFixed(1)}%`}
            />
            
            {totalPages > 0 && (
              <div style={{ textAlign: 'center', marginTop: 8, fontSize: '12px', color: '#666' }}>
                {currentPage > 0 ? `正在处理第 ${currentPage} 页，共 ${totalPages} 页` : `共 ${totalPages} 页待处理`}
              </div>
            )}
            
            {estimatedTime > 0 && (
              <TimeInfo>
                <span>预计剩余时间: {formatTime(estimatedTime)}</span>
                <span>进度: {progress.toFixed(1)}%</span>
              </TimeInfo>
            )}
          </ProgressWrapper>
          
          {progress === 100 && (
            <div style={{ textAlign: 'center', color: '#52c41a', fontWeight: 'bold' }}>
              ✅ 识别完成！
            </div>
          )}
        </Space>
      </ProgressContainer>
    </Modal>
  );
};

export default ProgressModal;