import fs from 'fs';
import path from 'path';
import { parse } from '@babel/parser';
import generate from '@babel/generator';

// Execute the actual save handler with controlled I/O, without mounting the
// PDF viewer or allocating a large PDF. This covers the orchestration as well
// as the adapter's separate disk/download tests.
const appAst = parse(fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8'), {
  sourceType: 'module', plugins: ['jsx'],
});
const app = appAst.program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'AppContent');
const handler = app.body.body.flatMap(node => node.type === 'VariableDeclaration' ? node.declarations : [])
  .find(node => node.id.name === 'handleAutoSaveToOriginalFile').init;

const makeSave = result => {
  const context = {
    isElectron: () => false,
    markAnnotationDraftDirty: jest.fn(),
    flushAnnotationDraft: jest.fn(async () => ({ dirty: true })),
    generateAnnotatedPDFBytes: jest.fn(async () => new Uint8Array([1, 2])),
    fileAdapter: { savePDF: jest.fn(async () => result) },
    message: { loading: jest.fn(), success: jest.fn(), error: jest.fn() },
    pdfFileName: 'drawing', pdfFilePath: null,
    MAX_RESIDENT_PDF_BUFFER_BYTES: 64 * 1024 * 1024,
    setPdfArrayBuffer: jest.fn(), setPdfFilePath: jest.fn(), setPdfFileName: jest.fn(),
    markAnnotationDraftSaved: jest.fn(),
    latestCloudAnnotationDraftRef: { current: { annotations: [{ page: 1 }] } },
    persistCloudAnnotationDraft: jest.fn(),
    logLayoutQualityFinalization: jest.fn(), logAnnotationSnapshot: jest.fn(),
  };
  const save = new Function(...Object.keys(context), `return (${generate(handler).code});`)(...Object.values(context));
  return { save, context };
};

beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => {}); jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { jest.restoreAllMocks(); });

test('unconfirmed browser download checkpoints before PDF generation and never clears recovery', async () => {
  const { save, context } = makeSave({ success: true, saveMethod: 'download', savedPath: 'drawing.pdf' });
  await save();
  expect(context.flushAnnotationDraft).toHaveBeenCalledWith({ emergency: true });
  expect(context.flushAnnotationDraft.mock.invocationCallOrder[0])
    .toBeLessThan(context.generateAnnotatedPDFBytes.mock.invocationCallOrder[0]);
  expect(context.markAnnotationDraftSaved).not.toHaveBeenCalled();
  expect(context.persistCloudAnnotationDraft).toHaveBeenCalled();
  expect(context.message.success.mock.calls[0][0].content).toContain('恢复草稿已保留');
});

test('failure after checkpoint leaves recovery available', async () => {
  const { save, context } = makeSave({ success: false, error: 'download unavailable' });
  await save();
  expect(context.flushAnnotationDraft).toHaveBeenCalled();
  expect(context.markAnnotationDraftSaved).not.toHaveBeenCalled();
  expect(context.message.error).toHaveBeenCalled();
});

test.each(['original', 'save-as'])('confirmed %s disk save may mark the checkpoint saved', async saveMethod => {
  const { save, context } = makeSave({ success: true, saveMethod });
  await save();
  expect(context.markAnnotationDraftSaved).toHaveBeenCalledTimes(1);
});

