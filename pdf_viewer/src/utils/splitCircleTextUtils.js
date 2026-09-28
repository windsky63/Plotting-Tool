export const formatSplitCircleTopText = (diameter, jointType) => {
  const diameterText = String(diameter || '').trim();
  const jointTypeText = String(jointType || '').trim();
  if (diameterText && jointTypeText) return `${diameterText}"${jointTypeText}`;
  return diameterText || jointTypeText;
};

export default formatSplitCircleTopText;
