import React, {useLayoutEffect, useState} from 'react';
import {createPortal} from 'react-dom';
import {Button} from 'antd';

export const getPageCacheStatusText = progress => {
  if (!progress.running && progress.error) return '页面缓存失败';
  if (progress.stage === 'uploading') {
    const uploaded = Math.max(0, Number(progress.uploadedBytes) || 0) / (1024 * 1024);
    const size = Math.max(0, Number(progress.sourceSize) || 0) / (1024 * 1024);
    return size > 0 ? `图纸上传 ${uploaded.toFixed(1)}/${size.toFixed(1)} MB` : `图纸已上传 ${uploaded.toFixed(1)} MB`;
  }
  if (progress.stage === 'queued') return '页面缓存：等待生成';
  if (progress.stage === 'rendering' && !progress.completed) return '页面缓存：正在生成第1页';
  return `页面缓存 ${progress.completed}/${progress.total}`;
};

// Keep progress owned by the viewer. The portal updates only this part of the
// shared status bar instead of publishing each progress tick into App state.
export default function PageCacheStatus({containerRef, progress, paused, serverMode, onTogglePause, onRetry}) {
  const [container, setContainer] = useState(null);
  useLayoutEffect(() => {setContainer(containerRef?.current || null);}, [containerRef]);
  if (!(progress.total > 0)) return null;
  const failed = Boolean(progress.error || progress.failed > 0);
  const complete = !progress.running && !failed && progress.completed >= progress.total;
  const content = <div data-page-cache-status className="page-cache-status" style={{display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap'}}
    onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <span className={`draft-channel ${failed ? 'error' : complete ? 'saved' : 'pending'}`} title={progress.error || ''}>
      {getPageCacheStatusText(progress)}
      {progress.failed > 0 ? `，失败${progress.failed}` : ''}
      {progress.skipped > 0 ? `，跳过超大页${progress.skipped}` : ''}
      {paused && progress.running ? ' · 已暂停' : ''}
    </span>
    {!serverMode && progress.running && progress.completed + progress.failed < progress.total &&
      <Button size="small" onClick={onTogglePause}>{paused ? '继续' : '暂停'}</Button>}
    {!progress.running && failed && <Button size="small" onClick={onRetry}>重试缓存</Button>}
  </div>;
  if (container) return createPortal(content, container);
  if (containerRef) return null;
  // Standalone/desktop viewers retain their existing cache controls.
  return <div style={{position: 'absolute', left: 12, bottom: 12, zIndex: 5500, padding: '6px 8px', background: '#fff', border: '1px solid #dce4ed', borderRadius: 6}}
    onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>{content}</div>;
}
