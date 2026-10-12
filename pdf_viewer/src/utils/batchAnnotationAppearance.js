import { selectPanelTextAnnotations } from './annotationPanelSelectors';
import { getFixedA3TenMmFrameSize, isFixedA3TenMmShape } from './pageAnnotationScale';
import { DEFAULT_TEXT_RECTANGLE_FRAME_SIZE } from './textRectangleFrame';

export const ANNOTATION_APPEARANCE_SHAPES = [
  { value: 'circle', label: '圆形' },
  { value: 'split-circle', label: '分割圆' },
  { value: 'rectangle', label: '方形' },
  { value: 'diamond', label: '菱形' },
  { value: 'text-rectangle', label: '长方形框' },
  { value: 'pipe-tag', label: '管段框' },
  { value: 'field-weld', label: '现场焊缝' },
  { value: 'shop-weld', label: '车间焊缝' },
  { value: 'none', label: '无边框' }
];

export const parseAppearancePages = (value, totalPages) => {
  const tokens = String(value || '').trim().split(/[,，\s]+/).filter(Boolean);
  if (!tokens.length) throw new Error('请输入页码，例如 1,3-5');
  const pages = new Set();
  tokens.forEach(token => {
    const match = token.match(/^(\d+)(?:[-—–](\d+))?$/);
    const start = Number(match?.[1]);
    const end = Number(match?.[2] || match?.[1]);
    if (!match || start < 1 || end < start || end > totalPages) {
      throw new Error(`页码范围无效，请填写 1 至 ${totalPages} 页`);
    }
    for (let page = start; page <= end; page += 1) pages.add(page);
  });
  return pages;
};

export const selectAppearanceTargets = ({ annotations, scope, currentPage, selectedIds = [],
  pageRange = '', totalPages, sourceShape = 'all' }) => {
  const pages = scope === 'pages' ? parseAppearancePages(pageRange, totalPages) : null;
  const selected = new Set(selectedIds);
  return selectPanelTextAnnotations(annotations).filter(annotation => {
    const page = Number(annotation.page || 1);
    if (scope === 'current' && page !== Number(currentPage)) return false;
    if (scope === 'selected' && (page !== Number(currentPage) || !selected.has(annotation.id))) return false;
    if (scope === 'pages' && !pages.has(page)) return false;
    if (!['current', 'selected', 'pages', 'all'].includes(scope)) return false;
    return sourceShape === 'all' || annotation.borderShape === sourceShape;
  });
};

export const buildAppearanceUpdates = async ({ targets, shape = 'keep', color = null, pdfDocument }) => {
  if (shape !== 'keep' && !ANNOTATION_APPEARANCE_SHAPES.some(option => option.value === shape)) {
    throw new Error('请选择有效的框形');
  }
  if (color !== null && !/^#[0-9a-f]{6}$/i.test(color)) throw new Error('请选择有效的颜色');
  const pageSizes = new Map();
  // Automatic A3 shapes do not necessarily store their displayed size. Freeze
  // that size when switching to a shape that renders the stored frame size.
  if (shape !== 'keep' && shape !== 'text-rectangle' && !isFixedA3TenMmShape(shape)) {
    const pages = new Set(targets.filter(annotation => annotation.borderShape !== shape &&
      isFixedA3TenMmShape(annotation.borderShape)).map(annotation => Number(annotation.page || 1)));
    if (pages.size && !pdfDocument?.getPage) throw new Error('PDF页面尺寸尚未加载，请稍后再试');
    for (const page of pages) {
      const pdfPage = await pdfDocument.getPage(page);
      pageSizes.set(page, pdfPage.getViewport({ scale: 1 }));
    }
  }
  const updatesById = {};
  targets.forEach(annotation => {
    const updates = {};
    if (shape !== 'keep' && annotation.borderShape !== shape) {
      updates.borderShape = shape;
      if (shape === 'text-rectangle') updates.frameSize = DEFAULT_TEXT_RECTANGLE_FRAME_SIZE;
      else if (!isFixedA3TenMmShape(shape) && isFixedA3TenMmShape(annotation.borderShape)) {
        updates.frameSize = getFixedA3TenMmFrameSize(pageSizes.get(Number(annotation.page || 1)));
      }
      if (shape === 'split-circle') {
        updates.topFontSize = annotation.topFontSize || 16;
        updates.bottomFontSize = annotation.bottomFontSize || annotation.fontSize || 34;
      }
    }
    if (color !== null && String(annotation.color || '').toLowerCase() !== color.toLowerCase()) {
      updates.color = color;
    }
    if (Object.keys(updates).length) updatesById[annotation.id] = updates;
  });
  return updatesById;
};
