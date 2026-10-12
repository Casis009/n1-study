/*
 * 기기 저장소 (IndexedDB). 모든 학습 데이터는 이 기기 안에만 저장된다.
 *
 * stores
 *   notes   : 오답노트          { id, at, kind, title, passage, q }
 *   cards   : 단어장(저장한 표현) { id, at, type: "kanji"|"grammar"|"compare", front, reading, meaning, extra, source }
 *   history : 풀이 기록          { id, at, kind, title, total, right, elapsedMs }
 *   meta    : 기타              { id: "current", value: <풀던 세트> }
 */
const DB_NAME = "n1-study";
const DB_VERSION = 1;
export const STORES = ["notes", "cards", "history", "meta"];

let dbPromise = null;

function open(){
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn){
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}
const wrap = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const db = {
  all: store => tx(store, "readonly", s => wrap(s.getAll())),
  get: (store, id) => tx(store, "readonly", s => wrap(s.get(id))),
  put: (store, value) => tx(store, "readwrite", s => { s.put(value); }),
  putMany: (store, values) => tx(store, "readwrite", s => { for (const v of values) s.put(v); }),
  del: (store, id) => tx(store, "readwrite", s => { s.delete(id); }),
  clear: store => tx(store, "readwrite", s => { s.clear(); }),
};

/* 브라우저가 공간이 부족할 때 데이터를 지우지 않도록 요청한다. */
export async function requestPersist(){
  try {
    if (!navigator.storage?.persist) return "unsupported";
    if (await navigator.storage.persisted()) return "granted";
    return (await navigator.storage.persist()) ? "granted" : "denied";
  } catch { return "unsupported"; }
}
export async function persistState(){
  try {
    if (!navigator.storage?.persisted) return "unsupported";
    return (await navigator.storage.persisted()) ? "granted" : "denied";
  } catch { return "unsupported"; }
}

/* 백업: 기기 데이터를 JSON 하나로 내보내고, 불러올 때는 id 기준으로 합친다. */
export async function exportAll(){
  const [notes, cards, history] = await Promise.all([db.all("notes"), db.all("cards"), db.all("history")]);
  return { app: "n1-study", version: 1, exportedAt: new Date().toISOString(), notes, cards, history };
}
export async function importAll(data){
  if (!data || data.app !== "n1-study") throw new Error("N1 연습장 백업 파일이 아니에요.");
  const counts = {};
  for (const store of ["notes", "cards", "history"]){
    const rows = Array.isArray(data[store]) ? data[store].filter(r => r && r.id) : [];
    if (rows.length) await db.putMany(store, rows);
    counts[store] = rows.length;
  }
  return counts;
}
