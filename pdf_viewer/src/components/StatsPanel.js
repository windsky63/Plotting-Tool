import React, { useState } from 'react';
import styled from 'styled-components';
import { Card, Statistic, Row, Col, Typography, Divider, Button } from 'antd';
import { 
  PlusCircleOutlined, 
  DeleteOutlined, 
  EditOutlined, 
  UserAddOutlined,
  BarChartOutlined,
  CloudUploadOutlined,
  LeftOutlined,
  RightOutlined
} from '@ant-design/icons';

const { Title } = Typography;

const PanelContainer = styled.div`
  width: ${props => props.$collapsed ? '40px' : '250px'};
  background: white;
  border-right: 1px solid #e8e8e8;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: ${props => props.$collapsed ? 'hidden' : 'auto'};
  flex-shrink: 0; /* 防止被压缩 */
  transition: width 0.3s ease;
  position: relative;
  z-index: 1; /* 确保在调试按钮下方 */
`;

const Header = styled.div`
  padding: 12px;
  border-bottom: 1px solid #e8e8e8;
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: space-between;
  cursor: pointer;
  user-select: none;
  
  &:hover {
    background: #f5f5f5;
  }
`;

const Content = styled.div`
  padding: 12px;
  flex: 1;
`;

const StyledCard = styled(Card)`
  margin-bottom: 12px;
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.05);
  
  .ant-card-body {
    padding: 8px 12px;
  }
`;

const StatItem = ({ title, value, icon, color, suffix }) => (
  <div style={{ marginBottom: 8 }}>
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 2, color: '#666', fontSize: '12px' }}>
      <span style={{ marginRight: 4, color, fontSize: '14px' }}>{icon}</span>
      {title}
    </div>
    <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#333' }}>
      {value} <span style={{ fontSize: '11px', color: '#999', fontWeight: 'normal' }}>{suffix || '个'}</span>
    </div>
  </div>
);

