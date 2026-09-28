import React, { useEffect, useState } from 'react';
import { Button, Modal, Progress } from 'antd';

// Keep page-by-page progress local: updating it must not rerender the PDF viewer.
export default function PdfExportProgress() {
  const [progress, setProgress] = useState(null);
  useEffect(() => {
    const handleProgress = ({ detail }) => setProgress(previous => ({
      ...(detail.start ? {} : previous),
      ...detail,
      visible: true,
    }));
    window.addEventListener('pdf-export-progress', handleProgress);
    return () => window.removeEventListener('pdf-export-progress', handleProgress);
  }, []);
  const finished = Boolean(progress?.done || progress?.error);
  const close = () => setProgress(previous => ({ ...previous, visible: false }));
  return (
    <Modal
      title="PDF 导出进度"
      open={Boolean(progress?.visible)}
      closable={finished}
      keyboard={finished}
      maskClosable={false}
      onCancel={close}
      footer={finished ? <Button onClick={close}>关闭</Button> : null}
      centered
      zIndex={20000}
      width={520}
    >
      <Progress percent={progress?.percent || 0} status={progress?.error ? 'exception' : progress?.done ? 'success' : 'active'} />
      <p role="status">{progress?.status}</p>
      <p style={{ color: '#888', fontSize: 12 }}>进度按实际处理阶段和有标注页数更新。PDF 封装期间可能暂时停留；请勿重复导出或刷新页面。</p>
    </Modal>
  );
}
