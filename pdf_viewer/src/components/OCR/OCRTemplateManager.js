/**
 * OCR模板管理器组件
 * 处理OCR模板的保存、加载和管理
 */

import React, { useState, useEffect } from 'react';
import { Modal, Button, Space, List, Input, message, Popconfirm } from 'antd';
import { SaveOutlined, UploadOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { useOCRContext } from '../../contexts/OCRContext';

const OCRTemplateManager = ({ visible, onCancel }) => {
  const {
    globalOcrRegion,
    ocrState,
    setGlobalOcrRegion,
    setOcrState
  } = useOCRContext();

  const [templates, setTemplates] = useState([]);
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [templateName, setTemplateName] = useState('');
  const [showSaveDialog, setShowSaveDialog] = useState(false);

  // 加载已保存的模板
  useEffect(() => {
    loadTemplates();
  }, []);

  const loadTemplates = () => {
    try {
      const savedTemplates = localStorage.getItem('ocrTemplates');
      if (savedTemplates) {
        setTemplates(JSON.parse(savedTemplates));
      }
    } catch (error) {
      console.error('加载模板失败:', error);
      message.error('加载模板失败');
    }
  };

  const saveTemplates = (newTemplates) => {
    try {
      localStorage.setItem('ocrTemplates', JSON.stringify(newTemplates));
      setTemplates(newTemplates);
    } catch (error) {
      console.error('保存模板失败:', error);
      message.error('保存模板失败');
    }
  };

  const handleSaveTemplate = () => {
    if (!globalOcrRegion) {
      message.warning('请先选择OCR区域');
      return;
    }

    setShowSaveDialog(true);
  };

  const confirmSaveTemplate = () => {
    if (!templateName.trim()) {
      message.warning('请输入模板名称');
      return;
    }

    const template = {
      id: Date.now().toString(),
      name: templateName.trim(),
      createdAt: new Date().toISOString(),
      data: {
        materialArea: {
          ...globalOcrRegion,
          splitLines: ocrState.splitLines || []
        },
        pipelineArea: null,
        drawingNumberArea: null,
        pageNumberArea: null,
        scaffoldArea: null
      }
    };

    const newTemplates = [...templates, template];
    saveTemplates(newTemplates);
    
    setShowSaveDialog(false);
    setTemplateName('');
    message.success('模板保存成功');
  };

  const handleLoadTemplate = (template) => {
    try {
      const templateData = template.data;
      
      // 检查是否至少有一个区域
      const hasAnyArea = templateData.materialArea || 
                        templateData.pipelineArea || 
                        templateData.pipeClassArea ||
                        templateData.drawingNumberArea || 
                        templateData.pageNumberArea || 
                        templateData.scaffoldArea;
      
      if (!hasAnyArea) {
        message.error('模板格式错误：模板中没有任何区域数据');
        return;
      }

      // 应用材料表模板（如果存在）
      if (templateData.materialArea) {
        setGlobalOcrRegion(templateData.materialArea);
        setOcrState(prev => ({
          ...prev,
          splitLines: templateData.materialArea.splitLines || []
        }));
      } else {
        // 如果没有材料表区域，清空相关状态
        setGlobalOcrRegion(null);
        setOcrState(prev => ({
          ...prev,
          splitLines: []
        }));
      }

      onCancel();
    } catch (error) {
      console.error('加载模板失败:', error);
      message.error('加载模板失败');
    }
  };

  const handleDeleteTemplate = (templateId) => {
    const newTemplates = templates.filter(t => t.id !== templateId);
    saveTemplates(newTemplates);
  };

  const handleEditTemplate = (template) => {
    setEditingTemplate(template);
    setTemplateName(template.name);
  };

  const confirmEditTemplate = () => {
    if (!templateName.trim()) {
      message.warning('请输入模板名称');
      return;
    }

    const newTemplates = templates.map(t => 
      t.id === editingTemplate.id 
        ? { ...t, name: templateName.trim(), updatedAt: new Date().toISOString() }
        : t
    );
    
    saveTemplates(newTemplates);
    setEditingTemplate(null);
    setTemplateName('');
  };

  const handleExportTemplate = (template) => {
    try {
      const dataStr = JSON.stringify(template.data, null, 2);
      const dataBlob = new Blob([dataStr], { type: 'application/json' });
      
      const link = document.createElement('a');
      link.href = URL.createObjectURL(dataBlob);
      link.download = `${template.name}_template.json`;
      link.click();
      
      message.success('模板导出成功');
    } catch (error) {
      console.error('导出模板失败:', error);
      message.error('导出模板失败');
    }
  };

  const handleImportTemplate = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const templateData = JSON.parse(e.target.result);
          
          // 验证模板格式
          if (!templateData.materialArea) {
            message.error('模板格式错误：缺少材料表区域');
            return;
          }

          // 创建新模板
          const template = {
            id: Date.now().toString(),
            name: `导入_${file.name.replace('.json', '')}`,
            createdAt: new Date().toISOString(),
            data: templateData
          };

          const newTemplates = [...templates, template];
          saveTemplates(newTemplates);
          message.success('模板导入成功');
        } catch (error) {
          console.error('导入模板失败:', error);
          message.error('模板文件格式错误');
        }
      };
      
      reader.readAsText(file);
    };
    
    input.click();
  };

  const renderTemplateItem = (template) => {
    const isEditing = editingTemplate && editingTemplate.id === template.id;
    
    return (
      <List.Item
        key={template.id}
        actions={[
          <Button
            key="load"
            type="primary"
            size="small"
            onClick={() => handleLoadTemplate(template)}
          >
            加载
          </Button>,
          <Button
            key="edit"
            size="small"
            icon={<EditOutlined />}
            onClick={() => handleEditTemplate(template)}
          />,
          <Button
            key="export"
            size="small"
            onClick={() => handleExportTemplate(template)}
          >
            导出
          </Button>,
          <Popconfirm
            key="delete"
            title="确定删除这个模板吗？"
            onConfirm={() => handleDeleteTemplate(template.id)}
            okText="确定"
            cancelText="取消"
          >
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
            />
          </Popconfirm>
        ]}
      >
        <List.Item.Meta
          title={
            isEditing ? (
              <Space>
                <Input
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  onPressEnter={confirmEditTemplate}
                  style={{ width: 200 }}
                />
                <Button size="small" type="primary" onClick={confirmEditTemplate}>
                  确定
                </Button>
                <Button size="small" onClick={() => {
                  setEditingTemplate(null);
                  setTemplateName('');
                }}>
                  取消
                </Button>
              </Space>
            ) : (
              template.name
            )
          }
          description={
            <div>
              <div>创建时间: {new Date(template.createdAt).toLocaleString()}</div>
              {template.updatedAt && (
                <div>更新时间: {new Date(template.updatedAt).toLocaleString()}</div>
              )}
            </div>
          }
        />
      </List.Item>
    );
  };

  return (
    <>
      <Modal
        title="OCR模板管理"
        open={visible}
        onCancel={onCancel}
        width={800}
        footer={[
          <Button key="save" icon={<SaveOutlined />} onClick={handleSaveTemplate}>
            保存当前模板
          </Button>,
          <Button key="import" icon={<UploadOutlined />} onClick={handleImportTemplate}>
            导入模板
          </Button>,
          <Button key="close" onClick={onCancel}>
            关闭
          </Button>
        ]}
      >
        <div style={{ maxHeight: 400, overflow: 'auto' }}>
          {templates.length === 0 ? (
            <div style={{ 
              textAlign: 'center', 
              padding: '40px',
              color: '#999'
            }}>
              <p>暂无已保存的模板</p>
              <p>请先在PDF页面上选择OCR区域，然后保存为模板</p>
            </div>
          ) : (
            <List
              dataSource={templates}
              renderItem={renderTemplateItem}
              split={true}
            />
          )}
        </div>
      </Modal>

      <Modal
        title="保存模板"
        open={showSaveDialog}
        onOk={confirmSaveTemplate}
        onCancel={() => {
          setShowSaveDialog(false);
          setTemplateName('');
        }}
        okText="保存"
        cancelText="取消"
      >
        <div>
          <p>请输入模板名称：</p>
          <Input
            value={templateName}
            onChange={(e) => setTemplateName(e.target.value)}
            placeholder="请输入模板名称"
            onPressEnter={confirmSaveTemplate}
            autoFocus
          />
        </div>
      </Modal>
    </>
  );
};

export default OCRTemplateManager;
