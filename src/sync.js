/*
 * 기기 간 동기화 (구글 로그인 + Firestore). 로그인하지 않으면 이 파일은 불러오지 않는다(main.js가 동적 import).
 *
 * 클라우드: users/{uid}/{스토어}/{문서}  문서 = { k: 원래 id, j: 행 JSON 문자열, u: 바꾼 시각(ms, 기기 시계), s: 서버 받은 시각, del: 삭제 표시 }
 *          users/{uid}/prefs/app        설정(하루 학습 시간 등. API 키·읽기 음성 제외) { j, u, s }
 * 순서: 올리기(outbox) → 내려받기(스토어마다 s > 마지막으로 받은 시각) → 합치기(u가 더 최근인 쪽이 이김, del이면 기기에서도 지움)
 * 처음 로그인(이 기기에서 이 uid로 처음): 기기 행 전부를 올릴 목록에 넣고, 클라우드 전체를 받아 합친다. 어느 쪽도 지우지 않는다.
 * 행을 JSON 문자열로 넣는 이유: Firestore는 배열 안의 배열·undefined를 못 받는다. 가장 큰 행(모의고사)도 약 200KB라 문서 한도 1MB 안.
 * SDK는 gstatic 공식 CDN, 버전 고정(바꿀 때는 sw.js의 FIREBASE_SDK도 같이).
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { getFirestore, collection, doc, query, where, orderBy, getDocs, getDoc, writeBatch, serverTimestamp, Timestamp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { db as localDb, syncDb, SYNC_STORES, trackSync, rowTime } from "./db.js";

const LS = { uid: "n1.sync.uid", pull: uid => `n1.sync.pull.${uid}`, last: "n1.sync.last", prefsPushed: uid => `n1.sync.prefs.${uid}` };
const ls = { get(k, d){ try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v){ try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
const docId = key => encodeURIComponent(String(key));
const BATCH = 400;

let auth, fs, user = null, opts, running = null, again = false, timer = null;
const state = { status: "signedout", email: "", lastSync: ls.get(LS.last, null), error: "" };
const emit = () => opts.onState?.({ ...state });
const set = patch => { Object.assign(state, patch); emit(); };

export const IOS_HINT = "홈 화면 앱에서는 로그인이 끝나지 않았어요(아이폰이 로그인 창의 저장소를 막는 경우). Safari에서 casis009.github.io/n1-study 를 열어 로그인해 그 탭에서 쓰세요. 홈 화면 앱과 Safari 탭은 기기 저장소가 따로라, Safari 쪽에서 로그인하면 클라우드를 통해 진행 상황이 이어져요.";
/* 아이폰 홈 화면 앱(standalone)은 팝업이 막히므로 리디렉트 */
const standalone = () => window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;

export async function initSync(config, o){
  opts = o;
  const app = initializeApp(config);
  auth = getAuth(app); auth.languageCode = "ko";
  fs = getFirestore(app);
  /* 리디렉트로 돌아왔는데 로그인이 안 됐으면(아이폰 Safari가 다른 도메인 저장소를 막는 경우) 안내 */
  getRedirectResult(auth).then(r => {
    const tried = sessionStorage.getItem("n1.sync.redirect"); sessionStorage.removeItem("n1.sync.redirect");
    if (tried && !r && !auth.currentUser) set({ status: "error", error: IOS_HINT });
  }).catch(e => { sessionStorage.removeItem("n1.sync.redirect"); set({ status: "error", error: authMsg(e) || IOS_HINT }); });
  onAuthStateChanged(auth, async u => {
    user = u;
    if (!u){ trackSync(false); set({ status: "signedout", email: "" }); return; }
    const first = ls.get(LS.uid, null) !== u.uid;
    ls.set(LS.uid, u.uid);
    trackSync(true, schedule);
    set({ status: "syncing", email: u.email || "" });
    if (first){ ls.set(LS.pull(u.uid), {}); await syncDb.enqueueAll(); }
    syncNow();
  });
  window.addEventListener("online", () => syncNow());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") syncNow(); });
  window.addEventListener("offline", () => { if (user) set({ status: "offline" }); });
  return { login, logout, syncNow, schedule };
}
function authMsg(e){
  const c = e?.code || "";
  if (c === "auth/popup-closed-by-user" || c === "auth/cancelled-popup-request") return "";
  if (c === "auth/unauthorized-domain") return "이 주소는 Firebase 승인된 도메인에 없어요.";
  if (c === "auth/network-request-failed") return "네트워크 오류로 로그인하지 못했어요.";
  return e?.message || "로그인하지 못했어요.";
}
async function login(){
  const p = new GoogleAuthProvider();
  p.setCustomParameters({ prompt: "select_account" });
  try {
    if (standalone()){ sessionStorage.setItem("n1.sync.redirect", String(Date.now())); await signInWithRedirect(auth, p); return; }
    await signInWithPopup(auth, p);
  } catch (e){
    if (e?.code === "auth/popup-blocked"){ await signInWithRedirect(auth, p); return; }
    const m = authMsg(e); if (m) set({ status: "error", error: m });
  }
}
async function logout(){
  await signOut(auth);
  ls.set(LS.uid, null);                    // 다음 로그인은 다시 '처음 로그인'(합치기)
  set({ status: "signedout", email: "", error: "" });
}
/* 기록이 바뀌면 5초 뒤 묶어서 */
function schedule(){ clearTimeout(timer); timer = setTimeout(syncNow, 5000); }

