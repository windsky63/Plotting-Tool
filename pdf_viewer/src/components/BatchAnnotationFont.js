import React, { useMemo, useRef, useState } from 'react';
import { Button, Input, InputNumber, Select, Space, message } from 'antd';
import { selectAppearanceTargets } from '../utils/batchAnnotationAppearance';
import { buildBatchFontUpdates } from '../utils/batchAnnotationFont';
import BatchControlTitle from './BatchControlTitle';

const scopes = [
  { value: 'current', label: '当前页' }, { value: 'selected', label: '当前页已选' },
  { value: 'pages', label: '指定多页' }, { value: 'all', label: '所有页' }
];

export default function BatchAnnotationFont({ annotations, currentPage, selectedIds, pdfDocument, onBatchAnnotationUpdates }) {
  const [scope, setScope] = useState('current');
  const [pageRange, setPageRange] = useState('');
  const [regularSize, setRegularSize] = useState(34);
  const [topSize, setTopSize] = useState(16);
  const [bottomSize, setBottomSize] = useState(34);
  const [applying, setApplying] = useState(false);
  const busy = useRef(false);
  const documentRef = useRef(pdfDocument);
  documentRef.current = pdfDocument;
  const totalPages = Number(pdfDocument?.numPages) || (annotations || []).reduce((max, a) => Math.max(max, Number(a.page || 1)), 1);
  const selection = useMemo(() => {
    try {
      return { targets: selectAppearanceTargets({ annotations, scope, currentPage, selectedIds, pageRange, totalPages }), error: '' };
    } catch (error) { return { targets: [], error: error.message }; }
  }, [annotations, scope, currentPage, selectedIds, pageRange, totalPages]);
  const hasSplit = selection.targets.some(a => a.borderShape === 'split-circle');
  const hasRegular = selection.targets.some(a => a.borderShape !== 'split-circle');
  const apply = async () => {
    if (busy.current) return;
    busy.current = true;
    setApplying(true);
    try {
      const updates = await buildBatchFontUpdates({ targets: selection.targets, regularSize, topSize, bottomSize, pdfDocument });
      if (documentRef.current !== pdfDocument) return;
      const count = Object.keys(updates).length;
      if (!count) { message.info('所选标注已使用该字号'); return; }
      onBatchAnnotationUpdates(updates, `统一修改${scopes.find(item => item.value === scope).label}标注字号 (${count}个)`);
      message.success(`已修改 ${count} 个标注的字号，可用 Ctrl+Z 撤销`);
    } catch (error) { message.error(`修改字号失败：${error.message}`); }
    finally { busy.current = false; setApplying(false); }
  };
  return <div role="group" aria-label="已有标注字号" style={{ marginTop: 8, padding: 8,
    border: '1px solid #e8e8e8', borderRadius: 6, background: 'white' }}>
    <div style={{ marginBottom: 6 }}>
      <BatchControlTitle tip={`${hasSplit ? '“上/下”为分割圆上下文字，' : ''}字号统一按页面尺寸换算，保持 A3 打印大小一致；不改变新建标注的默认字号。`}>已有标注字号</BatchControlTitle>
    </div>
    <Space wrap size={8}>
      <Select aria-label="字号处理范围" size="small" value={scope} options={scopes}
        onChange={setScope} disabled={applying} style={{ width: 116 }} />
      {scope === 'pages' && <Input aria-label="字号处理页码" size="small" value={pageRange}
        onChange={event => setPageRange(event.target.value)} disabled={applying} placeholder="例如 1,3-5" style={{ width: 140 }} />}
      {hasSplit && <>
        <InputNumber aria-label="分割圆上半字号" size="small" addonBefore="上" min={6} max={96}
          value={topSize} onChange={setTopSize} disabled={applying} style={{ width: 92 }} />
        <InputNumber aria-label="分割圆下半字号" size="small" addonBefore="下" min={6} max={96}
          value={bottomSize} onChange={setBottomSize} disabled={applying} style={{ width: 92 }} />
      </>}
      {hasRegular && <InputNumber aria-label="普通标注字号" size="small" addonBefore={hasSplit ? '普通' : '字号'}
        min={6} max={96} value={regularSize} onChange={setRegularSize} disabled={applying} style={{ width: 112 }} />}
      <Button size="small" type="primary" onClick={apply} loading={applying}
        disabled={!onBatchAnnotationUpdates || !selection.targets.length}>应用字号（{selection.targets.length}个）</Button>
    </Space>
    {selection.error && <div role="alert" style={{ fontSize: 12, marginTop: 6, color: '#d4380d' }}>
      {selection.error}
    </div>}
  </div>;
}
