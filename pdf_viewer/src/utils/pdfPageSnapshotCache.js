const DB_NAME = 'luotu-pdf-page-snapshots';
const DB_VERSION = 1;
const STORE_NAME = 'snapshots';
const DEFAULT_SNAPSHOT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

let databasePromise = null;
let legacyScalePrunePromise = null;

// Release only the live IndexedDB connection. Stored snapshots remain on disk
// and openDatabase() will transparently reopen the database on the next read.
export const closePdfPageSnapshotCache = async () => {
  const pendingDatabase = databasePromise;
  databasePromise = null;
  if (!pendingDatabase) return false;
  try {
    const database = await pendingDatabase;
    database?.close?.();
    return Boolean(database);
  } catch (error) {
    console.debug('[PDF页面缓存] 关闭空闲数据库连接失败', error);
    return false;
  }
};

const openDatabase = () => {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.objectStoreNames.contains(STORE_NAME)
        ? request.transaction.objectStore(STORE_NAME)
        : database.createObjectStore(STORE_NAME, { keyPath: 'key' });
      if (!store.indexNames.contains('scope')) store.createIndex('scope', 'scope', { unique: false });
      if (!store.indexNames.contains('lastUsed')) store.createIndex('lastUsed', 'lastUsed', { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('PDF页面缓存数据库打开失败'));
  }).catch(error => {
    console.warn('[PDF页面缓存] IndexedDB不可用:', error);
    databasePromise = null;
    return null;
  });
  return databasePromise;
};

const runRequest = async (mode, executor) => {
  const database = await openDatabase();
  if (!database) return null;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    let request;
    let requestResult = null;
    let settled = false;
    const resolveOnce = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const rejectOnce = error => {
      if (settled) return;
      settled = true;
      reject(error || transaction.error || new Error('PDF页面缓存事务失败'));
    };
    try {
      request = executor(store);
    } catch (error) {
      rejectOnce(error);
      return;
    }
    request.onsuccess = () => {
      requestResult = request.result;
      // A write request can succeed before its transaction has committed the
      // large PNG Blob. Wait for transaction.oncomplete so the next page
      // cannot start while the previous Blob is still retained by IndexedDB.
      if (mode === 'readonly') resolveOnce(requestResult);
    };
    request.onerror = () => rejectOnce(request.error || transaction.error);
    transaction.oncomplete = () => resolveOnce(requestResult);
    transaction.onerror = () => rejectOnce(transaction.error);
    transaction.onabort = () => rejectOnce(transaction.error || new Error('PDF页面缓存事务已中止'));
  });
};

export const getPdfPageSnapshot = key => runRequest('readonly', store => store.get(key));

export const putPdfPageSnapshot = record => runRequest('readwrite', store => store.put({
  ...record,
  lastUsed: Date.now()
}));

export const listPdfSnapshotPages = async scope => {
  const database = await openDatabase();
  if (!database) return [];
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const index = transaction.objectStore(STORE_NAME).index('scope');
    const request = index.openKeyCursor(IDBKeyRange.only(scope));
    const pages = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(pages);
        return;
      }
      const match = String(cursor.primaryKey).match(/\|page:(\d+)$/);
      if (match) pages.push(Number(match[1]));
      cursor.continue();
    };
    request.onerror = () => reject(request.error || transaction.error);
  });
};

// Before snapshot:v2, each UI zoom level created a complete independent cache
// whose scope contained "|scale:". Remove those records once per browser
// session as soon as a PDF opens; they are never read by the new key format.
export const pruneLegacyScalePdfPageSnapshots = () => {
  if (legacyScalePrunePromise) return legacyScalePrunePromise;
  legacyScalePrunePromise = (async () => {
    const database = await openDatabase();
    if (!database) return 0;
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.openCursor();
      let removed = 0;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const record = cursor.value || {};
        const legacyKey = `${String(record.scope || '')}|${String(record.key || '')}`;
        if (legacyKey.includes('|scale:')) {
          cursor.delete();
          removed += 1;
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error || transaction.error);
      transaction.oncomplete = () => resolve(removed);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('旧PDF页面缓存清理已中止'));
    });
  })().catch(error => {
    legacyScalePrunePromise = null;
    throw error;
  });
  return legacyScalePrunePromise;
};

export const pruneOldPdfPageSnapshots = async (maxAgeMs = DEFAULT_SNAPSHOT_MAX_AGE_MS) => {
  const database = await openDatabase();
  if (!database) return 0;
  const cutoff = Date.now() - maxAgeMs;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const index = transaction.objectStore(STORE_NAME).index('lastUsed');
    const request = index.openCursor(IDBKeyRange.upperBound(cutoff));
    let removed = 0;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(removed);
        return;
      }
      cursor.delete();
      removed += 1;
      cursor.continue();
    };
    request.onerror = () => reject(request.error || transaction.error);
  });
};
