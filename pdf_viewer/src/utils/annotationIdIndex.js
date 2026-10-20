const hasId = annotation => annotation?.id !== undefined && annotation?.id !== null;
const bucketFor = key => {
  const type = typeof key;
  const text = ['string', 'number', 'bigint'].includes(type) ? `${type}:${String(key)}` : type;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return [hash & 31, (hash >>> 5) & 31];
};

// A read-only ID lookup with two levels of shared buckets. An edit copies
// only its affected paths, never the whole document's ID Map. No parent index
// is retained, so old snapshots can be collected when undo/save releases them.
export class AnnotationIdIndex {
  constructor(annotations, root, size) {
    this.annotations = annotations;
    this.root = root;
    this.size = size;
  }

  get(key) {
    const [outer, inner] = bucketFor(key);
    return this.root[outer]?.[inner]?.get(key);
  }

  has(key) {
    const [outer, inner] = bucketFor(key);
    return Boolean(this.root[outer]?.[inner]?.has(key));
  }

  withChanges(annotations, updates, removals = []) {
    const root = this.root.slice();
    const copiedBranches = new Set(), copiedBuckets = new Set();
    let size = this.size;
    const writableBucket = key => {
      const [outer, inner] = bucketFor(key);
      if (!copiedBranches.has(outer)) {
        root[outer] = root[outer] ? root[outer].slice() : new Array(32);
        copiedBranches.add(outer);
      }
      const bucket = outer * 32 + inner;
      if (!copiedBuckets.has(bucket)) {
        root[outer][inner] = new Map(root[outer][inner]);
        copiedBuckets.add(bucket);
      }
      return root[outer][inner];
    };
    for (const key of removals) {
      if (this.has(key) && writableBucket(key).delete(key)) size--;
    }
    for (const [key, annotation] of updates) {
      const bucket = writableBucket(key);
      if (!bucket.has(key)) size++;
      bucket.set(key, annotation);
    }
    return new AnnotationIdIndex(annotations, root, size);
  }

  // Match Map's insertion order and duplicate-ID behavior without copying a
  // separate array of all keys on each edit. Iteration is needed only on demand.
  *entries() {
    const seen = new Set();
    for (const annotation of this.annotations) {
      if (!hasId(annotation) || seen.has(annotation.id)) continue;
      seen.add(annotation.id);
      yield [annotation.id, this.get(annotation.id)];
    }
  }
  *keys() {for (const [key] of this.entries()) yield key;}
  *values() {for (const [, value] of this.entries()) yield value;}
  [Symbol.iterator]() {return this.entries();}
  forEach(callback, thisArg) {
    for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
  }
}

export const createAnnotationIdIndex = annotations => {
  const root = new Array(32);
  let size = 0;
  for (const annotation of annotations) {
    if (!hasId(annotation)) continue;
    const [outer, inner] = bucketFor(annotation.id);
    if (!root[outer]) root[outer] = new Array(32);
    if (!root[outer][inner]) root[outer][inner] = new Map();
    const bucket = root[outer][inner];
    if (!bucket.has(annotation.id)) size++;
    bucket.set(annotation.id, annotation);
  }
  return new AnnotationIdIndex(annotations, root, size);
};
