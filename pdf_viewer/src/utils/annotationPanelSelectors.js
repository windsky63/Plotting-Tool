export const selectPanelTextAnnotations = currentPageAnnotations => (
  (Array.isArray(currentPageAnnotations) ? currentPageAnnotations : []).filter(annotation => (
    annotation?.type === 'text' || annotation?.isScaffoldAnnotation === true
  ))
);

