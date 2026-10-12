import { getAnnotationWeldNumber, parseWeldNumberRanges, weldNumberInRanges } from './weldNumberRangeUtils';

export const buildBatchSplitCircleContentUpdates = ({ targets, diameter = '', jointType = '',
  rangeText = '', requireDiameterRange = false }) => {
  const nextDiameter = String(diameter).trim();
  const nextJointType = String(jointType).trim();
  if (!nextDiameter && !nextJointType) throw new Error('请至少填写寸径或接头类型');
  const parsed = parseWeldNumberRanges(rangeText);
  if (!parsed.valid) throw new Error(`焊口号范围格式不正确：${parsed.invalidParts.join('、')}`);
  if (nextDiameter && requireDiameterRange && !parsed.ranges.length) {
    throw new Error('当前页存在多种管子寸径，请先填写焊口号范围，或选中需要修改的焊口');
  }
  const effectiveTargets = targets.filter(annotation => annotation.borderShape === 'split-circle' &&
    !annotation.isScaffoldAnnotation && !annotation.isWeldedSupport &&
    (!parsed.ranges.length || weldNumberInRanges(getAnnotationWeldNumber(annotation), parsed.ranges)));
  if (!effectiveTargets.length) throw new Error('指定范围内没有找到当前页焊口');
  const updatesById = {};
  effectiveTargets.forEach(annotation => {
    const updates = {
      ...(nextDiameter ? { topText: nextDiameter } : {}),
      ...(nextJointType ? { jointTypeText: nextJointType } : {})
    };
    if (Object.keys(updates).some(key => annotation[key] !== updates[key])) updatesById[annotation.id] = updates;
  });
  return updatesById;
};