const ButtonContainer = styled.div`
  margin-top: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const UploadButton = styled(Button)`
  width: 100%;
  margin-bottom: 12px;
  height: 36px;
  font-weight: bold;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border: none;
  color: white;
  
  &:hover {
    background: linear-gradient(135deg, #764ba2 0%, #667eea 100%) !important;
    color: white !important;
  }
  
  &:active {
    background: linear-gradient(135deg, #5568d3 0%, #6342a0 100%) !important;
  }
`;

const AccuracyCard = styled(Card)`
  margin-bottom: 12px;
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.05);
  border: 1px solid #e8e8e8;
  
  .ant-card-body {
    padding: 8px 12px;
  }
`;

const AccuracyItem = ({ title, value, color }) => (
  <div style={{ marginBottom: 8 }}>
    <div style={{ fontSize: '11px', color: '#666', marginBottom: 2 }}>
      {title}
    </div>
    <div style={{ 
      fontSize: '22px', 
      fontWeight: 'bold', 
      color: color,
      textAlign: 'center'
    }}>
      {value}
    </div>
  </div>
);

const StatsPanel = ({ visible = true, stats, debugButtonsRef, onUploadClick }) => {
  const [collapsed, setCollapsed] = useState(false);
  
  if (!visible) return null;

  const { batchAdded = 0, deleted = 0, modified = 0, manuallyAdded = 0 } = stats || {};

  // 计算实际焊点数量：批量增加 + 手动添加 - 删除的标号
  const actualWeldCount = batchAdded + manuallyAdded - deleted;
  
  // 计算焊点识别准确率：(批量增加 - 删除的标号) / 实际焊点数量 * 100%
  // 这样可以同时反映多识别（删除）和漏识别（手动添加）的情况
  // 如果实际焊点数量为0，准确率为 N/A
  const weldDetectionAccuracy = actualWeldCount > 0 
    ? (((batchAdded - deleted) / actualWeldCount) * 100).toFixed(1) + '%'
    : 'N/A';
  
  // 计算编号准确率：(批量增加 - 修改的标号) / 批量增加 * 100%
  // 如果批量增加为0，准确率为 N/A
  const numberingAccuracy = batchAdded > 0 
    ? (((batchAdded - modified) / batchAdded) * 100).toFixed(1) + '%'
    : 'N/A';

  return (
    <PanelContainer $collapsed={collapsed}>
      <Header onClick={() => setCollapsed(!collapsed)} title={collapsed ? '展开面板' : '收起面板'}>
        {!collapsed && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <BarChartOutlined style={{ fontSize: '18px', color: '#1890ff' }} />
              <Title level={5} style={{ margin: 0 }}>操作统计</Title>
            </div>
            <LeftOutlined style={{ fontSize: '14px', color: '#666' }} />
          </>
        )}
        {collapsed && (
          <div style={{ 
            writingMode: 'vertical-rl', 
            textOrientation: 'mixed',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
            height: '100%',
            fontSize: '14px',
            color: '#1890ff',
            fontWeight: 'bold'
          }}>
            <RightOutlined style={{ fontSize: '14px', marginBottom: '8px' }} />
            <span>操作统计</span>
          </div>
        )}
      </Header>
      
      {!collapsed && (
      <Content>
        <StyledCard bordered={false}>
          <StatItem 
            title="批量增加" 
            value={batchAdded} 
            icon={<PlusCircleOutlined />} 
            color="#52c41a"
          />
          <Divider style={{ margin: '4px 0' }} />
          
          <StatItem 
            title="手动添加" 
            value={manuallyAdded} 
            icon={<UserAddOutlined />} 
            color="#1890ff"
          />
          <Divider style={{ margin: '4px 0' }} />
          
          <StatItem 
            title="修改标号" 
            value={modified} 
            icon={<EditOutlined />} 
            color="#fa8c16"
          />
          <Divider style={{ margin: '4px 0' }} />
          
          <StatItem 
            title="删除标号" 
            value={deleted} 
            icon={<DeleteOutlined />} 
            color="#ff4d4f"
          />
        </StyledCard>
        
        {/* 准确率统计卡片 */}
        <AccuracyCard bordered={false}>
          <div style={{ fontSize: '12px', fontWeight: 'bold', marginBottom: 8, color: '#333', borderBottom: '1px solid #f0f0f0', paddingBottom: 4 }}>
            📊 准确率分析
          </div>
          
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: '11px', color: '#666', marginBottom: 2 }}>
              实际焊点数量
            </div>
            <div style={{ 
              fontSize: '20px', 
              fontWeight: 'bold', 
              color: '#1890ff',
              textAlign: 'center'
            }}>
              {actualWeldCount} <span style={{ fontSize: '11px', color: '#999', fontWeight: 'normal' }}>个</span>
            </div>
            <div style={{ fontSize: '10px', color: '#999', textAlign: 'center', marginTop: 1 }}>
              = {batchAdded} + {manuallyAdded} - {deleted}
            </div>
          </div>
          
          <Divider style={{ margin: '8px 0' }} />
          
          <AccuracyItem 
            title="焊点识别准确率" 
            value={weldDetectionAccuracy}
            color="#52c41a"
          />
          
          <Divider style={{ margin: '8px 0' }} />
          
          <AccuracyItem 
            title="编号准确率" 
            value={numberingAccuracy}
            color="#722ed1"
          />
        </AccuracyCard>
        
        {/* 上传到氚云按钮 */}
        <UploadButton 
          icon={<CloudUploadOutlined />}
          onClick={onUploadClick}
        >
          上传数据到氚云
        </UploadButton>
        
        {/* 调试按钮容器 - 通过Portal从PDFViewer渲染 */}
        <ButtonContainer ref={debugButtonsRef} />
      </Content>
      )}
    </PanelContainer>
  );
};

export default StatsPanel;

