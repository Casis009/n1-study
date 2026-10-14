/*
 * 기기 저장소 (IndexedDB). 주 저장소는 언제나 이 기기. 구글 로그인하면 SYNC_STORES의 변경만 Firestore로 동기화한다(src/sync.js).
 *
 * stores
 *   notes   : 오답노트          { id, at, kind, title, passage, q }
 *   cards   : 단어장(저장한 표현) { id, at, type: "kanji"|"grammar"|"compare", front, reading, meaning, extra, source }
 *   history : 풀이 기록          { id, at, kind, title, total, right, elapsedMs }
 *   meta    : 기타              { id: "current", value: <풀던 세트> }
 *   progress : 문제은행 풀이 상태 { id: unitId, kind, seen, wrong, step, due, lastAt, graduated? }
 *   localBank: 기기 문제은행     { id, kind, source: "ai"|"mine", at, unit: { title, topic, passage, questions } }
 *   tagStats : 패턴별 통계        { id: 패턴, group, seen, wrong, lastAt }
 *   vocabDone: 기본 단어장 "외웠어요" { id: 단어장 항목 id, at }
 *   answers : 내 답변 노트(면접)  { id, at, updatedAt, cat, question, text, timerSec, followups: null | { at, model, items: [{ q, ko, intent, point }] } }
 *   book    : 문제집 회차         { id: "kind:회차", kind, round, ids, set: <풀던·푼 세트> | null, last: { right, total, at } | null, best }
 *   marks   : 문제집 북마크        { id: unitId, kind, at }
 *   exams   : 모의고사 응시        { id, round, startedAt, timing, phase, ends, sets, flags, result, released }
 *   daily   : 데일리 학습(날짜별)  { id: "YYYY-MM-DD", plan, done, test, completedAt }
 *   vcards  : 단어·문법 카드 상태  { id: 단어장 항목 id, deck, step, due, seen, wrong, introducedOn, lastAt }
 *   outbox  : 아직 클라우드에 안 올린 변경 { id: "스토어|키", store, key, at }   (동기화용, v6)
 *   tombs   : 삭제 표시(다른 기기에 삭제 전파) { id: "스토어|키", store, key, _u }   (동기화용, v6)
 *
 * 동기화 대상 스토어(SYNC_STORES)의 행에는 저장할 때마다 _u(바꾼 시각 ms)가 붙는다. 충돌은 _u가 더 최근인 쪽이 이긴다.
 * 로그인한 적이 있을 때(trackSync)만 outbox·tombs를 쌓는다. 모의고사(exams)는 끝난 회차(result 있음)만 올린다.
 *
 * v2: answers 스토어 추가, v3: progress·localBank·tagStats 추가, v4: vocabDone 추가, v5: book·marks·exams·daily·vcards 추가, v6: outbox·tombs 추가 (없는 스토어만 만들어서 기존 데이터는 그대로)
 */
const DB_NAME = "n1-study";
const DB_VERSION = 6;
export const STORES = ["notes", "cards", "history", "meta", "answers", "progress", "localBank", "tagStats", "vocabDone", "book", "marks", "exams", "daily", "vcards", "outbox", "tombs"];
export const SYNC_STORES = ["notes", "cards", "history", "progress", "tagStats", "vocabDone", "vcards", "book", "marks", "exams", "daily", "answers", "localBank"];
const SYNCED = new Set(SYNC_STORES);

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

function tx(stores, mode, fn){
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const s = Array.isArray(stores) ? Object.fromEntries(stores.map(n => [n, t.objectStore(n)])) : t.objectStore(stores);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}
const wrap = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

/* 동기화 표시: 로그인한 적이 있으면(trackSync) 바뀐 행을 outbox에, 지운 행을 tombs에 남기고 onChange로 알린다 */
let tracking = false, onChange = null;
export function trackSync(on, hook = null){ tracking = on; onChange = hook; }
const okey = (store, key) => `${store}|${key}`;
const uploadable = (store, v) => store !== "exams" || !!v.result;     // 진행 중인 모의고사는 끝나면 올린다
function stamp(store, values, s){
  if (!SYNCED.has(store)) return false;
  const now = Date.now();
  for (const v of values){
    v._u = now;
    if (!tracking) continue;
    s.tombs.delete(okey(store, v.id));
    if (uploadable(store, v)) s.outbox.put({ id: okey(store, v.id), store, key: v.id, at: now });
  }
  return tracking;
}
function tomb(store, keys, s){
  if (!SYNCED.has(store) || !tracking) return false;
  const now = Date.now();
  for (const key of keys){ s.tombs.put({ id: okey(store, key), store, key, _u: now }); s.outbox.put({ id: okey(store, key), store, key, at: now }); }
  return true;
}
const stores = store => SYNCED.has(store) ? [store, "outbox", "tombs"] : [store];
const notify = changed => { if (changed) onChange?.(); };

