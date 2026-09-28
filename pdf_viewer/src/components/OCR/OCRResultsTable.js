/**
 * OCR结果表格组件
 * 显示和管理OCR识别结果
 */

import React, { useState, useMemo } from 'react';
import { Table, Button, Space, Modal, Input, message, Popconfirm } from 'antd';
import { DownloadOutlined, ExportOutlined, EditOutlined, DeleteOutlined, SearchOutlined } from '@ant-design/icons';
import { useOCRContext } from '../../contexts/OCRContext';

const OCRResultsTable = ({ 
  visible, 
  onCancel, 
  results = [], 
  title = "OCR识别结果",
  onExport,
  onAssociate,
  isScaffoldMode = false // 新增参数：是否为支架模式
}) => {
  const { ocrLogicalRows } = useOCRContext();
  
  const [editingKey, setEditingKey] = useState('');
  const [editingValue, setEditingValue] = useState('');
  const [searchText, setSearchText] = useState('');
  const [filteredData, setFilteredData] = useState([]);

  // 检测支架模式的函数 - 移到前面定义
  const detectScaffoldMode = useMemo(() => {
    // 如果显式传入了isScaffoldMode参数
    if (isScaffoldMode) return true;
    
    // 根据识别结果自动检测：如果没有材料相关字段，可能是支架模式
    if (results && results.length > 0) {
      const firstResult = results[0];
      // 检查是否包含支架特征字段而缺少材料字段
      const hasScaffoldFields = firstResult.hasOwnProperty('支架信息') || 
                               firstResult.hasOwnProperty('scaffoldInfo') ||
                               firstResult.hasOwnProperty('页码信息');
      const lacksMaterialFields = !firstResult.hasOwnProperty('材料描述') && 
                                  !firstResult.hasOwnProperty('规格');
      return hasScaffoldFields || lacksMaterialFields;
    }
    
    return false;
  }, [isScaffoldMode, results]);

  // 使用传入的results或者context中的数据
  const tableData = useMemo(() => {
    if (results && results.length > 0) {
      // 检查是否为支架数据
      if (detectScaffoldMode) {
        // 处理支架数据
        const scaffoldData = [];
        
        results.forEach((result, resultIndex) => {
          if (result.scaffoldData && Array.isArray(result.scaffoldData)) {
            // 如果有格式化的支架数据
            result.scaffoldData.forEach((item, itemIndex) => {
              scaffoldData.push({
                key: `${resultIndex}-${itemIndex}`,
                ...item,
                页码信息: result.pageNumber || item.页码信息,
                识别页码: result.pageNumber || item.识别页码
              });
            });
          } else {
            // 创建基本的支架数据项
            scaffoldData.push({
              key: resultIndex.toString(),
              序号: resultIndex + 1,
              支架信息: result.scaffoldInfo || result.content || result.text || '支架识别内容',
              页码信息: result.pageNumber || result.pageInfo || '',
              识别页码: result.pageNumber || resultIndex + 1,
              位置信息: result.position || '支架区域'
            });
          }
        });
        
        // 对支架数据按编号排序
        const sortedScaffoldData = scaffoldData.sort((a, b) => {
          // 提取支架编号中的数字部分进行比较
          const getScaffoldNumber = (scaffoldInfo) => {
            if (!scaffoldInfo) return 0;
            const match = scaffoldInfo.match(/S-(\d+)/);
            return match ? parseInt(match[1], 10) : 0;
          };
          
          const numA = getScaffoldNumber(a.支架信息);
          const numB = getScaffoldNumber(b.支架信息);
          return numA - numB; // 从小到大排序
        });
        
        console.log('🔢 OCR结果表格 - 支架数据排序结果:', sortedScaffoldData.map(item => item.支架信息));
        
        return sortedScaffoldData;
      } else {
        // 普通数据处理
        return results.map((item, index) => ({
          key: index.toString(),
          ...item
        }));
      }
    }
    
    if (ocrLogicalRows && ocrLogicalRows.length > 0) {
      return ocrLogicalRows.map((row, index) => ({
        key: index.toString(),
        序号: row[0] || '',
        材料描述: row[1] || '',
        规格: row[2] || '',
        材料代码: row[3] || '',
        数量: row[4] || '',
        单位: row[5] || '',
        类型: row[6] || '',
        OCR页码: row[7] || '',
        计算页码: row[8] || ''
      }));
    }

    return [];
  }, [results, ocrLogicalRows, detectScaffoldMode]);

  // 搜索过滤
  const handleSearch = (value) => {
    setSearchText(value);
    if (!value) {
      setFilteredData([]);
      return;
    }

    const filtered = tableData.filter(item =>
      Object.values(item).some(val => 
        val && val.toString().toLowerCase().includes(value.toLowerCase())
      )
    );
    setFilteredData(filtered);
  };

  const displayData = searchText ? filteredData : tableData;

  // 编辑功能
  const handleEdit = (record, dataIndex) => {
    setEditingKey(`${record.key}_${dataIndex}`);
    setEditingValue(record[dataIndex] || '');
  };

  const handleSaveEdit = () => {
    // 这里可以添加保存编辑的逻辑
    message.success('修改已保存');
    setEditingKey('');
    setEditingValue('');
  };

  const handleCancelEdit = () => {
    setEditingKey('');
    setEditingValue('');
  };

  // 删除功能
  const handleDelete = (key) => {
    // 这里可以添加删除逻辑
    message.success('删除成功');
  };

  // 导出功能
  const handleExport = async () => {
    try {
      if (onExport) {
        await onExport(displayData);
      } else {
        // 默认导出逻辑
        const { ocrDataUtils } = await import('../../utils/ocrUtils');
        
        let exportData;
        if (detectScaffoldMode) {
          // 支架数据导出格式
          exportData = displayData.map(item => [
            item.序号, item.支架信息, item.页码信息, item.识别页码, item.位置信息
          ]);
        } else {
          // 材料表数据导出格式
          exportData = displayData.map(item => [
            item.序号, item.材料描述, item.规格, item.材料代码,
            item.数量, item.单位, item.类型, item.OCR页码, item.计算页码
          ]);
        }
        
        await ocrDataUtils.exportLogicalRowsToExcel(exportData);
        message.success('导出成功');
      }
    } catch (error) {
      console.error('导出失败:', error);
      message.error('导出失败');
    }
  };

  // 关联功能
  const handleAssociate = () => {
    if (onAssociate) {
      onAssociate(displayData);
    } else {
      message.info('关联功能待配置');
    }
  };


  // 支架模式的表格列配置
  const scaffoldColumns = [
    {
      title: '序号',
      dataIndex: '序号',
      key: 'sequence',
      width: 80,
      render: (text, record, index) => text || index + 1
    },
    {
      title: '支架信息',
      dataIndex: '支架信息',
      key: 'scaffoldInfo',
      width: 300,
      ellipsis: true,
      render: (text, record) => {
        // 尝试从不同的字段获取支架信息
        const scaffoldInfo = text || 
                           record.scaffoldInfo || 
                           record.content ||
                           record.text ||
                           '支架区域识别内容';
        return <span>{scaffoldInfo}</span>;
      }
    },
    {
      title: '页码信息',
      dataIndex: '页码信息',
      key: 'pageInfo',
      width: 150,
      render: (text, record) => {
        const pageInfo = text || 
                        record.pageInfo || 
                        record.pageNumber ||
                        record.OCR页码 ||
                        record.计算页码 ||
                        '页码识别内容';
        return <span>{pageInfo}</span>;
      }
    },
    {
      title: '识别页码',
      dataIndex: '识别页码',
      key: 'recognizedPage',
      width: 100,
      render: (text, record) => {
        const page = text || record.page || record.OCR页码 || '-';
        return <span>{page}</span>;
      }
    },
    {
      title: '位置信息',
      dataIndex: '位置信息',
      key: 'position',
      width: 200,
      render: (text, record) => {
        if (record.x !== undefined && record.y !== undefined) {
          return <span>x:{record.x?.toFixed(3)}, y:{record.y?.toFixed(3)}</span>;
        }
        return <span>{text || '-'}</span>;
      }
    }
  ];

  // 材料表模式的表格列配置（原有配置）
  const materialColumns = [
    {
      title: '序号',
      dataIndex: '序号',
      key: 'sequence',
      width: 80,
      render: (text, record, index) => {
        const key = `${record.key}_序号`;
        return editingKey === key ? (
          <Input
            value={editingValue}
            onChange={(e) => setEditingValue(e.target.value)}
            onPressEnter={handleSaveEdit}
            onBlur={handleSaveEdit}
            style={{ width: 60 }}
          />
        ) : (
          <span onDoubleClick={() => handleEdit(record, '序号')}>
            {text || index + 1}
          </span>
        );
      }
    },
    {
      title: '材料描述',
      dataIndex: '材料描述',
      key: 'description',
      width: 200,
      ellipsis: true,
      render: (text, record) => {
        const key = `${record.key}_材料描述`;
        return editingKey === key ? (
          <Input
            value={editingValue}
            onChange={(e) => setEditingValue(e.target.value)}
            onPressEnter={handleSaveEdit}
            onBlur={handleSaveEdit}
          />
        ) : (
          <span onDoubleClick={() => handleEdit(record, '材料描述')}>
            {text}
          </span>
        );
      }
    },
    {
      title: '规格',
      dataIndex: '规格',
      key: 'specification',
      width: 120,
      render: (text, record) => {
        const key = `${record.key}_规格`;
        return editingKey === key ? (
          <Input
            value={editingValue}
            onChange={(e) => setEditingValue(e.target.value)}
            onPressEnter={handleSaveEdit}
            onBlur={handleSaveEdit}
          />
        ) : (
          <span onDoubleClick={() => handleEdit(record, '规格')}>
            {text}
          </span>
        );
      }
    },
    {
      title: '材料代码',
      dataIndex: '材料代码',
      key: 'code',
      width: 100,
      render: (text, record) => {
        const key = `${record.key}_材料代码`;
        return editingKey === key ? (
          <Input
            value={editingValue}
            onChange={(e) => setEditingValue(e.target.value)}
            onPressEnter={handleSaveEdit}
            onBlur={handleSaveEdit}
          />
        ) : (
          <span onDoubleClick={() => handleEdit(record, '材料代码')}>
            {text}
          </span>
        );
      }
    },
    {
      title: '数量',
      dataIndex: '数量',
      key: 'quantity',
      width: 80,
      render: (text, record) => {
        const key = `${record.key}_数量`;
        return editingKey === key ? (
          <Input
            value={editingValue}
            onChange={(e) => setEditingValue(e.target.value)}
            onPressEnter={handleSaveEdit}
            onBlur={handleSaveEdit}
            style={{ width: 60 }}
          />
        ) : (
          <span onDoubleClick={() => handleEdit(record, '数量')}>
            {text}
          </span>
        );
      }
    },
    {
      title: '单位',
      dataIndex: '单位',
      key: 'unit',
      width: 80,
      render: (text, record) => {
        const key = `${record.key}_单位`;
        return editingKey === key ? (
          <Input
            value={editingValue}
            onChange={(e) => setEditingValue(e.target.value)}
            onPressEnter={handleSaveEdit}
            onBlur={handleSaveEdit}
            style={{ width: 60 }}
          />
        ) : (
          <span onDoubleClick={() => handleEdit(record, '单位')}>
            {text}
          </span>
        );
      }
    },
    {
      title: '类型',
      dataIndex: '类型',
      key: 'type',
      width: 100,
      render: (text, record) => {
        const key = `${record.key}_类型`;
        return editingKey === key ? (
          <Input
            value={editingValue}
            onChange={(e) => setEditingValue(e.target.value)}
            onPressEnter={handleSaveEdit}
            onBlur={handleSaveEdit}
          />
        ) : (
          <span onDoubleClick={() => handleEdit(record, '类型')}>
            {text}
          </span>
        );
      }
    },
    {
      title: 'OCR页码',
      dataIndex: 'OCR页码',
      key: 'ocrPage',
      width: 90,
      render: (text) => <span>{text}</span>
    },
    {
      title: '计算页码',
      dataIndex: '计算页码',
      key: 'calculatedPage',
      width: 90,
      render: (text) => <span>{text}</span>
    }
  ];

  // 根据模式选择使用的列配置
  const columns = detectScaffoldMode ? scaffoldColumns : materialColumns;

  // 如果有焊口号列，添加到表格中
  if (results && results.length > 0 && results[0].hasOwnProperty('焊口号')) {
    columns.push({
      title: '焊口号',
      dataIndex: '焊口号',
      key: 'weldSeam',
      width: 120,
      render: (text) => <span style={{ color: text ? '#52c41a' : '#999' }}>
        {text || '未关联'}
      </span>
    });
  }

  return (
    <Modal
      title={`${detectScaffoldMode ? '支架识别结果' : title} (${displayData.length}条)`}
      open={visible}
      onCancel={onCancel}
      width="90%"
      style={{ top: 20 }}
      footer={[
        <Button key="export" type="primary" icon={<DownloadOutlined />} onClick={handleExport}>
          导出Excel
        </Button>,
        onAssociate && (
          <Button key="associate" icon={<ExportOutlined />} onClick={handleAssociate}>
            关联焊口
          </Button>
        ),
        <Button key="close" onClick={onCancel}>
          关闭
        </Button>
      ].filter(Boolean)}
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        {/* 搜索栏 */}
        <Space>
          <Input.Search
            placeholder="搜索内容..."
            value={searchText}
            onChange={(e) => handleSearch(e.target.value)}
            onSearch={handleSearch}
            style={{ width: 300 }}
            prefix={<SearchOutlined />}
            allowClear
          />
          {searchText && (
            <span style={{ color: '#666' }}>
              找到 {filteredData.length} 条结果
            </span>
          )}
        </Space>

        {/* 数据表格 */}
        <Table
          columns={columns}
          dataSource={displayData}
          pagination={{
            showSizeChanger: true,
            showQuickJumper: true,
            showTotal: (total, range) => 
              `第 ${range[0]}-${range[1]} 条/共 ${total} 条`,
            pageSizeOptions: ['10', '20', '50', '100'],
            defaultPageSize: 20
          }}
          scroll={{ y: 400, x: 1200 }}
          size="small"
          bordered
          rowClassName={(record, index) => 
            index % 2 === 0 ? 'table-row-light' : 'table-row-dark'
          }
        />

        {displayData.length === 0 && (
          <div style={{ 
            textAlign: 'center', 
            padding: '40px',
            color: '#999'
          }}>
            {searchText ? '没有找到匹配的数据' : '暂无OCR识别结果'}
          </div>
        )}
      </Space>

      <style jsx>{`
        .table-row-light {
          background-color: #fafafa;
        }
        .table-row-dark {
          background-color: #ffffff;
        }
        .ant-table-tbody > tr > td {
          cursor: pointer;
        }
        .ant-table-tbody > tr:hover > td {
          background-color: #e6f7ff !important;
        }
      `}</style>
    </Modal>
  );
};

export default OCRResultsTable;
