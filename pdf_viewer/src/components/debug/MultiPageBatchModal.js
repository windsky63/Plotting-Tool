/**
 * 多页批量编号进度弹窗组件
 * 显示多页处理的实时进度
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Modal, Progress, Steps, Button, InputNumber, Space, Alert, Table, message, Select, Tooltip } from 'antd';
import { LoadingOutlined, CheckCircleOutlined, CloseCircleOutlined, ExclamationCircleOutlined, InfoCircleOutlined } from '@ant-design/icons';
import multiPageBatchService from '../../services/multiPageBatchService';
import { SortStrategy, StrategyDescriptions, getRecommendedStrategy } from '../../utils/WeldSmartSorter';

const { Step } = Steps;
const { Option } = Select;

const STEPS = [
  { key: 'vectors', title: '矢量提取', description: '提取各页矢量信息' },
  { key: 'ocr', title: '文字识别', description: 'OCR识别各页文字' },
  { key: 'welds', title: '焊点识别', description: '识别各页焊点' },
  { key: 'pipelines', title: '管道识别', description: '识别主管/支管结构' },
  { key: 'numbering', title: '编号生成', description: '生成焊点编号' }
];

export const MultiPageBatchModal = ({
  visible,
  onClose,
  onComplete,
  pdfDocument,
  pdfPath,
  totalPages,
  currentPage,
  scale,
  annotationRule
}) => {
  // 页面范围
  const [startPage, setStartPage] = useState(1);
  const [endPage, setEndPage] = useState(totalPages || 1);
  const [startNumber, setStartNumber] = useState(1);
  const [prefix, setPrefix] = useState('');
  const [sortStrategy, setSortStrategy] = useState(null); // null表示自动推荐
  
  // 处理状态
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentStep, setCurrentStep] = useState(-1);
  const [progress, setProgress] = useState({ current: 0, total: 0, step: '' });
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  // 更新默认范围
  useEffect(() => {
    if (totalPages) {
      setEndPage(totalPages);
    }
  }, [totalPages]);

  // 重置状态
  const resetState = useCallback(() => {
    setIsProcessing(false);
    setCurrentStep(-1);
    setProgress({ current: 0, total: 0, step: '' });
    setResult(null);
    setError(null);
  }, []);

  // 关闭弹窗
  const handleClose = useCallback(() => {
    if (isProcessing) {
      Modal.confirm({
        title: '确认取消',
        content: '处理正在进行中，确定要取消吗？',
        okText: '确定',
        cancelText: '继续处理',
        onOk: () => {
          resetState();
          onClose();
        }
      });
    } else {
      resetState();
      onClose();
    }
  }, [isProcessing, onClose, resetState]);

  // 获取步骤索引
  const getStepIndex = useCallback((stepKey) => {
    const index = STEPS.findIndex(s => s.key === stepKey);
    return index >= 0 ? index : -1;
  }, []);

  // 开始处理
  const handleStart = useCallback(async () => {
    if (!pdfDocument) {
      message.error('PDF文档未加载');
      return;
    }
    
    if (startPage > endPage) {
      message.error('起始页码不能大于结束页码');
      return;
    }
    
    setIsProcessing(true);
    setError(null);
    setResult(null);
    
    // 设置回调
    multiPageBatchService.setCallbacks({
      onProgress: (current, total, step) => {
        setProgress({ current, total, step });
      },
      onStepChange: (step) => {
        setCurrentStep(getStepIndex(step));
      },
      onError: (err, page) => {
        console.error(`处理错误 (第${page}页):`, err);
      }
    });
    
    try {
      // 执行完整的多页处理流程
      const processResult = await multiPageBatchService.runFullProcess(
        pdfDocument,
        pdfPath,
        startPage,
        endPage,
        {
          enableOCRFilter: true,
          startNumber: startNumber,
          prefix: prefix
        }
      );
      
      if (processResult.success) {
        setResult(processResult);
        setCurrentStep(STEPS.length); // 完成
        message.success(`处理完成! 共识别到 ${processResult.allWelds.length} 个焊点`);
      } else {
        setError(processResult.error);
        message.error(`处理失败: ${processResult.error}`);
      }
      
    } catch (err) {
      setError(err.message);
      message.error(`处理出错: ${err.message}`);
    } finally {
      setIsProcessing(false);
    }
  }, [pdfDocument, pdfPath, startPage, endPage, startNumber, prefix, getStepIndex]);

  // 生成标注
  const handleGenerateAnnotations = useCallback(() => {
    if (!result || !result.allWelds || result.allWelds.length === 0) {
      message.warning('没有焊点数据可生成标注');
      return;
    }
    
    // 转换为标注格式，传入排序策略
    const annotations = multiPageBatchService.convertWeldsToAnnotations(scale, annotationRule, sortStrategy);
    
    if (annotations.length > 0) {
      // 调用回调，传递标注数据
      if (onComplete) {
        onComplete({
          annotations,
          statistics: result.statistics,
          pageWelds: result.pageWelds,
          sortStrategy: sortStrategy
        });
      }
      
      const strategyName = sortStrategy ? StrategyDescriptions[sortStrategy]?.name : '自动推荐';
      message.success(`已生成 ${annotations.length} 个焊点标注 (排序: ${strategyName})`);
      handleClose();
    }
  }, [result, scale, annotationRule, sortStrategy, onComplete, handleClose]);

  // 获取步骤状态图标
  const getStepStatus = useCallback((index) => {
    if (error && index === currentStep) {
      return 'error';
    }
    if (index < currentStep) {
      return 'finish';
    }
    if (index === currentStep) {
      return 'process';
    }
    return 'wait';
  }, [currentStep, error]);

  // 获取步骤图标
  const getStepIcon = useCallback((index) => {
    const status = getStepStatus(index);
    if (status === 'process') {
      return <LoadingOutlined />;
    }
    if (status === 'finish') {
      return <CheckCircleOutlined style={{ color: '#52c41a' }} />;
    }
    if (status === 'error') {
      return <CloseCircleOutlined style={{ color: '#ff4d4f' }} />;
    }
    return null;
  }, [getStepStatus]);

  // 渲染统计表格
  const renderStatistics = () => {
    if (!result || !result.statistics) return null;
    
    const columns = [
      { title: '页码', dataIndex: 'pageNum', key: 'pageNum', width: 80 },
      { title: '矢量数', dataIndex: 'vectorCount', key: 'vectorCount', width: 100 },
      { title: '文字区域', dataIndex: 'textCount', key: 'textCount', width: 100 },
      { title: '焊点数', dataIndex: 'weldCount', key: 'weldCount', width: 100 }
    ];
    
    return (
      <div style={{ marginTop: 16 }}>
        <Alert
          type="success"
          message={`处理完成! 共 ${result.statistics.totalWelds} 个焊点，耗时 ${result.statistics.duration} 秒`}
          style={{ marginBottom: 16 }}
        />
        
        <Table
          dataSource={result.statistics.pageStats}
          columns={columns}
          rowKey="pageNum"
          size="small"
          pagination={false}
          scroll={{ y: 200 }}
        />
      </div>
    );
  };

  return (
    <Modal
      title="多页焊点批量编号"
      open={visible}
      onCancel={handleClose}
      width={700}
      footer={[
        <Button key="cancel" onClick={handleClose}>
          {result ? '关闭' : '取消'}
        </Button>,
        !result && (
          <Button
            key="start"
            type="primary"
            onClick={handleStart}
            loading={isProcessing}
            disabled={isProcessing}
          >
            {isProcessing ? '处理中...' : '开始处理'}
          </Button>
        ),
        result && result.success && (
          <Button
            key="generate"
            type="primary"
            onClick={handleGenerateAnnotations}
          >
            生成标注 ({result.allWelds.length}个)
          </Button>
        )
      ].filter(Boolean)}
      maskClosable={false}
    >
      {/* 配置区域 */}
      {!isProcessing && !result && (
        <div style={{ marginBottom: 24 }}>
          <Alert
            type="info"
            message="多页批量处理流程"
            description="将依次执行：多页矢量提取 → 多页文字识别 → 多页焊点识别 → 批量编号生成"
            showIcon
            style={{ marginBottom: 16 }}
          />
          
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <Space>
              <span>页面范围:</span>
              <InputNumber
                min={1}
                max={totalPages}
                value={startPage}
                onChange={setStartPage}
                style={{ width: 80 }}
                addonBefore="从"
              />
              <span>到</span>
              <InputNumber
                min={1}
                max={totalPages}
                value={endPage}
                onChange={setEndPage}
                style={{ width: 80 }}
                addonAfter="页"
              />
              <span style={{ color: '#888', marginLeft: 8 }}>
                (共 {totalPages} 页)
              </span>
            </Space>
            
            <Space>
              <span>起始编号:</span>
              <InputNumber
                min={1}
                value={startNumber}
                onChange={setStartNumber}
                style={{ width: 100 }}
              />
            </Space>
            
            <Space style={{ width: '100%' }}>
              <span>排序策略:</span>
              <Select
                value={sortStrategy}
                onChange={setSortStrategy}
                style={{ width: 280 }}
                placeholder="依次选择最近的焊点（推荐）"
              >
                <Option value={null}>
                  <Space>
                    <span>🤖 自动推荐（最近邻遍历）</span>
                    <Tooltip title="从起点开始，依次选择距离最近的焊点进行编号">
                      <InfoCircleOutlined style={{ color: '#1890ff' }} />
                    </Tooltip>
                  </Space>
                </Option>
                {Object.entries(StrategyDescriptions).map(([key, desc]) => (
                  <Option key={key} value={key} disabled={desc.requiresPipeline && !result?.pageWelds}>
                    <Space>
                      <span>{desc.icon}</span>
                      <span>{desc.name}</span>
                      {desc.recommended && <span style={{ color: '#52c41a', fontSize: 12 }}>推荐</span>}
                    </Space>
                  </Option>
                ))}
              </Select>
            </Space>
            
            {sortStrategy && StrategyDescriptions[sortStrategy] && (
              <Alert
                message={StrategyDescriptions[sortStrategy].description}
                type="info"
                showIcon
                style={{ fontSize: 12 }}
              />
            )}
          </Space>
        </div>
      )}
      
      {/* 进度显示 */}
      {(isProcessing || result) && (
        <div>
          <Steps current={currentStep} size="small" style={{ marginBottom: 24 }}>
            {STEPS.map((step, index) => (
              <Step
                key={step.key}
                title={step.title}
                description={step.description}
                icon={getStepIcon(index)}
                status={getStepStatus(index)}
              />
            ))}
          </Steps>
          
          {isProcessing && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ marginBottom: 8, color: '#666' }}>
                {progress.step}
              </div>
              <Progress
                percent={Math.round((progress.current / progress.total) * 100) || 0}
                status={error ? 'exception' : 'active'}
                strokeColor={{
                  '0%': '#108ee9',
                  '100%': '#87d068',
                }}
              />
              <div style={{ marginTop: 4, fontSize: 12, color: '#999' }}>
                {progress.current} / {progress.total}
              </div>
            </div>
          )}
          
          {error && (
            <Alert
              type="error"
              message="处理失败"
              description={error}
              showIcon
              icon={<ExclamationCircleOutlined />}
              style={{ marginTop: 16 }}
            />
          )}
          
          {renderStatistics()}
        </div>
      )}
    </Modal>
  );
};

export default MultiPageBatchModal;

