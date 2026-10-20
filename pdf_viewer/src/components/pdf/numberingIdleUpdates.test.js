import React, {act, useCallback, useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import fs from 'fs';
import path from 'path';
import {parse} from '@babel/parser';
import generate from '@babel/generator';

// Exercise the actual viewer reset/effect together without importing its PDF,
// OCR and rendering dependencies into the regression test.
const ast = parse(fs.readFileSync(path.join(__dirname, '../PDFViewer.js'), 'utf8'), {
  sourceType: 'module', plugins: ['jsx']
});
const viewer = ast.program.body.find(node => node.type === 'VariableDeclaration' &&
  node.declarations.some(declaration => declaration.id.name === 'PDFViewer'))
  .declarations.find(declaration => declaration.id.name === 'PDFViewer').init;
const reset = viewer.body.body.find(node => node.type === 'VariableDeclaration' &&
  node.declarations.some(declaration => declaration.id.name === 'clearSinglePageNumberingSelection'))
  .declarations[0].init;
const effect = viewer.body.body.find(node => node.type === 'ExpressionStatement' &&
  node.expression.callee?.name === 'useEffect' &&
  node.expression.arguments[1]?.elements.some(element => element.name === 'numberingSegments') &&
  generate(node).code.includes('if (!showWeldNumbers)')).expression;
const instantiate = (node, context) => new Function(...Object.keys(context),
  `return (${generate(node).code});`)(...Object.values(context));

let root, container, state, initial, enabled, renders, setEnabled;
const welds = [{pathId: 1}, {pathId: 2}];
const getNumberingWeldsForPage = () => welds;
const rebuildNumberingWeldsFromSegments = () => [...welds];
const normalizeWeldPathId = Number;
function Harness() {
  renders += 1;
  if (renders > 20) throw new Error('Disabled numbering caused an update loop');
  const [showWeldNumbers, toggle] = useState(enabled);
  setEnabled = toggle;
  const [isWeldStartPickMode, setIsWeldStartPickMode] = useState(false);
  const [selectedStartWeldId, setSelectedStartWeldId] = useState(null);
  const [selectedStartWeld, setSelectedStartWeld] = useState(null);
  const [numberingSegments, setNumberingSegments] = useState(initial.segments);
  const [numberlessNumberingSegmentKeys, setNumberlessNumberingSegmentKeys] = useState(initial.hidden);
  const [orderedNumberingWelds, setOrderedNumberingWelds] = useState(initial.ordered);
  const clearSinglePageNumberingSelection = instantiate(reset, {
    useCallback, setSelectedStartWeldId, setSelectedStartWeld, setNumberingSegments,
    setNumberlessNumberingSegmentKeys, setOrderedNumberingWelds
  });
  instantiate(effect, {
    useEffect, showWeldNumbers, setIsWeldStartPickMode, clearSinglePageNumberingSelection,
    getNumberingWeldsForPage, currentPage: 1, displayedWelds: welds, selectedStartWeldId,
    setSelectedStartWeldId, setSelectedStartWeld, normalizeWeldPathId,
    setOrderedNumberingWelds, rebuildNumberingWeldsFromSegments, numberingSegments
  });
  state = {numberingSegments, numberlessNumberingSegmentKeys, orderedNumberingWelds,
    isWeldStartPickMode, selectedStartWeld, clearSinglePageNumberingSelection};
  return null;
}
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); root = createRoot(container);
  initial = {segments: [], hidden: [], ordered: []}; enabled = false; renders = 0;
});
afterEach(() => {act(() => root.unmount()); container.remove();});
const render = () => act(() => root.render(<Harness />));

test('disabled numbering settles and preserves empty array identities on rerender', () => {
  render();
  expect(renders).toBe(1);
  render();
  expect(state.numberingSegments).toBe(initial.segments);
  expect(state.numberlessNumberingSegmentKeys).toBe(initial.hidden);
  expect(state.orderedNumberingWelds).toBe(initial.ordered);
});

test('disabled numbering clears existing selections once, then settles', () => {
  initial = {segments: [{start: 1, end: 2}], hidden: ['segment'], ordered: welds};
  render();
  // React can call the component once more before bailing out unchanged state.
  expect(renders).toBeLessThanOrEqual(3);
  expect(state.numberingSegments).toEqual([]);
  expect(state.numberlessNumberingSegmentKeys).toEqual([]);
  expect(state.orderedNumberingWelds).toEqual([]);
});

test('active numbering preserves segments and hidden ranges; exit clears them', () => {
  initial = {segments: [{start: 1, end: 2}], hidden: ['segment'], ordered: []};
  enabled = true; render();
  expect(state.numberingSegments).toBe(initial.segments);
  expect(state.numberlessNumberingSegmentKeys).toBe(initial.hidden);
  expect(state.orderedNumberingWelds).toEqual(welds);
  expect(state.isWeldStartPickMode).toBe(true);
  act(() => setEnabled(false));
  expect(state.numberingSegments).toEqual([]);
  expect(state.numberlessNumberingSegmentKeys).toEqual([]);
  expect(state.orderedNumberingWelds).toEqual([]);
  expect(state.isWeldStartPickMode).toBe(false);
  const settled = renders;
  act(() => state.clearSinglePageNumberingSelection());
  expect(renders - settled).toBeLessThanOrEqual(1);
});
