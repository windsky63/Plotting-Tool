import React, {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {Button, Modal, message} from 'antd';
import styled from 'styled-components';
import {getDraftSaveHealth} from '../utils/draftSaveHealth';

const Container = styled.div`
  position: fixed;
  top: var(--toolbar-height, 56px);
  left: 0; right: 0; z-index: 5500;
  background: #f8fafc; border-bottom: 1px solid #dce4ed;
  box-shadow: 0 2px 6px rgba(15, 23, 42, 0.04);
  font-size: 13px; color: #334155;
  .draft-status-row {display:flex; gap:8px 20px; align-items:center; flex-wrap:wrap; padding:9px 16px; min-height:48px; box-sizing:border-box;}
  .draft-status-title {font-weight:600; color:#334155; white-space:nowrap;}
  .draft-status-actions {display:flex; gap:8px; margin-left:auto;}
  .draft-status-actions .ant-btn {height:30px; border-radius:7px; font-size:13px;}
  .draft-save-warning {padding:12px 16px; background:#fff7e6; border-top:1px solid #ffd591; color:#873800; line-height:1.7;}
  .draft-save-warning.danger {background:#fff1f0; border-color:#ffa39e; color:#a8071a;}
  .draft-warning-actions {display:flex; flex-wrap:wrap; gap:8px; margin-top:8px;}
  .draft-save-summary {display:flex; flex-wrap:wrap; gap:6px 10px; flex:1;}
  .draft-channel {display:inline-flex; align-items:center; gap:7px; padding:4px 10px; border-radius:6px; background:#eef2f6; color:#526176; line-height:20px;}
  .draft-channel::before {content:''; width:6px; height:6px; border-radius:50%; background:currentColor; flex-shrink:0;}
  .draft-channel.saved {background:#eaf6ef; color:#257449;}
  .draft-channel.pending {background:#eaf2ff; color:#245eaa;}
  .draft-channel.error {background:#fff0d8; color:#995500; font-weight:600;}
  .draft-channel.danger {background:#ffe9e7; color:#b42318;}
  @media(max-width:600px) {
    .draft-status-row {padding:8px 10px; gap:8px;}
    .draft-save-summary {order:3; flex-basis:100%;}
    .draft-channel {padding:3px 8px; font-size:12px;}
    .draft-save-warning {padding:8px; max-height:32vh; overflow:auto;}
  }
`;
const time = value => value ? new Date(value).toLocaleTimeString('zh-CN', {hour12: false}) : '本次打开后尚未确认成功';
const age = (value, now) => value ? `（${Math.max(0, Math.floor((now - value) / 60000))} 分钟前）` : '';
export default function DraftSaveStatus({store, hasDocument = true, onRetry, onExport, onRecover, pageCacheContainerRef}) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [now, setNow] = useState(Date.now);
  const [details, setDetails] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const element = useRef(null), dangerModal = useRef(null), dangerShown = useRef(false);
  const cloudWarningSeen = useRef(false);
  const health = getDraftSaveHealth(state, now);
  const handlers = useRef({onExport}); handlers.current = {onExport};
  useEffect(() => {
    setNow(Date.now());
    if (!health.pending) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, [health.pending]);
  useEffect(() => {
    const update = () => document.documentElement.style.setProperty('--draft-status-height', `${element.current?.getBoundingClientRect().height || 0}px`);
    update();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    if (element.current) observer?.observe(element.current);
    window.addEventListener('resize', update);
    return () => {observer?.disconnect(); window.removeEventListener('resize', update);
      document.documentElement.style.removeProperty('--draft-status-height');};
  }, []);
  useEffect(() => {
    if (health.cloudWarning) cloudWarningSeen.current = true;
    if (cloudWarningSeen.current && health.cloudCurrent) {
      message.success('云端同步已恢复'); cloudWarningSeen.current = false;
    }
    if (!state.edited) cloudWarningSeen.current = false;
    if (health.danger && !dangerShown.current) {
      dangerShown.current = true;
      dangerModal.current = Modal.confirm({zIndex: 8000, title: '最新修改尚未保存到本机或云端',
        content: '本机和云端草稿均保存失败。建议立即导出可编辑 PDF 备份；失败提示会保留，直到保存恢复。',
        okText: '导出可编辑 PDF', cancelText: '我已知晓',
        onOk: () => handlers.current.onExport()});
    }
    if (!health.danger) {dangerShown.current = false; dangerModal.current?.destroy(); dangerModal.current = null;}
  }, [health.cloudWarning, health.cloudCurrent, health.danger, state.edited]);
  useEffect(() => () => dangerModal.current?.destroy(), []);
  const retry = async () => {
    if (retrying || !hasDocument) return;
    setRetrying(true);
    try {await onRetry();} catch {message.error('重试未完成，请查看保存详情');}
    finally {setRetrying(false);}
  };
  const localText = !hasDocument ? '本机：等待打开 PDF' : health.localCurrent ? '本机已保存最新修改' : state.local.error ? '本机最新修改未保存' :
    state.local.saving ? '本机保存中' : state.edited ? '本机待保存' : '本机：暂无新增修改';
  const cloudText = !hasDocument ? '云端：等待打开 PDF' : health.cloudCurrent ? '云端已同步最新修改' : state.cloud.error ? '云端未同步' :
    state.cloud.saving ? '云端同步中' : state.edited ? '云端待同步' : '云端：暂无新增修改';
  const channelClass = (target, current) => `draft-channel ${!hasDocument ? '' : current ? 'saved' : state[target].error ? (health.danger ? 'danger' : 'error') : state.edited ? 'pending' : ''}`;
  return <>
    <Container ref={element} data-draft-save-status>
      <div className="draft-status-row">
        <span className="draft-status-title">保存与缓存</span>
        <div className="draft-save-summary" role="status" aria-live="polite">
          <span className={channelClass('local', health.localCurrent)}>{localText}{hasDocument && state.local.saving && state.local.error ? ' · 正在重试' : ''}</span>
          <span className={channelClass('cloud', health.cloudCurrent)}>{cloudText}{hasDocument && state.cloud.saving && state.cloud.error ? ' · 正在重试' : ''}</span>
          <div ref={pageCacheContainerRef} data-page-cache-status-host style={{display: 'contents'}} />
        </div>
        <div className="draft-status-actions">
          <Button onClick={() => setDetails(true)}>保存详情</Button>
          <Button onClick={onRecover}>恢复草稿</Button>
        </div>
      </div>
      {hasDocument && health.warning && <div className={`draft-save-warning${health.danger ? ' danger' : ''}`} role="alert">
        <strong>{health.danger ? '最新修改尚未保存到本机或云端，请立即备份' : health.localWarning ? '本机草稿尚未保存最新修改' : '云端草稿尚未同步'}</strong>
        <div>上次云端保存成功：{time(state.cloud.savedAt)} {age(state.cloud.savedAt, now)}。{localText}。</div>
        <div className="draft-warning-actions">
          <Button loading={retrying} onClick={retry}>立即重试</Button>
          <Button type="primary" danger={health.danger} onClick={onExport}>导出可编辑 PDF</Button>
          <Button onClick={() => setDetails(true)}>查看详情</Button>
        </div>
      </div>}
    </Container>
    <Modal open={details} title="草稿保存详情" zIndex={8000} onCancel={() => setDetails(false)} footer={[
      <Button key="retry" disabled={!hasDocument} loading={retrying} onClick={retry}>立即重试</Button>,
      <Button key="export" disabled={!hasDocument} onClick={onExport}>导出可编辑 PDF</Button>,
      <Button key="close" onClick={() => setDetails(false)}>关闭</Button>
    ]}>
      <p>{localText}；{cloudText}。</p>
      <p>本机最后成功：{time(state.local.savedAt)}</p>
      <p>云端最后成功：{time(state.cloud.savedAt)} {age(state.cloud.savedAt, now)}</p>
      {state.local.error && <p>本机失败原因：{state.local.error}</p>}
      {state.cloud.error && <p>云端失败原因：{state.cloud.error}。连续失败 {state.cloud.failures} 次。</p>}
      <p>“已保存最新修改”以当前文件的保存回执为准。普通云端失败每 60 秒自动重试；接口不存在时，请修复服务后点击立即重试。</p>
    </Modal>
  </>;
}