export const db = {
  all: store => tx(store, "readonly", s => wrap(s.getAll())),
  get: (store, id) => tx(store, "readonly", s => wrap(s.get(id))),
  put: (store, value) => tx(stores(store), "readwrite", s => { const st = s[store] || s; const ch = SYNCED.has(store) && stamp(store, [value], s); st.put(value); return ch; }).then(notify),
  putMany: (store, values) => tx(stores(store), "readwrite", s => { const st = s[store] || s; const ch = SYNCED.has(store) && stamp(store, values, s); for (const v of values) st.put(v); return ch; }).then(notify),
  del: (store, id) => tx(stores(store), "readwrite", s => { const st = s[store] || s; st.delete(id); return SYNCED.has(store) && tomb(store, [id], s); }).then(notify),
  clear: store => tx(stores(store), "readwrite", s => {
    const st = s[store] || s;
    if (!(SYNCED.has(store) && tracking)){ st.clear(); return false; }
    const req = st.getAllKeys();                    // 트랜잭션 안에서는 await 대신 콜백(Safari는 await 사이에 트랜잭션을 닫는다)
    req.onsuccess = () => { tomb(store, req.result, s); st.clear(); };
    return true;
  }).then(notify),
};

/* 동기화 엔진(src/sync.js) 전용: 클라우드 값을 표시 없이 반영, 올릴 목록 관리 */
export const syncDb = {
  outbox: () => tx("outbox", "readonly", s => wrap(s.getAll())),
  /* 올린 뒤: 그사이 다시 바뀌지 않았으면(at 같음) 지운다 */
  done: entries => tx("outbox", "readwrite", s => {
    for (const e of entries){ const req = s.get(e.id); req.onsuccess = () => { if (req.result && req.result.at === e.at) s.delete(e.id); }; }
  }),
  tomb: (store, key) => tx("tombs", "readonly", s => wrap(s.get(okey(store, key)))),
  /* 처음 로그인(합치기): 기기의 모든 행을 올릴 목록에 */
  enqueueAll: () => tx(["outbox", "tombs", ...SYNC_STORES], "readwrite", s => {
    const now = Date.now();
    for (const store of SYNC_STORES){
      const req = s[store].getAll();
      req.onsuccess = () => { for (const v of req.result) if (uploadable(store, v)) s.outbox.put({ id: okey(store, v.id), store, key: v.id, at: now }); };
    }
    const tr = s.tombs.getAll();
    tr.onsuccess = () => { for (const t of tr.result) s.outbox.put({ id: t.id, store: t.store, key: t.key, at: now }); };
  }),
  /* 클라우드에서 온 값 반영: row가 있으면 저장, 없으면(삭제) 지우고 삭제 표시를 그 시각으로 */
  apply: (store, key, row, u) => tx([store, "tombs"], "readwrite", s => {
    if (row){ s[store].put(row); s.tombs.delete(okey(store, key)); }
    else { s[store].delete(key); s.tombs.put({ id: okey(store, key), store, key, _u: u }); }
  }),
};
/* 행의 바꾼 시각. 예전 행(_u 없음)은 다른 시각 필드로 대신한다 */
export const rowTime = v => v?._u ?? v?.updatedAt ?? v?.lastAt ?? v?.at ?? v?.startedAt ?? 0;

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
 * v1: notes/cards/history,  v2: + answers(면접 내 답변 노트),  v3: + progress·localBank(AI 문제·내 문제)·tagStats,  v4: + vocabDone,
 * v5: + book(문제집)·marks(북마크)·exams(모의고사)·daily(데일리 학습)·vcards(카드 암기 상태).
 * 예전 version 파일도 그대로 불러올 수 있다.
 * notes·localBank 안의 문제에는 새 해설 필드(translation·choicesKo·gloss·passageKo·passageGloss·sentences·passageNotes·mainIdea)가 들어갈 수 있다.
 * 행을 통째로 저장·복원하므로 필드 추가만으로는 version을 올리지 않는다(예전 파일은 이 필드 없이 그대로 보인다).
 */
export const BACKUP_VERSION = 5;
const BACKUP_STORES = ["notes", "cards", "history", "answers", "progress", "localBank", "tagStats", "vocabDone", "book", "marks", "exams", "daily", "vcards"];
export async function exportAll(){
  const rows = await Promise.all(BACKUP_STORES.map(s => db.all(s)));
  return { app: "n1-study", version: BACKUP_VERSION, exportedAt: new Date().toISOString(), ...Object.fromEntries(BACKUP_STORES.map((s, i) => [s, rows[i]])) };
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
