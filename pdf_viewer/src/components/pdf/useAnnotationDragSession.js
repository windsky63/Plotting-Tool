import { useLayoutEffect, useRef } from 'react';

// Pointer-rate changes stay outside the document/React parent state. The page
// preview owns its own small state; only mouseup/blur commits one transaction.
export function useAnnotationDragSession(options) {
  const latest = useRef(options);
  const session = useRef(null);
  useLayoutEffect(() => { latest.current = options; });

  useLayoutEffect(() => {
    if (!options.draggingAnnotation || options.enabled === false) return undefined;
    const initial = latest.current;
    const source = initial.annotations.find(a => a.id === initial.draggingAnnotation);
    if (!source) {
      initial.setDraggingAnnotation(null);
      return undefined;
    }
    const selected = new Set(initial.multiSelectedAnnotationIds || []);
    const group = selected.size > 1 && selected.has(source.id) && initial.multiAnnotationStartPositions;
    const originals = group
      ? initial.annotations.filter(a => selected.has(a.id) && initial.multiAnnotationStartPositions[a.id])
      : [source];
    let frame = null;
    let pointer = null;
    let stopped = false;
    const reset = () => {
      latest.current.onAnnotationDragPreview?.([]);
      latest.current.setDraggingAnnotation(null);
      latest.current.setDragType(null);
    };
    const moves = () => {
      if (!pointer) return [];
      const rect = initial.containerRef.current?.getBoundingClientRect();
      if (!rect || !(initial.scale > 0)) return [];
      const dx = (pointer.x - rect.left - initial.annotationDragStart.x) / initial.scale;
      const dy = (pointer.y - rect.top - initial.annotationDragStart.y) / initial.scale;
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return [];
      return originals.map(annotation => {
        const start = group ? initial.multiAnnotationStartPositions[annotation.id] : initial.annotationStartPos;
        const moveStart = group || initial.dragType !== 'annotation';
        return { annotation, id: annotation.id, updates: {
          startX: start.startX + (moveStart ? dx : 0),
          startY: start.startY + (moveStart ? dy : 0),
          endX: start.endX + dx,
          endY: start.endY + dy,
        } };
      });
    };
    const stop = commit => {
      if (stopped) return;
      stopped = true;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      try {
        if (commit) {
          const changes = moves().filter(({ annotation, updates }) =>
            Object.keys(updates).some(key => annotation[key] !== updates[key]));
          if (changes.length) {
            const patches = changes.map(({ id, updates }) => ({ id, updates }));
            if (latest.current.onAnnotationMoveCommit) latest.current.onAnnotationMoveCommit(patches);
            else patches.forEach(({ id, updates }) => latest.current.onAnnotationUpdate?.(id, updates));
          }
        }
      } finally {
        reset();
      }
    };
    session.current = {
      cancel: () => stop(false), annotations: initial.annotations,
      scope: [initial.currentPage, initial.scale, initial.documentKey, initial.enabled],
    };
    const move = event => {
      if (stopped) return;
      event.preventDefault();
      pointer = { x: event.clientX, y: event.clientY };
      if (frame === null) frame = requestAnimationFrame(() => {
        frame = null;
        if (!stopped) latest.current.onAnnotationDragPreview?.(
          moves().map(({ annotation, updates }) => ({ ...annotation, ...updates })));
      });
    };
    const up = event => {
      const matches = initial.dragType === 'annotation' ? event.button === 2
        : initial.dragType === 'leader' ? event.button === 0 : event.button === 0 || event.button === 2;
      if (!matches || stopped) return;
      // Include the final coordinates even when mouseup precedes the next RAF.
      pointer = { x: event.clientX, y: event.clientY };
      stop(true);
    };
    const blur = () => stop(true);
    const visibility = () => { if (document.hidden) stop(true); };
    const key = event => { if (event.key === 'Escape') stop(false); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up, true);
    document.addEventListener('keydown', key);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('blur', blur);
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = 'move';
    return () => {
      stopped = true;
      if (frame !== null) cancelAnimationFrame(frame);
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up, true);
      document.removeEventListener('keydown', key);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('blur', blur);
      latest.current.onAnnotationDragPreview?.([]);
      document.body.style.cursor = previousCursor;
      session.current = null;
    };
    // All other values are captured once at drag start or accessed via latest.
    // Parent saves/selection rerenders must not restart an in-flight gesture.
  }, [options.draggingAnnotation]);

  useLayoutEffect(() => {
    const next = [options.currentPage, options.scale, options.documentKey, options.enabled];
    if (session.current && next.some((value, i) => value !== session.current.scope[i])) session.current.cancel();
    // An external edit/undo/file replacement must not be overwritten by old
    // drag coordinates. Committing our own move has already stopped the session.
    if (session.current && session.current.annotations !== options.annotations) session.current.cancel();
  }, [options.currentPage, options.scale, options.documentKey, options.enabled, options.annotations]);
}
