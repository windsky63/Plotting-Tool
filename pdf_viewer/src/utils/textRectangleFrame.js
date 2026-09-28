export const DEFAULT_TEXT_RECTANGLE_FRAME_SIZE = 56.7;

export const isTextRectangleAnnotation = annotation => (
  annotation?.borderShape === 'text-rectangle'
);

// Rectangle annotations are sized by their text.  Keeping a separate,
// user-editable frame multiplier allows stale data to create large gaps.
export const normalizeTextRectangleAnnotation = annotation => {
  if (!annotation || !isTextRectangleAnnotation(annotation)) return annotation;
  if (annotation.frameSizeMode === 'auto-a3' || annotation.frameSizeMode === 'fixed-px') return annotation;
  if (Number(annotation.frameSize) === DEFAULT_TEXT_RECTANGLE_FRAME_SIZE) return annotation;
  return {
    ...annotation,
    frameSize: DEFAULT_TEXT_RECTANGLE_FRAME_SIZE
  };
};

export const normalizeTextRectangleAnnotations = annotations => (
  Array.isArray(annotations)
    ? annotations.map(normalizeTextRectangleAnnotation)
    : []
);

export const getAnnotationFrameSize = (annotation, fallback = 56.7) => {
  const storedFrameSize = Number(annotation?.frameSize);
  if (
    (annotation?.frameSizeMode === 'auto-a3' || annotation?.frameSizeMode === 'fixed-px') &&
    Number.isFinite(storedFrameSize) && storedFrameSize > 0
  ) {
    return storedFrameSize;
  }
  if (isTextRectangleAnnotation(annotation)) {
    return DEFAULT_TEXT_RECTANGLE_FRAME_SIZE;
  }
  return Number.isFinite(storedFrameSize) && storedFrameSize > 0
    ? storedFrameSize
    : fallback;
};
