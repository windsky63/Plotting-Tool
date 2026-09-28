const assert = require('node:assert/strict');
const { buildDocumentAnnotationStats } = require('./audit_document_annotation_stats');

const event = (action, fileName, time, details = {}, count = 1) => ({
  category: 'user-event',
  action,
  pdfFileName: fileName,
  projectName: '项目甲',
  erpUser: 'user1',
  time,
  count,
  details: { clientId: 'client1', ...details }
});

const rows = buildDocumentAnnotationStats([
  event('pdf_open', 'A图', '2026-09-20T10:00:00Z'),
  event('weld_add_auto', 'A图', '2026-09-20T10:01:00Z', { pages: [1, 2] }, 8),
  event('weld_add_manual', 'A图', '2026-09-20T10:02:00Z', { page: 2 }, 2),
  event('annotation_snapshot', 'A图', '2026-09-20T10:03:00Z', { originCounts: { auto: 6, manual: 3 } }),
  event('annotation_snapshot', 'A图', '2026-09-20T10:04:00Z', { originCounts: { auto: 5, manual: 4 } }),
  event('weld_add_manual', 'B图', '2026-09-20T10:05:00Z', { page: 1 }, 3)
]);

assert.equal(rows.length, 2);
assert.deepEqual(
  (({ auto, manual, total, pages, source, autoRatio, manualRatio }) =>
    ({ auto, manual, total, pages, source, autoRatio, manualRatio }))(rows[0]),
  {
    auto: 5, manual: 4, total: 9, pages: 2, source: '保存/导出快照',
    autoRatio: 5 / 9, manualRatio: 4 / 9
  }
);
assert.equal(rows[1].manual, 3);
assert.equal(rows[1].source, '历史新增记录');

console.log('document annotation stats: OK');
