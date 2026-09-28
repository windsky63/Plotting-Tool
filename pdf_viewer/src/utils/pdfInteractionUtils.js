export const shouldStartViewPan = ({ button }) => button === 2;

export const shouldCreatePipeSegmentOnMouseDown = ({ pipeSegmentMode, button }) => (
  pipeSegmentMode && button === 0
);
