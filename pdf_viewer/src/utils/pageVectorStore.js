export function estimateVectorBytes(value) {
  const seen = new WeakSet(), stack = [value]; let bytes = 0;
  while (stack.length) {
    const item = stack.pop();
    if (typeof item === 'string') bytes += item.length * 2;
    else if (typeof item === 'number') bytes += 8;
    else if (item && typeof item === 'object' && !seen.has(item)) {
      seen.add(item);
      if (ArrayBuffer.isView(item)) bytes += item.byteLength;
      else { bytes += 64; Object.entries(item).forEach(([key, v]) => { bytes += key.length * 2 + 16; stack.push(v); }); }
    }
  }
  return bytes;
}

let dbPromise;
const vectorDb = () => {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('矢量磁盘缓存不可用'));
  if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('pdf_viewer_page_vectors', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('pages', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { dbPromise = null; reject(request.error); };
    request.onblocked = () => { dbPromise = null; reject(new Error('矢量磁盘缓存被占用')); };
  });
  return dbPromise;
};
export const vectorDiskStorage = {
  async write(id, vectors) {
    const db = await vectorDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('pages', 'readwrite');
      tx.objectStore('pages').put({ id, vectors, savedAt: Date.now() });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  },
  async read(id) {
    const db = await vectorDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('pages', 'readonly'); const request = tx.objectStore('pages').get(id);
      request.onsuccess = () => resolve(request.result?.vectors || null); request.onerror = () => reject(request.error);
    });
  },
};

export class PageVectorStore {
  constructor({ storage = vectorDiskStorage, maxPages = 5, maxBytes = 32 * 1024 * 1024, rebuild = null } = {}) {
    this.storage = storage; this.maxPages = maxPages; this.maxBytes = maxBytes; this.rebuild = rebuild;
    this.scope = ''; this.generation = 0; this.resident = {}; this.lru = new Map(); this.known = new Map();
  }
  activate(scope) {
    if (scope === this.scope) return;
    this.scope = scope; this.generation++; this.resident = {}; this.lru.clear(); this.known.clear();
  }
  clearResident() { this.resident = {}; this.lru.clear(); this.generation++; }
  trim() {
    let bytes = Array.from(this.lru.values()).reduce((a, b) => a + b, 0);
    while (this.lru.size > 1 && (this.lru.size > this.maxPages || bytes > this.maxBytes)) {
      const page = this.lru.keys().next().value;
      bytes -= this.lru.get(page); this.lru.delete(page); delete this.resident[page];
    }
  }
  retain(page, vectors) {
    this.resident[page] = vectors; this.known.set(Number(page), vectors.length);
    this.lru.delete(Number(page)); this.lru.set(Number(page), estimateVectorBytes(vectors)); this.trim();
    return vectors;
  }
  async set(page, vectors) {
    const scope = this.scope, generation = this.generation;
    try { await this.storage.write(`${scope}|page:${page}`, vectors); }
    catch (error) { if (!this.rebuild) throw error; this.lastDiskError = error.message; }
    if (scope !== this.scope || generation !== this.generation) return vectors;
    return this.retain(Number(page), vectors);
  }
  async get(page) {
    page = Number(page);
    if (this.resident[page]) return this.retain(page, this.resident[page]);
    const scope = this.scope, generation = this.generation;
    let vectors;
    try { vectors = await this.storage.read(`${scope}|page:${page}`); } catch (error) { this.lastDiskError = error.message; }
    if (!vectors && this.rebuild) vectors = await this.rebuild(page, scope);
    if (scope !== this.scope || generation !== this.generation) throw new Error('矢量读取期间文档已切换');
    if (!vectors) {
      if (this.known.has(page)) throw new Error(`第 ${page} 页矢量缓存缺失`);
      return [];
    }
    return this.retain(page, vectors);
  }
  getSummary() { return Object.fromEntries(Array.from(this.known, ([page, vectorCount]) => [page, { vectorCount, archived: true }])); }
  getStats() { return { scope: this.scope, residentPages: this.lru.size, knownPages: this.known.size,
    estimatedBytes: Array.from(this.lru.values()).reduce((a, b) => a + b, 0), maxPages: this.maxPages, maxBytes: this.maxBytes, diskError: this.lastDiskError || '' }; }
}
