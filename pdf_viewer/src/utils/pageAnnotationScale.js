const A3_LONG_EDGE_MM = 420;
const A3_SHORT_EDGE_MM = 297;
const PDF_POINTS_PER_MM = 72 / 25.4;
const A3_LONG_EDGE_PT = A3_LONG_EDGE_MM * PDF_POINTS_PER_MM;
const A3_SHORT_EDGE_PT = A3_SHORT_EDGE_MM * PDF_POINTS_PER_MM;
const ANNOTATION_UNITS_PER_PDF_POINT = 2;
const MIN_ANNOTATION_PAGE_SCALE = 0.5;
const MAX_ANNOTATION_PAGE_SCALE = 4;

export const getPageAnnotationScale = (pageSize) => {
  const widthMM = Number(pageSize?.widthMM);
  const heightMM = Number(pageSize?.heightMM);

  if (Number.isFinite(widthMM) && Number.isFinite(heightMM) && widthMM > 0 && heightMM > 0) {
    const longEdgeMM = Math.max(widthMM, heightMM);
    const shortEdgeMM = Math.min(widthMM, heightMM);
    const printScaleToA3 = Math.min(
      A3_LONG_EDGE_MM / longEdgeMM,
      A3_SHORT_EDGE_MM / shortEdgeMM
    );

    if (!Number.isFinite(printScaleToA3) || printScaleToA3 <= 0) {
      return 1;
    }

    return Math.min(
      MAX_ANNOTATION_PAGE_SCALE,
      Math.max(MIN_ANNOTATION_PAGE_SCALE, 1 / printScaleToA3)
    );
  }

  const width = Number(pageSize?.width);
  const height = Number(pageSize?.height);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 1;
  }

  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const printScaleToA3 = Math.min(
    A3_LONG_EDGE_PT / longEdge,
    A3_SHORT_EDGE_PT / shortEdge
  );

  if (!Number.isFinite(printScaleToA3) || printScaleToA3 <= 0) {
    return 1;
  }

  return Math.min(
    MAX_ANNOTATION_PAGE_SCALE,
    Math.max(MIN_ANNOTATION_PAGE_SCALE, 1 / printScaleToA3)
  );
};

export const scaleAnnotationValue = (value, pageSize, fallback = value) => {
  const numericValue = Number(value);
  const baseValue = Number.isFinite(numericValue) ? numericValue : fallback;
  return baseValue * getPageAnnotationScale(pageSize);
};

// Circle/diamond annotations use the viewer's fixed 2x PDF coordinate space.
// Return the source-page diameter/diagonal which becomes exactly 10 mm after
// the complete page is fitted to A3 for printing. This intentionally has no
// min/max clamp: the 10 mm printed-size requirement is a document invariant.
export const getFixedA3TenMmFrameSize = (pageSize) => {
  const widthMM = Number(pageSize?.widthMM);
  const heightMM = Number(pageSize?.heightMM);
  let printScaleToA3 = 1;

  if (Number.isFinite(widthMM) && Number.isFinite(heightMM) && widthMM > 0 && heightMM > 0) {
    printScaleToA3 = Math.min(
      A3_LONG_EDGE_MM / Math.max(widthMM, heightMM),
      A3_SHORT_EDGE_MM / Math.min(widthMM, heightMM)
    );
  } else {
    const width = Number(pageSize?.width);
    const height = Number(pageSize?.height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      printScaleToA3 = Math.min(
        A3_LONG_EDGE_PT / Math.max(width, height),
        A3_SHORT_EDGE_PT / Math.min(width, height)
      );
    }
  }

  if (!Number.isFinite(printScaleToA3) || printScaleToA3 <= 0) printScaleToA3 = 1;
  return (10 * PDF_POINTS_PER_MM * ANNOTATION_UNITS_PER_PDF_POINT) / printScaleToA3;
};

// A cached page image stores its CSS dimensions at the UI zoom at which it
// was produced. Annotation coordinates, however, always live in the fixed
// 2x-PDF-point coordinate space. Reconstruct the physical page dimensions so
// image-first rendering uses exactly the same A3 sizing calculation as the
// PDF.js page and the exported PDF.
export const getAnnotationPageSizeFromSnapshot = (snapshot) => {
  const cssWidth = Number(snapshot?.cssWidth ?? snapshot?.width);
  const cssHeight = Number(snapshot?.cssHeight ?? snapshot?.height);
  const snapshotScale = Number(snapshot?.snapshotScale);

  if (
    !Number.isFinite(cssWidth) || cssWidth <= 0 ||
    !Number.isFinite(cssHeight) || cssHeight <= 0 ||
    !Number.isFinite(snapshotScale) || snapshotScale <= 0
  ) {
    return null;
  }

  const annotationWidth = cssWidth / snapshotScale;
  const annotationHeight = cssHeight / snapshotScale;
  const pdfWidth = annotationWidth / ANNOTATION_UNITS_PER_PDF_POINT;
  const pdfHeight = annotationHeight / ANNOTATION_UNITS_PER_PDF_POINT;

  return {
    width: annotationWidth,
    height: annotationHeight,
    widthMM: pdfWidth / PDF_POINTS_PER_MM,
    heightMM: pdfHeight / PDF_POINTS_PER_MM
  };
};

export const isFixedA3TenMmShape = borderShape => (
  borderShape === 'circle' ||
  borderShape === 'split-circle' ||
  borderShape === 'diamond'
);
