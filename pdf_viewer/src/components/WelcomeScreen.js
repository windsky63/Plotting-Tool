/**
 * 欢迎屏幕组件
 * 在未打开PDF时显示，提供文件上传和拖放功能
 */

import React, { useCallback } from 'react';
import styled from 'styled-components';
import { Button, Typography, Space } from 'antd';
import { UploadOutlined, FileAddOutlined, InboxOutlined } from '@ant-design/icons';
import { isElectron } from '../utils/platformDetect';

const { Title, Paragraph, Text } = Typography;

const WelcomeContainer = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  background: #f8f9fa;
  padding: 40px;
  position: relative;
  overflow: hidden;

  &::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: 
      radial-gradient(circle at 20% 30%, rgba(24, 144, 255, 0.05) 0%, transparent 50%),
      radial-gradient(circle at 80% 70%, rgba(82, 196, 26, 0.04) 0%, transparent 50%);
    pointer-events: none;
  }
`;

const ContentBox = styled.div`
  position: relative;
  z-index: 1;
  background: white;
  padding: 48px;
  border-radius: 16px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.06);
  max-width: 560px;
  text-align: center;
  border: 1px solid rgba(0, 0, 0, 0.04);
`;

const LogoIcon = styled.div`
  font-size: 64px;
  margin-bottom: 24px;
  color: #1890ff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 96px;
  height: 96px;
  background: linear-gradient(135deg, #e6f7ff 0%, #bae7ff 100%);
  border-radius: 20px;
  box-shadow: 0 4px 12px rgba(24, 144, 255, 0.15);
`;

const StyledTitle = styled(Title)`
  color: #262626 !important;
  margin-bottom: 12px !important;
  font-weight: 600 !important;
`;

const StyledParagraph = styled(Paragraph)`
  color: #8c8c8c !important;
  font-size: 15px;
  margin-bottom: 32px !important;
  line-height: 1.6;
`;

const FeatureList = styled.div`
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  margin: 32px 0;
  text-align: left;
`;

const FeatureItem = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  background: #fafafa;
  border-radius: 10px;
  color: #595959;
  font-size: 14px;
  border: 1px solid #f0f0f0;
  transition: all 0.2s;

  &:hover {
    background: #f5f5f5;
    border-color: #d9d9d9;
  }

  .anticon {
    color: #1890ff;
    font-size: 16px;
  }
`;

const DropZone = styled.div`
  margin-top: 24px;
  padding: 32px;
  border: 2px dashed #d9d9d9;
  border-radius: 12px;
  background: #fafafa;
  cursor: pointer;
  transition: all 0.25s ease;

  &:hover {
    background: #f5f5f5;
    border-color: #1890ff;
    border-style: solid;
  }

  .anticon {
    font-size: 40px;
    color: #bfbfbf;
    margin-bottom: 12px;
    transition: color 0.25s;
  }

  &:hover .anticon {
    color: #1890ff;
  }
`;

const PlatformBadge = styled.div`
  position: absolute;
  top: 24px;
  right: 24px;
  padding: 6px 14px;
  background: white;
  border-radius: 16px;
  color: #595959;
  font-weight: 500;
  font-size: 13px;
  z-index: 2;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  border: 1px solid rgba(0, 0, 0, 0.06);
`;

const WelcomeScreen = ({ onFileSelect }) => {
  const handleClick = useCallback(() => {
    if (onFileSelect) {
      onFileSelect();
    }
  }, [onFileSelect]);

  const handleDropZoneClick = useCallback((e) => {
    e.stopPropagation();
    handleClick();
  }, [handleClick]);

  const platform = isElectron() ? 'Electron 桌面版' : 'Web 浏览器版';

  return (
    <WelcomeContainer>
      <PlatformBadge>{platform}</PlatformBadge>
      
      <ContentBox>
        <LogoIcon>
          <FileAddOutlined />
        </LogoIcon>
        
        <StyledTitle level={2}>
          PDF 单线图焊口预制标注工具
        </StyledTitle>
        
        <StyledParagraph>
          专业的 PDF 标注工具，支持焊口编号、材料识别、支架标注等功能
        </StyledParagraph>

        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Button
            type="primary"
            size="large"
            icon={<UploadOutlined />}
            onClick={handleClick}
            style={{
              height: '48px',
              fontSize: '15px',
              width: '100%',
              fontWeight: 500,
              boxShadow: '0 2px 8px rgba(24, 144, 255, 0.2)',
            }}
          >
            {isElectron() ? '选择 PDF 文件' : '上传 PDF 文件'}
          </Button>

          <DropZone onClick={handleDropZoneClick}>
            <InboxOutlined />
            <Text style={{ display: 'block', fontSize: '15px', color: '#8c8c8c', fontWeight: 500 }}>
              或拖放 PDF 文件到此处
            </Text>
            <Text style={{ display: 'block', fontSize: '13px', color: '#bfbfbf', marginTop: '6px' }}>
              支持拖放操作，快速打开文件
            </Text>
          </DropZone>
        </Space>

        <FeatureList>
          <FeatureItem>
            <FileAddOutlined />
            <span>焊口智能编号</span>
          </FeatureItem>
          <FeatureItem>
            <FileAddOutlined />
            <span>材料表识别</span>
          </FeatureItem>
          <FeatureItem>
            <FileAddOutlined />
            <span>支架标注</span>
          </FeatureItem>
          <FeatureItem>
            <FileAddOutlined />
            <span>批量导出</span>
          </FeatureItem>
        </FeatureList>

        {!isElectron() && (
          <Text style={{ display: 'block', marginTop: '24px', color: '#bfbfbf', fontSize: '13px' }}>
            💡 提示：Web版本所有功能均可用，保存将下载到本地
          </Text>
        )}
      </ContentBox>
    </WelcomeContainer>
  );
};

export default WelcomeScreen;

