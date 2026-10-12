import { scaleAnnotationValue } from './pageAnnotationScale';

export const buildBatchFontUpdates = async ({ targets, regularSize, topSize, bottomSize, pdfDocument }) => {
  const hasSplit = targets.some(annotation => annotation.borderShape === 'split-circle');
  const hasRegular = targets.some(annotation => annotation.borderShape !== 'split-circle');
  const values = [...(hasSplit ? [topSize, bottomSize] : []), ...(hasRegular ? [regularSize] : [])];
  if (values.some(value => !Number.isFinite(Number(value)) || Number(value) < 6 || Number(value) > 96)) {
    throw new Error('请输入 6 至 96 的有效字号');
  }
  if (!targets.length) return {};
  if (!pdfDocument?.getPage) throw new Error('PDF页面尺寸尚未加载，请稍后再试');
  const pageNumbers = [...new Set(targets.map(annotation => Number(annotation.page || 1)))];
  const pageSizes = new Map();
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(6, pageNumbers.length) }, async () => {
    while (index < pageNumbers.length) {
      const page = pageNumbers[index++];
      const pdfPage = await pdfDocument.getPage(page);
      pageSizes.set(page, pdfPage.getViewport({ scale: 1 }));
    }
  }));
  const updatesById = {};
  targets.forEach(annotation => {
    const pageSize = pageSizes.get(Number(annotation.page || 1));
    const updates = annotation.borderShape === 'split-circle'
      ? { topFontSize: scaleAnnotationValue(topSize, pageSize), bottomFontSize: scaleAnnotationValue(bottomSize, pageSize) }
      : { fontSize: scaleAnnotationValue(regularSize, pageSize) };
    if (Object.keys(updates).some(key => annotation[key] !== updates[key])) updatesById[annotation.id] = updates;
  });
  return updatesById;
};
