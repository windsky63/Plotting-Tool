import fs from 'fs';
import path from 'path';
import {parse} from '@babel/parser';
import generate from '@babel/generator';
import {transformSync} from '@babel/core';
import {createDraftSaveHealth, getDraftSaveHealth} from './draftSaveHealth';

const ast = parse(fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8'), {sourceType: 'module', plugins: ['jsx']});
const app = ast.program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'AppContent');
const declarations = app.body.body.flatMap(node => node.type === 'VariableDeclaration' ? node.declarations : []);
const callback = name => declarations.find(node => node.id.name === name).init.arguments[0];
const execute = (node, context) => {
  const source = transformSync(`(${generate(node).code})`, {configFile: false, babelrc: false, plugins: ['@babel/plugin-transform-react-jsx']}).code;
  return new Function(...Object.keys(context), `return ${source}`)(...Object.values(context));
};
test.each(['older', 'same', 'unknown'])('cloud %s timestamps still open the recovery choices', async clock => {
  const draft = {fileInfo: {fingerprint: 'a'}, annotations: [{id: 1, page: 1}], updatedAt: clock === 'unknown' ? null : '2020-01-01'};
  const context = {
    isElectron: () => false, getCurrentProjectDraftFileInfo: info => info,
    cloudRecoveryPrefetchRef: {current: null}, loadCloudAnnotationDraft: jest.fn(async () => draft),
    cloudAnnotationDraftGenerationRef: {current: 1},
    recoveryCompletionRef: {current: null},
    isSamePdfDraftFile: () => true, setCloudAnnotationDraftStatus: jest.fn(), message: {warning: jest.fn()},
    setRecoveryDialog: jest.fn(dialog => dialog.onFinished(true)),
  };
  const run = execute(callback('maybeRestoreCloudAnnotationDraft'), context);
  await expect(run({fingerprint: 'a'}, {updatedAt: '2030-01-01', annotations: [{page: 1}]}, {updatedAt: '2030-01-01', annotations: [{page: 1}]})).resolves.toBe(true);
  expect(context.setRecoveryDialog).toHaveBeenCalledWith(expect.objectContaining({open: true, cloudState: {draft}}));
});
test('startup cleanup followed by a second mount still offers the existing local draft once', async () => {
  const effect = app.body.body.find(node => node.type === 'ExpressionStatement' && node.expression.callee?.name === 'useEffect' &&
    generate(node).code.includes('startupDraftPromptShownRef.current = true')).expression.arguments[0];
  const reads = [];
  const context = {isElectron: () => false, startupDraftPromptShownRef: {current: false},
    loadLatestAnnotationDraft: () => new Promise(resolve => reads.push(resolve)), latestAnnotationDraftRef: {current: null},
    Modal: {confirm: jest.fn()}, startupRecoveryHandlersRef: {current: {restore: jest.fn()}}, React: {createElement: () => null}};
  const run = execute(effect, context);
  const cleanup = run(); cleanup(); run();
  const draft = {fileInfo: {name: 'a.pdf'}, annotations: [{page: 1}]};
  reads.forEach(resolve => resolve(draft)); await Promise.resolve(); await Promise.resolve();
  expect(context.Modal.confirm).toHaveBeenCalledTimes(1);
  const options = context.Modal.confirm.mock.calls[0][0];
  expect(options.cancelText).toBe('稍后恢复');
  expect(options.onCancel).toBeUndefined();
});
test.each([[5, 'pending'], [6, 'saved']])('save acknowledgement for edit %s reports %s when the current edit is 6', async (revision, expected) => {
  const context = {isElectron: () => false, cloudAnnotationDraftUnsupportedRef: {current: false},
    latestCloudAnnotationDraftRef: {current: null}, cloudAnnotationDraftInFlightRef: {current: null},
    cloudAnnotationDraftSchedulerRef: {current: {cancel: jest.fn()}}, cloudAnnotationDraftGenerationRef: {current: 1},
    annotationEditRevisionRef: {current: 6}, cloudAnnotationDraftErrorShownRef: {current: false},
    draftSaveHealthRef: {current: {started: jest.fn(), saved: jest.fn(), failed: jest.fn()}},
    setCloudAnnotationDraftStatus: jest.fn(), saveCloudAnnotationDraftOffMainThread: jest.fn(async () => ({success: true}))};
  await execute(callback('persistCloudAnnotationDraft'), context)({fileInfo: {fingerprint: 'a'}, editRevision: revision});
  expect(context.setCloudAnnotationDraftStatus).toHaveBeenLastCalledWith(expected);
});

