/**
 * 矢量类型兼容工具
 *
 * 当前 OCR / SVG / PyMuPDF 提取链路里，直线通常编码为 `0`。
 * 历史逻辑里也出现过把 `1` 当直线的判断，因此这里统一兼容。
 */

export function isLineVectorType(type) {
  return type === 0 || type === 1 || type === 'line' || type === 'l';
}

export function getVectorSegmentType(type) {
  return isLineVectorType(type) ? 'line' : 'curve';
}
