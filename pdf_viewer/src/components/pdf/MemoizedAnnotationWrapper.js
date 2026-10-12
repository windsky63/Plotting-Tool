import React, { memo } from 'react';

/**
 * 标注包装器组件 - 使用 React.memo 优化
 * 每个标注成为独立的组件，只有自身变化时才重新渲染
 */
const MemoizedAnnotationWrapper = memo(({ 
  annotation,
  scale,
  selectedAnnotation,
  interactionDisabled,
  children 
}) => {
  // 这个组件只是一个透明的包装器
  // 它的作用是通过 React.memo 阻止不必要的重渲染
  return children;
}, (prevProps, nextProps) => {
  // 自定义比较函数：返回 true 表示props相等，不需要重新渲染
  const prev = prevProps.annotation;
  const next = nextProps.annotation;
  
  // 检查标注是否被选中（selectedAnnotation 是字符串 id）
  const wasSelected = prevProps.selectedAnnotation === prev.id;
  const isSelected = nextProps.selectedAnnotation === next.id;
  const wasMultiSelected = !!prevProps.isMultiSelected;
  const isMultiSelected = !!nextProps.isMultiSelected;
  
  // 快速比较关键属性
  const isEqual = (
    // Every annotation update replaces that annotation object. Reusing the
    // previous children for a new object would retain stale display metadata
    // and event closures even when the page-level renderer correctly reruns.
    prev === next &&
    // Children contain event closures. A changed renderer must refresh those
    // closures, otherwise cached annotations retain stale selections/documents.
    prevProps.renderContext === nextProps.renderContext &&
    prev.id === next.id &&
    prev.text === next.text &&
    prev.topText === next.topText &&
    prev.materialNumber === next.materialNumber &&
    prev.startX === next.startX &&
    prev.startY === next.startY &&
    prev.endX === next.endX &&
    prev.endY === next.endY &&
    prev.color === next.color &&
    prev.fontSize === next.fontSize &&
    prev.topFontSize === next.topFontSize &&
    prev.bottomFontSize === next.bottomFontSize &&
    prev.frameSize === next.frameSize &&
    prev.borderShape === next.borderShape &&
    prev.rotation === next.rotation &&
    prev.hasLeaderLine === next.hasLeaderLine &&
    prevProps.scale === nextProps.scale &&
    prevProps.interactionDisabled === nextProps.interactionDisabled &&
    wasSelected === isSelected &&
    wasMultiSelected === isMultiSelected
  );
  
  return isEqual;
});

MemoizedAnnotationWrapper.displayName = 'MemoizedAnnotationWrapper';

export default MemoizedAnnotationWrapper;

