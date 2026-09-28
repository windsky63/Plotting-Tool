import {
  shouldCreatePipeSegmentOnMouseDown,
  shouldStartViewPan
} from '../pdfInteractionUtils';

describe('pdfInteractionUtils', () => {
  test('管段号模式下只有左键会创建管段号', () => {
    expect(shouldCreatePipeSegmentOnMouseDown({ pipeSegmentMode: true, button: 0 })).toBe(true);
    expect(shouldCreatePipeSegmentOnMouseDown({ pipeSegmentMode: true, button: 2 })).toBe(false);
    expect(shouldCreatePipeSegmentOnMouseDown({ pipeSegmentMode: false, button: 0 })).toBe(false);
  });

  test('右键平移在普通模式和管段号模式下都可用', () => {
    expect(shouldStartViewPan({ pipeSegmentMode: false, button: 2 })).toBe(true);
    expect(shouldStartViewPan({ pipeSegmentMode: true, button: 2 })).toBe(true);
  });

  test('左键和中键不会触发容器层平移', () => {
    expect(shouldStartViewPan({ pipeSegmentMode: false, button: 0 })).toBe(false);
    expect(shouldStartViewPan({ pipeSegmentMode: true, button: 1 })).toBe(false);
  });
});
