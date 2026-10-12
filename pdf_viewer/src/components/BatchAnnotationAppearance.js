import React, { useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Input, Select, Space, message } from 'antd';
import styled from 'styled-components';
import BatchControlTitle from './BatchControlTitle';
import { ANNOTATION_APPEARANCE_SHAPES, buildAppearanceUpdates, selectAppearanceTargets } from '../utils/batchAnnotationAppearance';

const scopes = [
  { value: 'current', label: '当前页' },
  { value: 'selected', label: '当前页已选' },
  { value: 'pages', label: '指定多页' },
  { value: 'all', label: '所有页' }
];

const AppearanceControls = styled.div`
  margin-top: 8px;
  padding: 8px;
  border: 1px solid #e8e8e8;
  border-radius: 6px;
  background: white;
  min-width: 0;
`;
const AppearanceFields = styled.div`
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-top: 6px;
  > div { min-width: 0; }
  .ant-select { width: 100%; min-width: 0; }
  .ant-space-compact { width: 100%; }
  .ant-space-compact > .ant-select { flex: 1; }
`;
const AppearanceActions = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
`;

export default function BatchAnnotationAppearance({ annotations, currentPage, selectedIds, pdfDocument,
  onBatchAnnotationUpdates }) {
  const [scope, setScope] = useState('current');
  const [pageRange, setPageRange] = useState('');
  const [sourceShape, setSourceShape] = useState('all');
  const [shape, setShape] = useState('keep');
  const [changeColor, setChangeColor] = useState(false);
  const [color, setColor] = useState('#0000ff');
  const [applying, setApplying] = useState(false);
  const applyingRef = useRef(false);
  const latestDocument = useRef(pdfDocument);
  latestDocument.current = pdfDocument;
  const totalPages = Number(pdfDocument?.numPages) || (annotations || []).reduce(
    (max, annotation) => Math.max(max, Number(annotation.page || 1)), 1);
  const selection = useMemo(() => {
    try {
      return { targets: selectAppearanceTargets({ annotations, scope, currentPage, selectedIds,
        pageRange, totalPages, sourceShape }), error: '' };
    } catch (error) {
      return { targets: [], error: error.message };
    }
  }, [annotations, scope, currentPage, selectedIds, pageRange, totalPages, sourceShape]);

  const apply = async () => {
    if (applyingRef.current) return;
    applyingRef.current = true;
    setApplying(true);
    try {
      const updates = await buildAppearanceUpdates({ targets: selection.targets, shape,
        color: changeColor ? color : null, pdfDocument });
      if (latestDocument.current !== pdfDocument) return;
      const count = Object.keys(updates).length;
      if (!count) { message.info('所选标注已使用该外观'); return; }
      onBatchAnnotationUpdates(updates, `批量修改${scopes.find(item => item.value === scope).label}标注外观 (${count}个)`);
      message.success(`已修改 ${count} 个标注的外观，可用 Ctrl+Z 撤销`);
    } catch (error) {
      message.error(`修改外观失败：${error.message}`);
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
  };

  return <AppearanceControls role="group" aria-label="批量标注外观">
    <BatchControlTitle tip="按所选范围处理文字标注，框形与颜色可单独修改，整次操作可用 Ctrl+Z 撤销。">标注外观</BatchControlTitle>
    <AppearanceFields>
      <div><Select aria-label="外观处理范围" size="small" value={scope}
        options={scopes} onChange={setScope} disabled={applying} /></div>
      <Space.Compact size="small">
        <Button disabled style={{ color: '#555', fontSize: 12 }}>原框形</Button>
        <Select aria-label="原框形筛选" size="small" value={sourceShape}
        options={[{ value: 'all', label: '全部' }, ...ANNOTATION_APPEARANCE_SHAPES.map(item => ({ ...item, label: `仅${item.label}` }))]}
        onChange={setSourceShape} disabled={applying} />
      </Space.Compact>
      <Space.Compact size="small">
        <Button disabled style={{ color: '#555', fontSize: 12 }}>新框形</Button>
        <Select aria-label="修改后的框形" size="small" value={shape}
        options={[{ value: 'keep', label: '保持不变' }, ...ANNOTATION_APPEARANCE_SHAPES]}
        onChange={setShape} disabled={applying} />
      </Space.Compact>
      {scope === 'pages' && <Space.Compact size="small" style={{ gridColumn: '1 / -1' }}>
        <Button disabled style={{ color: '#555', fontSize: 12 }}>页码</Button>
        <Input aria-label="外观处理页码" size="small" placeholder="例如 1,3-5" value={pageRange}
          onChange={event => setPageRange(event.target.value)} disabled={applying} style={{ flex: 1, minWidth: 0 }} />
      </Space.Compact>}
    </AppearanceFields>
    <AppearanceActions>
      <Space size={8}>
        <Checkbox checked={changeColor} onChange={event => setChangeColor(event.target.checked)} disabled={applying}>修改颜色</Checkbox>
        <input aria-label="修改后的颜色" type="color" value={color} disabled={!changeColor || applying}
          onChange={event => setColor(event.target.value)} style={{ width: 34, height: 24, padding: 0 }} />
      </Space>
      <Button size="small" type="primary" onClick={apply} loading={applying}
        disabled={!onBatchAnnotationUpdates || !selection.targets.length || (shape === 'keep' && !changeColor)}>
        应用外观（{selection.targets.length}个）
      </Button>
    </AppearanceActions>
    {selection.error && <div role="alert" style={{ marginTop: 4, fontSize: 12, color: '#d4380d' }}>
      {selection.error}
    </div>}
  </AppearanceControls>;
}
