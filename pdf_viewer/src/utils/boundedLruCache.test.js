import { touchBoundedMapEntry, touchExistingMapEntry } from './boundedLruCache';

test('bounded map evicts the least recently used derived entry', () => {
  const cache = new Map([['a', 1], ['b', 2]]);
  expect(touchExistingMapEntry(cache, 'a')).toBe(1);
  touchBoundedMapEntry(cache, 'c', 3, 2);
  expect(Array.from(cache.keys())).toEqual(['a', 'c']);
});

test('bounded map updates without growing beyond its limit', () => {
  const cache = new Map();
  touchBoundedMapEntry(cache, 1, 'old', 2);
  touchBoundedMapEntry(cache, 1, 'new', 2);
  touchBoundedMapEntry(cache, 2, 'second', 2);
  expect(Array.from(cache.entries())).toEqual([[1, 'new'], [2, 'second']]);
});
