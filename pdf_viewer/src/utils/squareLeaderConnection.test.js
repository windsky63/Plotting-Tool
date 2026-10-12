import { getSquareLeaderConnection } from './squareLeaderConnection';

test.each([[100, 0, 20, 0], [-100, 0, -20, 0], [0, 100, 0, 20], [0, -100, 0, -20],
  [100, 100, 20, 20], [-100, 50, -20, 10], [40, -100, 8, -20]])(
  'leader from (%s,%s) meets the actual square border', (startX, startY, x, y) => {
    const result = getSquareLeaderConnection({ startX, startY, endX: 0, endY: 0 }, 20);
    expect(result.connectionX).toBeCloseTo(x);
    expect(result.connectionY).toBeCloseTo(y);
    expect(Math.max(Math.abs(result.connectionX), Math.abs(result.connectionY))).toBeCloseTo(20);
  });
test('offset and zoom-independent source coordinates preserve the border intersection', () => {
  expect(getSquareLeaderConnection({ startX: 200, startY: 150, endX: 100, endY: 100 }, 20))
    .toEqual({ connectionX: 120, connectionY: 110 });
});
test('origin inside the frame and coincident points do not extend the leader past its origin', () => {
  expect(getSquareLeaderConnection({ startX: 5, startY: 10, endX: 0, endY: 0 }, 20))
    .toEqual({ connectionX: 5, connectionY: 10 });
  expect(getSquareLeaderConnection({ startX: 0, startY: 0, endX: 0, endY: 0 }, 20))
    .toEqual({ connectionX: 0, connectionY: 0 });
});