export async function syncNow(){
  if (!user) return;
  if (running){ again = true; return running; }
  if (!navigator.onLine){ set({ status: "offline" }); return; }
  set({ status: "syncing", error: "" });
  running = (async () => {
    try {
      await push();
      const changed = await pull();
      state.lastSync = Date.now(); ls.set(LS.last, state.lastSync);
      set({ status: "ok" });
      if (changed.size) await opts.onPulled?.(changed);
    } catch (e){
      console.warn("[sync]", e);
      set({ status: navigator.onLine ? "error" : "offline", error: e?.code === "permission-denied" ? "권한이 없어요. Firestore 규칙(firestore.rules)을 콘솔에 붙여 넣었는지 확인하세요." : (e?.message || "동기화 오류") });
    } finally {
      running = null;
      if (again){ again = false; syncNow(); }
    }
  })();
  return running;
}

const col = store => collection(fs, "users", user.uid, store);
async function push(){
  const entries = await syncDb.outbox();
  for (let i = 0; i < entries.length; i += BATCH){
    const part = entries.slice(i, i + BATCH), b = writeBatch(fs), sent = [];
    for (const e of part){
      if (!SYNC_STORES.includes(e.store)){ sent.push(e); continue; }
      const row = await localDb.get(e.store, e.key);
      const ref = doc(col(e.store), docId(e.key));
      if (row){
        if (e.store === "exams" && !row.result){ sent.push(e); continue; }
        b.set(ref, { k: String(e.key), j: JSON.stringify(row), u: rowTime(row), s: serverTimestamp(), del: false });
      } else {
        const t = await syncDb.tomb(e.store, e.key);
        b.set(ref, { k: String(e.key), j: "", u: t?._u || Date.now(), s: serverTimestamp(), del: true });
      }
      sent.push(e);
    }
    await b.commit();
    await syncDb.done(sent);
  }
  await pushPrefs();
}
async function pull(){
  const marks = ls.get(LS.pull(user.uid), {}), changed = new Set();
  for (const store of SYNC_STORES){
    const since = marks[store] || 0;
    const snap = await getDocs(query(col(store), where("s", ">", Timestamp.fromMillis(since)), orderBy("s")));
    let max = since;
    for (const d of snap.docs){
      const r = d.data(), key = r.k, u = r.u || 0;
      max = Math.max(max, r.s?.toMillis?.() || 0);
      const local = await localDb.get(store, key), t = await syncDb.tomb(store, key);
      const localU = Math.max(local ? rowTime(local) : 0, t?._u || 0);
      if (u <= localU) continue;                                   // 기기 쪽이 같거나 더 최근
      if (r.del){ if (local){ await syncDb.apply(store, key, null, u); changed.add(store); } else await syncDb.apply(store, key, null, u); continue; }
      let row; try { row = JSON.parse(r.j); } catch { continue; }
      row._u = u;
      await syncDb.apply(store, key, row, u); changed.add(store);
    }
    marks[store] = max;
  }
  ls.set(LS.pull(user.uid), marks);
  if (await pullPrefs()) changed.add("prefs");
  return changed;
}
/* 설정: 기기의 바꾼 시각(prefsU)이 더 최근이면 올리고, 클라우드가 더 최근이면 받는다 */
const prefsRef = () => doc(fs, "users", user.uid, "prefs", "app");
async function pushPrefs(){
  const p = opts.getPrefs();
  if (!p.u || p.u <= ls.get(LS.prefsPushed(user.uid), 0)) return;
  const b = writeBatch(fs);
  b.set(prefsRef(), { j: JSON.stringify(p.values), u: p.u, s: serverTimestamp() });
  await b.commit();
  ls.set(LS.prefsPushed(user.uid), p.u);
}
async function pullPrefs(){
  const d = await getDoc(prefsRef());
  if (!d.exists()) return false;
  const r = d.data(), p = opts.getPrefs();
  if ((r.u || 0) <= (p.u || 0)) return false;
  try { opts.applyPrefs(JSON.parse(r.j), r.u); } catch { return false; }
  ls.set(LS.prefsPushed(user.uid), r.u);
  return true;
}
