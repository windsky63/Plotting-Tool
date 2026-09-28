import React, { useMemo, useState } from 'react';
import styled from 'styled-components';
import { Button, Drawer, Input, List, message, Space, Typography } from 'antd';
import { CustomerServiceOutlined, SendOutlined } from '@ant-design/icons';

const FloatingButton = styled(Button)`
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 1600;
  box-shadow: 0 8px 20px rgba(24, 144, 255, 0.28);
`;

const ToolbarHelpButton = styled(Button)`
  background: #f0f7ff;
  border-color: #91caff;
  color: #0958d9;
`;

const ChatBody = styled.div`
  display: flex;
  flex-direction: column;
  height: calc(100% - 96px);
  min-height: 360px;
`;

const MessageList = styled.div`
  flex: 1;
  overflow-y: auto;
  padding-right: 4px;
`;

const MessageBubble = styled.div`
  max-width: 92%;
  margin-left: ${props => (props.$role === 'user' ? 'auto' : '0')};
  margin-bottom: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: ${props => (props.$role === 'user' ? '#1677ff' : '#f5f5f5')};
  color: ${props => (props.$role === 'user' ? '#fff' : '#1f1f1f')};
  white-space: pre-wrap;
  line-height: 1.6;
`;

const InputArea = styled.div`
  padding-top: 12px;
  border-top: 1px solid #f0f0f0;
`;

const examples = [
  '软件有哪些快捷键？',
  '右键无法移动图纸怎么办？',
  '管线号、图号、页码识别不出来怎么办？',
  '怎么复制焊口到另一页？',
];

const SUPPORT_HEALTH_TIMEOUT_MS = 3000;
const SUPPORT_REQUEST_TIMEOUT_MS = 60000;
const LAN_SUPPORT_URL = 'http://192.168.32.61:8788';

const normalizeUrl = (url) => String(url || '').trim().replace(/\/+$/, '');

async function resolveSupportUrls() {
  const urls = [];
  const addUrl = (url) => {
    const normalized = normalizeUrl(url);
    if (normalized && !urls.includes(normalized)) {
      urls.push(normalized);
    }
  };

  // Prefer the same-origin production proxy. Public and cross-network clients
  // cannot reliably access the workstation's private 8788 address directly.
  addUrl(`${window.location.origin}/support-proxy`);

  try {
    const response = await fetch('./app-config.json', { cache: 'no-store' });
    if (response.ok) {
      const config = await response.json();
      if (config.support_chat_url) {
        addUrl(config.support_chat_url);
      }
    }
  } catch (error) {
    console.warn('读取帮助助手配置失败，使用默认帮助服务地址', error);
  }

  const host = window.location?.hostname || '127.0.0.1';
  addUrl(`http://${host}:8788`);
  addUrl(LAN_SUPPORT_URL);
  return urls;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function checkSupportHealth(baseUrl) {
  const response = await fetchWithTimeout(`${baseUrl}/health`, {}, SUPPORT_HEALTH_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error('帮助助手健康检查失败');
  }
  const data = await response.json().catch(() => ({}));
  if (data.ready === false) {
    throw new Error(data.error || '帮助助手未就绪');
  }
}

async function requestSupportAnswer(baseUrl, question) {
  const response = await fetchWithTimeout(`${baseUrl}/api/support-chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    }, SUPPORT_REQUEST_TIMEOUT_MS);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.detail || data.message || '帮助助手请求失败');
  }
  return data;
}

const SupportAssistant = ({ variant = 'floating' }) => {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content: '你好，我可以回答落图网页端的使用方法、快捷键、标注、OCR 区域识别和常见故障处理问题。',
    },
  ]);

  const canSend = useMemo(() => question.trim().length > 0 && !loading, [question, loading]);

  const sendQuestion = async (text = question) => {
    const currentQuestion = text.trim();
    if (!currentQuestion || loading) return;

    setQuestion('');
    setLoading(true);
    setMessages(prev => [...prev, { role: 'user', content: currentQuestion }]);

    try {
      const supportUrls = await resolveSupportUrls();
      let data = null;
      let lastError = null;

      for (const baseUrl of supportUrls) {
        try {
          await checkSupportHealth(baseUrl);
          data = await requestSupportAnswer(baseUrl, currentQuestion);
          break;
        } catch (error) {
          lastError = error;
          console.warn(`帮助助手地址不可用: ${baseUrl}`, error);
        }
      }

      if (!data) {
        throw lastError || new Error('帮助助手请求失败');
      }

      setMessages(prev => [...prev, {
        role: 'assistant',
        content: data.answer || '没有获得有效回复，请稍后重试。',
      }]);
    } catch (error) {
      console.error('帮助助手请求失败:', error);
      message.error(error.message || '帮助助手请求失败');
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `帮助助手请求失败：${error.message || '未知错误'}。请检查帮助服务或 DeepSeek 上游状态；该问题不等同于 OCR 服务异常。`,
      }]);
    } finally {
      setLoading(false);
    }
  };

  const trigger = variant === 'toolbar' ? (
    <ToolbarHelpButton
      icon={<CustomerServiceOutlined />}
      onClick={() => setOpen(true)}
    >
      帮助
    </ToolbarHelpButton>
  ) : (
    <FloatingButton
      type="primary"
      shape="round"
      icon={<CustomerServiceOutlined />}
      onClick={() => setOpen(true)}
    >
      帮助
    </FloatingButton>
  );

  return (
    <>
      {trigger}
      <Drawer
        title="落图帮助助手"
        placement="right"
        width={420}
        open={open}
        onClose={() => setOpen(false)}
        destroyOnClose={false}
      >
        <ChatBody>
          <MessageList>
            <List
              dataSource={messages}
              renderItem={item => (
                <MessageBubble $role={item.role}>
                  {item.content}
                </MessageBubble>
              )}
            />
          </MessageList>
          <InputArea>
            <Typography.Text type="secondary">可以这样问：</Typography.Text>
            <Space wrap style={{ margin: '8px 0 12px' }}>
              {examples.map(item => (
                <Button key={item} size="small" onClick={() => sendQuestion(item)} disabled={loading}>
                  {item}
                </Button>
              ))}
            </Space>
            <Input.TextArea
              value={question}
              onChange={event => setQuestion(event.target.value)}
              placeholder="请输入你的问题"
              autoSize={{ minRows: 2, maxRows: 4 }}
              onPressEnter={event => {
                if (!event.shiftKey) {
                  event.preventDefault();
                  sendQuestion();
                }
              }}
            />
            <Button
              type="primary"
              icon={<SendOutlined />}
              loading={loading}
              disabled={!canSend}
              onClick={() => sendQuestion()}
              style={{ marginTop: 10, width: '100%' }}
            >
              发送
            </Button>
          </InputArea>
        </ChatBody>
      </Drawer>
    </>
  );
};

export default SupportAssistant;
