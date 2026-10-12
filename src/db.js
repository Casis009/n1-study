/*
 * 기기 저장소 (IndexedDB). 모든 학습 데이터는 이 기기 안에만 저장된다.
 *
 * stores
 *   notes   : 오답노트          { id, at, kind, title, passage, q }
 *   cards   : 단어장(저장한 표현) { id, at, type: "kanji"|"grammar"|"compare", front, reading, meaning, extra, source }
 *   history : 풀이 기록          { id, at, kind, title, total, right, elapsedMs }
 *   meta    : 기타              { id: "current", value: <풀던 세트> }
 *   answers : 내 답변 노트(면접)  { id, at, updatedAt, cat, question, text, timerSec, followups: null | { at, model, items: [{ q, ko, intent, point }] } }
 *
 * v2: answers 스토어 추가 (없는 스토어만 만들어서 기존 데이터는 그대로)
 */
const DB_NAME = "n1-study";
const DB_VERSION = 2;
export const STORES = ["notes", "cards", "history", "meta", "answers"];

let dbPromise = null;

function open(){
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
    };
    req.onsuccess = () => { const db = req.result; db.onversionchange = () => { db.close(); dbPromise = null; }; resolve(db); };   // 다른 탭의 업그레이드를 막지 않게(다음 요청 때 다시 연다)
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

/*
 * 백업: 기기 데이터를 JSON 하나로 내보내고, 불러올 때는 id 기준으로 합친다. API 키는 넣지 않는다.
 * v1: notes/cards/history,  v2: + answers(면접 내 답변 노트). v1 파일도 그대로 불러올 수 있다.
 */
export const BACKUP_VERSION = 2;
const BACKUP_STORES = ["notes", "cards", "history", "answers"];
export async function exportAll(){
  const [notes, cards, history, answers] = await Promise.all(BACKUP_STORES.map(s => db.all(s)));
  return { app: "n1-study", version: BACKUP_VERSION, exportedAt: new Date().toISOString(), notes, cards, history, answers };
}
export async function importAll(data){
  if (!data || data.app !== "n1-study") throw new Error("N1 연습장 백업 파일이 아니에요.");
  if (Number(data.version) > BACKUP_VERSION) throw new Error("더 새 버전 앱에서 만든 백업이에요. 앱을 새로고침해 최신 버전으로 바꾼 뒤 불러오세요.");
  const counts = {};
  for (const store of BACKUP_STORES){
    const rows = Array.isArray(data[store]) ? data[store].filter(r => r && r.id) : [];
    if (rows.length) await db.putMany(store, rows);
    counts[store] = rows.length;
  }
  return counts;
}
