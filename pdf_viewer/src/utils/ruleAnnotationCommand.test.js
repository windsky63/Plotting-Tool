import fs from 'fs';
import path from 'path';
import {parse} from '@babel/parser';
import generate from '@babel/generator';

const ast = parse(fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8'), {sourceType: 'module', plugins: ['jsx']});
const app = ast.program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'AppContent');
const handler = app.body.body.flatMap(node => node.declarations || [])
  .find(node => node.id.name === 'handleAnnotationAddWithRule').init;
const code = generate(handler).code;
function setup(continuous = true) {
  const context = {
    activeAnnotationRule: {id: 'r', name: 'test', prefix: 'F', currentNumber: 100, increment: 2},
    annotationRules: [{id: 'r', currentNumber: 100}],
    annotations: [{id: 'existing', page: 4}], continuousRuleNumberingEnabled: continuous, continuousRuleNumber: 100,
    annotationColor: '#f00', annotationFrameSize: 56.7, annotationPipeTagZeroPadCount: 0,
    currentPage: 4, newlyAddedAnnotations: new Set(), weldStats: {manuallyAdded: 0},
    latestAutoBatchAnnotationRef: {current: {batchRunId: 'batch-last'}},
    getAnnotationOrigin: () => 'manual', normalizeTextRectangleAnnotation: a => a,
    DEFAULT_TEXT_RECTANGLE_FRAME_SIZE: 56.7,
    generateRulePreview: r => r.prefix + r.currentNumber,
    splitRulePreviewForSplitCircle: r => ({bottomText: r.prefix + r.currentNumber, topText: '', jointTypeText: 'BW'}),
    markAnnotationDraftDirty: jest.fn(), logAuditEvent: jest.fn(), setTimeout: jest.fn(),
    handleAnnotationAdd: jest.fn(), undoRedoSystem: {executeCommand: jest.fn(c => c.execute())},
    console: {log: jest.fn()},
  };
  for (const [setter, key] of Object.entries({setAnnotations: 'annotations', setAnnotationRules: 'annotationRules',
    setActiveAnnotationRule: 'activeAnnotationRule', setContinuousRuleNumber: 'continuousRuleNumber',
    setNewlyAddedAnnotations: 'newlyAddedAnnotations', setWeldStats: 'weldStats'})) {
    context[setter] = update => {context[key] = typeof update === 'function' ? update(context[key]) : update;};
  }
  const run = () => new Function(...Object.keys(context), `return (${code});`)(...Object.values(context));
  return {context, add: a => run()(a)};
}
const annotation = {id: 'new', type: 'text', page: 4, borderShape: 'split-circle'};

test('continuous rule add, undo and redo mark the committed page dirty and preserve numbering', () => {
  const {context: c, add} = setup();
  add(annotation);
  const command = c.undoRedoSystem.executeCommand.mock.calls[0][0];
  expect(c.annotations.at(-1).text).toBe('F100');
  expect(c.continuousRuleNumber).toBe(101);
  expect(c.markAnnotationDraftDirty.mock.calls).toEqual([[4]]);
  command.undo();
  expect(c.annotations.map(a => a.id)).toEqual(['existing']);
  expect(c.continuousRuleNumber).toBe(100);
  command.execute();
  expect(c.continuousRuleNumber).toBe(101);
  expect(c.markAnnotationDraftDirty.mock.calls).toEqual([[4], [4], [4]]);
});

test('independent rule undo restores its rule without removing later unrelated annotations', () => {
  const {context: c, add} = setup(false);
  add(annotation);
  expect(c.activeAnnotationRule.currentNumber).toBe(102);
  c.annotations.push({id: 'unrelated', page: 5});
  c.undoRedoSystem.executeCommand.mock.calls[0][0].undo();
  expect(c.annotations.map(a => a.id)).toEqual(['existing', 'unrelated']);
  expect(c.activeAnnotationRule.currentNumber).toBe(100);
  expect(c.markAnnotationDraftDirty).toHaveBeenLastCalledWith(4);
});

test('rule annotation uses the current batch reference without copying the whole annotation table', () => {
  const {context: c, add} = setup();
  add(annotation);
  expect(c.annotations.at(-1)).toMatchObject({batchRunId: 'batch-last', qualityCorrection: true});
});

test('1000 continuous rule annotations advance numbering without losing existing annotations', () => {
  const {context: c, add} = setup();
  for (let i = 0; i < 1000; i++) add({...annotation, id: 'new-' + i, page: Math.floor(i / 10) + 1});
  expect(c.annotations).toHaveLength(1001);
  expect(c.annotations.slice(1).map(a => a.text)).toEqual(Array.from({length: 1000}, (_, i) => 'F' + (100 + i)));
  expect(c.continuousRuleNumber).toBe(1100);
  expect(c.markAnnotationDraftDirty).toHaveBeenCalledTimes(1000);
});
