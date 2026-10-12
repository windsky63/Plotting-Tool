// Intersect the direction from the square's centre to the leader origin with
// its actual border. halfSide is the rendered half-width, not the diagonal.
export const getSquareLeaderConnection = (annotation, halfSide) => {
  const dx = annotation.startX - annotation.endX;
  const dy = annotation.startY - annotation.endY;
  const extent = Math.max(Math.abs(dx), Math.abs(dy));
  if (!extent || !(halfSide > 0)) {
    return { connectionX: annotation.endX, connectionY: annotation.endY };
  }
  const ratio = Math.min(1, halfSide / extent);
  return {
    connectionX: annotation.endX + dx * ratio,
    connectionY: annotation.endY + dy * ratio
  };
};