test('reopening the original PDF offers local recovery when the cloud is unavailable', async () => {
  const node = app.body.body.flatMap(item => item.type === 'VariableDeclaration' ? item.declarations : [])
    .find(item => item.id.name === 'handleFileSelect').init.arguments[0];
  const file = new File(['pdf'], 'drawing.pdf');
  file.arrayBuffer = async () => new ArrayBuffer(3);
  const info = { name: file.name, size: file.size, fingerprint: 'same-pdf' };
  const draft = { fileInfo: info, annotations: [{ page: 1 }], updatedAt: '2026-10-10T08:00:00Z' };
  const context = {
    undoRedoSystem: { clearHistory: jest.fn() }, isElectron: () => false,
    cancelPdfMetadataRead: jest.fn(),
    releaseIdleDraftWorker: jest.fn(),
    loadLatestAnnotationDraft: jest.fn(async () => draft), resetAnnotationDraftState: jest.fn(),
    MAX_RESIDENT_PDF_BUFFER_BYTES: 64 * 1024 * 1024,
    warnIfPdfEncrypted: jest.fn(), buildPdfDraftFileInfo: jest.fn(async () => info),
    currentPdfDraftInfoRef: { current: null },
    loadAnnotationsFromPDFMetadata: jest.fn(async () => null),
    maybeRestoreCloudAnnotationDraft: jest.fn(async (info, summary, local) => {
      context.restoreAnnotationDraftData(local, '本机草稿'); return true;
    }),
    pdfDraftSummaryRef: {current: null}, cloudRecoveryPrefetchRef: {current: null},
    cloudAnnotationDraftGenerationRef: {current: 1},
    getAnnotationDraftUserKey: () => 'web_test', getCurrentProjectDraftFileInfo: info => info,
    loadCloudAnnotationDraft: jest.fn(async () => null), setAnnotations: jest.fn(), setTotalPages: jest.fn(),
    setBatchSequenceDraftState: jest.fn(),
    isSamePdfDraftFile: (left, right) => left?.fingerprint === right?.fingerprint,
    getDraftUpdatedTime: value => value?.updatedAt ? new Date(value.updatedAt).getTime() : 0,
    restoreAnnotationDraftData: jest.fn(),
    Modal: { confirm: jest.fn(options => options.onOk()) },
    performanceRef: { current: {} },
    setPdfFile: jest.fn(), setPdfFileName: jest.fn(), setPdfArrayBuffer: jest.fn(),
    setPdfFilePath: jest.fn(), setCurrentPage: jest.fn(), setSearchText: jest.fn(),
    setSearchResults: jest.fn(), setCurrentSearchIndex: jest.fn(), setPageRecognitionData: jest.fn(),
  };
  const open = new Function(...Object.keys(context), `return (${generate(node).code});`)(...Object.values(context));
  await open(file);
  expect(context.maybeRestoreCloudAnnotationDraft).toHaveBeenCalledWith(expect.objectContaining({fingerprint: 'same-pdf'}), null, draft);
  expect(context.restoreAnnotationDraftData).toHaveBeenCalledWith(draft, '本机草稿');
  expect(context.loadLatestAnnotationDraft.mock.invocationCallOrder[0])
    .toBeLessThan(context.resetAnnotationDraftState.mock.invocationCallOrder[0]);
  expect(context.loadAnnotationsFromPDFMetadata).not.toHaveBeenCalled();
});

test('a failed cloud save cannot retire a checkpoint or cancel its retry', async () => {
  const node = app.body.body.flatMap(item => item.type === 'VariableDeclaration' ? item.declarations : [])
    .find(item => item.id.name === 'markAnnotationDraftSaved').init.arguments[0];
  const context = {
    isElectron: () => false,
    annotationDraftSaveInFlightRef: { current: null },
    latestCloudAnnotationDraftRef: { current: { annotations: [{ page: 1 }] } },
    persistCloudAnnotationDraft: jest.fn(async () => null),
    resetAnnotationDraftState: jest.fn(), markLatestAnnotationDraftSaved: jest.fn(),
  };
  const mark = new Function(...Object.keys(context), `return (${generate(node).code});`)(...Object.values(context));
  await mark();
  expect(context.persistCloudAnnotationDraft).toHaveBeenCalledTimes(1);
  expect(context.resetAnnotationDraftState).not.toHaveBeenCalled();
  expect(context.markLatestAnnotationDraftSaved).not.toHaveBeenCalled();
});
