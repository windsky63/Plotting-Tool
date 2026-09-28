// Percentages describe completed export stages, not an estimate of elapsed time.
export const getPdfExportProgress = ({ kind, phase, completedPages = 0, totalPages = 0, pageNumber, completedSteps = 0, totalSteps = 0, stage }) => {
  const editable = kind === 'editable';
  const label = editable ? '可编辑版' : '标注版';
  const stages = {
    loading: [editable ? 1 : 15, `正在读取${label} PDF`],
    loaded: [editable ? 5 : 18, `正在准备${label} PDF`],
    metadata: [8, '正在写入可编辑标注信息'],
    serializing: [editable ? 10 : 90, `正在封装${label} PDF，文件较大时需要等待`],
    generated: [editable ? 15 : 98, `${label} PDF 已生成`],
  };
  if (phase === 'rendering') {
    const ratio = totalPages > 0 ? Math.min(1, Math.max(0, completedPages / totalPages)) : 0;
    return {
      percent: Math.round(18 + 70 * ratio),
      status: `正在生成标注图像：已完成 ${completedPages}/${totalPages} 个有标注页${pageNumber ? `（PDF 第 ${pageNumber} 页）` : ''}`,
    };
  }
  if (phase === 'serializing' && totalSteps > 0) {
    const ratio = Math.min(1, Math.max(0, completedSteps / totalSteps));
    return {
      percent: Math.floor((editable ? 10 : 90) + (editable ? 5 : 8) * ratio),
      status: `正在封装${label} PDF：${stage === 'sizing' ? '计算文件结构' : '写入文件数据'} ${Math.round(ratio * 100)}%`,
    };
  }
  const [percent, status] = stages[phase] || stages.loading;
  return { percent, status };
};

export const publishPdfExportProgress = detail => {
  window.dispatchEvent(new CustomEvent('pdf-export-progress', { detail }));
};
