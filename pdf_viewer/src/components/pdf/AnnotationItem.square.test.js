import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import AnnotationItem from './AnnotationItem';

test.each([[0, 100, 80, 100], [0, 50, 80, 90], [200, 200, 120, 120]])(
  'square SVG leader from (%s,%s) terminates on its rendered border', (startX, startY, x, y) => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() => root.render(<AnnotationItem
        annotation={{ id: 'square', borderShape: 'rectangle', text: 'F1', color: '#0000ff',
          startX, startY, endX: 100, endY: 100, hasLeaderLine: true }}
        scale={1} isSelected={false} annotationMode={false}
        processAnnotationText={() => ({ displayText: 'F1', fontSize: 34 })}
        calculateAnnotationSize={() => ({ circleRadius: 20, rectangleHalfSide: 20, diagonalLength: 56.7 })}
        annotationStyles={{ strokeWidth: 1, fontFamily: 'Arial', fontWeight: 'normal' }}
      />));
      const line = container.querySelector('line');
      expect(Number(line.getAttribute('x2'))).toBeCloseTo(x);
      expect(Number(line.getAttribute('y2'))).toBeCloseTo(y);
      const rect = [...container.querySelectorAll('rect')].find(node => node.getAttribute('stroke') === '#0000ff');
      expect(Number(rect.getAttribute('x'))).toBe(80);
      expect(Number(rect.getAttribute('width'))).toBe(40);
    } finally { act(() => root.unmount()); container.remove(); }
  });
