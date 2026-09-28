import { OCRUtils } from './ocrUtils';

describe('OCRUtils cached PDF snapshot geometry', () => {
  test('uses the snapshot image instead of an annotation SVG', () => {
    const page = document.createElement('div');
    const snapshot = document.createElement('img');
    snapshot.setAttribute('data-pdf-page-snapshot', 'true');
    Object.defineProperty(snapshot, 'naturalWidth', { value: 2000 });
    Object.defineProperty(snapshot, 'naturalHeight', { value: 1200 });
    snapshot.getBoundingClientRect = () => ({
      left: 100,
      top: 50,
      width: 1000,
      height: 600,
      right: 1100,
      bottom: 650
    });
    const overlaySvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    overlaySvg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 });
    page.append(snapshot, overlaySvg);

    const utils = new OCRUtils({ current: { 1: page } }, 1, 1, { current: new Map() });
    const geometry = utils.getViewportGeometry();

    expect(geometry.mode).toBe('snapshot');
    expect(geometry.element).toBe(snapshot);
    expect(geometry.internalWidth).toBe(2000);
    expect(geometry.scaleX).toBe(0.5);
    expect(utils.clientToCanvas(600, 350)).toEqual({ x: 1000, y: 600 });
  });
});
