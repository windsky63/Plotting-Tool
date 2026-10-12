import { useCallback, useEffect, useRef, useState } from 'react';

export default function useAnnotationPanelResize({ visible, onWidthChange, onToggle }) {
  const latest = useRef(null);
  latest.current = { onWidthChange, onToggle };
  const session = useRef(null);
  const [isResizing, setIsResizing] = useState(false);
  const startResize = useCallback(event => {
    if (event.button !== 0) return;
    event.preventDefault();
    session.current?.cancel();
    const start = { x: event.clientX, y: event.clientY };
    let pointer = start;
    let frame = null;
    let moved = false;
    let stopped = false;
    const cursor = document.body.style.cursor;
    const userSelect = document.body.style.userSelect;
    const apply = () => {
      if (!moved) return;
      const maxWidth = Math.max(280, Math.min(1280, window.innerWidth - 40));
      const minWidth = Math.min(560, maxWidth);
      latest.current.onWidthChange(Math.max(minWidth, Math.min(maxWidth, window.innerWidth - pointer.x)));
    };
    const finish = (event, cancel = false) => {
      if (stopped) return;
      stopped = true;
      if (event && !cancel) pointer = { x: event.clientX, y: event.clientY };
      if (frame !== null) cancelAnimationFrame(frame);
      if (!cancel) {
        moved = moved || Math.abs(pointer.x - start.x) > 2 || Math.abs(pointer.y - start.y) > 2;
        apply();
        if (!moved) latest.current.onToggle?.();
      }
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      window.removeEventListener('blur', blur);
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
      session.current = null;
      setIsResizing(false);
    };
    const move = event => {
      event.preventDefault();
      pointer = { x: event.clientX, y: event.clientY };
      if (!moved && (Math.abs(pointer.x - start.x) > 2 || Math.abs(pointer.y - start.y) > 2)) {
        moved = true;
        setIsResizing(true);
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      }
      if (moved && frame === null) frame = requestAnimationFrame(() => { frame = null; apply(); });
    };
    const up = event => { if (event.button === 0) finish(event); };
    const blur = () => finish(null, true);
    session.current = { cancel: () => finish(null, true) };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    window.addEventListener('blur', blur);
  }, []);
  useEffect(() => () => session.current?.cancel(), [visible]);
  return { startResize, isResizing };
}
