import React, { forwardRef, memo, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import styled from 'styled-components';

const PreviewLayer = styled.div`
  position: absolute;
  inset: 0;
  z-index: 1002;
  pointer-events: none;
  & * { pointer-events: none !important; }
`;

// This component, not PDFViewer/App, receives pointer-rate state updates.
const AnnotationDragPreview = memo(forwardRef(({ pageNumber, renderAnnotations }, ref) => {
  const [annotations, setAnnotations] = useState([]);
  const layer = useRef(null);
  useImperativeHandle(ref, () => ({
    update: next => setAnnotations(next),
    clear: () => setAnnotations(current => current.length ? [] : current),
  }), []);
  const hiddenIdsKey = JSON.stringify(annotations.map(a => String(a.id)));
  useLayoutEffect(() => {
    const ids = new Set(JSON.parse(hiddenIdsKey));
    if (!ids.size) return undefined;
    const originals = Array.from(layer.current?.parentElement?.querySelectorAll('[data-pdf-annotation-id]') || [])
      .filter(node => ids.has(node.getAttribute('data-pdf-annotation-id')));
    const saved = originals.map(node => [node, node.style.visibility]);
    originals.forEach(node => { node.style.visibility = 'hidden'; });
    return () => saved.forEach(([node, visibility]) => { node.style.visibility = visibility; });
  }, [hiddenIdsKey]);
  return <PreviewLayer ref={layer} data-annotation-drag-preview={pageNumber}>
    {annotations.length ? renderAnnotations(pageNumber, annotations) : null}
  </PreviewLayer>;
}));
AnnotationDragPreview.displayName = 'AnnotationDragPreview';
export default AnnotationDragPreview;
