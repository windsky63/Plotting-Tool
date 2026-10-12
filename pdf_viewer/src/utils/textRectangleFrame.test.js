import {
  DEFAULT_TEXT_RECTANGLE_FRAME_SIZE,
  getAnnotationFrameSize,
  normalizeTextRectangleAnnotation,
  normalizeTextRectangleAnnotations
} from './textRectangleFrame';

describe('textRectangleFrame', () => {
  test('resets a historical custom rectangle frame to the default fit', () => {
    expect(normalizeTextRectangleAnnotation({
      id: 'rect-1',
      borderShape: 'text-rectangle',
      fontSize: 52,
      frameSize: 120
    })).toEqual({
      id: 'rect-1',
      borderShape: 'text-rectangle',
      fontSize: 52,
      frameSize: DEFAULT_TEXT_RECTANGLE_FRAME_SIZE
    });
  });

  test('does not alter frame sizes for other annotation shapes', () => {
    const circle = { borderShape: 'circle', frameSize: 84 };
    expect(normalizeTextRectangleAnnotation(circle)).toBe(circle);
    expect(getAnnotationFrameSize(circle)).toBe(84);
  });

  test.each(['auto-a3', 'fixed-px'])('restores rectangle fitting for saved %s annotations', frameSizeMode => {
    const annotation = {
      borderShape: 'text-rectangle',
      frameSize: 100,
      frameSizeMode,
      text: 'PIPE-1',
      fontSize: 34
    };
    expect(normalizeTextRectangleAnnotation(annotation)).toEqual({
      ...annotation,
      frameSize: DEFAULT_TEXT_RECTANGLE_FRAME_SIZE
    });
    expect(getAnnotationFrameSize(annotation)).toBe(DEFAULT_TEXT_RECTANGLE_FRAME_SIZE);
  });

  test('normalizes rectangle collections loaded from storage', () => {
    const result = normalizeTextRectangleAnnotations([
      { borderShape: 'text-rectangle', frameSize: 96 },
      { borderShape: 'pipe-tag', frameSize: 72 }
    ]);
    expect(result[0].frameSize).toBe(DEFAULT_TEXT_RECTANGLE_FRAME_SIZE);
    expect(result[1].frameSize).toBe(72);
  });

  test('rendering ignores a stale custom rectangle frame', () => {
    expect(getAnnotationFrameSize({
      borderShape: 'text-rectangle',
      frameSize: 200
    })).toBe(DEFAULT_TEXT_RECTANGLE_FRAME_SIZE);
  });
});
