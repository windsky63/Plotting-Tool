const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-7;

// Capture the existing DOM once. Move frame primitives in SVG units and update
// only leader endpoints; never reparent React-owned elements.
export function createAnchoredAnnotationPreview(svg, annotation, connectionFor) {
  if (!svg || !connectionFor) return null;
  if (near(annotation.startX, annotation.endX) && near(annotation.startY, annotation.endY)) return null;
  const leaves = Array.from(svg.querySelectorAll('circle,rect,text,path,line,polygon,polyline'))
    .filter(node => !node.closest('defs'));
  const leaders = leaves.filter(node => node.tagName.toLowerCase() === 'line' &&
    near(node.getAttribute('x1'), annotation.startX) && near(node.getAttribute('y1'), annotation.startY));
  if (!leaders.length) return null;
  const startDots = leaves.filter(node => node.tagName.toLowerCase() === 'circle' &&
    near(node.getAttribute('cx'), annotation.startX) && near(node.getAttribute('cy'), annotation.startY));
  const bounds = (svg.getAttribute('viewBox') || '').split(/[ ,]+/).map(Number);
  const [bx, by, bw, bh] = bounds;
  const px = Math.min(annotation.endX - bx, bx + bw - annotation.endX);
  const py = Math.min(annotation.endY - by, by + bh - annotation.endY);
  const attrs = ['transform', 'x', 'y', 'width', 'height', 'r', 'x2', 'y2', 'values'];
  const saved = new Map(leaves.map(node => [node, new Map(attrs.map(key => [key, node.getAttribute(key)]))]));
  const stationary = new Set([...leaders, ...startDots]);
  const coordinateMatrices = new Map();
  for (const node of leaves) {
    if (stationary.has(node)) continue;
    const transformedParent = node.parentElement?.closest('g[transform]');
    if (!transformedParent) continue;
    // A frame can live inside a rotated group (pipe tags). Convert the page
    // translation into that group's coordinates instead of rotating the drag.
    if (!svg.getCTM || !node.parentElement.getCTM) return null;
    const root = svg.getCTM(), parent = node.parentElement.getCTM();
    if (!root || !parent) return null;
    coordinateMatrices.set(node, root.inverse().multiply(parent).inverse());
  }
  return {
    update(next) {
      const dx = next.endX - annotation.endX, dy = next.endY - annotation.endY;
      const connection = connectionFor(next);
      if (!connection || !Number.isFinite(connection.connectionX) || !Number.isFinite(connection.connectionY)) return false;
      const nx = Math.min(next.startX, next.endX - px), ny = Math.min(next.startY, next.endY - py);
      const nw = Math.max(next.startX, next.endX + px) - nx, nh = Math.max(next.startY, next.endY + py) - ny;
      leaves.forEach(node => {
        if (stationary.has(node)) return;
        const original = saved.get(node);
        const isBoundRect = node.tagName.toLowerCase() === 'rect' &&
          (node.parentElement === svg || node.closest('[data-preview-highlight]'));
        if (isBoundRect) {
          node.setAttribute('x', nx + Number(original.get('x')) - bx);
          node.setAttribute('y', ny + Number(original.get('y')) - by);
          node.setAttribute('width', nw + Number(original.get('width')) - bw);
          node.setAttribute('height', nh + Number(original.get('height')) - bh);
        } else {
          const matrix = coordinateMatrices.get(node);
          const tx = matrix ? matrix.a * dx + matrix.c * dy : dx;
          const ty = matrix ? matrix.b * dx + matrix.d * dy : dy;
          node.setAttribute('transform', `translate(${tx} ${ty}) ${original.get('transform') || ''}`.trim());
          if (node.tagName.toLowerCase() === 'circle' && node.closest('[data-preview-highlight]')) {
            node.setAttribute('r', Number(original.get('r')) + (Math.max(nw, nh) - Math.max(bw, bh)) / 4);
          }
        }
      });
      leaders.forEach(node => {
        const original = saved.get(node);
        const center = near(original.get('x2'), annotation.endX) && near(original.get('y2'), annotation.endY);
        node.setAttribute('x2', center ? next.endX : connection.connectionX);
        node.setAttribute('y2', center ? next.endY : connection.connectionY);
      });
      return true;
    },
    restore() {
      saved.forEach((values, node) => values.forEach((value, key) =>
        value === null ? node.removeAttribute(key) : node.setAttribute(key, value)));
    },
  };
}
