import React, { useState, useMemo } from 'react';
import { Collapse, Card, Table, Tag, Space, Typography, Empty, Spin, Button, Input, message } from 'antd';
import { EyeOutlined, FileTextOutlined, TableOutlined, LoadingOutlined, CheckCircleOutlined, ClockCircleOutlined, ClearOutlined, DeleteOutlined, PlusOutlined, MinusOutlined, DownloadOutlined } from '@ant-design/icons';
import styled from 'styled-components';

const { Title, Text } = Typography;

const PanelContainer = styled.div`
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: white;
  border-top: 1px solid #e8e8e8;
  box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.1);
  /* Keep the bottom recognition panel below the right annotation editor.
     The old 1002 layer covered the editor's last rows and scrollbar. */
  z-index: 900;
  max-height: 60vh;
  overflow: hidden;
`;

const StyledCollapse = styled(Collapse)`
  .ant-collapse-header {
    background: #fafafa;
    border-bottom: 1px solid #e8e8e8;
    
    .ant-collapse-arrow {
      color: #1890ff;
    }
  }
  
  .ant-collapse-content {
    background: white;
  }
`;

const InfoSection = styled.div`
  padding: 16px;
  border-bottom: 1px solid #f0f0f0;
`;

const MaterialSection = styled.div`
  padding: 16px;
  max-height: 300px;
  overflow-y: auto;
`;

const InfoCard = styled(Card)`
  margin-bottom: 16px;
  
  .ant-card-body {
    padding: 12px 16px;
  }
`;

const StatusIcon = styled.div`
  display: inline-flex;
  align-items: center;
  margin-right: 8px;
  
  .anticon {
    font-size: 14px;
  }
  
  &.recognizing .anticon {
    animation: spin 1s linear infinite;
  }
  
  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
`;

