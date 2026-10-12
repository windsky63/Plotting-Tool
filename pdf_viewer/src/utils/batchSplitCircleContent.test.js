import { buildBatchSplitCircleContentUpdates as build } from './batchSplitCircleContent';
const targets = [
  { id: 'a', borderShape: 'split-circle', text: 'F1', topText: '4', jointTypeText: 'BW' },
  { id: 'b', borderShape: 'split-circle', text: 'F2', topText: '4', jointTypeText: 'BW' },
  { id: 'c', borderShape: 'circle', text: 'F3' }
];
test('fills diameter and joint together in one set of patches', () => {
  expect(build({ targets, diameter: '6', jointType: 'FW' })).toEqual({
    a: { topText: '6', jointTypeText: 'FW' }, b: { topText: '6', jointTypeText: 'FW' }
  });
});
test.each([['6', '', { topText: '6' }], ['', 'FW', { jointTypeText: 'FW' }]])(
  'only filled fields change (%s, %s)', (diameter, jointType, patch) => {
    expect(build({ targets, diameter, jointType })).toEqual({ a: patch, b: patch });
  });
test('one weld-number range restricts both fields', () => {
  expect(build({ targets, diameter: '6', jointType: 'FW', rangeText: '2' }))
    .toEqual({ b: { topText: '6', jointTypeText: 'FW' } });
});
test('keeps multiple-diameter protection without blocking joint-only filling', () => {
  expect(() => build({ targets, diameter: '6', requireDiameterRange: true })).toThrow('多种管子寸径');
  expect(build({ targets, jointType: 'FW', requireDiameterRange: true })).toEqual({
    a: { jointTypeText: 'FW' }, b: { jointTypeText: 'FW' }
  });
});
test('empty fields, invalid ranges and empty matches never produce partial updates', () => {
  expect(() => build({ targets })).toThrow('至少填写');
  expect(() => build({ targets, diameter: '6', jointType: 'FW', rangeText: 'bad' })).toThrow('范围格式');
  expect(() => build({ targets, diameter: '6', jointType: 'FW', rangeText: '9' })).toThrow('没有找到');
});
test('matching values are a no-op and source annotations stay unchanged', () => {
  const before = JSON.stringify(targets);
  expect(build({ targets, diameter: '4', jointType: 'BW' })).toEqual({});
  expect(JSON.stringify(targets)).toBe(before);
});
