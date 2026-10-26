// Capture geometry before toBlob yields. Reading the current UI zoom in its
// callback can pair an old bitmap with a new scale and persist that mismatch.
export const capturePdfPageSnapshot = ({ canvas, isCurrent, onSnapshot, onDiscard }) => {
  const snapshotScale = Number(canvas?.dataset?.pdfSnapshotScale);
  if (!canvas?.toBlob || !canvas.width || !canvas.height || !(snapshotScale > 0)) return 'unavailable';
  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  if (!(cssWidth > 0) || !(cssHeight > 0)) return 'unavailable';
  canvas.toBlob(blob => {
    if (!blob || !isCurrent()) {
      onDiscard();
      return;
    }
    onSnapshot({ blob, cssWidth, cssHeight, snapshotScale });
  }, 'image/png');
  return 'pending';
};
