import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import MemoizedAnnotationWrapper from './MemoizedAnnotationWrapper';

describe('MemoizedAnnotationWrapper', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    global.IS_REACT_ACT_ENVIRONMENT = false;
  });

  test('refreshes children when annotation metadata changes', () => {
    const renderAnnotation = annotation => (
      <MemoizedAnnotationWrapper
        annotation={annotation}
        scale={1}
        selectedAnnotation={null}
        isMultiSelected={false}
        interactionDisabled={false}
        renderContext="stable-renderer"
      >
        <button type="button">{annotation.jointTypeText}</button>
      </MemoizedAnnotationWrapper>
    );

    act(() => root.render(renderAnnotation({ id: 'a', text: '1', jointTypeText: 'BW' })));
    act(() => root.render(renderAnnotation({ id: 'a', text: '1', jointTypeText: 'SW' })));

    expect(container.textContent).toBe('SW');
  });

  test('refreshes event closures when the annotation object changes', () => {
    let clickedRemark = '';
    const renderAnnotation = annotation => (
      <MemoizedAnnotationWrapper
        annotation={annotation}
        scale={1}
        selectedAnnotation={null}
        isMultiSelected={false}
        interactionDisabled={false}
        renderContext="stable-renderer"
      >
        <button type="button" onClick={() => { clickedRemark = annotation.remark; }}>edit</button>
      </MemoizedAnnotationWrapper>
    );

    act(() => root.render(renderAnnotation({ id: 'a', text: '1', remark: 'old' })));
    act(() => root.render(renderAnnotation({ id: 'a', text: '1', remark: 'new' })));
    act(() => container.querySelector('button').click());

    expect(clickedRemark).toBe('new');
  });
});
