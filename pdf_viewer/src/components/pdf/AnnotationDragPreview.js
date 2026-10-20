import React, { forwardRef, memo, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { getAnnotationDragTranslation, getAnnotationFrameDragTranslation } from '../../utils/annotationDragTranslation';
import { createAnchoredAnnotationPreview } from '../../utils/anchoredAnnotationPreview';

const PreviewLayer = styled.div`
  position: absolute;
  inset: 0;
  z-index: 1002;
  pointer-events: none;
  & * { pointer-events: none !important; }
`;

// This component, not PDFViewer/App, receives pointer-rate state updates.
const AnnotationDragPreview = memo(forwardRef(({ pageNumber, renderAnnotations, createLeaderConnection, scale = 1 }, ref) => {
  const [annotations, setAnnotations] = useState([]);
  const layer = useRef(null);
  const baseline = useRef([]);
  const anchored = useRef(new Map());
  const resetAnchored = () => {
    anchored.current.forEach(value => value.restore()); anchored.current.clear();
  };
  useImperativeHandle(ref, () => ({
    update: next => {
      const translation = getAnnotationDragTranslation(baseline.current, next);
      if (translation && layer.current) {
        resetAnchored();
        layer.current.style.transform = `translate(${translation.dx * scale}px, ${translation.dy * scale}px)`;
        return;
      }
      if (createLeaderConnection && getAnnotationFrameDragTranslation(baseline.current, next)) {
        const svgs = Array.from(layer.current?.querySelectorAll('svg[data-preview-id]') || []);
        const ready = baseline.current.every(annotation => {
          if (!anchored.current.has(annotation.id)) {
            const svg = svgs.find(node => node.getAttribute('data-preview-id') === String(annotation.id));
            const updater = createAnchoredAnnotationPreview(svg, annotation, createLeaderConnection(annotation));
            if (!updater) return false;
            anchored.current.set(annotation.id, updater);
          }
          return true;
        });
        if (ready && next.every(annotation => anchored.current.get(annotation.id).update(annotation))) return;
      }
      resetAnchored();
      baseline.current = next;
      if (layer.current) layer.current.style.transform = '';
      setAnnotations(next);
    },
    clear: () => {
      resetAnchored();
      baseline.current = [];
      if (layer.current) layer.current.style.transform = '';
      setAnnotations(current => current.length ? [] : current);
    },
  }), [scale, createLeaderConnection]);
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
