import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import Toolbar from './Toolbar';

const renderToolbar = (props = {}) => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = window.matchMedia || (() => ({
    matches: false,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false
  }));
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(
    <Toolbar
      currentPage={2}
      totalPages={10}
      onPageChange={() => {}}
      onScaleChange={() => {}}
      onFileSelect={() => {}}
      {...props}
    />
  ));
  return {
    container,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
      delete global.IS_REACT_ACT_ENVIRONMENT;
    }
  };
};

const findButtonByText = (container, text) => (
  [...container.querySelectorAll('button')].find(button => button.textContent.includes(text))
);

test('common tools stay visible without a collapse toggle and auxiliary tools remain collapsible', () => {
  const { container, cleanup } = renderToolbar();
  const commonToggle = findButtonByText(container, '常用工具');
  const auxiliaryToggle = findButtonByText(container, '辅助工具');
  const commonTools = container.querySelector('#toolbar-common-tools');
  const commonTier = commonTools.parentElement;

  expect(commonToggle).toBeUndefined();
  expect(commonTools).not.toBeNull();
  expect(commonTier.lastElementChild).toBe(auxiliaryToggle);
  expect(container.querySelector('[aria-label="框型大小模式"]')).toBeNull();
  expect(container.querySelector('[aria-label="固定框型大小（px）"]')).toBeNull();
  cleanup();
});

test('shortcut help is a common toolbar button instead of a floating page button', () => {
  const { container, cleanup } = renderToolbar();
  const commonTools = container.querySelector('#toolbar-common-tools');
  const shortcutHelp = findButtonByText(container, '快捷键帮助');

  expect(shortcutHelp).toBeDefined();
  expect(commonTools.contains(shortcutHelp)).toBe(true);
  expect(getComputedStyle(shortcutHelp).position).not.toBe('fixed');
  cleanup();
});

test('recognition setup actions are shown only inside the expanded auxiliary toolbar', () => {
  const { container, cleanup } = renderToolbar();
  const auxiliaryToggle = findButtonByText(container, '辅助工具');
  const commonTools = container.querySelector('#toolbar-common-tools');
  const movedLabels = ['对照落图', '模板设置', '导入识别模板', '开始识别', '材料表识别'];

  movedLabels.forEach(label => expect(commonTools.textContent).not.toContain(label));
  act(() => auxiliaryToggle.click());
  const auxiliaryTools = container.querySelector('#toolbar-auxiliary-tools');
  movedLabels.forEach(label => expect(auxiliaryTools.textContent).toContain(label));
  cleanup();
});

test('the four page navigation controls share one height and vertical alignment', () => {
  const { container, cleanup } = renderToolbar();
  const navigation = container.querySelector('[role="group"][aria-label="页码导航"]');
  const controls = navigation.querySelectorAll('button, input');

  expect(controls).toHaveLength(4);
  controls.forEach(control => expect(getComputedStyle(control).height).toBe('32px'));
  expect(getComputedStyle(navigation).alignItems).toBe('center');
  cleanup();
});

test('PDF zoom controls and Canvas performance selector share the toolbar control height', () => {
  const { container, cleanup } = renderToolbar();
  const zoomControls = container.querySelector('[role="group"][aria-label="PDF缩放"]');
  const zoomItems = zoomControls.querySelectorAll('.ant-btn, .ant-select');
  const auxiliaryToggle = findButtonByText(container, '辅助工具');

  expect(zoomItems).toHaveLength(3);
  zoomItems.forEach(control => expect(getComputedStyle(control).height).toBe('32px'));

  act(() => auxiliaryToggle.click());
  const performanceSelect = container
    .querySelector('[aria-label="Canvas性能档位"]')
    .closest('.ant-select');
  expect(getComputedStyle(performanceSelect).height).toBe('32px');
  cleanup();
});

test.each(['circle', 'split-circle', 'pipe-tag'])('%s annotation settings fit the toolbar control height', annotationBorderShape => {
  const { container, cleanup } = renderToolbar({ annotationMode: true, annotationBorderShape });
  const group = container.querySelector('[aria-label="标注样式设置"]');
  const styles = getComputedStyle(group);

  expect(styles.height).toBe('32px');
  expect(styles.boxSizing).toBe('border-box');
  expect(styles.paddingTop).toBe('0px');
  expect(styles.paddingBottom).toBe('0px');
  group.querySelectorAll('.ant-select').forEach(control => {
    expect(getComputedStyle(control).height).toBe('32px');
  });
  cleanup();
});

test.each(['circle', 'split-circle', 'mixed'])('%s selected font settings fit the toolbar control height', type => {
  const { container, cleanup } = renderToolbar({
    annotationMode: true,
    selectedAnnotationFontTools: {
      visible: true,
      count: 2,
      type,
      mixedType: type === 'mixed',
      fontSize: 34,
      topFontSize: 16,
      bottomFontSize: 34
    }
  });
  const group = container.querySelector('[aria-label="选中标注字体设置"]');
  const styles = getComputedStyle(group);

  expect(styles.height).toBe('32px');
  expect(styles.paddingTop).toBe('0px');
  expect(styles.paddingBottom).toBe('0px');
  expect(group.style.border).toBe('');
  expect(styles.boxShadow).toBe('inset 0 0 0 1px #91caff');
  cleanup();
});