const VisualizationPanel = ({ 
  visible = false, 
  recognitionData = null,
  recognitionStatus = 'unrecognized', // 'unrecognized', 'recognizing', 'completed'
  onClose,
  onClearAll = null,
  onClearCurrent = null,
  onDataChange = null,
  currentPage = 1,
  ocrContext = null // 添加OCR上下文
}) => {
  // 使用本地状态管理可编辑的识别数据
  const [editableData, setEditableData] = useState(null);
  
  // 当recognitionData或currentPage变化时，更新editableData
  React.useEffect(() => {
    console.log(`🎨 VisualizationPanel 更新 - 第${currentPage}页, 有数据: ${!!recognitionData}`);
    
    if (recognitionData) {
      const isLightData = recognitionData._isLightData;
      
      console.log('🎨 VisualizationPanel 接收到 recognitionData:', {
        page: currentPage,
        isLightData: isLightData,
        keys: Object.keys(recognitionData),
        scaffolds: recognitionData.scaffolds?.length || recognitionData.scaffoldCount || 0,
        scaffoldData: recognitionData.scaffoldData?.length || 0,
        materials: recognitionData.materials?.length || recognitionData.materialCount || 0,
        isScaffoldMode: recognitionData.isScaffoldMode
      });
      
      // 🔧 优先检查材料表数据（修复材料表识别后不显示的问题）
      // 轻量级数据使用 materialSummary
      const materialsArray = recognitionData.materials || recognitionData.materialSummary || [];
      
      // 检查是否为支架数据 - 支持 scaffolds 和 scaffoldData 两种字段名
      // 轻量级数据使用 scaffoldSummary
      const scaffoldArray = recognitionData.scaffolds || 
                           recognitionData.scaffoldData || 
                           recognitionData.scaffoldSummary;
      
      // 🔧 判断模式：只有在明确标记为支架模式 或者 (有支架数据且无材料表数据) 时才使用支架模式
      const isScaffoldMode = recognitionData.isScaffoldMode === true || 
                            (scaffoldArray && scaffoldArray.length > 0 && materialsArray.length === 0);
      
      if (isScaffoldMode && scaffoldArray && scaffoldArray.length > 0) {
        // 支架数据处理 - 按支架编号排序
        const sortedScaffoldData = [...scaffoldArray].sort((a, b) => {
          // 提取支架编号中的数字部分进行比较
          const getScaffoldNumber = (scaffoldInfo) => {
            if (!scaffoldInfo) return 0;
            const match = scaffoldInfo.match(/S-(\d+)/);
            return match ? parseInt(match[1], 10) : 0;
          };
          
          const numA = getScaffoldNumber(a.scaffoldInfo);
          const numB = getScaffoldNumber(b.scaffoldInfo);
          return numA - numB; // 从小到大排序
        });
        
        const scaffoldData = sortedScaffoldData.map((item, index) => ({
          ...item,
          key: item.key || index.toString()
        }));
        
        console.log('🔢 可视化面板 - 支架数据排序结果:', scaffoldData.map(item => item.scaffoldInfo || item.text));
        
        setEditableData({
          ...recognitionData,
          drawingNumber: recognitionData.drawingNumber || '',
          pipelineNumber: recognitionData.pipelineNumber || '',
          pageNumber: recognitionData.pageNumber || '',
          scaffoldData: scaffoldData,
          isScaffoldMode: true, // 明确标记为支架模式
          materials: [], // 支架模式下材料为空
          _isLightData: recognitionData._isLightData // 传递轻量级数据标记
        });
      } else {
        // 材料表数据处理
        // 轻量级数据使用 materialSummary
        // 辅助函数：展开嵌套格式 { column1: { text: "xxx" } } -> { column1: "xxx" }
        const flattenMaterialRow = (row) => {
          if (!row || typeof row !== 'object') return row;
          const flatRow = {};
          Object.keys(row).forEach(key => {
            const value = row[key];
            // 如果值是对象且有 text 属性，提取 text
            if (value && typeof value === 'object' && 'text' in value) {
              flatRow[key] = value.text || '';
            } else {
              flatRow[key] = value;
            }
          });
          return flatRow;
        };
        
        const materials = (recognitionData.materials || recognitionData.materialSummary || [])
          .map((item, index) => ({
            ...flattenMaterialRow(item),
            key: item.key || index.toString()
          }));
        
        setEditableData({
          ...recognitionData, // 保留所有原始数据，包括detections
          drawingNumber: recognitionData.drawingNumber || '',
          pipelineNumber: recognitionData.pipelineNumber || '',
          pageNumber: recognitionData.pageNumber || '',
          materials: materials,
          _isLightData: recognitionData._isLightData // 传递轻量级数据标记
        });
      }
    } else {
      setEditableData(null);
    }
  }, [recognitionData, currentPage]); // 添加 currentPage 作为依赖，确保翻页时更新

  // 处理基本信息变化
  const handleBasicInfoChange = (field, value) => {
    if (!editableData) return;
    
    const newData = {
      ...editableData,
      [field]: value
    };
    setEditableData(newData);
    
    // 通知父组件数据变化
    if (onDataChange) {
      onDataChange(newData);
    }
  };

  // 处理材料表数据变化
  const handleMaterialChange = (rowIndex, columnKey, value) => {
    if (!editableData) return;
    
    const newMaterials = [...editableData.materials];
    newMaterials[rowIndex] = {
      ...newMaterials[rowIndex],
      [columnKey]: value
    };
    
    const newData = {
      ...editableData,
      materials: newMaterials
    };
    setEditableData(newData);
    
    // 通知父组件数据变化
    if (onDataChange) {
      onDataChange(newData);
    }
  };

  // 添加新行
  const handleAddRow = () => {
    // 如果没有editableData，先创建一个空的数据结构，但保留原始数据
    let currentData = editableData;
    if (!currentData) {
      currentData = {
        ...recognitionData, // 保留原始数据，包括detections
        drawingNumber: recognitionData?.drawingNumber || '',
        pipelineNumber: recognitionData?.pipelineNumber || '',
        pageNumber: recognitionData?.pageNumber || '',
        materials: recognitionData?.materials || []
      };
      setEditableData(currentData);
    }
    
    // 创建新行，基于现有列结构
    const existingMaterials = currentData.materials;
    const newRow = { key: Date.now().toString() };
    
    // 如果有现有数据，复制列结构
    if (existingMaterials.length > 0) {
      Object.keys(existingMaterials[0]).forEach(key => {
        if (key !== 'key') {
          newRow[key] = '';
        }
      });
    } else {
      // 默认列结构
      newRow.column1 = '';
      newRow.column2 = '';
      newRow.column3 = '';
      newRow.column4 = '';
      newRow.column5 = '';
    }
    
    const newMaterials = [...existingMaterials, newRow];
    const newData = {
      ...currentData,
      materials: newMaterials
    };
    setEditableData(newData);
    
    // 通知父组件数据变化
    if (onDataChange) {
      onDataChange(newData);
    }
  };

  // 删除行
  const handleDeleteRow = (rowIndex) => {
    if (!editableData) return;
    
    const newMaterials = editableData.materials.filter((_, index) => index !== rowIndex);
    const newData = {
      ...editableData,
      materials: newMaterials
    };
    setEditableData(newData);
    
    // 通知父组件数据变化
    if (onDataChange) {
      onDataChange(newData);
    }
  };

  // 基本信息列配置
  const basicInfoColumns = [
    {
      title: '项目',
      dataIndex: 'label',
      key: 'label',
      width: 100,
    },
    {
      title: '内容',
      dataIndex: 'value',
      key: 'value',
      render: (text) => <Text strong>{text || '未识别'}</Text>
    }
  ];

  // 使用 useMemo 优化数据计算，避免每次渲染都重新计算
  const { materialData, scaffoldData, isScaffoldMode, isMixedMode } = useMemo(() => {
    const materials = editableData?.materials || [];
    const scaffolds = editableData?.scaffolds || editableData?.scaffoldData || [];
    const scaffoldMode = (editableData?.isScaffoldMode || editableData?.scaffoldData) && scaffolds.length > 0;
    const mixedMode = materials.length > 0 && scaffolds.length > 0;
    
    return {
      materialData: materials,
      scaffoldData: scaffolds,
      isScaffoldMode: scaffoldMode,
      isMixedMode: mixedMode
    };
  }, [editableData]);
  
  // 支架列配置（使用 useMemo 避免每次渲染都重新创建）
  const scaffoldColumns = useMemo(() => [
    {
      title: '序号',
      dataIndex: 'index',
      key: 'index',
      width: 80,
      render: (text, record, index) => index + 1
    },
    {
      title: '类型',
      dataIndex: 'itemType',
      key: 'itemType',
      width: 100,
      render: (text, record) => {
        const isValve = record.isValveInfo === true || record.itemType === 'valve';
        return (
          <Tag color={isValve ? 'red' : 'blue'} icon={isValve ? '🔧' : '🏗️'}>
            {isValve ? '阀门' : '支架'}
          </Tag>
        );
      }
    },
    {
      title: '支架/阀门信息',
      dataIndex: 'scaffoldInfo',
      key: 'scaffoldInfo',
      ellipsis: true,
      render: (text, record) => {
        const isValve = record.isValveInfo === true || record.itemType === 'valve';
        return (
          <Text style={{ color: isValve ? '#FF0000' : 'inherit', fontWeight: isValve ? 'bold' : 'normal' }}>
            {text}
            {record.mergedFrom && (
              <Text type="secondary" style={{ fontSize: '12px', marginLeft: '8px' }}>
                (由 {record.mergedFrom.join(' + ')} 合并)
              </Text>
            )}
          </Text>
        );
      }
    },
    {
      title: '页码信息',
      dataIndex: 'pageInfo',
      key: 'pageInfo',
      width: 100
    },
    {
      title: '图号',
      dataIndex: 'drawingNumber',
      key: 'drawingNumber',
      width: 150
    },
    {
      title: '位置信息',
      dataIndex: 'position',
      key: 'position',
      width: 120,
      render: (position) => position ? `(${position.x || 0}, ${position.y || 0})` : ''
    }
  ], []);

  // 动态生成材料表列配置（可编辑版本），使用 useMemo 缓存
  const materialColumns = useMemo(() => {
    if (!materialData || materialData.length === 0) {
      return [];
    }

    // 从第一行数据中提取所有字段
    const firstRow = materialData[0];
    const columns = [];

    Object.keys(firstRow).forEach(key => {
      if (key !== 'key') { // 排除antd table的key字段
        columns.push({
          title: key,
          dataIndex: key,
          key: key,
          width: 120,
          ellipsis: true,
          render: (text, record, rowIndex) => {
            // 处理嵌套格式 { text: "xxx" } 或直接字符串
            const displayValue = (text && typeof text === 'object' && 'text' in text) 
              ? text.text 
              : (text || '');
            return (
              <Input
                size="small"
                value={displayValue}
                onChange={(e) => handleMaterialChange(rowIndex, key, e.target.value)}
                style={{ border: 'none', padding: '2px 4px' }}
              />
            );
          }
        });
      }
    });

    // 添加操作列
    columns.push({
      title: '操作',
      key: 'actions',
      width: 100,
      fixed: 'right',
      render: (text, record, rowIndex) => (
        <Space size="small">
          <Button
            type="primary"
            size="small"
            icon={<PlusOutlined />}
            onClick={() => handleAddRow()}
            title="添加一行"
          />
          <Button
            type="primary"
            danger
            size="small"
            icon={<MinusOutlined />}
            onClick={() => handleDeleteRow(rowIndex)}
            title="删除当前行"
            disabled={materialData.length <= 1}
          />
        </Space>
      )
    });

    return columns;
  }, [materialData, handleMaterialChange, handleAddRow, handleDeleteRow]);

  // 根据识别状态获取状态信息（使用 useMemo 缓存）
  const statusInfo = useMemo(() => {
    switch (recognitionStatus) {
      case 'unrecognized':
        return {
          icon: <ClockCircleOutlined style={{ color: '#8c8c8c' }} />,
          text: '未识别',
          color: 'default'
        };
      case 'recognizing':
        return {
          icon: <LoadingOutlined style={{ color: '#1890ff' }} />,
          text: '识别中',
          color: 'processing'
        };
      case 'completed':
        return {
          icon: <CheckCircleOutlined style={{ color: '#52c41a' }} />,
          text: '已识别',
          color: 'success'
        };
      default:
        return {
          icon: <ClockCircleOutlined style={{ color: '#8c8c8c' }} />,
          text: '未识别',
          color: 'default'
        };
    }
  }, [recognitionStatus]);

  // 移除visible控制，面板始终显示

  return (
    <PanelContainer>
      <StyledCollapse 
        defaultActiveKey={[]} 
        ghost
        expandIconPosition="end"
        items={[
          {
            key: 'visualization',
            label: (
              <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                <Space>
                  <EyeOutlined style={{ color: '#1890ff' }} />
                  <span style={{ fontWeight: 500, fontSize: '14px' }}>可视化识别结果</span>
                  <StatusIcon className={recognitionStatus === 'recognizing' ? 'recognizing' : ''}>
                    {statusInfo.icon}
                  </StatusIcon>
                  <Tag color={statusInfo.color}>{statusInfo.text}</Tag>
                  {editableData?._isLightData && (
                    <Tag color="orange" style={{ fontSize: '11px' }}>
                      简化数据（完整数据已清理以节省内存）
                    </Tag>
                  )}
                </Space>
                <Space size="small">
                  {onClearCurrent && (
                    <Button
                      size="small"
                      icon={<DeleteOutlined />}
                      onClick={(e) => {
                        e.stopPropagation();
                        onClearCurrent(currentPage);
                      }}
                      title="清空当前页面的识别信息"
                    >
                      清空当页
                    </Button>
                  )}
                  {onClearAll && (
                    <Button
                      size="small"
                      icon={<ClearOutlined />}
                      onClick={(e) => {
                        e.stopPropagation();
                        onClearAll();
                      }}
                      title="清空所有页面的识别信息"
                    >
                      清空全部
                    </Button>
                  )}
                </Space>
              </Space>
            ),
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
                {/* 基本信息区域 */}
                <InfoSection>
                  <Space align="center" style={{ marginBottom: 12 }}>
                    <FileTextOutlined style={{ color: '#1890ff' }} />
                    <Title level={5} style={{ margin: 0 }}>基本信息</Title>
                  </Space>
                  
                  <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: '200px' }}>
                      <Text strong style={{ minWidth: '60px' }}>图号:</Text>
                      <Input
                        size="small"
                        value={editableData?.drawingNumber || ''}
                        onChange={(e) => handleBasicInfoChange('drawingNumber', e.target.value)}
                        placeholder="未识别"
                        style={{ flex: 1 }}
                      />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: '200px' }}>
                      <Text strong style={{ minWidth: '60px' }}>管线号:</Text>
                      <Input
                        size="small"
                        value={editableData?.pipelineNumber || ''}
                        onChange={(e) => handleBasicInfoChange('pipelineNumber', e.target.value)}
                        placeholder="未识别"
                        style={{ flex: 1 }}
                      />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: '150px' }}>
                      <Text strong style={{ minWidth: '50px' }}>页码:</Text>
                      <Input
                        size="small"
                        value={editableData?.pageNumber || ''}
                        onChange={(e) => handleBasicInfoChange('pageNumber', e.target.value)}
                        placeholder="未识别"
                        style={{ flex: 1 }}
                      />
                    </div>
                  </div>
                </InfoSection>

                {/* 数据表信息区域 */}
                <MaterialSection>
                  <Space align="center" style={{ marginBottom: 12 }}>
                    <TableOutlined style={{ color: '#1890ff' }} />
                    <Title level={5} style={{ margin: 0 }}>
                      {isMixedMode ? '材料表 & 支架/阀门信息（混合模式）' : 
                       isScaffoldMode ? '支架/阀门信息' : '材料表信息'}
                    </Title>
                    {isMixedMode ? (
                      <Space size="small">
                        <Tag color="blue">📋 材料: {materialData.length} 项</Tag>
                        <Tag color="purple">🏗️ 支架: {scaffoldData.filter(item => !item.isValveInfo && item.itemType !== 'valve').length}</Tag>
                        <Tag color="red">🔧 阀门: {scaffoldData.filter(item => item.isValveInfo === true || item.itemType === 'valve').length}</Tag>
                      </Space>
                    ) : isScaffoldMode ? (
                      scaffoldData.length > 0 && (
                        <Space size="small">
                          <Tag color="green">{scaffoldData.length} 项</Tag>
                          {(() => {
                            const valveCount = scaffoldData.filter(item => item.isValveInfo === true || item.itemType === 'valve').length;
                            const scaffoldCount = scaffoldData.length - valveCount;
                            return (
                              <>
                                {scaffoldCount > 0 && <Tag color="blue" icon="🏗️">支架: {scaffoldCount}</Tag>}
                                {valveCount > 0 && <Tag color="red" icon="🔧">阀门: {valveCount}</Tag>}
                              </>
                            );
                          })()}
                        </Space>
                      )
                    ) : (
                      materialData.length > 0 && (
                        <Tag color="blue">{materialData.length} 项</Tag>
                      )
                    )}
                  </Space>
                  
                  {isMixedMode ? (
                    // 混合模式：同时显示材料表和支架数据
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                      {/* 🆕 材料阀门序号提取结果 */}
                      {editableData?.valveMaterialIndexes && editableData.valveMaterialIndexes.length > 0 && (
                        <div style={{ background: '#fff7e6', padding: '12px', borderRadius: '4px', border: '1px solid #ffd666' }}>
                          <Title level={5} style={{ margin: '0 0 8px 0', color: '#d48806' }}>
                            🔧 材料表中的阀门序号
                          </Title>
                          <Space wrap>
                            {editableData.valveMaterialIndexes.map((item, index) => (
                              <Tag key={index} color="orange" style={{ fontSize: '14px', padding: '4px 12px' }}>
                                {item.index || '未识别'}
                              </Tag>
                            ))}
                          </Space>
                        </div>
                      )}
                      
                      {/* 🆕 支架纯数字提取结果 */}
                      {editableData?.scaffoldPureNumbers && editableData.scaffoldPureNumbers.length > 0 && (
                        <div style={{ background: '#e6f7ff', padding: '12px', borderRadius: '4px', border: '1px solid #91d5ff' }}>
                          <Title level={5} style={{ margin: '0 0 8px 0', color: '#096dd9' }}>
                            🔢 支架区域纯数字
                          </Title>
                          <Space wrap>
                            {editableData.scaffoldPureNumbers.map((item, index) => (
                              <Tag key={index} color="blue" style={{ fontSize: '14px', padding: '4px 12px' }}>
                                {item.pureNumber}
                                <Text type="secondary" style={{ fontSize: '12px', marginLeft: '4px' }}>
                                  ({item.original})
                                </Text>
                              </Tag>
                            ))}
                          </Space>
                        </div>
                      )}
                      
                      {/* 材料表部分 */}
                      <div>
                        <Title level={5} style={{ margin: '0 0 12px 0' }}>
                          📋 材料表信息
                        </Title>
                        {materialData.length > 0 ? (
                          <Table
                            columns={materialColumns}
                            dataSource={materialData}
                            pagination={{
                              pageSize: 3,
                              size: 'small',
                              showSizeChanger: false,
                              showQuickJumper: false
                            }}
                            size="small"
                            bordered
                            scroll={{ y: 150, x: 'max-content' }}
                            tableLayout="auto"
                          />
                        ) : (
                          <Empty 
                            image={Empty.PRESENTED_IMAGE_SIMPLE} 
                            description="暂无材料表数据" 
                            style={{ margin: '12px 0' }}
                          />
                        )}
                      </div>
                      
                      {/* 支架/阀门部分 */}
                      <div>
                        <Title level={5} style={{ margin: '0 0 12px 0' }}>
                          🏗️ 支架/阀门信息
                        </Title>
                        {scaffoldData.length > 0 ? (
                          <Table
                            columns={scaffoldColumns}
                            dataSource={scaffoldData}
                            pagination={{
                              pageSize: 3,
                              size: 'small',
                              showSizeChanger: false,
                              showQuickJumper: false
                            }}
                            size="small"
                            bordered
                            scroll={{ y: 150, x: 'max-content' }}
                            tableLayout="auto"
                          />
                        ) : (
                          <Empty 
                            image={Empty.PRESENTED_IMAGE_SIMPLE} 
                            description="暂无支架数据" 
                            style={{ margin: '12px 0' }}
                          />
                        )}
                      </div>
                    </div>
                  ) : isScaffoldMode ? (
                    // 支架数据显示
                    scaffoldData.length > 0 ? (
                      <Table
                        columns={scaffoldColumns}
                        dataSource={scaffoldData}
                        pagination={{
                          pageSize: 5,
                          size: 'small',
                          showSizeChanger: false,
                          showQuickJumper: false
                        }}
                        size="small"
                        bordered
                        scroll={{ y: 200, x: 'max-content' }}
                        tableLayout="auto"
                      />
                    ) : (
                      <Empty 
                        image={Empty.PRESENTED_IMAGE_SIMPLE} 
                        description="暂无支架数据" 
                        style={{ margin: '20px 0' }}
                      />
                    )
                  ) : (
                    // 材料表数据显示
                    materialData.length > 0 ? (
                      <Table
                        columns={materialColumns}
                        dataSource={materialData}
                        pagination={{
                          pageSize: 5,
                          size: 'small',
                          showSizeChanger: false,
                          showQuickJumper: false
                        }}
                        size="small"
                        bordered
                        scroll={{ y: 200, x: 'max-content' }}
                        tableLayout="auto"
                      />
                    ) : (
                      <Empty 
                        image={Empty.PRESENTED_IMAGE_SIMPLE} 
                        description="暂无材料表数据" 
                        style={{ margin: '20px 0' }}
                      >
                        <Button
                          type="primary"
                          icon={<PlusOutlined />}
                          onClick={handleAddRow}
                        >
                          添加材料行
                        </Button>
                      </Empty>
                    )
                  )}
                </MaterialSection>
              </div>
            )
          }
        ]}
      />
    </PanelContainer>
  );
};

// 使用 React.memo 防止不必要的重渲染
export default React.memo(VisualizationPanel, (prevProps, nextProps) => {
  // 只有当关键 props 改变时才重新渲染
  return (
    prevProps.visible === nextProps.visible &&
    prevProps.recognitionData === nextProps.recognitionData &&
    prevProps.recognitionStatus === nextProps.recognitionStatus &&
    prevProps.currentPage === nextProps.currentPage
  );
});
