import React, { useState } from 'react';
import { Modal, Button, Table, Typography, Tag } from 'antd';
import { QuestionCircleOutlined } from '@ant-design/icons';
import styled from 'styled-components';

const { Title, Text } = Typography;

const HelpButton = styled(Button)`
  position: fixed;
  top: 80px;
  left: 20px;
  z-index: 1000;
  border-radius: 50%;
  width: 50px;
  height: 50px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  
  &:hover {
    transform: scale(1.05);
    transition: transform 0.2s;
  }
`;

const ToolbarHelpButton = styled(Button)`
  && {
    height: var(--toolbar-control-height, 32px);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
`;

const KeyboardKey = styled(Tag)`
  font-family: 'Courier New', monospace;
  font-weight: bold;
  padding: 2px 8px;
  margin: 2px;
  background: #f5f5f5;
  border: 1px solid #d9d9d9;
  border-radius: 4px;
  color: #333;
`;

const ShortcutHelp = ({ variant = 'floating' }) => {
  const [visible, setVisible] = useState(false);

  const shortcuts = [
    {
      key: '1',
      category: '模式切换',
      shortcut: ['A'],
      description: '进入标注模式',
    },
    {
      key: '2',
      category: '模式切换',
      shortcut: ['D'],
      description: '进入管段号模式',
    },
    {
      key: '3',
      category: '标注编辑',
      shortcut: ['E'],
      description: '标注模式下编辑当前页最近的焊口标注',
    },
    {
      key: '4',
      category: '标注框调整',
      shortcut: ['Q'],
      description: '在菱形框与圆形框之间切换',
    },
    {
      key: '5',
      category: '标注框调整',
      shortcut: ['W'],
      description: '切换现场焊缝与车间焊缝',
    },
    {
      key: '6',
      category: '界面控制',
      shortcut: ['Space'],
      description: '控制标注管理栏显示/隐藏',
    },
    {
      key: '7',
      category: '文件操作',
      shortcut: ['Ctrl', 'S'],
      description: '保存到原文件',
    },
    {
      key: '8',
      category: '撤销操作',
      shortcut: ['Ctrl', 'Z'],
      description: '撤销上一步操作',
    },
  ];

  shortcuts.push({
    key: '9',
    category: '编号操作',
    shortcut: ['Alt', 'R'],
    description: '重置当前激活规则的焊点编号（可撤销）',
  });

  const columns = [
    {
      title: '功能分类',
      dataIndex: 'category',
      key: 'category',
      width: 120,
      render: (category) => (
        <Tag color="blue">{category}</Tag>
      ),
    },
    {
      title: '快捷键',
      dataIndex: 'shortcut',
      key: 'shortcut',
      width: 200,
      render: (shortcut) => (
        <div>
          {shortcut.map((key, index) => (
            <span key={index}>
              <KeyboardKey>{key}</KeyboardKey>
              {index < shortcut.length - 1 && <span style={{ margin: '0 4px' }}>+</span>}
            </span>
          ))}
        </div>
      ),
    },
    {
      title: '功能描述',
      dataIndex: 'description',
      key: 'description',
      render: (description) => (
        <Text>{description}</Text>
      ),
    },
  ];

  return (
    <>
      {variant === 'toolbar' ? (
        <ToolbarHelpButton
          icon={<QuestionCircleOutlined />}
          onClick={() => setVisible(true)}
          title="查看快捷键帮助"
        >
          快捷键帮助
        </ToolbarHelpButton>
      ) : (
        <HelpButton
          type="primary"
          icon={<QuestionCircleOutlined />}
          onClick={() => setVisible(true)}
          title="查看快捷键帮助"
        />
      )}
      
      <Modal
        title={
          <div style={{ textAlign: 'center' }}>
            <Title level={3} style={{ margin: 0 }}>
              ⌨️ 快捷键帮助
            </Title>
          </div>
        }
        open={visible}
        onCancel={() => setVisible(false)}
        footer={[
          <Button key="close" type="primary" onClick={() => setVisible(false)}>
            关闭
          </Button>
        ]}
        width={800}
        centered
      >
        <div style={{ marginBottom: 16 }}>
          <Text type="secondary">
            以下是PDF查看器中的主要快捷键。在输入框中输入时，快捷键会被暂时禁用。
          </Text>
          <br />
          <Text type="secondary" style={{ color: '#52c41a', fontWeight: 'bold', marginTop: 8, display: 'block' }}>
            ✓ 所有快捷键均不区分大小写，大写锁定(CapsLock)开启时也可正常使用。
          </Text>
        </div>
        
        <Table
          dataSource={shortcuts}
          columns={columns}
          pagination={false}
          size="small"
          bordered
          rowKey="key"
          style={{ marginTop: 16 }}
        />
        
        <div style={{ marginTop: 16, padding: 12, background: '#f6f8fa', borderRadius: 6 }}>
          <Text strong>💡 提示：</Text>
          <ul style={{ margin: '8px 0', paddingLeft: 20 }}>
            <li><strong>快捷键不区分大小写</strong>，无论CapsLock是否开启都能正常使用</li>
            <li>快捷键在输入框获得焦点时会自动禁用，避免冲突</li>
            <li>移动/编辑标注框需退出标注模式或管段号模式</li>
            <li>使用A键和D键快速切换工作模式</li>
            <li>使用Q键和W键调整不同类型的标注框</li>
            <li>空格键可以快速显示/隐藏标注管理栏</li>
          </ul>
        </div>
      </Modal>
    </>
  );
};

export default ShortcutHelp;
