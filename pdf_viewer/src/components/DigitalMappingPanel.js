import React, { useState, useEffect } from 'react';
import styled from 'styled-components';
import { 
  Card, 
  Button, 
  Progress, 
  Alert, 
  Space, 
  Divider,
  Typography,
  Switch,
  Select,
  Input,
  Tooltip,
  message
} from 'antd';
import { 
  ScanOutlined, 
  EditOutlined, 
  SaveOutlined, 
  ExportOutlined,
  SettingOutlined,
  EyeOutlined,
  EyeInvisibleOutlined
} from '@ant-design/icons';

const { Title, Text } = Typography;
const { Option } = Select;

const PanelContainer = styled.div`
  width: 320px;
  background: #fff;
  border-left: 1px solid #e8e8e8;
  display: flex;
  flex-direction: column;
  overflow: hidden;
`;

const PanelHeader = styled.div`
  padding: 16px;
  border-bottom: 1px solid #e8e8e8;
  background: #fafafa;
`;

const PanelContent = styled.div`
  flex: 1;
  overflow-y: auto;
  padding: 16px;
`;

const Section = styled.div`
  margin-bottom: 24px;
`;

const FeatureCard = styled(Card)`
  margin-bottom: 12px;
  cursor: pointer;
  transition: all 0.3s;
  
  &:hover {
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    transform: translateY(-2px);
  }
  
  &.active {
    border-color: #1890ff;
    background: #f0f8ff;
  }
`;

const ProgressContainer = styled.div`
  margin: 16px 0;
`;

