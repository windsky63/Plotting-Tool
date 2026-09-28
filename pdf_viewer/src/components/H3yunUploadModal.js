import React, { useState } from 'react';
import { Modal, Form, Input, InputNumber, message, Select, Button } from 'antd';
import { CloudUploadOutlined, QuestionCircleOutlined } from '@ant-design/icons';

const { Option } = Select;

const H3yunUploadModal = ({ visible, onClose, stats, annotations, pdfFileName }) => {
  const [form] = Form.useForm();
  const [uploading, setUploading] = useState(false);

  // 显示配置帮助
  const showConfigHelp = () => {
    Modal.info({
      title: '氚云配置说明',
      width: 600,
      content: (
        <div>
          <p><strong>如果上传失败，请检查以下配置：</strong></p>
          <ol style={{ lineHeight: '1.8' }}>
            <li>
              <strong>创建配置文件</strong>
              <pre style={{ background: '#f5f5f5', padding: '8px', marginTop: '4px' }}>
                src/config/h3yun.config.js
              </pre>
            </li>
            <li>
              <strong>填写氚云配置</strong>
              <ul>
                <li>appCode - 应用编码</li>
                <li>engineCode - 引擎编码</li>
              </ul>
              <div style={{ marginTop: '4px', fontSize: '12px', color: '#666' }}>
                💡 在氚云管理后台 &gt; 应用设置中获取
              </div>
            </li>
            <li>
              <strong>重启应用</strong>
              <pre style={{ background: '#f5f5f5', padding: '8px', marginTop: '4px' }}>
                npm start
              </pre>
            </li>
          </ol>
          <div style={{ marginTop: '16px', padding: '12px', background: '#fff7e6', border: '1px solid #ffd591', borderRadius: '4px' }}>
            <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>📚 详细说明文档：</div>
            <ul style={{ margin: 0, paddingLeft: '20px' }}>
              <li>氚云上传功能说明.md</li>
              <li>氚云配置故障排除.md</li>
              <li>氚云字段映射表.md</li>
            </ul>
          </div>
        </div>
      ),
      okText: '我知道了'
    });
  };

  // 计算准确率
  const { batchAdded = 0, deleted = 0, modified = 0, manuallyAdded = 0 } = stats || {};
  const weldCount = annotations?.length || 0;
  
  // 实际焊点数量
  const actualWeldCount = batchAdded + manuallyAdded - deleted;
  
  // 焊点识别准确率：(批量增加 - 删除的标号) / 实际焊点数量
  // 注意：氚云百分比控件需要传入 0-1 之间的小数（如 0.95 表示 95%）
  const detectionAccuracy = actualWeldCount > 0 
    ? parseFloat(((batchAdded - deleted) / actualWeldCount).toFixed(4))
    : 0;
  
  // 编号准确率：(批量增加 - 修改的标号) / 批量增加
  // 注意：氚云百分比控件需要传入 0-1 之间的小数（如 0.95 表示 95%）
  const numberingAccuracy = batchAdded > 0 
    ? parseFloat(((batchAdded - modified) / batchAdded).toFixed(4))
    : 0;
  
  // 用于界面显示的百分比格式
  const detectionAccuracyDisplay = (detectionAccuracy * 100).toFixed(1) + '%';
  const numberingAccuracyDisplay = (numberingAccuracy * 100).toFixed(1) + '%';

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setUploading(true);

      // 准备上传数据
      const uploadData = {
        userName: values.userName,
        personType: values.personType,
        projectName: values.projectName,
        processedPages: values.processedPages,
        workHours: values.workHours,
        weldCount: weldCount,
        batchAdded: batchAdded,
        manuallyAdded: manuallyAdded,
        modified: modified,
        deleted: deleted,
        detectionAccuracy: detectionAccuracy,
        numberingAccuracy: numberingAccuracy
      };

      console.log('📤 开始上传数据到氚云...');
      console.log('📊 统计数据:', { batchAdded, manuallyAdded, modified, deleted });
      console.log('📊 实际焊点数量:', actualWeldCount);
      console.log('📊 准确率（纯数字）:', { detectionAccuracy, numberingAccuracy });
      console.log('📊 准确率（显示）:', { detectionAccuracyDisplay, numberingAccuracyDisplay });
      console.log('📦 完整上传数据:', uploadData);

      // 导入氚云服务
      const { h3yunService } = await import('../services/h3yunService');
      
      // 上传到氚云
      await h3yunService.uploadStats(uploadData);
      
      message.success('✅ 数据已成功上传到氚云', 3);
      form.resetFields();
      onClose();
    } catch (error) {
      console.error('❌ 上传失败:', error);
      
      // 显示详细的错误信息
      const errorLines = error.message.split('\n');
      const errorContent = (
        <div style={{ maxHeight: '300px', overflow: 'auto' }}>
          {errorLines.map((line, index) => (
            <div key={index} style={{ marginBottom: '4px' }}>
              {line}
            </div>
          ))}
        </div>
      );
      
      message.error({
        content: errorContent,
        duration: 8,
        style: { whiteSpace: 'pre-wrap' }
      });
    } finally {
      setUploading(false);
    }
  };

  return (
    <Modal
      title={
        <span>
          <CloudUploadOutlined style={{ marginRight: 8 }} />
          上传数据到氚云
        </span>
      }
      open={visible}
      onCancel={onClose}
      onOk={handleSubmit}
      confirmLoading={uploading}
      width={600}
      okText="上传"
      cancelText="取消"
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          personType: '数据组成员',
          processedPages: 1
        }}
      >
        <Form.Item
          label="姓名"
          name="userName"
          rules={[{ required: true, message: '请输入姓名' }]}
        >
          <Input placeholder="请输入姓名" />
        </Form.Item>

        <Form.Item
          label="人员类型"
          name="personType"
        >
          <Select>
            <Option value="数据组成员">数据组成员</Option>
            <Option value="项目经理">项目经理</Option>
            <Option value="技术负责人">技术负责人</Option>
          </Select>
        </Form.Item>

        <Form.Item
          label="项目名称"
          name="projectName"
          rules={[{ required: true, message: '请输入项目名称' }]}
        >
          <Input placeholder="请输入项目名称" />
        </Form.Item>

        <Form.Item
          label="处理张数"
          name="processedPages"
          rules={[{ required: true, message: '请输入处理张数' }]}
        >
          <InputNumber min={1} style={{ width: '100%' }} />
        </Form.Item>

        <Form.Item
          label="工时（小时）"
          name="workHours"
          rules={[{ required: true, message: '请输入工时' }]}
        >
          <InputNumber min={0} step={0.5} style={{ width: '100%' }} />
        </Form.Item>

        {/* 自动统计数据展示 */}
        <div style={{ 
          background: '#f5f5f5', 
          padding: '12px', 
          borderRadius: '4px',
          marginBottom: '16px'
        }}>
          <div style={{ fontWeight: 'bold', marginBottom: 8 }}>自动统计数据：</div>
          <div style={{ fontSize: '13px', lineHeight: '24px' }}>
            <div>📄 当前文件：{pdfFileName || '未命名'}</div>
            <div>🔢 焊口数量：{weldCount} 个</div>
            <div>➕ 批量编号：{batchAdded} 个</div>
            <div>✋ 手动添加：{manuallyAdded} 个</div>
            <div>✏️ 修改数量：{modified} 个</div>
            <div>🗑️ 删除数量：{deleted} 个</div>
            <div>✅ 识别准确率：{detectionAccuracyDisplay}</div>
            <div>🎯 编号准确率：{numberingAccuracyDisplay}</div>
          </div>
        </div>

        <div style={{ 
          background: '#fff7e6', 
          border: '1px solid #ffd591',
          padding: '8px 12px', 
          borderRadius: '4px',
          fontSize: '12px',
          color: '#ad6800'
        }}>
          <div style={{ fontWeight: 'bold', marginBottom: 4 }}>📌 说明</div>
          <div>• 数据来源将自动设置为"焊口识别与编号"</div>
          <div>• 时间将自动记录为当前日期</div>
          <div>• 上传前请确认所有数据准确无误</div>
          <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px dashed #ffd591' }}>
            <Button 
              size="small" 
              icon={<QuestionCircleOutlined />}
              onClick={showConfigHelp}
              style={{ fontSize: '12px' }}
            >
              上传失败？查看配置说明
            </Button>
          </div>
        </div>
      </Form>
    </Modal>
  );
};

export default H3yunUploadModal;

