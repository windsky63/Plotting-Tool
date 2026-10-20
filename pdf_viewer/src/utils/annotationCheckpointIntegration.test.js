import fs from 'fs';
import path from 'path';
import { parse } from '@babel/parser';
import generate from '@babel/generator';
import { acknowledgeCheckpointPages } from './annotationCheckpoint';

const ast = parse(fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8'), {sourceType: 'module', plugins: ['jsx']});
const app = ast.program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'AppContent');
const checkpoint = app.body.body.find(node => node.type === 'ExpressionStatement' &&
  node.expression.callee?.name === 'useEffect' && generate(node).code.includes('const checkpointPages =')).expression.arguments[0];
const makeCheckpoint = success => {
  const context = {
    isElectron: () => false, annotationCheckpointPagesRef: {current: new Map(Array.from({length: 30}, (_, i) => [i + 1, 1]))},
    annotationCheckpointInFlightRef: {current: false}, annotationDraftDirtyRef: {current: true}, annotationCheckpointRetryRef: {current: null},
    cloudAnnotationDraftGenerationRef: {current: 1}, localAnnotationDraftFullCheckpointVersionRef: {current: 1},
    localAnnotationDraftCompletedFullVersionRef: {current: 1}, currentPageForDraftRef: {current: 30},
    undoRedoSystem: {trimHistory: jest.fn()}, acknowledgeCheckpointPages,
    setAnnotationCheckpointRetryNonce: jest.fn(), setTimeout: jest.fn(() => 42),
    window: {dispatchEvent: jest.fn()}, CustomEvent,
  };
  context.flushAnnotationDraft = jest.fn(async () => {
    if (success) context.localAnnotationDraftCompletedFullVersionRef.current = context.localAnnotationDraftFullCheckpointVersionRef.current;
    return success ? {savedAt: 'now'} : null;
  });
  const run = new Function(...Object.keys(context), `return (${generate(checkpoint).code});`)(...Object.values(context));
  return {run, context};
};
const settle = async () => {for(let i = 0; i < 8; i++) await Promise.resolve();};
test('actual App checkpoint releases resources after all 30 batch pages are committed', async () => {
  const {run, context} = makeCheckpoint(true); run(); await settle();
  expect(context.flushAnnotationDraft).toHaveBeenCalledTimes(1);
  expect(context.annotationCheckpointPagesRef.current.size).toBe(0);
  expect(context.undoRedoSystem.trimHistory).toHaveBeenCalledWith(5);
  expect(context.window.dispatchEvent).toHaveBeenCalledTimes(1);
  expect(context.annotationCheckpointInFlightRef.current).toBe(false);
});
test('failed checkpoint retains every page and schedules a retry without pruning history', async () => {
  const {run, context} = makeCheckpoint(false); run(); await settle();
  expect(context.annotationCheckpointPagesRef.current.size).toBe(30);
  expect(context.undoRedoSystem.trimHistory).not.toHaveBeenCalled();
  expect(context.setTimeout).toHaveBeenCalledWith(expect.any(Function), 30000);
});
test('an older successful save cannot release a newer full checkpoint', async () => {
  const {run, context} = makeCheckpoint(false);
  context.flushAnnotationDraft.mockResolvedValue({savedAt: 'old'});
  run(); await settle();
  expect(context.annotationCheckpointPagesRef.current.size).toBe(30);
  expect(context.undoRedoSystem.trimHistory).not.toHaveBeenCalled();
});