const DigitalMappingPanel = ({
  visible,
  onToggle,
  onMappingStart,
  onMappingComplete,
  mappingStatus,
  mappingProgress,
  mappingError
}) => {
  const [mappingMode, setMappingMode] = useState('auto'); // auto, manual, hybrid
  const [recognitionFeatures, setRecognitionFeatures] = useState({
    pipes: true,
    valves: true,
    equipment: true,
    text: true,
    dimensions: true
  });
  const [exportFormat, setExportFormat] = useState('dxf');
  const [mappingData, setMappingData] = useState(null);
  const [isMapping, setIsMapping] = useState(false);

  // 处理开始数字化映射
  const handleStartMapping = () => {
    if (!mappingData) {
      message.warning('请先选择要数字化的PDF文件');
      return;
    }

    setIsMapping(true);
    onMappingStart({
      mode: mappingMode,
      features: recognitionFeatures,
      format: exportFormat
    });
  };

  // 处理映射完成
  const handleMappingComplete = (data) => {
    setIsMapping(false);
    setMappingData(data);
    onMappingComplete(data);
    message.success('数字化映射完成！');
  };

  // 处理特征识别开关
  const handleFeatureToggle = (feature) => {
    setRecognitionFeatures(prev => ({
      ...prev,
      [feature]: !prev[feature]
    }));
  };

  // 导出数字化结果
  const handleExport = () => {
    if (!mappingData) {
      message.warning('没有可导出的数字化数据');
      return;
    }

    // 这里可以调用导出功能
    // 已导出为指定格式
  };

  if (!visible) return null;

  return (
    <PanelContainer>
      <PanelHeader>
        <Space align="center" style={{ width: '100%', justifyContent: 'space-between' }}>
          <Title level={5} style={{ margin: 0 }}>
            <ScanOutlined /> 电子化落图
          </Title>
          <Button 
            type="text" 
            icon={<SettingOutlined />}
            onClick={onToggle}
          />
        </Space>
      </PanelHeader>

      <PanelContent>
        {/* 映射模式选择 */}
        <Section>
          <Title level={5}>映射模式</Title>
          <Select
            value={mappingMode}
            onChange={setMappingMode}
            style={{ width: '100%' }}
          >
            <Option value="auto">自动识别</Option>
            <Option value="manual">手动标注</Option>
            <Option value="hybrid">混合模式</Option>
          </Select>
          <Text type="secondary" style={{ fontSize: '12px', display: 'block', marginTop: '8px' }}>
            {mappingMode === 'auto' && '自动识别PDF中的工程元素'}
            {mappingMode === 'manual' && '手动标注工程元素'}
            {mappingMode === 'hybrid' && '自动识别 + 手动修正'}
          </Text>
        </Section>

        {/* 识别特征设置 */}
        <Section>
          <Title level={5}>识别特征</Title>
          <Space direction="vertical" style={{ width: '100%' }}>
            <FeatureCard 
              size="small"
              className={recognitionFeatures.pipes ? 'active' : ''}
              onClick={() => handleFeatureToggle('pipes')}
            >
              <Space>
                <Switch 
                  checked={recognitionFeatures.pipes}
                  size="small"
                />
                <Text>管道识别</Text>
              </Space>
            </FeatureCard>
            
            <FeatureCard 
              size="small"
              className={recognitionFeatures.valves ? 'active' : ''}
              onClick={() => handleFeatureToggle('valves')}
            >
              <Space>
                <Switch 
                  checked={recognitionFeatures.valves}
                  size="small"
                />
                <Text>阀门识别</Text>
              </Space>
            </FeatureCard>
            
            <FeatureCard 
              size="small"
              className={recognitionFeatures.equipment ? 'active' : ''}
              onClick={() => handleFeatureToggle('equipment')}
            >
              <Space>
                <Switch 
                  checked={recognitionFeatures.equipment}
                  size="small"
                />
                <Text>设备识别</Text>
              </Space>
            </FeatureCard>
            
            <FeatureCard 
              size="small"
              className={recognitionFeatures.text ? 'active' : ''}
              onClick={() => handleFeatureToggle('text')}
            >
              <Space>
                <Switch 
                  checked={recognitionFeatures.text}
                  size="small"
                />
                <Text>文字识别</Text>
              </Space>
            </FeatureCard>
            
            <FeatureCard 
              size="small"
              className={recognitionFeatures.dimensions ? 'active' : ''}
              onClick={() => handleFeatureToggle('dimensions')}
            >
              <Space>
                <Switch 
                  checked={recognitionFeatures.dimensions}
                  size="small"
                />
                <Text>尺寸标注</Text>
              </Space>
            </FeatureCard>
          </Space>
        </Section>

        <Divider />

        {/* 映射进度 */}
        {isMapping && (
          <Section>
            <Title level={5}>映射进度</Title>
            <ProgressContainer>
              <Progress 
                percent={mappingProgress} 
                status={mappingError ? 'exception' : 'active'}
                strokeColor={{
                  '0%': '#108ee9',
                  '100%': '#87d068',
                }}
              />
              {mappingError && (
                <Alert
                  message="映射失败"
                  description={mappingError}
                  type="error"
                  showIcon
                  style={{ marginTop: '12px' }}
                />
              )}
            </ProgressContainer>
          </Section>
        )}

        {/* 导出设置 */}
        <Section>
          <Title level={5}>导出格式</Title>
          <Select
            value={exportFormat}
            onChange={setExportFormat}
            style={{ width: '100%' }}
          >
            <Option value="dxf">DXF (AutoCAD)</Option>
            <Option value="dwg">DWG (AutoCAD)</Option>
            <Option value="svg">SVG (矢量图)</Option>
            <Option value="json">JSON (数据)</Option>
          </Select>
        </Section>

        {/* 操作按钮 */}
        <Section>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Button
              type="primary"
              icon={<ScanOutlined />}
              onClick={handleStartMapping}
              loading={isMapping}
              block
            >
              {isMapping ? '映射中...' : '开始数字化映射'}
            </Button>
            
            {mappingData && (
              <Button
                icon={<ExportOutlined />}
                onClick={handleExport}
                block
              >
                导出数字化结果
              </Button>
            )}
          </Space>
        </Section>

        {/* 映射状态信息 */}
        {mappingData && (
          <Section>
            <Title level={5}>映射结果</Title>
            <Card size="small">
              <Space direction="vertical" style={{ width: '100%' }}>
                <Text>识别元素: {mappingData.elementsCount || 0}</Text>
                <Text>管道数量: {mappingData.pipesCount || 0}</Text>
                <Text>阀门数量: {mappingData.valvesCount || 0}</Text>
                <Text>设备数量: {mappingData.equipmentCount || 0}</Text>
              </Space>
            </Card>
          </Section>
        )}
      </PanelContent>
    </PanelContainer>
  );
};

export default DigitalMappingPanel; 