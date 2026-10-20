import React, {useEffect, useState} from 'react';
import {Alert, Button, Modal, Space, Table} from 'antd';
import {listLocalAnnotationDrafts, loadRecoveryLocalDraft} from '../utils/annotationDraftStore';
import {loadCloudAnnotationDraft} from '../utils/annotationCloudDraftStore';
import {draftTime, matchRecoveryFile, validateRecoveryDraft} from '../utils/draftRecovery';

export default function DraftRecoveryModal({open, fileInfo, localDraft, cloudState, pdfSummary, onRestore, onClose, onChoosePdf}) {
  const [rows, setRows] = useState([]), [errors, setErrors] = useState([]);
  const [loading, setLoading] = useState(false), [restoring, setRestoring] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!open) {
      setRows([]); setErrors([]); setRefresh(0);
      return;
    }
    let active = true;
    setLoading(true); setErrors([]); setRows([]);
    const cloud = fileInfo?.fingerprint
      ? !refresh && cloudState ? Promise.resolve(cloudState)
        : loadCloudAnnotationDraft(fileInfo.fingerprint, fileInfo.recoveryUserKey).then(draft => ({draft})).catch(error => ({error: error.message}))
      : Promise.resolve({unqueried: true});
    Promise.allSettled([listLocalAnnotationDrafts(), cloud]).then(([localResult, cloudResult]) => {
      if (!active) return;
      const candidates = [], failures = [];
      if (localResult.status === 'fulfilled') {
        candidates.push(...localResult.value.map(item => ({...item, key: item.localId})));
        if (localResult.value.readError) failures.push(`本机分页草稿读取失败，已保留应急副本：${localResult.value.readError}`);
      }
      else failures.push(`本机草稿读取失败：${localResult.reason?.message || localResult.reason}`);
      if (localDraft) {
        const sameLatest = candidates.find(item => item.localId === 'latest' &&
          item.fileInfo?.fingerprint === localDraft.fileInfo?.fingerprint &&
          draftTime(item) === draftTime(localDraft) && item.annotationCount === localDraft.annotations.length);
        if (sameLatest) sameLatest.draft = localDraft;
        else candidates.push({key: 'opening', source: '本机草稿（打开前）', fileInfo: localDraft.fileInfo, draft: localDraft,
          annotationCount: localDraft.annotations.length, updatedAt: localDraft.updatedAt});
      }
      const state = cloudResult.status === 'fulfilled' ? cloudResult.value : {error: cloudResult.reason?.message};
      if (state.error) failures.push(`云端草稿查询失败：${state.error}`);
      if (pdfSummary?.error) failures.push(`PDF 内标注读取失败：${pdfSummary.error}`);
      if (state.draft) candidates.push({key: 'cloud', source: '云端草稿', draft: state.draft,
        fileInfo: state.draft.fileInfo, annotationCount: state.draft.annotations?.length ?? 0,
        updatedAt: state.draft.updatedAt || state.draft.savedAt});
      if (pdfSummary?.annotations) candidates.push({key: 'pdf', source: 'PDF 内标注', fileInfo, draft: {...pdfSummary, fileInfo},
        annotationCount: pdfSummary.annotations.length, updatedAt: pdfSummary.updatedAt});
      candidates.forEach(row => {
        row.matched = !fileInfo || matchRecoveryFile(row.fileInfo, fileInfo);
        const validation = row.draft ? validateRecoveryDraft(row.draft) : {valid: true};
        row.disabledReason = !row.matched ? '与当前图纸或项目不匹配，请选择对应图纸' : !validation.valid ? validation.reason : '';
      });
      candidates.sort((a, b) => Number(b.matched) - Number(a.matched) || draftTime(b) - draftTime(a));
      setRows(candidates); setErrors(failures); setLoading(false);
    });
    return () => {active = false;};
  }, [open, fileInfo, localDraft, cloudState, pdfSummary, refresh]);
  const restore = async row => {
    setRestoring(true);
    try {
      const draft = row.draft || await loadRecoveryLocalDraft(row.localId);
      const validation = validateRecoveryDraft(draft);
      if (!validation.valid) throw new Error(validation.reason);
      const restored = await onRestore(draft, row.source);
      if (restored !== false) onClose(true);
    } catch (error) { setErrors(previous => [...previous, error.message]); }
    finally { setRestoring(false); }
  };
  return <Modal title="恢复标注草稿" open={open} width={900} centered zIndex={8000} onCancel={() => onClose(false)}
    footer={<Space wrap><Button onClick={() => {onClose(false); onChoosePdf();}} disabled={restoring}>选择对应 PDF</Button>
      <Button onClick={() => setRefresh(value => value + 1)} loading={loading} disabled={restoring}>重新查询</Button>
      <Button onClick={() => onClose(false)} disabled={restoring}>稍后恢复 / 保留 PDF 标注</Button></Space>}>
    <p>时间用于推荐；较早或时间相同的草稿也可以选择恢复。恢复会替换当前工作区的标注。</p>
    {!fileInfo && <Alert type="info" showIcon message="尚未选择图纸：可查看本机草稿；选择对应 PDF 后查询云端草稿。" />}
    {fileInfo && <p>图纸：{fileInfo.name}　项目：{fileInfo.projectName || '未指定'}</p>}
    {errors.map((error, i) => <Alert key={i} type="warning" showIcon message={error} style={{marginBottom: 8}} />)}
    <Table size="small" rowKey="key" loading={loading} dataSource={rows} scroll={{x: 760}} pagination={{pageSize: 6}}
      locale={{emptyText: fileInfo ? '未找到对应草稿。可重新查询，或选择崩溃前使用的原 PDF。' : '未找到本机草稿'}}
      columns={[
        {title: '来源', dataIndex: 'source'},
        {title: '文件', render: (_, row) => String(row.fileInfo?.name || '当前 PDF')},
        {title: '标注数', dataIndex: 'annotationCount', width: 80},
        {title: '时间', render: (_, row) => draftTime(row) ? new Date(draftTime(row)).toLocaleString() : '未知'},
        {title: '恢复', render: (_, row) => row.disabledReason || <Button size="small" loading={restoring}
          onClick={() => restore(row)}>恢复此版本</Button>},
      ]} />
  </Modal>;
}
