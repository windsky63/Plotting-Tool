const getCount = value => {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
};

const buildDocumentAnnotationStats = entries => {
  const documents = new Map();
  (entries || []).forEach(entry => {
    if (entry?.category !== 'user-event') return;
    const fileName = String(entry.pdfFileName || '').trim();
    if (!fileName) return;
    const action = entry.action;
    if (!['pdf_open', 'weld_add_auto', 'weld_add_manual', 'annotation_snapshot'].includes(action)) return;

    const details = entry.details || {};
    const project = String(entry.projectName || details.projectName || entry.projectId || details.projectId || '').trim();
    const clientId = String(details.clientId || '').trim();
    const key = JSON.stringify([clientId, project, fileName]);
    if (!documents.has(key)) {
      documents.set(key, {
        project, fileName, clientId, erpUser: '',
        addedAuto: 0, addedManual: 0, pages: new Set(), snapshot: null
      });
    }
    const document = documents.get(key);
    const erpUser = String(entry.erpUser || details.erpUser || '').trim();
    if (erpUser) document.erpUser = erpUser;
    const pageValues = [details.pages, entry.page || details.page].flat();
    pageValues.forEach(value => {
      const page = Number(value);
      if (Number.isInteger(page) && page > 0) document.pages.add(page);
    });

    if (action === 'weld_add_auto') document.addedAuto += getCount(entry.count || details.count || 1);
    if (action === 'weld_add_manual') document.addedManual += getCount(entry.count || details.count || 1);
    if (action === 'annotation_snapshot') {
      const originCounts = details.originCounts;
      if (!originCounts || typeof originCounts !== 'object') return;
      const timestamp = String(entry.time || details.timestamp || '');
      if (!document.snapshot || timestamp > document.snapshot.time) {
        document.snapshot = {
          time: timestamp,
          auto: getCount(originCounts.auto),
          manual: getCount(originCounts.manual)
        };
      }
    }
  });

  return Array.from(documents.values()).map(document => {
    const auto = document.snapshot ? document.snapshot.auto : document.addedAuto;
    const manual = document.snapshot ? document.snapshot.manual : document.addedManual;
    const total = auto + manual;
    return {
      project: document.project,
      fileName: document.fileName,
      clientId: document.clientId,
      erpUser: document.erpUser,
      pages: document.pages.size,
      auto,
      manual,
      total,
      autoRatio: total ? auto / total : null,
      manualRatio: total ? manual / total : null,
      source: document.snapshot ? '保存/导出快照' : '历史新增记录',
      snapshotAt: document.snapshot?.time || ''
    };
  }).sort((a, b) => a.project.localeCompare(b.project, 'zh-CN') ||
    a.fileName.localeCompare(b.fileName, 'zh-CN'));
};

module.exports = { buildDocumentAnnotationStats };