test('closing a reused dialog completes the current open request rather than an old render callback', () => {
  const current = jest.fn(), previous = jest.fn();
  const context = {recoveryCompletionRef: {current}, cloudRecoveryPrefetchRef: {current: {promise: Promise.resolve({})}}, setRecoveryDialog: jest.fn(), recoveryDialog: {onFinished: previous}};
  execute(callback('handleCloseDraftRecovery'), context)(false);
  expect(current).toHaveBeenCalledWith(false);
  expect(previous).not.toHaveBeenCalled();
  expect(context.recoveryCompletionRef.current).toBeNull();
  expect(context.cloudRecoveryPrefetchRef.current).toBeNull();
});

test('actual cloud save keeps persistent failure until the latest edit is acknowledged', async () => {
  const health = createDraftSaveHealth(); health.edited(6);
  health.failed('cloud', 'offline'); health.failed('cloud', 'offline');
  const context = {isElectron: () => false, cloudAnnotationDraftUnsupportedRef: {current: false},
    latestCloudAnnotationDraftRef: {current: null}, cloudAnnotationDraftInFlightRef: {current: null},
    cloudAnnotationDraftSchedulerRef: {current: {cancel: jest.fn(), retry: jest.fn()}}, cloudAnnotationDraftGenerationRef: {current: 1},
    annotationEditRevisionRef: {current: 6}, cloudAnnotationDraftErrorShownRef: {current: false},
    draftSaveHealthRef: {current: health}, setCloudAnnotationDraftStatus: jest.fn(),
    saveCloudAnnotationDraftOffMainThread: jest.fn(async () => ({success: true}))};
  const save = execute(callback('persistCloudAnnotationDraft'), context);
  await save({fileInfo: {fingerprint: 'a'}, editRevision: 5});
  expect(getDraftSaveHealth(health.getSnapshot()).cloudWarning).toBe(true);
  await save({fileInfo: {fingerprint: 'a'}, editRevision: 6});
  expect(getDraftSaveHealth(health.getSnapshot()).cloudCurrent).toBe(true);
  expect(getDraftSaveHealth(health.getSnapshot()).cloudWarning).toBe(false);
});

test('manual retry re-probes a missing interface and never saves an old file after switching', async () => {
  const context = {cloudAnnotationDraftGenerationRef: {current: 1},
    cloudAnnotationDraftUnsupportedRef: {current: true}, cloudAnnotationDraftSchedulerRef: {current: {cancel: jest.fn()}},
    latestCloudAnnotationDraftRef: {current: {editRevision: 4}}, flushAnnotationDraft: jest.fn(async () => {}),
    persistCloudAnnotationDraft: jest.fn(async () => {})};
  const retry = execute(callback('handleRetryDraftSave'), context);
  await retry(); expect(context.cloudAnnotationDraftUnsupportedRef.current).toBe(false);
  expect(context.persistCloudAnnotationDraft).toHaveBeenCalledWith({editRevision: 4});
  context.persistCloudAnnotationDraft.mockClear();
  context.flushAnnotationDraft.mockImplementation(async () => {context.cloudAnnotationDraftGenerationRef.current += 1;});
  await retry(); expect(context.persistCloudAnnotationDraft).not.toHaveBeenCalled();
});
