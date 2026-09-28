export const touchBoundedMapEntry = (map, key, value, limit = 1) => {
  if (!(map instanceof Map)) return value;
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  const normalizedLimit = Math.max(1, Number(limit) || 1);
  while (map.size > normalizedLimit) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
  return value;
};

export const touchExistingMapEntry = (map, key) => {
  if (!(map instanceof Map) || !map.has(key)) return undefined;
  const value = map.get(key);
  map.delete(key);
  map.set(key, value);
  return value;
};
