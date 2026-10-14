/*
 * N1 연습장 — 화면과 상태.
 * 데이터 흐름: 문제은행(bank.js, data/bank) 또는 Gemini 생성(gemini.js) → 정리(sets.js) → 풀이
 *            → 오답노트/단어장/기록/복습 일정/패턴 통계를 IndexedDB(db.js)에 저장.
 */
import { h, $, prefs, fmtTime } from "./dom.js";
import { KINDS, TOPICS, EXAM } from "./kinds.js";
import { SAMPLES } from "./samples.js";
import { prepSet, normalizeFollowups, normalizeStudy, passageFields } from "./sets.js";
import { CATS, CAT } from "./interview.js";
import { SCENES, KEIGO } from "./keigo.js";
import { buildPrompt, buildFollowupPrompt } from "./prompt.js";
import { callGemini, callsToday, resetTimeKST, DEFAULT_MODEL } from "./gemini.js";
import { db, exportAll, importAll, requestPersist, persistState } from "./db.js";
import { firebaseConfig } from "./firebase-config.js";
import { state as bank, loadIndex, loadBankState, bankCounts, pickSet, pickByTag, tagUnitCount, buildSet, recordSet, tagList, splitUnits, addLocalUnits, removeLocal, findUnitByPassage, bookRounds, setFromIds, isReserved, setReserved, recordExamUnits, qPerUnit } from "./bank.js";
import { DAILY_OPTIONS, NEW_CARDS, planDay, dayKey, addDays, streak, mergeDaily } from "./daily.js";
import { EXAM_CFG, loadExam, examRounds, reservedIds, buildSection, sectionMinutes, scoreExam } from "./exam.js";
import { hasKanji, rubyParts } from "./furigana.js";
import { speak, stopSpeak, ttsReady, onVoices, jaVoices, setTtsOpts, RATES, RATE_LABEL, speakerSplit } from "./tts.js";
import { VKINDS, vocabKey, vocabGroup, vocabCount, loadVocabIndex, loadVocab, loadVocabState, setDone, undoDoneFor, vstate, DECK_KINDS, vcards, rank, loadRank, loadCardState, cardDue, swipeCard, restoreCard } from "./vocab.js";

const GROUPS = ["문자·어휘", "문법", "독해", "청해"];
const NUM = ["①", "②", "③", "④"];

/* ---------- state ---------- */
const settings = Object.assign({ key: "", model: DEFAULT_MODEL, studyEarly: false, ttsRate: 0.85, ttsVoice: "", listenMode: "exam", dailyMin: 60 }, prefs.get("n1.settings", {}));
setTtsOpts({ rate: settings.ttsRate, voice: settings.ttsVoice });
const gen = Object.assign({ kind: "grammar_blank", count: 5, topic: "", weak: true }, prefs.get("n1.gen", {}));
if (!KINDS[gen.kind]) gen.kind = "grammar_blank";
let current = null;
let notes = [], cards = [], history = [], answers = [];
const cardIds = new Set();
let busy = null, lastError = "", toastTimer = null;
let persist = "unsupported";

/* 기기 간 동기화하는 설정(API 키·읽기 음성은 제외). 바뀌면 n1.prefsU(바꾼 시각)를 남긴다 */
const SYNC_PREF_KEYS = ["dailyMin", "ttsRate", "listenMode", "studyEarly", "model"];
const syncedPrefs = () => Object.fromEntries(SYNC_PREF_KEYS.map(k => [k, settings[k]]));
let prefsSnap = JSON.stringify(syncedPrefs());
const savePrefs = () => {
  prefs.set("n1.settings", settings); prefs.set("n1.gen", gen);
  const snap = JSON.stringify(syncedPrefs());
  if (snap !== prefsSnap){ prefsSnap = snap; prefs.set("n1.prefsU", Date.now()); sync?.schedule(); }
};
let curTimer = null;
/* 풀던 세트 저장(문제집 회차면 그 회차 기록에도) */
function saveCurrent(){
  clearTimeout(curTimer);
  curTimer = setTimeout(() => {
    db.put("meta", { id: "current", value: current }).catch(() => {});
    const row = current?.book && books.get(`${current.book.kind}:${current.book.round}`);
    if (row){ row.set = current; db.put("book", row).catch(() => {}); }
  }, 300);
}

function toast(msg){
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
async function ensurePersist(){ if (persist !== "granted") persist = await requestPersist(); }

/* ---------- weak points: 패턴별 통계(tagStats)에서 틀린 횟수가 많은 순 ---------- */
const weakTags = (vocab, limit) => tagList().filter(t => t.wrong > 0 && t.group !== "청해" && (t.group === "문자·어휘") === !!vocab).slice(0, limit);
const fmtWhen = ts => {
  const hrs = Math.round((ts - Date.now()) / 3600000);
  if (hrs < 1) return "곧";
  if (hrs < 24) return `${hrs}시간 후`;
  const d = new Date(ts); return `${Math.round(hrs / 24)}일 후 (${d.getMonth() + 1}/${d.getDate()})`;
};
/* 모델 출력·내 문제를 검증하고 문제은행 단위로 나눈다(풀이용 필드는 뺀다). 형식이 틀리면 throw. */
function cleanUnits(kind, raw){
  const set = prepSet(structuredClone({ ...raw, kind }), { fallbackKind: kind });
  const questions = set.questions.map(({ stem, choices, answer, patternTags, gloss, ex, script }) => ({ stem, choices, answer, patternTags, gloss, ex, ...(script ? { script } : {}) }));
  return splitUnits(kind, { title: set.title, topic: set.topic, passage: set.passage, ...passageFields(set), questions });
}

/* ---------- notes / cards / history ---------- */
async function addNote(set, q){
  if (q.saved) return;
  q.saved = true;
  const src = set.passages?.[q.unitId] || set;          // 여러 지문이 든 세트는 문항이 속한 지문
  const note = { id: set.id + "-" + set.questions.indexOf(q), at: Date.now(), kind: set.kind, title: src.title || set.title, passage: src.passage || "",
    ...passageFields(src),
    q: { stem: q.stem, choices: q.choices, answer: q.answer, ex: q.ex, mySel: q.sel, patternTags: q.patternTags || [], gloss: q.gloss || [], ...(q.script ? { script: q.script } : {}) } };
  notes = [note, ...notes.filter(n => n.id !== note.id)];
  await db.put("notes", note); ensurePersist();
  const undone = await undoDoneFor(questionKeys(q)).catch(() => 0);   // 외웠다고 체크한 항목을 다시 틀리면 되돌림
  if (undone) toast(`외웠던 단어장 항목 ${undone}개를 '안 외운 것'으로 되돌렸어요`);
}
async function removeNote(id){ notes = notes.filter(n => n.id !== id); await db.del("notes", id); }

function cardId(type, front){ return `${type}:${front}`; }
async function toggleCard(type, item, source){
  const front = type === "grammar" ? item.pattern : item.word;
  const id = cardId(type, front);
  if (cardIds.has(id)){
    cardIds.delete(id); cards = cards.filter(c => c.id !== id); await db.del("cards", id);
    toast("단어장에서 뺐어요");
  } else {
    const card = { id, at: Date.now(), type, front, reading: item.reading || "", meaning: item.meaning || "",
      extra: type === "grammar" ? (item.example || "") : (item.note || ""), source };
    cardIds.add(id); cards = [card, ...cards]; await db.put("cards", card); ensurePersist();
    toast("단어장에 저장했어요");
  }
  renderCardsCount();
}
async function logHistory(set){
  if (set.logged || set.sample || set.retry) return;
  set.logged = true;
  const right = set.questions.filter(q => q.sel === q.answer).length;
  const rec = { id: set.id, at: Date.now(), kind: set.kind, title: set.title, total: set.questions.length, right, elapsedMs: set.elapsed };
  history = [rec, ...history];
  await db.put("history", rec);
}

/* ---------- generation ---------- */
async function generate(){
  if (busy) return;
  const ctl = new AbortController();
  busy = { ctl, started: Date.now() };
  lastError = "";
  renderAI();
  busy.timer = setInterval(() => { const s = $("busy-sec"); if (s) s.textContent = Math.round((Date.now() - busy.started) / 1000) + "초"; }, 1000);
  try {
    const vocab = !!KINDS[gen.kind].vocab;
    const weak = weakTags(vocab, vocab ? 8 : 6).map(t => t.id);
    const raw = await callGemini(buildPrompt(gen, weak), { key: settings.key, model: settings.model, signal: ctl.signal });
    const units = cleanUnits(gen.kind, raw);
    try {
      const rows = await addLocalUnits(gen.kind, units, "ai");
      current = buildSet(gen.kind, rows.map(r => ({ ...r.unit, id: r.id })));
    } catch { current = prepSet(structuredClone({ ...raw, kind: gen.kind }), { shuffle: true, fallbackKind: gen.kind }); }   // 기기 저장소를 못 쓰면 풀기만
    current.engine = "Gemini";
    saveCurrent();
  } catch (e){
    if (!(e && e.name === "AbortError")) lastError = e?.message || "문제를 만들지 못했어요.";
  } finally {
    clearInterval(busy.timer); busy = null;
    if (!lastError && current?.engine === "Gemini" && !current.questions.some(q => q.checked)) go("play"); else renderAI();
  }
}

/* ---------- shared rendering ---------- */
/* ---------- 단어 탭(gloss): 문장 속 단어에 점선 밑줄, 탭하면 작은 팝업 ---------- */
/* text를 노드 배열로. gl = { list, used, source }이면 list의 단어(긴 것 우선)를 처음 나올 때 한 번만 버튼으로 감싼다. */
function glossNodes(text, gl){
  if (!gl) return [text];
  const out = [];
  let buf = "";
  for (let i = 0; i < text.length;){
    const g = gl.list.find(x => !gl.used.has(x.w) && text.startsWith(x.w, i));
    if (!g){ buf += text[i++]; continue; }
    if (buf){ out.push(buf); buf = ""; }
    gl.used.add(g.w);
    out.push(h("button", { class: "gl", type: "button", lang: "ja", text: g.w, onclick: e => { e.stopPropagation(); openGloss(e.currentTarget, g, gl.source); } }));
    i += g.w.length;
  }
  if (buf) out.push(buf);
  return out;
}
/* ---------- 읽어주기 🔊 ---------- */
/* text: 읽을 일본어(단어·문법은 reading을 넘겨 오독 방지). 누르면 읽고, 읽는 중에 다시 누르면 멈춤 */
function speakBtn(text, label){
  const b = h("button", { class: "spk" + (ttsReady() ? "" : " off"), type: "button", "aria-label": `${label || "일본어"} 듣기`, title: "읽어주기", "aria-pressed": "false", text: "🔊" });
  b.addEventListener("click", e => {
    e.stopPropagation();
    if (!ttsReady()){ openTtsHelp(); return; }
    if (b.getAttribute("aria-pressed") === "true"){ stopSpeak(); return; }
    b.setAttribute("aria-pressed", "true");
    speak(text, { onEnd: () => b.setAttribute("aria-pressed", "false") });
  });
  return b;
}
onVoices(() => { if (ttsReady()) document.querySelectorAll(".spk.off").forEach(b => b.classList.remove("off")); });
let ttsHelp = null;
function openTtsHelp(){
  ttsHelp?.remove();
  const close = () => { ttsHelp?.remove(); ttsHelp = null; };
  ttsHelp = h("div", { class: "tts-help", role: "dialog", "aria-label": "일본어 음성 설치 방법" },
    h("div", { class: "gp-top" }, h("b", { text: "일본어 음성이 없어요" }), h("button", { class: "gp-x", type: "button", "aria-label": "닫기", onclick: close }, "×")),
    h("p", { text: "이 기기에서 일본어 읽기 음성을 찾지 못했어요. 설치한 뒤 브라우저를 다시 열어 주세요." }),
    h("p", null, h("b", { text: "안드로이드 " }), "설정 → 시스템(일반) → 언어 및 입력 → 텍스트 음성 변환(TTS) → Google 음성 엔진 설정 → 음성 데이터 설치 → 일본어"),
    h("p", null, h("b", { text: "아이폰 " }), "설정 → 손쉬운 사용 → 읽기 및 말하기 → 음성 → 일본어 → 음성(예: Kyoko) 다운로드"),
    h("p", null, h("b", { text: "PC(Windows) " }), "설정 → 시간 및 언어 → 음성 → 음성 추가 → 일본어"));
  document.body.append(ttsHelp);
}
document.addEventListener("keydown", e => { if (e.key === "Escape"){ ttsHelp?.remove(); ttsHelp = null; } });

/* 문법 표제어 후리가나: 한자 덩어리 위에만 <ruby>. 정렬이 안 되면 뒤에 （읽기）. hide면 읽기를 감춘다(뜻 가리기) */
function rubyNode(text, reading, { cls = null, hide = false } = {}){
  const el = h("b", { class: cls, lang: "ja" });
  const parts = hide ? null : rubyParts(text, reading);
  if (parts) for (const p of parts) el.append(p.r ? h("ruby", null, p.t, h("rt", { text: p.r })) : p.t);
  else el.append(text, !hide && reading && hasKanji(text) ? h("span", { class: "r", text: `（${reading}）` }) : "");
  return el;
}
const glossOf = (list, on, source) => on && list?.length ? { list: [...list].sort((a, b) => b.w.length - a.w.length), used: new Set(), source } : null;
let glossPop = null;
function closeGloss(){ glossPop?.remove(); glossPop = null; }
document.addEventListener("click", e => { if (glossPop && !glossPop.contains(e.target)) closeGloss(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeGloss(); });
window.addEventListener("resize", closeGloss);
async function findVocab(word){
  for (const kind of ["kanji", "words", "grammar"]){
    if (!vocabCount(kind)) continue;
    try { if ((await loadVocab(kind)).some(it => vocabKey(kind, it) === word)) return kind; } catch {}
  }
  return null;
}
function openGloss(target, g, source){
  closeGloss();
  const item = { word: g.w, reading: g.r, meaning: g.m }, id = cardId("kanji", g.w);
  const star = h("button", { class: "btn small", type: "button" });
  const paint = () => { const on = cardIds.has(id); star.textContent = on ? "★ 내 단어장에 있음" : "☆ 내 단어장"; star.setAttribute("aria-pressed", String(on)); };
  star.addEventListener("click", async () => { await toggleCard("kanji", item, source || ""); paint(); });
  paint();
  const acts = h("div", { class: "gp-act" }, star);
  const pop = h("div", { class: "gloss-pop", role: "dialog", "aria-label": g.w },
    h("div", { class: "gp-top" }, h("b", { lang: "ja", text: g.w }), g.r && g.r !== g.w ? h("span", { class: "r", lang: "ja", text: g.r }) : null, speakBtn(g.r || g.w, g.w),
      h("button", { class: "gp-x", type: "button", "aria-label": "닫기", onclick: closeGloss }, "×")),
    h("div", { class: "m", text: g.m }), acts);
  document.body.append(pop);
  glossPop = pop;
  const r = target.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = window.innerHeight;
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  const left = Math.min(Math.max(8, r.left), vw - pw - 8);
  const top = r.bottom + ph + 8 > vh && r.top > ph + 8 ? r.top - ph - 6 : r.bottom + 6;
  pop.style.left = left + window.scrollX + "px";
  pop.style.top = top + window.scrollY + "px";
  findVocab(g.w).then(kind => {
    if (!kind || glossPop !== pop) return;
    acts.append(h("button", { class: "btn small ghost", type: "button", onclick: () => {
      closeGloss();
      Object.assign(vb, { mode: "base", kind, group: "all", view: "all", q: g.w }); vLimit = 50; saveVb(); go("cards");
    } }, "단어장에서 보기"));
  });
}

function stemNode(s, gl){
  const wrap = h("div", { class: "jp", lang: "ja" });
  for (const p of s.split(/(★|__[^_]+__)/)){
    if (p === "★") wrap.append(h("span", { class: "star", text: "★" }));
    else if (/^__[^_]+__$/.test(p)) wrap.append(h("u", null, glossNodes(p.slice(2, -2), gl)));
    else if (p) wrap.append(...glossNodes(p, gl));
  }
  return wrap;
}
/* 밑줄(__)과 단어 탭을 살린 문장 조각 */
function segNodes(text, gl){
  return text.split(/(__[^_]+__)/).filter(Boolean).map(seg => /^__[^_]+__$/.test(seg) ? h("u", null, glossNodes(seg.slice(2, -2), gl)) : glossNodes(seg, gl));
}
function passageNode(text, kind, gl){
  const box = h("div", { class: "passage" + (kind === "info_search" ? " plain" : ""), lang: "ja" });
  for (const para of text.split(/\n+/).map(t => t.trim()).filter(Boolean))
    box.append(h("p", { class: /^[AB]$/.test(para) ? "mark-ab" : null }, segNodes(para, gl)));
  return box;
}

/* ---------- 본문 해설: [문장별 해석] [단락 요지·흐름] [전체 번역] ---------- */
const studyView = new WeakMap();                 // 세트·오답노트 객체 → 켜 둔 보기와 펼친 문장
const studyState = o => { let st = studyView.get(o); if (!st){ st = { sent: false, notes: false, full: false, open: new Set(), speaking: null, playing: false }; studyView.set(o, st); } return st; };
const passageBody = p => p.split("\n").map(l => l.trim()).filter(l => l && !/^[AB]$/.test(l)).join("");
const hasStudy = o => o.sentences?.length > 0 && o.sentences.map(s => s.ja).join("") === passageBody(o.passage);
const STUDY_BTNS = [["sent", "문장별 해석"], ["notes", "단락 요지·흐름"], ["full", "전체 번역"]];

/* 지문 + 본문 해설. on = 세트를 다 풀었는지(단어 탭·해설 공개), always = 오답노트처럼 항상 공개 */
function passageBlock(o, kind, on, source, { always = false } = {}){
  const wrap = h("div", { class: "study" });
  const open = always || on || settings.studyEarly;
  const st = studyState(o);
  /* 먼저 듣기: 지문을 가린 채 전체를 읽고, 다 들으면(또는 멈추면) 지문을 보여 준다 */
  const hearBtn = () => h("button", { class: "chip" + (ttsReady() ? "" : " off"), type: "button", onclick: () => {
    if (!ttsReady()){ openTtsHelp(); return; }
    const texts = hasStudy(o) ? o.sentences.map(s => s.ja) : o.passage.split(/\n+/).map(t => t.trim()).filter(t => t && !/^[AB]$/.test(t));
    speak(texts, { onEnd: () => { st.hearing = false; st.paint?.(); } });
    st.hearing = true; st.paint?.();
  } }, "🎧 먼저 듣기");
  const paint = () => {
    const gl = glossOf(o.passageGloss, on || always, source);
    wrap.replaceChildren();
    if (st.hearing){
      wrap.append(h("div", { class: "passage hearing" }, h("p", { text: "🎧 듣는 중이에요. 다 들으면 지문이 보여요." }),
        h("button", { class: "btn small", type: "button", onclick: () => stopSpeak() }, "■ 그만 듣고 지문 보기")));
      return;
    }
    if (!hasStudy(o)){                             // 예전 데이터·AI 문제: 지문 + 접어 둔 전체 번역
      wrap.append(passageNode(o.passage, kind, gl), h("div", { class: "study-bar" }, readAllBtn(o, st, wrap), hearBtn()));
      if (open && o.passageKo?.trim()){
        const d = h("details", { class: "passage-ko" }, h("summary", { text: "지문 해석 보기" }));
        for (const para of o.passageKo.split(/\n+/).map(t => t.trim()).filter(Boolean)) d.append(h("p", { text: para }));
        wrap.append(d);
      }
      return;
    }
    const mode = k => open && st[k];
    wrap.append(studyPassage(o, kind, gl, { sent: mode("sent"), notes: mode("notes"), open: st.open, speaking: st.speaking }, i => { st.open.has(i) ? st.open.delete(i) : st.open.add(i); paint(); }));
    const bar = h("div", { class: "study-bar" + (open ? "" : " locked") }, readAllBtn(o, st, wrap), hearBtn(),
      STUDY_BTNS.map(([k, label]) => h("button", { class: "chip", type: "button", disabled: !open, "aria-pressed": String(mode(k)),
        onclick: () => { st[k] = !st[k]; paint(); } }, label)),
      open ? null : h("span", { class: "hint", text: "문제를 다 풀면 볼 수 있어요" }));
    wrap.append(bar);
    if (mode("notes")) wrap.append(mainIdeaNode(o.mainIdea, kind));
    if (mode("full") && o.passageKo?.trim()) wrap.append(h("div", { class: "passage-ko full" },
      h("div", { class: "label", text: "전체 번역" }), o.passageKo.split(/\n+/).map(t => t.trim()).filter(Boolean).map(t => h("p", { text: t }))));
  };
  st.paint = paint;                                // 다시 그려지면 최신 화면으로
  paint();
  return [wrap];
}
/* 지문 전체 읽기(재생/정지). 문장 데이터가 있으면 읽는 문장을 강조 */
function readAllBtn(o, st, wrap){
  st.wrap = wrap;                                  // 다시 그려져도 최신 화면을 갱신하도록
  const sync = () => {
    st.wrap.querySelectorAll(".sent[data-i]").forEach(el => el.classList.toggle("speaking", el.dataset.i === String(st.speaking)));
    const b = st.wrap.querySelector(".spk-all");
    if (b){ b.textContent = st.playing ? "■ 정지" : "🔊 지문 읽기"; b.setAttribute("aria-pressed", String(st.playing)); }
  };
  const btn = h("button", { class: "chip spk-all" + (ttsReady() ? "" : " off"), type: "button", "aria-pressed": String(st.playing) }, st.playing ? "■ 정지" : "🔊 지문 읽기");
  btn.addEventListener("click", () => {
    if (!ttsReady()){ openTtsHelp(); return; }
    if (st.playing){ stopSpeak(); return; }
    const study = hasStudy(o);
    const texts = study ? o.sentences.map(s => s.ja) : o.passage.split(/\n+/).map(t => t.trim()).filter(t => t && !/^[AB]$/.test(t));
    speak(texts, {
      onEach: i => { st.speaking = study ? i : null; sync(); },
      onEnd: () => { st.playing = false; st.speaking = null; sync(); }
    });
    st.playing = true; sync();
  });
  return btn;
}
/* 문장 단위 지문: 문장별 해석이 켜지면 문장을 탭해 바로 아래에 해석, 단락 요지가 켜지면 단락마다 요지·흐름과 주장 문장 강조 */
function studyPassage(o, kind, gl, v, onTap){
  const box = h("div", { class: "passage" + (kind === "info_search" ? " plain" : "") + (v.sent ? " tappable" : ""), lang: "ja" });
  const notes = new Map((o.passageNotes || []).map(n => [n.para, n]));
  let part = null, para = 0, p = null;
  const flush = () => { const n = notes.get(para); if (v.notes && n) box.append(paraNote(n, kind)); };
  o.sentences.forEach((s, i) => {
    if (s.para !== para){ if (p) flush(); para = s.para; p = null; }
    if (s.part && s.part !== part){ part = s.part; box.append(h("p", { class: "mark-ab", text: part })); }
    if (!p){ p = h("p"); box.append(p); }
    const span = h("span", { class: "sent" + (v.notes && s.claim ? " claim" : "") + (v.speaking === i ? " speaking" : ""), "data-i": String(i) }, segNodes(s.ja, gl));
    if (v.sent){
      const on = v.open.has(i);
      Object.assign(span, { tabIndex: 0 });
      span.setAttribute("role", "button");
      span.setAttribute("aria-expanded", String(on));
      span.addEventListener("click", () => onTap(i));
      span.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " "){ e.preventDefault(); onTap(i); } });
      p.append(span);
      if (on) p.append(h("span", { class: "sent-ko", lang: "ko" }, h("span", { text: s.ko }), speakBtn(s.ja, `${i + 1}번째 문장`)));
    } else p.append(span);
  });
  if (p) flush();
  return box;
}
function paraNote(n, kind){
  return h("div", { class: "pnote" + (n.key ? " key" : ""), lang: "ko" },
    h("div", { class: "pn-top" }, h("b", { text: kind === "integrated" ? (n.para === 1 ? "A 요지" : "B 요지") : `${n.para}단락 요지` }),
      n.key ? h("span", { class: "tag key", text: kind === "info_search" ? "체크 포인트" : "필자 주장" }) : null),
    h("p", { text: n.summary }),
    n.flow ? h("p", { class: "flow" }, h("span", { class: "hint", text: "흐름 " }), h("span", { text: n.flow })) : null);
}
function mainIdeaNode(m, kind){
  const box = h("div", { class: "main-idea", lang: "ko" }, h("div", { class: "label", text: kind === "info_search" ? "안내문 요지" : kind === "integrated" ? "A·B의 주장" : "필자의 주장" }));
  if (m && typeof m === "object") box.append(...[["A", m.A], ["B", m.B], ["공통점", m.common], ["차이점", m.diff]].filter(([, t]) => t)
    .map(([k, t]) => h("p", null, h("b", { text: k + " " }), h("span", { text: t }))));
  else if (m) box.append(h("p", { text: m }));
  return box;
}
function starBtn(type, item, source){
  const front = type === "grammar" ? item.pattern : item.word;
  const btn = h("button", { class: "star-btn", type: "button" });
  const paint = () => {
    const on = cardIds.has(cardId(type, front));
    btn.textContent = on ? "★" : "☆";
    btn.setAttribute("aria-pressed", String(on));
    btn.setAttribute("aria-label", on ? `${front} 단어장에서 빼기` : `${front} 단어장에 저장`);
    btn.title = on ? "단어장에서 빼기" : "단어장에 저장";
  };
  btn.addEventListener("click", async e => { e.stopPropagation(); await toggleCard(type, item, source); paint(); });
  paint();
  return btn;
}
function explanationNode(q, source){
  const ex = q.ex, box = h("div", { class: "ex" });
  if (q.patternTags?.length) box.append(h("div", { class: "ptags" }, h("span", { class: "hint", text: "패턴" }), q.patternTags.map(t => h("span", { class: "tag", lang: "ja", text: t }))));
  if (q.script?.length) box.append(scriptNode(q, source));
  const tr = ex.translation || {};
  if (tr.full || tr.ko) box.append(h("section", null, h("h4", { text: "문제 해석" }),
    tr.full ? h("p", { class: "tr-jp", lang: "ja" }, h("span", { text: tr.full }), speakBtn(tr.full.replace(/★/g, ""), "완성 문장")) : null, tr.ko ? h("p", { text: tr.ko }) : null));
  if (ex.why) box.append(h("section", null, h("h4", { text: "정답 근거" }), h("p", { text: ex.why })));
  if (ex.choicesKo?.some(c => c.ko)) box.append(h("section", null, h("h4", { text: "선택지 해석" }),
    h("ul", { class: "notes cko" }, ex.choicesKo.map((c, i) => h("li", { class: i === q.answer ? "isans" : null }, h("span", { class: "n", text: NUM[i] }),
      h("span", null, c.reading ? h("span", { class: "r", lang: "ja", text: c.reading }) : null, h("span", { text: c.ko })))))));
  if (ex.kanji.length) box.append(h("section", null, h("h4", { text: "한자 · 읽기" }),
    h("div", { class: "kanji" }, ex.kanji.map(k => h("div", { class: "kj" },
      h("span", { class: "w", lang: "ja", text: k.word }),
      h("span", { class: "r", lang: "ja", text: k.reading ? `（${k.reading}）` : "" }),
      h("span", { class: "m", text: k.meaning }),
      speakBtn(k.reading || k.word, k.word),
      starBtn("kanji", k, source))))));
  if (ex.grammar.length) box.append(h("section", null, h("h4", { text: "주요 문법" }),
    h("div", { class: "gram" }, ex.grammar.map(g => h("div", { class: "gr" },
      h("div", { class: "gr-top" }, rubyNode(g.pattern, g.reading), h("span", { text: g.meaning ? "· " + g.meaning : "" }), starBtn("grammar", g, source)),
      g.example ? h("div", { class: "ex-jp", text: g.example }) : null)))));
  if (ex.compare?.length) box.append(h("section", null, h("h4", { text: "비슷한 말 비교" }),
    h("div", { class: "cmp" }, ex.compare.map(c => h("div", null,
      h("div", { class: "row1" }, h("b", { lang: "ja", text: c.word }), c.reading ? h("span", { class: "r", lang: "ja", text: `（${c.reading}）` }) : null, h("span", { text: c.meaning }), starBtn("compare", c, source)),
      c.note ? h("div", { class: "n", text: c.note }) : null)))));
  if (ex.pattern) box.append(h("section", null, h("h4", { text: "출제 패턴" }), h("p", { text: ex.pattern })));
  if (ex.tip) box.append(h("section", null, h("h4", { text: "풀이 팁" }), h("p", { text: ex.tip })));
  if (ex.choiceNotes.some(Boolean)) box.append(h("section", null, h("h4", { text: "선택지 분석" }),
    h("ul", { class: "notes" }, ex.choiceNotes.map((t, i) => t ? h("li", { class: i === q.answer ? "isans" : null }, h("span", { class: "n", text: NUM[i] }), h("span", { text: t })) : null))));
  return box;
}
/* ---------- 청해: 재생 버튼만 보이고 스크립트는 정답 확인 뒤 ---------- */
const SPEAKER = { M: "男", F: "女", N: "ナレーション" };
const listenPaints = new Set();          // 화면에 있는 재생 상자들(재생 상태가 바뀌면 다시 그림)
let listening = null;                    // { q, line } 지금 재생 중인 문제(line: 한 문장만 다시 듣기면 그 번호)
const repaintListen = () => { for (const p of [...listenPaints]) p(); };
/* 재생 목록: 대사(화자별 음성) + 即時応答은 대답 1~3도 상대 화자가 읽는다. 상황 설명·질문 뒤에는 잠깐 쉼 */
function listenItems(q){
  const s = q.script, items = s.map((l, i) => ({ text: l.text, speaker: l.speaker, pause: l.speaker === "N" && s[i + 1] && s[i + 1].speaker !== "N" ? 1500 : 350 }));
  if (!q.stem.trim()){
    const last = s[s.length - 1]?.speaker, resp = last === "F" ? "M" : "F";
    items[items.length - 1].pause = 900;
    q.choices.forEach((c, i) => items.push({ text: `${i + 1}、${c}`, speaker: resp, pause: 700 }));
  }
  return items;
}
function playListen(q, line = null){
  if (!ttsReady()){ openTtsHelp(); return; }
  if (listening?.q === q && listening.line === line){ stopSpeak(); return; }
  const items = listenItems(q);
  speak(line == null ? items : [items[line]], { onEnd: () => { if (listening?.q === q){ listening = null; repaintListen(); } } });
  listening = { q, line };
  if (line == null && !q.checked){ q.plays = (q.plays || 0) + 1; if (q.exam) saveExam(activeExam()); else saveCurrent(); }
  repaintListen();
}
function listenNode(q){
  const box = h("div", { class: "listen" });
  const paint = () => {
    if (!box.isConnected && box.dataset.drawn){ listenPaints.delete(paint); return; }
    box.dataset.drawn = "1";
    const lock = q.exam && !q.checked;                // 모의고사 중: 실전 모드 고정
    const exam = lock || (settings.listenMode !== "practice" && !q.checked);
    const playing = listening?.q === q && listening.line == null;
    const used = exam && (q.plays || 0) >= 1 && !playing;
    const items = listenItems(q), ns = q.script.length;
    box.replaceChildren(...[                       // replaceChildren은 null을 "null" 글자로 넣으므로 걸러 낸다
      h("div", { class: "row" },
        h("button", { class: "btn" + (playing ? "" : " primary") + (ttsReady() ? "" : " off"), type: "button", disabled: used, onclick: () => playListen(q) },
          playing ? "■ 정지" : used ? "재생 끝 (실전 모드는 1번)" : (q.plays ? "▶ 다시 재생" : "▶ 재생")),
        lock ? null : h("div", { class: "chips" }, [["exam", "실전 1번"], ["practice", "연습 반복"]].map(([m, label]) =>
          h("button", { class: "chip", type: "button", "aria-pressed": String((settings.listenMode || "exam") === m),
            onclick: () => { settings.listenMode = m; savePrefs(); repaintListen(); } }, label)))),
      !exam && items.length > 1 ? h("div", { class: "chips lines" }, h("span", { class: "hint", text: "문장 다시 듣기" }),
        items.map((it, i) => h("button", { class: "chip", type: "button", "aria-pressed": String(listening?.q === q && listening.line === i),
          title: SPEAKER[it.speaker] || "", onclick: () => playListen(q, i) }, i >= ns ? `答${i - ns + 1}` : `${i + 1}${it.speaker === "M" ? "男" : it.speaker === "F" ? "女" : ""}`))) : null,
      exam && !q.checked && !lock ? h("p", { class: "hint", text: "실전 모드: 시험처럼 한 번만 들을 수 있어요. 연습 모드에서는 반복·문장별 다시 듣기가 돼요." }) : null].filter(Boolean));
  };
  listenPaints.add(paint);
  paint();
  return box;
}
/* 정답 확인 뒤: 화자별 스크립트 + 문장별 해석 + 단어 탭 + 문장 🔊 */
function scriptNode(q, source){
  const gl = glossOf(q.gloss, true, source);
  return h("section", null, h("h4", { text: "스크립트" }), h("div", { class: "script" }, q.script.map(l =>
    h("div", { class: "sl sp-" + l.speaker },
      h("span", { class: "who", lang: "ja", text: SPEAKER[l.speaker] }),
      h("div", { class: "sl-body" }, h("div", { class: "jp", lang: "ja" }, glossNodes(l.text, gl), speakBtn({ text: l.text, speaker: l.speaker }, "이 문장")),
        l.ko ? h("div", { class: "ko", text: l.ko }) : null)))));
}
function questionNode(q, idx, ctx){
  const wrap = h("article", { class: "q" });
  const gl = glossOf(q.gloss, q.checked, ctx.source);   // 단어 탭은 정답 확인 뒤에만 (풀 때 힌트가 되지 않게)
  const listen = !!q.script?.length, quick = listen && !q.stem.trim();   // 청해 / 即時応答(선택지도 음성)
  const stem = listen && !q.checked ? h("div", { class: "jp listen-q hint", text: quick ? "🎧 짧은 말과 대답 1~3을 듣고 가장 알맞은 대답을 고르세요" : "🎧 질문은 음성으로 나와요. 들은 뒤 답을 고르세요" })
    : quick ? h("div", { class: "jp listen-q", text: "即時応答" }) : stemNode(q.stem, gl);
  wrap.append(h("div", { class: "q-stem" }, h("span", { class: "q-no", text: ctx.label || `問${idx + 1}` }), stem));
  if (listen) wrap.append(listenNode(q));
  const list = h("ol", { class: "choices" });
  q.choices.forEach((c, i) => {
    let cls = "choice", verdict = null;
    if (q.checked){
      if (i === q.answer){ cls += " right"; verdict = h("span", { class: "verdict ok", text: "정답" }); }
      else if (i === q.sel){ cls += " wrongpick"; verdict = h("span", { class: "verdict ng", text: "내 답" }); }
    }
    const inner = [h("span", { class: "bubble", text: String(i + 1) }), quick && !q.checked ? h("span", { class: "hint", text: "음성으로 들어요" }) : h("span", { class: "jp", lang: "ja" }, glossNodes(c, gl)), verdict];
    list.append(h("li", null, q.checked   // 확인 뒤에는 단어 탭 버튼을 넣을 수 있게 div로
      ? h("div", { class: cls + " done", "aria-pressed": String(q.sel === i) }, inner)
      : h("button", { class: cls, "aria-pressed": String(q.sel === i), onclick: () => { q.sel = i; ctx.onChange(); } }, inner)));
  });
  wrap.append(list);
  const actions = h("div", { class: "q-actions" });
  if (!q.checked){
    actions.append(h("button", { class: "btn primary", disabled: q.sel == null, onclick: async () => { q.checked = true; await ctx.onCheck?.(q); ctx.onChange(); } }, "정답 확인"));
    if (q.sel == null) actions.append(h("span", { class: "hint", text: "선택지를 고르면 정답을 확인할 수 있어요." }));
  } else {
    const ok = q.sel === q.answer;
    actions.append(h("span", { class: "result " + (ok ? "ok" : "ng"), text: ok ? "맞았어요" : `틀렸어요 · 정답 ${NUM[q.answer]}` }));
    if (ctx.extraActions) actions.append(...ctx.extraActions);
  }
  wrap.append(actions);
  if (q.checked) wrap.append(explanationNode(q, ctx.source || ""));
  return wrap;
}

/* ---------- AI로 새 문제 (더보기) ---------- */
function renderAI(){
  const v = $("view-ai"); v.replaceChildren();
  if (KINDS[gen.kind].listen){ gen.kind = "grammar_blank"; savePrefs(); }
  const k = KINDS[gen.kind];
  const g = h("section", { class: "panel stack" });
  const kindBox = h("div", { class: "kind-groups" });
  for (const grp of GROUPS.filter(x => x !== "청해")){
    kindBox.append(h("div", null, h("div", { class: "label", text: grp }), h("div", { class: "chips" },
      Object.entries(KINDS).filter(([, x]) => x.group === grp).map(([key, x]) =>
        h("button", { class: "chip", "aria-pressed": String(gen.kind === key), onclick: () => { gen.kind = key; savePrefs(); renderAI(); } }, x.label, h("small", { lang: "ja", text: x.jp }))))));
  }
  g.append(kindBox);
  if (k.counts){
    if (!k.counts.includes(gen.count)) gen.count = k.counts[0];
    g.append(h("div", null, h("div", { class: "label", text: "문항 수" }), h("div", { class: "chips" },
      k.counts.map(n => h("button", { class: "chip", "aria-pressed": String(gen.count === n), onclick: () => { gen.count = n; savePrefs(); renderAI(); } }, `${n}문항`)))));
  } else g.append(h("div", null, h("div", { class: "label", text: "구성" }), h("div", { class: "hint", text: k.fixed })));
  const topicIn = h("input", { id: "topic", type: "text", placeholder: "비우면 무작위 (예: 경제, 의료, 철학)", value: gen.topic, oninput: e => { gen.topic = e.target.value; savePrefs(); } });
  const weakCount = weakTags(k.vocab, k.vocab ? 8 : 6).length;
  const weakBox = h("input", { id: "weak", type: "checkbox", onchange: e => { gen.weak = e.target.checked; savePrefs(); } });
  weakBox.checked = gen.weak;
  g.append(h("div", { class: "row" },
    h("label", { class: "field", for: "topic" }, h("span", { class: "label", text: "주제" }), topicIn),
    h("label", { class: "check", for: "weak" }, weakBox, `자주 틀린 ${k.vocab ? "어휘" : "문법"} 반영${weakCount ? ` (${weakCount}개)` : " (아직 없음)"}`)));
  const actions = h("div", { class: "row" });
  if (busy){
    actions.append(h("div", { class: "status" }, h("span", { class: "spin" }),
      h("span", null, "Gemini가 문제와 해설을 쓰는 중 · ", h("span", { id: "busy-sec", class: "mono", text: Math.round((Date.now() - busy.started) / 1000) + "초" })),
      h("button", { class: "btn small", onclick: () => busy?.ctl.abort() }, "중지")));
  } else {
    actions.append(h("button", { class: "btn primary", onclick: generate }, "AI로 새 문제 만들기"));
    actions.append(h("span", { class: "hint", text: `오늘 ${callsToday()}회 호출 · 무료 한도 초기화 ${resetTimeKST()}` }));
    if (!settings.key.trim()) actions.append(h("a", { class: "btn small ghost", href: "#/set" }, "API 키 입력하기"));
  }
  g.append(actions, h("p", { class: "hint", text: "만든 문제는 이 기기의 문제은행에도 추가돼서 연습·복습에 섞여 나와요. 청해는 AI 생성이 없어요." }));
  if (lastError) g.append(h("div", { class: "status err", role: "alert", text: lastError }));
  v.append(g, h("section", { class: "panel stack", style: "margin-top:14px" }, h("div", { class: "label", text: "예시 세트 (API 없이 화면 확인용)" }),
    h("div", { class: "row" }, [["vocab", "어휘 2문항"], ["grammar", "문법 3문항"], ["reading", "독해 단문"]].map(([key, label]) =>
      h("button", { class: "btn small", onclick: () => openSet(prepSet(structuredClone(SAMPLES[key]))) }, label)))));
}

/* ---------- 홈 ---------- */
const DAY_MS = 86400000;
function ddayNum(){
  const today = new Date(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }) + "T00:00:00+09:00");
  return Math.round((EXAM - today) / DAY_MS);
}
/* 유형 목록의 풀이 기록(history) 정답률 */
function accOf(kinds){
  const set = new Set(kinds);
  let right = 0, total = 0;
  for (const r of history) if (set.has(r.kind)){ right += r.right; total += r.total; }
  return { right, total, pct: total ? Math.round(right / total * 100) : null };
}
const groupKinds = grp => Object.keys(KINDS).filter(k => KINDS[k].group === grp);
function groupProgress(grp){
  let total = 0, seen = 0, due = 0;
  for (const k of groupKinds(grp)){ const c = bankCounts(k); total += c.total; seen += c.total - c.left; due += c.due; }
  return { total, seen, due, pct: total ? Math.round(seen / total * 100) : 0 };
}
const PART_JP = { "문자·어휘": "文字・語彙", "문법": "文法", "독해": "読解", "청해": "聴解" };
const pct = n => n == null ? "–" : n + "%";
const barNode = (p, cls = "") => h("div", { class: "bar " + cls }, h("i", { style: `width:${Math.max(0, Math.min(100, p || 0))}%` }));

/* ---------- 데일리 학습 (배분 규칙은 src/daily.js) ---------- */
let dailyRows = new Map();
const accRatio = grp => { const a = accOf(groupKinds(grp)); return a.total ? a.right / a.total : null; };
/* 오늘 계획: 그날 처음 열 때 정해서 저장. 하루 학습 시간을 바꾸면 다시 계산 */
function todayRow(){
  const id = dayKey(), min = settings.dailyMin || 60;
  let row = dailyRows.get(id);
  if (row?.plan && row.plan.minutes === min) return row;
  const counts = {};
  for (const k of Object.keys(KINDS)){ const c = bankCounts(k); if (c.total) counts[k] = { left: c.left, due: c.due, qPerUnit: qPerUnit(k) }; }
  const lastMock = [...exams].filter(e => e.result).sort((a, b) => b.startedAt - a.startedAt)[0];
  const plan = planDay({ minutes: min, daysLeft: ddayNum(), acc: Object.fromEntries(GROUPS.map(g => [g, accRatio(g)])), counts,
    dueCards: dueCardCount(), lastMockAt: lastMock?.startedAt || null, mockLeft: examRounds().filter(no => !releasedRounds().has(no)).length });
  row = { ...(row || { id, done: {}, test: null, completedAt: null }), plan, planAt: Date.now() };
  dailyRows.set(id, row); db.put("daily", row).catch(() => {});
  return row;
}
/* 오늘 유형별로 푼 문항 수(모의고사 제외) */
function solvedToday(){
  const start = new Date(dayKey() + "T00:00:00+09:00").getTime(), m = new Map();
  for (const r of history) if (r.at >= start && !r.exam) m.set(r.kind, (m.get(r.kind) || 0) + r.total);
  return m;
}
/* 체크리스트 항목: { key, label, sub, done, progress: [n, total], go() } */
function todayItems(){
  const row = todayRow(), p = row.plan, solved = solvedToday(), items = [];
  items.push(...cardItems(row));
  for (const it of p.parts){
    const n = Math.min(solved.get(it.kind) || 0, it.questions);
    items.push({ key: "part:" + it.kind, label: `${KINDS[it.kind].label} ${it.questions}문항`, sub: `${KINDS[it.kind].jp}${it.review ? ` · 복습 ${it.review}${isUnit(it.kind) ? "" : "세트"} 포함` : ""} · 약 ${it.min}분`,
      done: n >= it.questions, progress: [n, it.questions],
      go: () => isUnit(it.kind) ? startPractice(it.kind, !(bankCounts(it.kind).left + bankCounts(it.kind).due), Math.min(10, Math.max(1, it.questions - n))) : startPractice(it.kind) });
  }
  if (p.mock){
    const today = exams.some(e => dayKey(e.startedAt) === dayKey());
    items.push({ key: "mock", label: "실전 모의고사 (이번 주 추천)", sub: "시험 2주 전부터 주 1회", done: today && !activeExam(), progress: null, go: () => go(activeExam() ? "exam/run" : "exam") });
  }
  return items;
}
const isUnit = k => !!KINDS[k]?.counts;
function checkDailyDone(items){
  const row = todayRow();
  if (!row.completedAt && items.length && items.every(i => i.done)){ row.completedAt = Date.now(); db.put("daily", row).catch(() => {}); toast("오늘의 학습을 다 했어요! 🎉"); }
}
const doneDays = () => new Set([...dailyRows.values()].filter(r => r.completedAt).map(r => r.id));

function renderHome(){
  const v = $("view-home"); v.replaceChildren();
  const dd = ddayNum();
  const live = current && !current.done && !current.sample && current.questions.some(q => !q.checked);
  const items = todayItems(); checkDailyDone(items);
  const row = todayRow(), nDone = items.filter(i => i.done).length, st = streak(doneDays());
  const next = items.find(i => !i.done);
  const cont = live ? () => go("play") : next ? next.go : null;
  v.append(h("section", { class: "panel hero" },
    h("div", { class: "hero-top" },
      h("div", null, h("div", { class: "big", text: dd > 0 ? `D-${dd}` : dd === 0 ? "D-DAY" : "끝!" }), h("div", { class: "sub", text: "2026년 12월 6일(일) JLPT N1" })),
      h("div", { class: "today-n" }, h("span", { class: "hint", text: "오늘의 학습" }), h("b", { class: "mono", text: `${nDone}/${items.length}` }))),
    barNode(items.length ? nDone / items.length * 100 : 0, row.completedAt ? "ok" : ""),
    h("div", { class: "row" },
      cont ? h("button", { class: "btn primary big grow", onclick: cont }, live ? `이어서 · ${KINDS[current.kind]?.label} ${current.questions.filter(q => q.checked).length}/${current.questions.length}` : `이어서 · ${next.label}`)
        : h("div", { class: "done-banner grow", text: "✓ 오늘의 학습 완료" }),
      h("div", { class: "streak", title: "연속 학습일" }, h("b", { class: "mono", text: `🔥 ${st}` }), h("span", { class: "hint", text: "일 연속" })))));
  const list = h("section", { class: "panel checklist" },
    h("div", { class: "cl-head" }, h("div", { class: "label", text: `오늘의 학습 · ${row.plan.minutes}분` }), h("div", { class: "row" }, h("a", { class: "hint", href: `#/report/${dayKey()}` }, "보고서"), h("a", { class: "hint", href: "#/set" }, "시간 바꾸기"))));
  for (const it of items) list.append(h("button", { class: "cl-item" + (it.done ? " done" : ""), type: "button", onclick: it.go },
    h("span", { class: "ck", "aria-hidden": "true", text: it.done ? "✓" : "" }),
    h("div", { class: "grow" }, h("div", { class: "cl-label", text: it.label }), h("div", { class: "hint", text: it.sub })),
    it.progress ? h("span", { class: "mono hint", text: `${it.progress[0]}/${it.progress[1]}` }) : null));
  if (!items.length) list.append(h("p", { class: "hint", text: "오늘 배분할 문제가 없어요. 문제은행을 다 풀었다면 연습의 [다시]로 복습해 보세요." }));
  v.append(list);
  v.append(h("div", { class: "parts" }, GROUPS.map(grp => {
    const a = accOf(groupKinds(grp)), p = groupProgress(grp);
    return h("a", { class: "part-card", href: "#/part/" + encodeURIComponent(grp) },
      h("div", null, h("div", { class: "pc-name", text: grp }), h("div", { class: "pc-jp", lang: "ja", text: PART_JP[grp] })),
      h("div", { class: "pc-stats" }, h("div", null, h("b", { text: pct(a.pct) }), h("span", { text: " 정답률" })), p.due ? h("div", null, h("b", { text: String(p.due) }), h("span", { text: " 복습" })) : null),
      h("div", null, barNode(p.pct), h("span", { class: "hint", text: `진행 ${p.seen}/${p.total}` })));
  })));
  const act = activeExam(), lastEx = [...exams].reverse().find(e => e.result);
  v.append(h("a", { class: "mock-card", href: act ? "#/exam/run" : "#/exam" },
    h("div", null, h("b", null, "실전 모의고사", row.plan.mock ? h("span", { class: "badge", text: "이번 주 추천" }) : null),
      h("span", { class: "hint", text: act ? `${act.round}회 진행 중 · 이어서` : lastEx ? `최근 ${lastEx.round}회 ${lastEx.result.total}/${lastEx.result.max}점 (추정) · ${examRounds().length}회분` : "1교시(언어지식·독해) → 휴식 → 청해, 점수 환산·합격 판정" })),
    h("span", { class: "chev", text: "›" })));
}

/* ---------- 파트 → 유형 ---------- */
function renderPart(grp){
  const v = $("view-part"); v.replaceChildren();
  if (!GROUPS.includes(grp)){ v.append(h("p", { class: "hint", text: "없는 파트예요." })); return; }
  const list = h("div", { class: "menu" });
  for (const key of groupKinds(grp)){
    const k = KINDS[key], c = bankCounts(key), a = accOf([key]);
    list.append(h("div", { class: "kind-row" },
      h("div", { class: "kr-top" }, h("b", { text: k.label }), h("span", { class: "jp", lang: "ja", text: k.jp })),
      h("div", { class: "kr-stats" },
        h("span", null, "남은 ", h("b", { text: `${c.left}/${c.total}` }), c.unit),
        h("span", null, "복습 ", h("b", { text: String(c.due) })),
        h("span", null, "정답률 ", h("b", { text: pct(a.pct) }))),
      h("div", { class: "kr-act" },
        h("button", { class: "btn primary", disabled: !c.total, onclick: () => startPractice(key, !(c.left + c.due)) }, c.left + c.due || !c.total ? "연습" : "연습 (다시)"),
        h("a", { class: "btn" + (c.total ? "" : " disabled"), href: `#/book/${key}` }, "문제집"))));
  }
  v.append(list);
  if (grp === "청해") v.append(h("p", { class: "hint", style: "margin-top:10px", text: "청해는 이 기기의 읽어주기(일본어 음성)로 들어요. 概要理解·統合理解는 아직 없어요." }));
}

/* ---------- 연습·문제집: 한 화면에 한 문제 ---------- */
/* 세트의 pos = 지금 보는 문항 번호(문항 수와 같으면 결과 화면). 지문형은 문항이 속한 지문(set.passages[unitId])을 위에 보여 준다 */
const srcOf = (s, q) => s.passages?.[q.unitId] || s;
const unitDone = (s, uid) => s.questions.every(x => x.unitId !== uid || x.checked);
function openSet(set){
  if (set.pos == null){ const i = set.questions.findIndex(q => !q.checked); set.pos = i < 0 ? set.questions.length : i; }
  current = set; saveCurrent(); go("play");
}
async function startPractice(kind, force = false, count = null){
  const k = KINDS[kind];
  try {
    const set = await pickSet(kind, count || (k.counts ? k.counts[k.counts.length - 1] : 1), { force });
    if (!set){ toast("이 유형은 문제은행에 아직 문제가 없어요."); return; }
    openSet(set);
  } catch (e){ toast(e?.message || "문제은행을 열지 못했어요."); }
}
function movePlay(d){
  const s = current; if (!s || route.name !== "play") return;
  const n = s.questions.length, q = s.questions[s.pos];
  if (d > 0 && (s.pos >= n || !q?.checked)) return;
  if (d < 0 && s.pos <= 0) return;
  s.pos = Math.max(0, Math.min(n, s.pos + d));
  saveCurrent(); renderPlay(); window.scrollTo({ top: 0 });
}
async function finishIfDone(s){
  if (s.done || !s.questions.every(x => x.checked)) return;
  s.done = true; s.elapsed = Date.now() - s.startedAt;
  await logHistory(s); await recordSet(s).catch(() => {});
  if (s.book){
    const row = books.get(`${s.book.kind}:${s.book.round}`);
    if (row){ const right = s.questions.filter(q => q.sel === q.answer).length;
      row.last = { right, total: s.questions.length, at: Date.now() }; row.best = Math.max(row.best || 0, right); }
  }
}
function markBtn(q, kind){
  if (!q.unitId) return null;
  const on = marks.has(q.unitId);
  return h("button", { class: "btn mark-btn", type: "button", "aria-pressed": String(on), "aria-label": on ? "북마크 빼기" : "북마크", onclick: async () => {
    if (marks.has(q.unitId)){ marks.delete(q.unitId); await db.del("marks", q.unitId).catch(() => {}); toast("북마크를 뺐어요"); }
    else { const r = { id: q.unitId, kind, at: Date.now() }; marks.set(r.id, r); await db.put("marks", r).catch(() => {}); toast("북마크했어요 · 문제집에서 모아 풀 수 있어요"); }
    renderPlay();
  } }, on ? "★" : "☆");
}
function renderPlay(){
  const v = $("view-play"); v.replaceChildren();
  if (!current){ v.append(h("div", { class: "panel empty" }, h("p", { text: "풀던 세트가 없어요." }), h("a", { class: "btn primary", href: "#/home" }, "홈으로"))); return; }
  const s = current, n = s.questions.length;
  if (s.pos == null || s.pos > n) s.pos = Math.max(0, s.questions.findIndex(q => !q.checked));
  const checked = s.questions.filter(q => q.checked).length;
  $("title").textContent = s.book ? `${KINDS[s.kind]?.label} 第${s.book.round}回` : s.retry ? s.title : (KINDS[s.kind]?.label || "연습");
  const timer = h("span", { class: "mono", id: "set-timer", text: fmtTime(s.done ? s.elapsed : Date.now() - s.startedAt) });
  v.append(h("div", { class: "play-head" },
    barNode(checked / n * 100, s.done ? "ok" : ""),
    h("div", { class: "meta" },
      h("b", { class: "mono", text: s.pos < n ? `${s.pos + 1} / ${n}` : `결과` }),
      s.sample ? h("span", { class: "tag sample", text: "예시" }) : null,
      s.bank ? h("span", { class: "tag" + (s.review ? " review" : ""), text: s.review ? "복습 포함" : s.engine ? "AI 문제" : s.book ? "문제집" : "문제은행" }) : null,
      h("span", { class: "tag", lang: "ja", text: KINDS[s.kind]?.jp || "" }),
      h("span", { class: "grow" }), h("span", null, "⏱ ", timer))));
  if (s.pos >= n){ v.append(playSummary(s)); return; }

  const q = s.questions[s.pos], src = srcOf(s, q);
  const sec = h("section", { class: "set one" });
  if (src.passage?.trim()){
    const inUnit = s.questions.filter(x => x.unitId === q.unitId);
    if (src !== s || s.passages) sec.append(h("div", { class: "hint unit-title", lang: "ja", text: `${src.title || s.title}${inUnit.length > 1 ? ` · 이 지문 ${inUnit.indexOf(q) + 1}/${inUnit.length}번째 문항` : ""}` }));
    sec.append(...passageBlock(src, s.kind, s.done || unitDone(s, q.unitId), src.title || s.title));
  }
  const i = s.pos;
  sec.append(questionNode(q, i, {
    source: src.title || s.title,
    onChange: async () => { await finishIfDone(s); saveCurrent(); renderPlay(); },
    onCheck: async qq => { if (qq.sel !== qq.answer && !s.retry) await addNote(s, qq); renderNoteCount(); },
    extraActions: s.retry ? [] : q.sel === q.answer
      ? [q.saved
          ? h("button", { class: "btn small ghost", onclick: async () => { q.saved = false; await removeNote(s.id + "-" + i); if (s.done) await recordSet(s).catch(() => {}); saveCurrent(); renderPlay(); renderNoteCount(); } }, "오답노트에서 빼기")
          : h("button", { class: "btn small ghost", onclick: async () => { await addNote(s, q); if (s.done) await recordSet(s).catch(() => {}); saveCurrent(); renderPlay(); renderNoteCount(); } }, "찍어서 맞힘 · 오답노트에 저장 · 복습에 넣기")]
      : [h("span", { class: "hint", text: "오답노트에 저장됐어요" })]
  }));
  v.append(sec);
  const last = i === n - 1;
  v.append(h("div", { class: "play-nav" },
    h("button", { class: "btn big", type: "button", disabled: i === 0, onclick: () => movePlay(-1) }, "← 이전"),
    markBtn(q, s.kind),
    h("button", { class: "btn big primary", type: "button", disabled: !q.checked, onclick: () => movePlay(1) }, last ? "결과 보기 →" : "다음 →")));
  if (q.checked && !last) v.append(h("p", { class: "hint center", text: "왼쪽으로 밀어도 다음 문제로 넘어가요" }));
}
function playSummary(s){
  const n = s.questions.length, right = s.questions.filter(q => q.sel === q.answer).length;
  const box = h("section", { class: "panel stack summary-box" },
    h("div", null, h("div", { class: "label", text: "결과" }), h("span", { class: "score", text: `${right} / ${n}` }),
      h("span", { class: "hint", text: `  ·  소요 ${fmtTime(s.done ? s.elapsed : Date.now() - s.startedAt)}` })),
    h("div", { class: "qgrid" }, s.questions.map((q, i) => h("button", { class: "qcell " + (!q.checked ? "" : q.sel === q.answer ? "ok" : "ng"), type: "button",
      onclick: () => { s.pos = i; saveCurrent(); renderPlay(); window.scrollTo({ top: 0 }); } }, h("span", { text: String(i + 1) }), h("i", { text: !q.checked ? "–" : q.sel === q.answer ? "○" : "✕" })))));
  const acts = h("div", { class: "row" });
  if (s.sample) acts.append(h("a", { class: "btn", href: "#/home" }, "홈으로"));
  else if (s.retry) acts.append(h("a", { class: "btn primary", href: `#/report/${dayKey()}` }, "보고서로"), h("a", { class: "btn", href: "#/note" }, "오답노트"));
  else if (s.book) acts.append(h("button", { class: "btn primary", onclick: () => openBook(s.book.kind, s.book.round, { fresh: true }) }, "이 회차 다시 풀기"),
    h("a", { class: "btn", href: `#/book/${s.kind}` }, "회차 목록"));
  else acts.append(h("button", { class: "btn primary", onclick: () => startPractice(s.kind) }, "같은 유형 계속 풀기"),
    h("a", { class: "btn", href: `#/part/${encodeURIComponent(KINDS[s.kind]?.group || "")}` }, "유형 목록"));
  box.append(acts);
  return box;
}
setInterval(() => { const t = $("set-timer"); if (t && current && !current.done) t.textContent = fmtTime(Date.now() - current.startedAt); }, 1000);
/* 스와이프: 왼쪽 = 다음(정답 확인 뒤), 오른쪽 = 이전. 세로 스크롤과 구분하려고 가로로 크게 움직였을 때만 */
(() => {
  let x0 = null, y0 = 0;
  const el = $("view-play");
  el.addEventListener("touchstart", e => { if (e.touches.length !== 1 || getSelection()?.toString()){ x0 = null; return; } x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  el.addEventListener("touchend", e => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0; x0 = null;
    if (Math.abs(dx) > 70 && Math.abs(dy) < Math.abs(dx) * 0.5) movePlay(dx < 0 ? 1 : -1);
  }, { passive: true });
  document.addEventListener("keydown", e => {
    if (route.name !== "play" || e.target.closest?.("input,textarea,select")) return;
    if (e.key === "ArrowRight") movePlay(1); else if (e.key === "ArrowLeft") movePlay(-1);
  });
})();

/* ---------- 문제집: 회차 목록 · 점수 · 이어 풀기 · 북마크 ---------- */
let books = new Map(), marks = new Map(), bookToken = 0;
async function openBook(kind, no, { fresh = false } = {}){
  const id = `${kind}:${no}`;
  let row = books.get(id);
  if (row?.set && !fresh){ openSet(row.set); return; }
  try {
    const ids = row?.ids || (await bookRounds(kind)).find(r => r.no === no)?.ids;
    const set = ids && await setFromIds(kind, ids, { keepOrder: true, title: `${KINDS[kind].label} 第${no}回` });
    if (!set){ toast("이 회차 문제를 찾지 못했어요"); return; }
    set.book = { kind, round: no };
    row = { ...(row || { id, kind, round: no, last: null, best: 0 }), ids, set };
    books.set(id, row); await db.put("book", row).catch(() => {});
    openSet(set);
  } catch (e){ toast(e?.message || "문제집을 열지 못했어요"); }
}
async function renderBook(){
  const v = $("view-book"), kind = route.args[0], k = KINDS[kind], token = ++bookToken;
  v.replaceChildren();
  if (!k){ v.append(h("p", { class: "hint", text: "없는 유형이에요." })); return; }
  $("title").textContent = `${k.label} 문제집`;
  let rounds;
  try { rounds = await bookRounds(kind); } catch (e){ v.append(h("div", { class: "status err", text: e.message })); return; }
  if (token !== bookToken) return;
  const marked = [...marks.values()].filter(m => m.kind === kind && !isReserved(m.id));
  const unitName = KINDS[kind].counts ? "문항" : "세트";
  v.append(h("section", { class: "panel row" },
    h("div", { class: "grow" }, h("b", { text: `북마크 ${marked.length}개` }), h("span", { class: "hint", text: "  문제를 풀 때 ☆를 누르면 모여요" })),
    h("button", { class: "btn", disabled: !marked.length, onclick: async () => {
      const set = await setFromIds(kind, marked.sort((a, b) => a.at - b.at).map(m => m.id), { keepOrder: true, title: `${k.label} 북마크 ${marked.length}${unitName}` });
      if (set) openSet(set);
    } }, "북마크만 풀기")));
  const list = h("div", { class: "menu", style: "margin-top:12px" });
  for (const r of rounds){
    const row = books.get(`${kind}:${r.no}`), s = row?.set;
    const live = s && !s.done, done = s ? s.questions.filter(q => q.checked).length : 0;
    const status = live ? `이어 풀기 ${done}/${s.questions.length}` : row?.last ? `${row.last.right}/${row.last.total}점 · 최고 ${row.best}` : "안 풂";
    list.append(h("button", { type: "button", class: "round-row" + (live ? " live" : row?.last ? " done" : ""), onclick: () => openBook(kind, r.no) },
      h("div", null, h("span", { class: "rn", lang: "ja", text: `第${r.no}回` }), h("span", { class: "m-sub", text: `${r.qn}문항${KINDS[kind].counts ? "" : ` · ${r.ids.length}세트`}` })),
      h("span", { class: "rs" + (row?.last ? " mono" : ""), text: status }),
      row?.last ? barNode(row.last.right / row.last.total * 100, "ok mini") : null));
  }
  if (!rounds.length) list.append(h("p", { class: "hint", style: "padding:16px", text: "이 유형은 문제집 회차가 아직 없어요." }));
  v.append(list, h("p", { class: "hint", style: "margin-top:10px", text: "문제집에서 푼 결과도 복습 일정과 정답률에 들어가요. 회차는 10문항(지문형은 세트 단위로 10문항 이내)씩이에요." }));
}

/* ---------- 실전 모의고사 ---------- */
/* exams 행: { id, round, startedAt, timing: "prop"|"official", phase: "s1"|"break"|"s2"|"done", breakAt, sections: { s1, s2 }, result, released }
 * 시간은 끝나는 시각(ends)으로 저장 → 앱을 닫았다 열어도 계속 흐르고, 지나 있으면 그 교시를 자동 제출한다. 해설은 다 끝난 뒤에만. */
let exams = [], examSheet = false, examConfirm = false, examPreview = null, examTiming = "prop";
const activeExam = () => exams.find(e => e.phase !== "done") || null;
const releasedRounds = () => new Set(exams.filter(e => e.released).map(e => e.round));
const applyReserve = () => setReserved(reservedIds(releasedRounds()));
let examSaveTimer = null;
function saveExam(row){ clearTimeout(examSaveTimer); examSaveTimer = setTimeout(() => db.put("exams", row).catch(() => {}), 300); }
const DAI_NO = n => `問題${n}`;
const fmtMin = m => m >= 60 ? `${Math.floor(m / 60)}시간${m % 60 ? ` ${m % 60}분` : ""}` : `${m}분`;

function renderExam(){
  const [sub, a, b, c] = route.args;
  examSheet = sub === "run" ? examSheet : false;
  if (!EXAM_CFG){ $("view-exam").replaceChildren(h("div", { class: "status err", text: "모의고사 구성 파일을 읽지 못했어요. 인터넷 연결을 확인하세요." })); return; }
  if (sub === "start") return renderExamStart(Number(a));
  if (sub === "run") return renderExamRun();
  if (sub === "result") return renderExamResult(a);
  if (sub === "review") return renderExamReview(a, b, Number(c) || 0);
  renderExamList();
}
function renderExamList(){
  const v = $("view-exam"); v.replaceChildren();
  const act = activeExam();
  if (act) v.append(h("section", { class: "panel row" },
    h("div", { class: "grow" }, h("b", { text: `${act.round}회 진행 중` }), h("span", { class: "hint", text: ` · ${act.phase === "break" ? "휴식" : act.phase === "s1" ? "1교시" : "청해"}` })),
    h("a", { class: "btn primary big", href: "#/exam/run" }, "이어서 →")));
  const list = h("div", { class: "menu", style: act ? "margin-top:12px" : null });
  for (const no of examRounds()){
    const done = exams.filter(e => e.round === no && e.result).sort((x, y) => y.startedAt - x.startedAt)[0];
    const live = act?.round === no;
    list.append(h("div", { class: "kind-row" },
      h("div", { class: "kr-top" }, h("b", { text: `모의고사 ${no}회` }),
        done ? h("span", { class: "tag " + (done.result.pass ? "ok" : "ng"), text: `${done.result.total}/${done.result.max}점 · ${done.result.pass ? "합격권" : "불합격권"} (추정)` }) : null),
      h("div", { class: "kr-stats" }, done ? h("span", { text: `${new Date(done.startedAt).toLocaleDateString("ko-KR")} 응시 · 예약 풀림(문제가 연습·문제집으로 돌아감)` })
        : h("span", { text: "아직 안 봤어요 · 이 회차 문제는 연습·문제집에 나오지 않아요" })),
      h("div", { class: "kr-act" },
        done ? h("a", { class: "btn", href: `#/exam/result/${done.id}` }, "결과·해설") : live ? h("a", { class: "btn primary", href: "#/exam/run" }, "이어서")
          : h("a", { class: "btn primary" + (act ? " disabled" : ""), href: `#/exam/start/${no}` }, "시작 준비"))));
  }
  v.append(list);
  v.append(h("p", { class: "hint", style: "margin-top:10px", text: `구성은 JLPT 공식 자료 기준이에요(1교시 문항 수는 공식 페이지에 없어 2009년 가이드북의 '目安' 값을 쓴 추정). 점수는 맞힌 비율로 환산한 추정이에요. 합격선: 총점 ${EXAM_CFG.pass.total}/${EXAM_CFG.pass.max}, 과목별 기준점 ${EXAM_CFG.pass.sectionMin}.` }));
}
async function renderExamStart(no){
  const v = $("view-exam"); v.replaceChildren(h("p", { class: "hint", text: "구성을 불러오는 중…" }));
  try {
    if (examPreview?.no !== no) examPreview = { no, s1: await buildSection(no, EXAM_CFG.sections[0]), s2: await buildSection(no, EXAM_CFG.sections[1]) };
  } catch (e){ v.replaceChildren(h("div", { class: "status err", text: e.message })); return; }
  const p = examPreview;
  v.replaceChildren();
  for (const s of [p.s1, p.s2]){
    const tbl = h("table", { class: "tagstat exam-plan" }, h("thead", null, h("tr", null, h("th", { text: "대문" }), h("th", { text: "공식" }), h("th", { text: "앱" }))),
      h("tbody", null, s.items.map(it => h("tr", { class: !it.kind ? "skip" : it.note ? "sub" : null },
        h("td", null, h("span", { lang: "ja", text: `${DAI_NO(it.no)} ${it.jp}` }), it.note ? h("div", { class: "hint", text: it.note }) : null),
        h("td", { class: "mono", text: String(it.official) }), h("td", { class: "mono", text: it.kind ? String(it.n) : "–" })))));
    v.append(h("section", { class: "panel stack", style: "margin-bottom:12px" }, h("div", { class: "label", text: `${s.label} · ${s.questions.length}문항 (공식 ${s.officialQn})` }), tbl));
  }
  const opt = (key, label, sub) => h("button", { class: "opt", type: "button", "aria-pressed": String(examTiming === key), onclick: () => { examTiming = key; renderExamStart(no); } },
    h("b", { text: label }), h("span", { class: "hint", text: sub }));
  v.append(h("section", { class: "panel stack" }, h("div", { class: "label", text: "시험 시간" }),
    h("div", { class: "opts" },
      opt("prop", "문항 수 비례 (기본)", `1교시 ${fmtMin(sectionMinutes(p.s1, "prop"))} · 청해 ${fmtMin(sectionMinutes(p.s2, "prop"))} — 공식 시간 × 앱 문항 수 ÷ 공식 문항 수`),
      opt("official", "공식 시간", `1교시 ${fmtMin(p.s1.officialMin)} · 청해 ${fmtMin(p.s2.officialMin)}`)),
    h("ul", { class: "hint plain-list" },
      h("li", { text: "1교시 → 휴식 → 청해 순서예요. 시작하면 앱을 닫아도 시간이 계속 흐르고, 시간이 끝나면 자동으로 제출돼요." }),
      h("li", { text: "해설·정답은 시험을 다 끝낸 뒤에만 볼 수 있어요. 문제 사이를 오가고 체크 표시를 할 수 있고, [마킹표]에서 답안을 한눈에 봐요." }),
      h("li", { text: "청해는 기기의 일본어 음성으로 한 번만 재생돼요(실전 모드)." })),
    h("button", { class: "btn primary big", disabled: !!activeExam(), onclick: () => startExam(no) }, "시작하기")));
}
async function startExam(no){
  const p = examPreview?.no === no ? examPreview : { s1: await buildSection(no, EXAM_CFG.sections[0]), s2: await buildSection(no, EXAM_CFG.sections[1]) };
  const now = Date.now();
  const row = { id: `exam-${no}-${now.toString(36)}`, round: no, startedAt: now, timing: examTiming, phase: "s1", breakAt: null, sections: { s1: p.s1, s2: p.s2 }, result: null, released: false };
  row.sections.s1.ends = now + sectionMinutes(row.sections.s1, row.timing) * 60000;
  examPreview = null;
  exams.push(row); await db.put("exams", row).catch(() => {}); ensurePersist();
  go("exam/run", { replace: true });
}
function examLeft(s){ return Math.max(0, s.ends - Date.now()); }
/* 교시 제출: 1교시 → 휴식, 청해 → 채점 */
async function submitSection(row, auto = false){
  examSheet = false; examConfirm = false;
  if (row.phase === "s1"){ row.phase = "break"; row.breakAt = Date.now(); }
  else if (row.phase === "s2"){ await finishExam(row); }
  saveExam(row);
  if (auto) toast(row.phase === "break" ? "1교시 시간이 끝나 자동으로 제출했어요" : "청해 시간이 끝나 자동으로 제출했어요");
  if (route.name === "exam") render();
}
function startListening(row){
  row.phase = "s2"; row.sections.s2.ends = Date.now() + sectionMinutes(row.sections.s2, row.timing) * 60000;
  saveExam(row); render();
}
async function finishExam(row){
  row.phase = "done";
  row.result = scoreExam(row);
  for (const s of Object.values(row.sections)) for (const q of s.questions) q.checked = true;
  /* 예약 풀기: 단위마다 연습과 같은 규칙으로 기록(틀린 것(안 고른 것 포함) = 1일 뒤 복습, 맞힌 것 = 푼 것). 틀린 문항은 오답노트에 */
  row.released = true;
  applyReserve();
  const units = new Map();                         // unitId → { id, kind, ok } (지문형은 세트 안 문항이 다 맞아야 ok)
  for (const s of Object.values(row.sections)) for (const q of s.questions){
    const u = units.get(q.unitId) || { id: q.unitId, kind: q.kind, ok: true };
    if (q.sel !== q.answer) u.ok = false;
    units.set(q.unitId, u);
  }
  await recordExamUnits([...units.values()]).catch(() => {});
  for (const s of Object.values(row.sections)){
    const title = `모의고사 ${row.round}회`;
    for (const q of s.questions) if (q.sel !== q.answer) await addNote({ id: `${row.id}-${s.id}`, kind: q.kind, title, passages: s.passages, questions: s.questions, passage: "" }, q).catch(() => {});
    /* 풀이 기록(유형별): 홈·파트의 정답률에 들어간다 */
    const byKind = new Map();
    for (const q of s.questions){ const r = byKind.get(q.kind) || { right: 0, total: 0 }; r.total++; if (q.sel === q.answer) r.right++; byKind.set(q.kind, r); }
    for (const [kind, r] of byKind){
      const rec = { id: `${row.id}-${kind}-${s.id}`, at: Date.now(), kind, title: `모의고사 ${row.round}회`, total: r.total, right: r.right, elapsedMs: 0, exam: true };
      history = [rec, ...history]; await db.put("history", rec).catch(() => {});
    }
  }
  await db.put("exams", row).catch(() => {});
  renderNoteCount();
  go(`exam/result/${row.id}`, { replace: true });
}
/* 1초마다: 남은 시간 표시, 시간이 끝나면 자동 제출(다른 화면에 있어도) */
setInterval(() => {
  const row = activeExam(); if (!row || (row.phase !== "s1" && row.phase !== "s2")) return;
  const s = row.sections[row.phase], left = examLeft(s);
  const t = $("exam-timer"); if (t){ t.textContent = fmtTime(left + 999); t.classList.toggle("low", left < 5 * 60000); }
  if (left <= 0 && !row.submitting){ row.submitting = true; submitSection(row, true).finally(() => { delete row.submitting; }); }
}, 1000);

function examQuestionNode(q, i){
  const wrap = h("article", { class: "q" });
  const listen = !!q.script?.length, quick = listen && !q.stem.trim();
  wrap.append(h("div", { class: "q-stem" }, h("span", { class: "q-no", text: `${i + 1}` }),
    listen ? h("div", { class: "jp listen-q hint", text: quick ? "🎧 짧은 말과 대답 1~3을 듣고 가장 알맞은 대답을 고르세요" : "🎧 질문은 음성으로 나와요. 들은 뒤 답을 고르세요" } ) : stemNode(q.stem, null)));
  if (listen) wrap.append(listenNode(q));
  wrap.append(h("ol", { class: "choices" }, q.choices.map((c, k) => h("li", null,
    h("button", { class: "choice", "aria-pressed": String(q.sel === k), onclick: () => { q.sel = q.sel === k ? null : k; saveExam(activeExam()); renderExamRun(); } },
      h("span", { class: "bubble", text: String(k + 1) }), quick ? h("span", { class: "hint", text: "음성으로 들어요" }) : h("span", { class: "jp", lang: "ja", text: c }))))));
  return wrap;
}
function renderExamRun(){
  const v = $("view-exam"); v.replaceChildren();
  const row = activeExam();
  if (!row){ v.append(h("div", { class: "panel empty" }, h("p", { text: "진행 중인 모의고사가 없어요." }), h("a", { class: "btn primary", href: "#/exam" }, "모의고사 목록"))); return; }
  $("title").textContent = `모의고사 ${row.round}회`;
  if (row.phase === "break"){
    const s2 = row.sections.s2, mins = sectionMinutes(s2, row.timing);
    const el = h("b", { class: "big-num", id: "break-timer" });
    const tick = () => { el.textContent = fmtTime(Date.now() - row.breakAt); };
    const id = setInterval(() => { if (!el.isConnected) clearInterval(id); else tick(); }, 1000); tick();
    v.append(h("section", { class: "panel stack center" },
      h("div", { class: "label", text: "1교시 끝 · 휴식" }), el, h("p", { class: "hint", text: `실제 시험처럼 ${EXAM_CFG.breakMinutes}분 정도 쉬어도 돼요. 준비되면 청해를 시작하세요.` }),
      h("p", { text: `청해 ${s2.questions.length}문항 · ${fmtMin(mins)} · 재생은 문제마다 한 번` }),
      ttsReady() ? null : h("p", { class: "status err", text: "이 기기에서 일본어 음성을 찾지 못했어요. 청해 전에 음성을 설치하세요." }),
      h("button", { class: "btn primary big", onclick: () => startListening(row) }, "청해 시작")));
    return;
  }
  const s = row.sections[row.phase], n = s.questions.length;
  s.pos = Math.min(Math.max(0, s.pos || 0), n - 1);
  const answered = s.questions.filter(q => q.sel != null).length;
  v.append(h("div", { class: "play-head exam-head" },
    barNode(answered / n * 100),
    h("div", { class: "meta" },
      h("b", { text: row.phase === "s1" ? "1교시" : "청해" }), h("span", { class: "mono", text: `${s.pos + 1} / ${n}` }), h("span", { class: "hint", text: `답 ${answered}` }),
      h("span", { class: "grow" }),
      h("b", { class: "mono exam-timer", id: "exam-timer", role: "timer", text: fmtTime(examLeft(s) + 999) }),
      h("button", { class: "btn small" + (examSheet ? " primary" : ""), onclick: () => { examSheet = !examSheet; examConfirm = false; renderExamRun(); } }, "마킹표"))));
  if (examSheet){ v.append(examSheetNode(row, s)); return; }
  const q = s.questions[s.pos], it = s.items.find(x => x.no === q.dai), src = s.passages[q.unitId];
  const first = s.questions.findIndex(x => x.dai === q.dai) === s.pos;
  const sec = h("section", { class: "set one" });
  sec.append(h("div", { class: "dai" + (first ? " first" : "") }, h("b", { lang: "ja", text: `${DAI_NO(it.no)} ${it.jp}` }), it.note ? h("span", { class: "hint", text: it.note }) : null));
  if (src?.passage?.trim()) sec.append(passageNode(src.passage, q.kind, null));
  sec.append(examQuestionNode(q, s.pos));
  v.append(sec);
  const flagged = s.flags.includes(s.pos), last = s.pos === n - 1;
  const move = d => { s.pos = Math.max(0, Math.min(n - 1, s.pos + d)); saveExam(row); renderExamRun(); window.scrollTo({ top: 0 }); };
  v.append(h("div", { class: "play-nav" },
    h("button", { class: "btn big", disabled: s.pos === 0, onclick: () => move(-1) }, "← 이전"),
    h("button", { class: "btn flag-btn", "aria-pressed": String(flagged), "aria-label": "체크 표시", onclick: () => { flagged ? s.flags.splice(s.flags.indexOf(s.pos), 1) : s.flags.push(s.pos); saveExam(row); renderExamRun(); } }, flagged ? "⚑" : "⚐"),
    last ? h("button", { class: "btn big primary", onclick: () => { examSheet = true; renderExamRun(); } }, "마킹표·제출")
      : h("button", { class: "btn big primary", onclick: () => move(1) }, "다음 →")));
}
function examSheetNode(row, s){
  const box = h("section", { class: "panel stack sheet" });
  for (const it of s.items){
    const idx = s.questions.map((q, i) => q.dai === it.no ? i : -1).filter(i => i >= 0);
    box.append(h("div", null, h("div", { class: "label", lang: "ja", text: `${DAI_NO(it.no)} ${it.jp}${it.kind ? "" : " · 건너뜀(앱에 없음)"}` }),
      idx.length ? h("div", { class: "qgrid" }, idx.map(i => {
        const q = s.questions[i];
        return h("button", { class: "qcell" + (q.sel != null ? " answered" : "") + (s.flags.includes(i) ? " flagged" : ""), type: "button",
          onclick: () => { s.pos = i; examSheet = false; saveExam(row); renderExamRun(); window.scrollTo({ top: 0 }); } },
          h("span", { text: String(i + 1) }), h("i", { text: q.sel != null ? NUM[q.sel] : "–" }));
      })) : null));
  }
  const blank = s.questions.filter(q => q.sel == null).length, flags = s.flags.length;
  const acts = h("div", { class: "confirm" });
  if (!examConfirm) acts.append(h("button", { class: "btn primary big", onclick: () => { examConfirm = true; renderExamRun(); } }, row.phase === "s1" ? "1교시 제출" : "청해 제출 · 채점"));
  else acts.append(h("span", { text: `${blank ? `안 고른 문항 ${blank}개는 오답이 돼요. ` : ""}${flags ? `체크 ${flags}개. ` : ""}제출하면 이 교시로 돌아올 수 없어요.` }),
    h("button", { class: "btn primary", onclick: () => submitSection(row) }, "제출"),
    h("button", { class: "btn ghost", onclick: () => { examConfirm = false; renderExamRun(); } }, "취소"));
  box.append(h("p", { class: "hint", text: `답 ${s.questions.length - blank}/${s.questions.length} · ⚑ 체크 ${flags}` }), acts);
  return box;
}
function renderExamResult(id){
  const v = $("view-exam"); v.replaceChildren();
  const row = exams.find(e => e.id === id);
  if (!row?.result){ v.append(h("p", { class: "hint", text: "결과를 찾지 못했어요." })); return; }
  $("title").textContent = `모의고사 ${row.round}회 결과`;
  const r = row.result, cfg = EXAM_CFG.pass;
  v.append(h("section", { class: "panel stack" },
    h("div", { class: "hero-top" }, h("div", null, h("div", { class: "big", text: `${r.total} / ${r.max}` }), h("div", { class: "sub", text: "총점 (추정)" })),
      h("span", { class: "verdict-big " + (r.pass ? "ok" : "ng"), text: r.pass ? "합격권" : "불합격권" })),
    h("div", { class: "score-rows" }, Object.entries(r.scores).map(([k, x]) => h("div", { class: "score-row" + (x.scaled != null && x.scaled < cfg.sectionMin ? " low" : "") },
      h("span", { text: EXAM_CFG.scores[k] }), h("b", { class: "mono", text: x.scaled == null ? "–" : `${x.scaled}` }), h("span", { class: "hint mono", text: `${x.right}/${x.total}` }),
      barNode(x.scaled == null ? 0 : x.scaled / cfg.sectionMax * 100, x.scaled != null && x.scaled >= cfg.sectionMin ? "ok" : "")))),
    h("p", { class: "hint", text: `합격선 총점 ${cfg.total}점 + 과목별 기준점 ${cfg.sectionMin}점. 점수는 맞힌 비율 × 60으로 환산한 추정이에요(공식 점수는 문항별 배점·등화를 거침).${r.sectionOk ? "" : " 기준점에 못 미친 과목이 있어요."}` })));
  const tbl = h("table", { class: "tagstat exam-plan" }, h("thead", null, h("tr", null, h("th", { text: "대문" }), h("th", { text: "맞힘" }), h("th", { text: "정답률" }))),
    h("tbody", null, r.dai.map(d => h("tr", { class: !d.total ? "skip" : d.right < d.total / 2 ? "ng" : null },
      h("td", null, h("span", { lang: "ja", text: `${d.section === "s2" ? "청해 " : ""}${DAI_NO(d.no)} ${d.jp}` }), d.note ? h("div", { class: "hint", text: d.note }) : null),
      h("td", { class: "mono", text: d.total ? `${d.right}/${d.total}` : "–" }), h("td", { class: "mono", text: d.total ? Math.round(d.right / d.total * 100) + "%" : "건너뜀" })))));
  v.append(h("section", { class: "panel stack", style: "margin-top:12px" }, h("div", { class: "label", text: "대문별 정답률" }), tbl));
  const wrong = Object.values(row.sections).reduce((a, s) => a + s.questions.filter(q => q.sel !== q.answer).length, 0);
  v.append(h("section", { class: "panel stack", style: "margin-top:12px" },
    h("p", { text: `틀린 문제 ${wrong}개는 오답노트에 넣었고, 1일 뒤 복습으로 나와요. 맞힌 문제는 연습에서 푼 것으로 기록했고, 이 회차 문제는 이제 문제집·복습에도 나와요.` }),
    h("div", { class: "row" },
      h("a", { class: "btn primary", href: `#/exam/review/${row.id}/s1/0` }, "1교시 해설"),
      h("a", { class: "btn primary", href: `#/exam/review/${row.id}/s2/0` }, "청해 해설"),
      h("a", { class: "btn", href: "#/note" }, "오답노트"))));
}
function renderExamReview(id, sid, i){
  const v = $("view-exam"); v.replaceChildren();
  const row = exams.find(e => e.id === id), s = row?.sections[sid];
  if (!row?.result || !s?.questions.length){ v.append(h("p", { class: "hint", text: "해설을 찾지 못했어요." })); return; }
  const n = s.questions.length; i = Math.max(0, Math.min(n - 1, i));
  const q = s.questions[i], it = s.items.find(x => x.no === q.dai), src = s.passages[q.unitId];
  $("title").textContent = `${row.round}회 ${sid === "s1" ? "1교시" : "청해"} 해설`;
  const go2 = j => go(`exam/review/${id}/${sid}/${j}`, { replace: true });
  v.append(h("div", { class: "play-head" }, barNode((i + 1) / n * 100),
    h("div", { class: "meta" }, h("b", { class: "mono", text: `${i + 1} / ${n}` }), h("span", { lang: "ja", text: `${DAI_NO(it.no)} ${it.jp}` }), h("span", { class: "grow" }),
      h("button", { class: "btn small", onclick: () => { const j = s.questions.findIndex((x, k) => k > i && x.sel !== x.answer); if (j >= 0) go2(j); else toast("뒤에 틀린 문제가 없어요"); } }, "다음 오답"))));
  const sec = h("section", { class: "set one" });
  if (src?.passage?.trim()) sec.append(...passageBlock(src, q.kind, true, `모의고사 ${row.round}회`));
  sec.append(questionNode(q, i, { source: `모의고사 ${row.round}회`, label: `${i + 1}`, onChange: () => renderExamReview(id, sid, i) }));
  v.append(sec, h("div", { class: "play-nav" },
    h("button", { class: "btn big", disabled: i === 0, onclick: () => go2(i - 1) }, "← 이전"),
    h("a", { class: "btn", href: `#/exam/result/${id}` }, "결과"),
    h("button", { class: "btn big primary", disabled: i === n - 1, onclick: () => go2(i + 1) }, "다음 →")));
}

/* ---------- 오답노트 ---------- */
const noteOpen = new Set(), noteRetry = new Map();
let noteFilter = "전체", confirmClear = false;
function renderNoteCount(){ const c = $("note-count"); c.textContent = notes.length > 99 ? "99+" : String(notes.length); c.hidden = !notes.length; }
function renderNote(){
  const v = $("view-note"); v.replaceChildren();
  renderNoteCount();
  if (!notes.length){
    v.append(h("div", { class: "panel empty" }, h("p", { text: "아직 오답노트가 비어 있어요." }),
      h("p", { class: "hint", text: "문제를 풀다가 틀리면 여기에 자동으로 모여요. 이 기기 안에 저장되고, 오프라인에서도 볼 수 있어요." })));
    return;
  }
  const weak = weakTags(false, 12), weakW = weakTags(true, 12);
  const chipsOf = list => h("div", { class: "weak" }, list.map(t => h("span", { lang: "ja", title: `출제 ${t.seen}회 · 틀림 ${t.wrong}회` }, t.id, h("i", { text: `틀림${t.wrong}·출제${t.seen}` }))));
  if (weak.length || weakW.length) v.append(h("section", { class: "panel stack" },
    weak.length ? h("div", null, h("div", { class: "label", text: "자주 틀린 문법·독해 패턴" }), chipsOf(weak)) : null,
    weakW.length ? h("div", null, h("div", { class: "label", text: "자주 틀린 어휘" }), chipsOf(weakW)) : null,
    h("div", { class: "hint", text: "찍어서 맞힌 문제도 틀린 것으로 셉니다. 전체 통계는 기록·설정 탭에 있어요." })));

  const filters = h("div", { class: "chips", style: "margin-top:14px" });
  for (const f of ["전체", ...GROUPS]){
    const n = f === "전체" ? notes.length : notes.filter(x => KINDS[x.kind]?.group === f).length;
    filters.append(h("button", { class: "chip", "aria-pressed": String(noteFilter === f), onclick: () => { noteFilter = f; renderNote(); } }, f, h("small", { text: String(n) })));
  }
  v.append(filters);

  const list = h("div", { class: "stack", style: "margin-top:12px" });
  for (const n of notes.filter(x => noteFilter === "전체" || KINDS[x.kind]?.group === noteFilter)){
    const det = h("details", { class: "note-item" });
    det.open = noteOpen.has(n.id);
    det.addEventListener("toggle", () => { det.open ? noteOpen.add(n.id) : noteOpen.delete(n.id); });
    const d = new Date(n.at);
    det.append(h("summary", null,
      h("div", { class: "meta" }, h("span", { class: "tag", lang: "ja", text: KINDS[n.kind]?.jp || "" }), h("span", { text: `${d.getMonth() + 1}/${d.getDate()}` }), h("span", { lang: "ja", text: n.title })),
      h("div", { class: "stemline", lang: "ja", text: n.q.stem.replace(/__/g, "") })));
    const body = h("div", { class: "note-body" });
    if (n.passage && n.passage.trim()) body.append(...passageBlock(n, n.kind, true, n.title, { always: true }));
    const r = noteRetry.get(n.id) || { stem: n.q.stem, choices: n.q.choices, answer: n.q.answer, ex: n.q.ex, gloss: n.q.gloss || [], script: n.q.script, sel: n.q.mySel, checked: true };
    body.append(questionNode(r, 0, { label: "復習", source: n.title, onChange: () => { noteRetry.set(n.id, r); renderNote(); },
      extraActions: [
        h("button", { class: "btn small", onclick: () => { noteRetry.set(n.id, { ...r, sel: null, checked: false }); renderNote(); } }, "다시 풀기"),
        h("button", { class: "btn small ghost", onclick: async () => { await removeNote(n.id); noteRetry.delete(n.id); renderNote(); } }, "외웠어요 · 삭제")] }));
    det.append(body);
    list.append(det);
  }
  v.append(list);
  const clear = h("div", { class: "confirm", style: "margin-top:18px" });
  if (!confirmClear) clear.append(h("button", { class: "btn small ghost", onclick: () => { confirmClear = true; renderNote(); } }, "오답노트 전체 비우기"));
  else clear.append(h("span", { text: `${notes.length}개를 모두 지울까요? 백업이 없다면 되돌릴 수 없어요.` }),
    h("button", { class: "btn small", onclick: async () => { notes = []; await db.clear("notes"); confirmClear = false; renderNote(); } }, "모두 지우기"),
    h("button", { class: "btn small ghost", onclick: () => { confirmClear = false; renderNote(); } }, "취소"));
  v.append(clear);
}

/* ---------- 단어장: 기본 단어장(data/vocab) / 내 단어장(☆) ---------- */
const vb = Object.assign({ mode: "base", kind: "grammar", group: "all", view: "todo", cover: false, q: "" }, prefs.get("n1.vocab", {}));
if (!VKINDS[vb.kind]) vb.kind = "grammar";
const saveVb = () => prefs.set("n1.vocab", vb);
const vShown = new Set();
let vLimit = 50, vToken = 0;
const V_VIEWS = { todo: "안 외운 것", done: "외운 것", wrong: "자주 틀림", all: "전체" };

/* 틀린 문제(오답노트·패턴 통계)에 나온 표제어 → 틀린 횟수 */
function vocabWrongMap(){
  const m = new Map(), bump = (k, n) => { if (k) m.set(k, Math.max(m.get(k) || 0, n)); };
  for (const t of tagList()) if (t.wrong > 0) bump(t.id, t.wrong);
  const fromNotes = new Map();
  for (const n of notes){
    const keys = new Set([...(n.q.patternTags || []), ...(n.q.ex?.kanji || []).map(k => k.word), ...(n.q.ex?.compare || []).map(c => c.word)]);
    for (const k of keys) fromNotes.set(k, (fromNotes.get(k) || 0) + 1);
  }
  for (const [k, n] of fromNotes) bump(k, n);
  return m;
}
const questionKeys = q => new Set([...(q.patternTags || []), ...(q.ex?.kanji || []).map(k => k.word), ...(q.ex?.compare || []).map(c => c.word)]);

function renderCards(){
  const v = $("view-cards"); v.replaceChildren();
  const [sub, deck] = route.args;
  if (sub === "flash" && deck){ renderFlash(v, deck); return; }
  if (sub === "test"){ renderTest(v); return; }
  if (sub === "review"){ renderReview(v, deck || dayKey()); return; }
  const flash = sub === "flash";
  const total = Object.keys(VKINDS).reduce((a, k) => a + vocabCount(k), 0);
  const tab = (on, label, n, fn) => h("button", { class: "chip", "aria-pressed": String(on), onclick: fn }, label, n != null ? h("small", { text: String(n) }) : null);
  const row = todayRow(), cardsLeft = ["words", "grammar"].reduce((a, d) => a + deckLeft(todayDeck(d, row)).length, 0);
  v.append(h("div", { class: "chips sub-tabs" },
    tab(flash, "카드 암기", cardsLeft || null, () => go("cards/flash", { replace: true })),
    tab(!flash && vb.mode !== "mine", "기본 단어장", total, () => { vb.mode = "base"; saveVb(); go("cards", { replace: true }); }),
    tab(!flash && vb.mode === "mine", "내 단어장", cards.length, () => { vb.mode = "mine"; saveVb(); go("cards", { replace: true }); })));
  if (flash) renderFlashHub(v); else if (vb.mode === "mine") myCards(v); else baseVocab(v);
}

async function baseVocab(v){
  const token = ++vToken;
  const kinds = h("div", { class: "chips" }, Object.entries(VKINDS).map(([key, k]) =>
    h("button", { class: "chip", "aria-pressed": String(vb.kind === key), onclick: () => { vb.kind = key; vb.group = "all"; vLimit = 50; vShown.clear(); saveVb(); renderCards(); } },
      k.label, h("small", { text: vocabCount(key) ? String(vocabCount(key)) : "준비 중" }))));
  const top = h("section", { class: "panel stack" }, kinds);
  v.append(top);
  const box = h("div", { class: "stack" });
  v.append(box);
  if (!vocabCount(vb.kind)){ box.append(h("div", { class: "panel empty" }, h("p", { text: `${VKINDS[vb.kind].label} 단어장은 준비 중이에요.` }))); return; }
  let items;
  try { items = await loadVocab(vb.kind); } catch (e){ if (token === vToken) box.append(h("div", { class: "status err", text: e.message })); return; }
  if (token !== vToken) return;

  const kind = vb.kind, wrong = vocabWrongMap();
  const inGroup = items.filter(it => vb.group === "all" || vocabGroup(kind, it) === vb.group);
  const isDone = it => vstate.done.has(it.id), wrongN = it => wrong.get(vocabKey(kind, it)) || 0;
  const groups = h("div", { class: "chips" }, ["all", ...VKINDS[kind].groups].map(g => {
    const n = g === "all" ? items.length : items.filter(it => vocabGroup(kind, it) === g).length;
    return n || g === "all" ? h("button", { class: "chip", lang: kind === "grammar" || g === "all" ? null : "ja", "aria-pressed": String(vb.group === g), onclick: () => { vb.group = g; vLimit = 50; saveVb(); renderCards(); } }, g === "all" ? "전체" : g, h("small", { text: String(n) })) : null;
  }));
  const views = h("div", { class: "chips" }, Object.entries(V_VIEWS).map(([key, label]) => {
    const n = { todo: inGroup.filter(it => !isDone(it)).length, done: inGroup.filter(isDone).length, wrong: inGroup.filter(wrongN).length, all: inGroup.length }[key];
    return h("button", { class: "chip", "aria-pressed": String(vb.view === key), onclick: () => { vb.view = key; vLimit = 50; saveVb(); renderCards(); } }, label, h("small", { text: String(n) }));
  }));
  const search = h("input", { id: "vocab-q", type: "search", placeholder: "표제어·읽기·뜻·예문으로 찾기", value: vb.q });
  search.addEventListener("input", e => { vb.q = e.target.value; vLimit = 50; saveVb(); paintList(); });
  const cover = h("input", { id: "vocab-cover", type: "checkbox", onchange: e => { vb.cover = e.target.checked; vShown.clear(); saveVb(); paintList(); } });
  cover.checked = vb.cover;
  const left = inGroup.filter(it => !isDone(it)).length;
  top.append(groups, views,
    h("div", { class: "row" }, h("label", { class: "field", for: "vocab-q" }, search), h("label", { class: "check", for: "vocab-cover" }, cover, "뜻 가리기 (탭하면 보여요)")),
    h("p", { class: "hint", text: `남은 ${left} / 전체 ${inGroup.length} · 외움 ${inGroup.length - left} · 자주 틀림 ${inGroup.filter(wrongN).length}` }));

  const list = h("div", { class: "card-list" });
  box.append(list);
  function paintList(){
    list.replaceChildren();
    const q = vb.q.trim().toLowerCase();
    const rows = inGroup.filter(it =>
      (vb.view === "all" || (vb.view === "todo" && !isDone(it)) || (vb.view === "done" && isDone(it)) || (vb.view === "wrong" && wrongN(it))) &&
      (!q || [it.word, it.pattern, it.reading, it.meaning, it.example, it.exampleKo, it.usage].some(x => (x || "").toLowerCase().includes(q))));
    if (vb.view === "wrong") rows.sort((a, b) => wrongN(b) - wrongN(a));
    if (!rows.length){ list.append(h("p", { class: "hint", text: vb.view === "todo" && !q ? "이 분류는 다 외웠어요." : "조건에 맞는 항목이 없어요." })); return; }
    for (const it of rows.slice(0, vLimit)) list.append(vocabCard(kind, it, wrongN(it)));
    if (rows.length > vLimit) list.append(h("button", { class: "btn small ghost", onclick: () => { vLimit += 50; paintList(); } }, `더 보기 (${rows.length - vLimit}개 남음)`));
  }
  paintList();
}

function vocabCard(kind, it, wrongN){
  const done = vstate.done.has(it.id), hidden = vb.cover && !vShown.has(it.id);
  const card = h("article", { class: "card vocab" + (hidden ? " covered" : "") + (done ? " done" : ""),
    onclick: () => { if (vb.cover){ vShown.has(it.id) ? vShown.delete(it.id) : vShown.add(it.id); renderCards(); } } });
  const doneBtn = h("button", { class: "btn small" + (done ? " primary" : " ghost"), "aria-pressed": String(done),
    onclick: async e => { e.stopPropagation(); await setDone(it.id, !done); toast(done ? "다시 '안 외운 것'으로 돌렸어요" : "외웠어요로 표시했어요"); renderCards(); } }, done ? "✓ 외웠어요" : "외웠어요");
  const head = kind === "grammar" ? it.pattern : it.word;
  const showReading = kind !== "grammar" && !(hidden && kind === "kanji");
  card.append(h("div", { class: "card-top" },
    kind === "grammar" ? rubyNode(head, it.reading, { cls: "front", hide: hidden }) : h("b", { class: "front", lang: "ja", text: head }),
    showReading && it.reading ? h("span", { class: "r", lang: "ja", text: `（${it.reading}）` }) : null,
    hidden ? null : speakBtn(kind === "grammar" ? (it.reading || it.pattern) : (it.reading || it.word), head),
    kind === "words" && it.pos ? h("span", { class: "tag", text: it.pos }) : null,
    wrongN ? h("span", { class: "tag wrong", text: `자주 틀림 ×${wrongN}` }) : null,
    doneBtn));
  if (hidden){ card.append(h("div", { class: "hint", text: kind === "kanji" ? "탭해서 읽기·뜻 보기" : "탭해서 뜻 보기" })); return card; }
  const body = h("div", { class: "card-body" }, h("div", { text: it.meaning }));
  if (kind === "grammar" && it.connection) body.append(h("div", { class: "src" }, h("b", { text: "접속 " }), h("span", { lang: "ja", text: it.connection })));
  if (kind === "kanji" && it.confusable?.length) body.append(h("div", { class: "src" }, "헷갈리는 읽기 ", it.confusable.map(c => h("span", { class: "x-read", lang: "ja", text: `✕ ${c}` }))));
  if (kind === "words"){
    if (it.usage) body.append(h("div", { class: "src" }, h("b", { text: "연어 " }), h("span", { lang: "ja", text: it.usage })));
    if (it.synonyms?.length) body.append(h("div", { class: "src" }, h("b", { text: "유의어 " }), h("span", { lang: "ja", text: it.synonyms.join("・") })));
  }
  body.append(h("div", { class: "extra", lang: "ja" }, glossNodes(it.example, glossOf(it.gloss, true, "기본 단어장")), speakBtn(it.example, "예문")), h("div", { class: "src", text: it.exampleKo }));
  if (kind === "grammar" && it.similar?.length) body.append(h("div", { class: "similar" }, it.similar.map(s =>
    h("div", null, rubyNode(s.pattern, s.reading), h("span", { text: " — " + s.diff })))));
  if (kind === "grammar"){
    const n = tagUnitCount(it.pattern);
    body.append(h("div", null, h("button", { class: "btn small", disabled: !n, onclick: async e => { e.stopPropagation(); await solveTag(it.pattern); } },
      n ? `이 문법 문제 풀기 (${n})` : "이 문법 문제 풀기 · 아직 문제 없음")));
  }
  card.append(body);
  return card;
}
async function solveTag(tag){
  try {
    const set = await pickByTag(tag);
    if (!set){ toast("이 문법 문제가 아직 없어요"); return; }
    openSet(set);
  } catch (e){ toast(e?.message || "문제를 열지 못했어요"); }
}

/* ---------- 카드 암기 · 오늘의 시험 (데일리 단어·문법) ---------- */
/* 오늘 덱 = 어제 시험에서 틀린 항목(맨 앞) + 오늘의 새 항목(자주 틀림 → A → B → C) + 복습할 카드. 그날 처음 열 때 정해서 daily 행에 저장 */
const DECK_LABEL = { words: "단어", grammar: "문법" };
const vocabCache = new Map();                      // id → { kind, it }
async function vocabById(){
  if (vocabCache.size) return vocabCache;
  for (const kind of Object.keys(VKINDS)){ if (!vocabCount(kind)) continue; for (const it of await loadVocab(kind)) vocabCache.set(it.id, { kind, it }); }
  return vocabCache;
}
function prevTestWrong(today){
  const rows = [...dailyRows.values()].filter(r => r.id < today && r.test?.wrong?.length).sort((a, b) => b.id.localeCompare(a.id));
  return rows[0]?.test.wrong || [];
}
function todayDeck(deck, row = todayRow()){
  row.cards ||= {};
  if (!row.cards[deck]){
    const today = row.id, list = rank[deck] || [], ids = new Set(list.map(x => x[0]));
    const nNew = (NEW_CARDS[settings.dailyMin || 60] || NEW_CARDS[60])[deck];
    const wrong = vocabWrongMap();
    const fresh = list.filter(([id]) => !vstate.done.has(id) && !vcards.has(id));
    const wrongFirst = fresh.filter(x => wrong.get(x[2])).sort((a, b) => wrong.get(b[2]) - wrong.get(a[2]));
    const newIds = [...new Set([...wrongFirst, ...fresh].map(x => x[0]))].slice(0, nNew);
    const carry = prevTestWrong(today).filter(id => ids.has(id));
    const due = [...vcards.values()].filter(r => r.deck === deck && cardDue(r.id, today)).sort((a, b) => a.dueDay.localeCompare(b.dueDay)).map(r => r.id);
    row.cards[deck] = { ids: [...new Set([...carry, ...newIds, ...due])], newIds, swiped: [], createdAt: Date.now() };
    db.put("daily", row).catch(() => {});
  }
  return row.cards[deck];
}
const deckLeft = d => d.ids.filter(id => !d.swiped.some(s => s.id === id));
function dueCardCount(){ const t = dayKey(); return [...vcards.values()].filter(r => cardDue(r.id, t)).length; }
function cardItems(row){
  if (!rank.words.length) return [];
  const items = [];
  for (const deck of ["words", "grammar"]){
    const d = todayDeck(deck, row), n = d.swiped.length, total = d.ids.length;
    if (!total) continue;
    items.push({ key: "cards:" + deck, label: `${DECK_LABEL[deck]} 카드 ${total}장`, sub: `새 ${d.newIds.length} · 복습 ${total - d.newIds.length} · 오른쪽 ○ 외웠음 / 왼쪽 ✕ 못 외움`,
      done: n >= total, progress: [n, total], go: () => go("cards/flash/" + deck) });
  }
  const ready = items.every(i => i.done);
  items.push({ key: "test", label: "오늘의 시험", sub: row.test ? `단어 ${row.test.word.right}/${row.test.word.total} · 문법 ${row.test.grammar.right}/${row.test.grammar.total}` : ready ? "단어 20 · 문법 5문항" : "카드를 다 넘기면 열려요",
    done: !!row.test, progress: null, locked: !ready && !row.test, go: () => ready || row.test ? go("cards/test") : toast("오늘 카드를 다 넘기면 시험이 열려요") });
  return items;
}

/* 카드 화면 */
let flashUndo = [], flashFlip = false;
function renderFlashHub(v){
  const row = todayRow();
  v.append(h("section", { class: "panel stack" }, h("div", { class: "label", text: "오늘의 카드" }),
    ...["words", "grammar"].map(deck => { const d = todayDeck(deck, row), n = d.swiped.length;
      return h("a", { class: "deck-row", href: `#/cards/flash/${deck}` },
        h("div", { class: "grow" }, h("b", { text: `${DECK_LABEL[deck]} 카드` }), h("span", { class: "hint", text: `  새 ${d.newIds.length} · 복습 ${d.ids.length - d.newIds.length}` }), barNode(d.ids.length ? n / d.ids.length * 100 : 100, n >= d.ids.length ? "ok" : "")),
        h("span", { class: "mono", text: `${n}/${d.ids.length}` })); }),
    (() => { const it = cardItems(row).find(i => i.key === "test");
      return h("button", { class: "btn big" + (it.locked ? "" : " primary"), disabled: !!it.locked, onclick: it.go }, row.test ? `오늘의 시험 결과 · ${it.sub}` : it.locked ? "오늘의 시험 · 카드를 다 넘기면 열려요" : "오늘의 시험 시작"); })(),
    h("p", { class: "hint", text: `오른쪽으로 밀면 외웠음(3 → 7 → 14일 뒤 다시, 그다음 졸업 = 외웠어요), 왼쪽은 못 외움(1일 뒤 다시). 새 항목은 하루 단어 ${(NEW_CARDS[settings.dailyMin || 60]).words}개·문법 ${(NEW_CARDS[settings.dailyMin || 60]).grammar}개(설정의 하루 학습 시간).` })));
}
async function renderFlash(v, deck){
  if (!DECK_KINDS[deck]){ v.append(h("p", { class: "hint", text: "없는 덱이에요." })); return; }
  const row = todayRow(), d = todayDeck(deck, row), left = deckLeft(d);
  $("title").textContent = `${DECK_LABEL[deck]} 카드`;
  const all = await vocabById();
  if (route.name !== "cards" || route.args[1] !== deck) return;
  v.replaceChildren();
  const n = d.swiped.length, total = d.ids.length;
  v.append(h("div", { class: "play-head" }, barNode(total ? n / total * 100 : 100, n >= total ? "ok" : ""),
    h("div", { class: "meta" }, h("b", { class: "mono", text: `${n}/${total}` }), h("span", { class: "hint", text: `남은 카드 ${left.length}장` }), h("span", { class: "grow" }),
      h("span", { class: "hint mono", text: `○ ${d.swiped.filter(s => s.ok).length} · ✕ ${d.swiped.filter(s => !s.ok).length}` }))));
  const undoBtn = h("button", { class: "btn flash-undo", type: "button", disabled: !flashUndo.some(u => u.deck === deck), "aria-label": "직전 카드 되돌리기", onclick: () => undoFlash(deck) }, "↶");
  if (!left.length){
    const other = deck === "words" ? "grammar" : "words", od = todayDeck(other, row);
    v.append(h("section", { class: "panel stack center flash-done" }, h("div", { class: "big-num", text: "✓" }), h("b", { text: `${DECK_LABEL[deck]} 카드 끝!` }),
      h("p", { class: "hint", text: `○ ${d.swiped.filter(s => s.ok).length} · ✕ ${d.swiped.filter(s => !s.ok).length}` }),
      deckLeft(od).length ? h("a", { class: "btn primary big", href: `#/cards/flash/${other}` }, `${DECK_LABEL[other]} 카드로 →`)
        : h("a", { class: "btn primary big", href: "#/cards/test" }, "오늘의 시험 →"),
      h("div", { class: "row center" }, undoBtn, h("a", { class: "btn", href: "#/home" }, "홈으로"))));
    return;
  }
  const id = left[0], entry = all.get(id);
  if (!entry){ d.swiped.push({ id, ok: true, skip: true }); db.put("daily", row).catch(() => {}); renderFlash(v, deck); return; }
  const card = flashCard(entry, vcards.get(id), d.newIds.includes(id));
  v.append(h("div", { class: "flash-stage" }, card));
  v.append(h("div", { class: "flash-btns" },
    h("button", { class: "btn big flash-x", type: "button", "aria-label": "못 외웠음", onclick: () => commitFlash(deck, id, false, card) }, "✕"),
    undoBtn,
    h("button", { class: "btn big flash-o", type: "button", "aria-label": "외웠음", onclick: () => commitFlash(deck, id, true, card) }, "○")));
  v.append(h("p", { class: "hint center", text: "카드를 탭하면 뒤집혀요 · 오른쪽 ○ 외웠음 · 왼쪽 ✕ 못 외움" }));
  dragCard(card, ok => commitFlash(deck, id, ok, card));
}
function flashCard({ kind, it }, st, isNew){
  const head = kind === "grammar" ? it.pattern : it.word;
  const reading = kind === "grammar" ? (it.reading || it.pattern) : (it.reading || it.word);
  const el = h("div", { class: "flash" + (flashFlip ? " flipped" : ""), tabIndex: 0, role: "button", "aria-label": "카드 뒤집기" });
  const tag = h("div", { class: "flash-tag" }, h("span", { class: "tag", text: kind === "grammar" ? `문법 · ${it.group}` : kind === "kanji" ? `한자 읽기 · ${it.group}` : `어휘${it.pos ? " · " + it.pos : ""}` }),
    isNew ? h("span", { class: "tag review", text: "새 카드" }) : st ? h("span", { class: "tag", text: `연속 ○ ${st.streak}` }) : null);
  const front = h("div", { class: "flash-face front" }, tag, h("div", { class: "flash-word", lang: "ja", text: head }), h("div", { class: "hint", text: "탭해서 뒤집기" }));
  const back = h("div", { class: "flash-face back" }, tag.cloneNode(true), ...cardBackNodes({ kind, it }));
  el.append(front, back);
  const flip = () => { flashFlip = !flashFlip; el.classList.toggle("flipped", flashFlip); };
  el.addEventListener("click", e => { if (e.target.closest(".spk,.gl") || el.dataset.dragged) return; flip(); });
  el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " "){ e.preventDefault(); flip(); } });
  return el;
}
/* 카드 뒷면: 표제어·읽기·뜻·예문 (카드 암기·보고서·다시 보기에서 같이 씀) */
function cardBackNodes({ kind, it }){
  const head = kind === "grammar" ? it.pattern : it.word;
  const reading = kind === "grammar" ? (it.reading || it.pattern) : (it.reading || it.word);
  return [
    kind === "grammar" ? rubyNode(it.pattern, it.reading, { cls: "flash-word sm" }) : h("div", { class: "flash-word sm", lang: "ja", text: head }),
    kind !== "grammar" ? h("div", { class: "flash-reading", lang: "ja" }, h("span", { text: it.reading }), speakBtn(reading, head)) : h("div", { class: "row center" }, speakBtn(reading, head)),
    h("div", { class: "flash-meaning", text: it.meaning }),
    kind === "grammar" && it.connection ? h("div", { class: "hint", lang: "ja", text: `접속: ${it.connection}` }) : null,
    kind === "kanji" && it.confusable?.length ? h("div", { class: "hint" }, "헷갈리는 읽기 ", it.confusable.map(c => h("span", { class: "x-read", lang: "ja", text: `✕ ${c}` }))) : null,
    kind === "words" && it.usage ? h("div", { class: "hint", lang: "ja", text: it.usage }) : null,
    it.example ? h("div", { class: "flash-ex", lang: "ja" }, h("span", { text: it.example }), speakBtn(it.example, "예문")) : null,
    it.exampleKo ? h("div", { class: "hint", text: it.exampleKo }) : null].filter(Boolean);
}
/* 끌어서 넘기기: 가로로 90px 넘게 끌면 넘김, 아니면 제자리 */
function dragCard(el, done){
  let x0 = null, y0 = 0, dx = 0;
  el.addEventListener("pointerdown", e => { if (e.target.closest(".spk")) return; x0 = e.clientX; y0 = e.clientY; dx = 0; delete el.dataset.dragged; el.setPointerCapture?.(e.pointerId); el.style.transition = "none"; });
  el.addEventListener("pointermove", e => {
    if (x0 == null) return;
    dx = e.clientX - x0; const dy = e.clientY - y0;
    if (Math.abs(dx) < 8 || Math.abs(dy) > Math.abs(dx)) return;
    el.dataset.dragged = "1";
    el.style.transform = `translateX(${dx}px) rotate(${dx / 20}deg)`;
    el.classList.toggle("go-o", dx > 60); el.classList.toggle("go-x", dx < -60);
  });
  const end = () => {
    if (x0 == null) return;
    x0 = null; el.style.transition = "";
    if (Math.abs(dx) > 90) done(dx > 0);
    else { el.style.transform = ""; el.classList.remove("go-o", "go-x"); setTimeout(() => { delete el.dataset.dragged; }, 0); }
  };
  el.addEventListener("pointerup", end); el.addEventListener("pointercancel", end);
}
let flashBusy = false;
async function commitFlash(deck, id, ok, el){
  if (flashBusy) return; flashBusy = true;
  try {
    el.style.transition = ""; el.style.transform = `translateX(${ok ? 120 : -120}%) rotate(${ok ? 12 : -12}deg)`; el.style.opacity = "0";
    const row = todayRow(), d = todayDeck(deck, row);
    const snap = await swipeCard(id, deck, ok, row.id, addDays);
    d.swiped.push({ id, ok, at: Date.now() }); await db.put("daily", row).catch(() => {});
    flashUndo.push({ deck, snap }); if (flashUndo.length > 30) flashUndo.shift();
    flashFlip = false;
    await new Promise(r => setTimeout(r, 160));
    checkDailyDone(todayItems());
  } finally { flashBusy = false; }
  if (route.name === "cards") renderCards();
}
async function undoFlash(deck){
  const i = flashUndo.map(u => u.deck).lastIndexOf(deck); if (i < 0) return;
  const [u] = flashUndo.splice(i, 1), row = todayRow(), d = todayDeck(deck, row);
  await restoreCard(u.snap);
  const j = d.swiped.map(s => s.id).lastIndexOf(u.snap.id); if (j >= 0) d.swiped.splice(j, 1);
  d.ids = [u.snap.id, ...d.ids.filter(x => x !== u.snap.id)];        // 되돌린 카드를 맨 앞으로
  await db.put("daily", row).catch(() => {});
  flashFlip = false; toast("직전 카드를 되돌렸어요"); renderCards();
}

/* 오늘의 시험: 단어 20(뜻 고르기·읽기 고르기·한국어 보고 단어 고르기) + 문법 5(예문 패턴 빈칸) */
let testState = null;                              // { day, qs, pos, done }
const shuffleArr = a => { for (let i = a.length - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pickN = (arr, n) => shuffleArr([...arr]).slice(0, n);
async function buildTest(row){
  const all = await vocabById();
  const wd = todayDeck("words", row), gd = todayDeck("grammar", row);
  const fill = (deck, ids, n, ok = () => true) => {
    const out = [...new Set(ids)].filter(id => all.has(id) && ok(id));
    for (const [id] of rank[deck]) { if (out.length >= n) break; if (!out.includes(id) && vcards.has(id) && all.has(id) && ok(id)) out.push(id); }
    return pickN(out, n);
  };
  const wordIds = fill("words", wd.ids, 20), gramIds = fill("grammar", gd.ids, 5, id => !!rank.blanks[id]);
  const pool = [...all.values()];
  const qs = [];
  wordIds.forEach((id, i) => qs.push(wordQ(all.get(id), pool, i % 3)));
  for (const id of gramIds) qs.push(grammarQ(all.get(id), pool));
  return qs.filter(Boolean);
}
/* 오답 선택지: 같은 종류(한자 읽기/어휘)·같은 품사(또는 분류)에서, 표제어 길이가 비슷한 것 우선 */
function similarItems(e, pool, n, valOf){
  const it = e.it, key = valOf(e);
  const same = pool.filter(x => x.kind === e.kind && x.it.id !== it.id && valOf(x) && valOf(x) !== key);
  const sameGroup = same.filter(x => (e.kind === "words" ? x.it.pos === it.pos : x.it.group === it.group));
  const near = (sameGroup.length >= n ? sameGroup : same).sort((a, b) => Math.abs((a.it.word || "").length - (it.word || "").length) - Math.abs((b.it.word || "").length - (it.word || "").length));
  const out = [], seen = new Set([key]);
  for (const x of pickN(near.slice(0, 12), 12)) { if (out.length >= n) break; const v = valOf(x); if (!seen.has(v)){ seen.add(v); out.push(v); } }
  return out;
}
function choiceQ(base, right, wrongs){
  if (wrongs.length < 3) return null;
  const choices = shuffleArr([right, ...wrongs.slice(0, 3)]);
  return { ...base, choices, answer: choices.indexOf(right), sel: null };
}
function wordQ(e, pool, type){
  const it = e.it, hasReading = it.reading && it.reading !== it.word;
  if (type === 1 && !hasReading) type = 0;
  if (type === 1){
    let wrongs = (it.confusable || []).filter(r => r !== it.reading);
    wrongs = [...wrongs, ...similarItems(e, pool, 3, x => x.it.reading)].filter((r, i, a) => r !== it.reading && a.indexOf(r) === i);
    return choiceQ({ id: it.id, deck: "words", type: "reading", prompt: it.word, ask: "읽기를 고르세요", jaChoices: true }, it.reading, wrongs);
  }
  if (type === 2) return choiceQ({ id: it.id, deck: "words", type: "word", prompt: it.meaning, ask: "이 뜻의 단어를 고르세요", jaChoices: true }, it.word, similarItems(e, pool, 3, x => x.it.word));
  return choiceQ({ id: it.id, deck: "words", type: "meaning", prompt: it.word, ask: "뜻을 고르세요", jaPrompt: true }, it.meaning, similarItems(e, pool, 3, x => x.it.meaning));
}
function grammarQ(e, pool){
  const it = e.it, b = rank.blanks[it.id]; if (!b) return null;
  const surf = x => { const bb = rank.blanks[x.it.id]; return bb ? x.it.example.slice(bb[0], bb[1]) : null; };
  const right = it.example.slice(b[0], b[1]);
  const others = pool.filter(x => x.kind === "grammar" && x.it.id !== it.id && surf(x) && surf(x) !== right);
  const same = others.filter(x => x.it.group === it.group);
  const wrongs = [...new Set(pickN(same.length >= 3 ? same : others, 6).map(surf))].slice(0, 3);
  return choiceQ({ id: it.id, deck: "grammar", type: "grammar", prompt: it.example.slice(0, b[0]) + "（　　）" + it.example.slice(b[1]), ask: `（　　）에 들어갈 말 · ${it.exampleKo || ""}`, jaPrompt: true, jaChoices: true, pattern: it.pattern }, right, wrongs);
}
async function renderTest(v){
  const row = todayRow();
  $("title").textContent = "오늘의 시험";
  if (row.test && !(testState?.day === row.id && !testState.saved)){ v.append(testResultNode(row)); return; }
  const ready = ["words", "grammar"].every(d => !deckLeft(todayDeck(d, row)).length);
  if (!ready){ v.append(h("div", { class: "panel empty" }, h("p", { text: "오늘 카드를 다 넘기면 시험이 열려요." }), h("a", { class: "btn primary", href: "#/cards/flash" }, "카드로"))); return; }
  if (testState?.day !== row.id){
    v.append(h("p", { class: "hint", text: "문제를 만드는 중…" }));
    testState = { day: row.id, qs: await buildTest(row), pos: 0 };
    if (route.name !== "cards") return;
    v.replaceChildren();
  }
  const t = testState, n = t.qs.length;
  if (!n){ v.append(h("p", { class: "hint", text: "시험을 만들 항목이 없어요." })); return; }
  if (t.pos >= n){ await saveTest(row, t); v.replaceChildren(testResultNode(row)); return; }
  const q = t.qs[t.pos];
  v.append(h("div", { class: "play-head" }, barNode(t.pos / n * 100), h("div", { class: "meta" }, h("b", { class: "mono", text: `${t.pos + 1} / ${n}` }),
    h("span", { class: "tag", text: q.deck === "grammar" ? "문법" : { meaning: "뜻 고르기", reading: "읽기 고르기", word: "단어 고르기" }[q.type] }))));
  const box = h("section", { class: "panel stack test-q" },
    h("div", { class: "hint", text: q.ask }),
    h("div", { class: "test-prompt" + (q.type === "grammar" ? " sent" : ""), lang: q.jaPrompt ? "ja" : null, text: q.prompt }),
    h("ol", { class: "choices" }, q.choices.map((c, i) => {
      const done = q.sel != null, cls = "choice" + (done && i === q.answer ? " right" : done && i === q.sel ? " wrongpick" : "");
      return h("li", null, h("button", { class: cls, disabled: done, "aria-pressed": String(q.sel === i), onclick: () => { q.sel = i; renderCards(); } },
        h("span", { class: "bubble", text: String(i + 1) }), h("span", { class: q.jaChoices ? "jp" : null, lang: q.jaChoices ? "ja" : null, text: c })));
    })));
  if (q.sel != null){
    const ok = q.sel === q.answer;
    box.append(h("div", { class: "row" }, h("span", { class: "result " + (ok ? "ok" : "ng"), text: ok ? "맞았어요" : `틀렸어요 · 정답 ${NUM[q.answer]}` }), q.pattern ? h("span", { class: "hint", lang: "ja", text: q.pattern }) : null));
  }
  v.append(box, h("div", { class: "play-nav one-btn" }, h("button", { class: "btn big primary", disabled: q.sel == null, onclick: () => { t.pos++; renderCards(); window.scrollTo({ top: 0 }); } }, t.pos === n - 1 ? "결과 보기 →" : "다음 →")));
}
async function saveTest(row, t){
  if (t.saved) return;
  const part = d => { const qs = t.qs.filter(q => q.deck === d); return { right: qs.filter(q => q.sel === q.answer).length, total: qs.length }; };
  const wrong = [...new Set(t.qs.filter(q => q.sel !== q.answer).map(q => q.id))];
  row.test = { at: Date.now(), word: part("words"), grammar: part("grammar"), wrong,
    items: t.qs.map(q => ({ id: q.id, deck: q.deck, type: q.type, ask: q.ask, prompt: q.prompt, choices: q.choices, answer: q.answer, sel: q.sel, pattern: q.pattern || "" })) };   // 보고서용 문항별 기록
  /* 틀린 항목: 내일 덱 맨 앞(prevTestWrong) + 카드 상태는 ✕와 같게(1일 뒤) */
  for (const id of wrong) await swipeCard(id, t.qs.find(q => q.id === id).deck, false, row.id, addDays).catch(() => {});
  t.saved = true;
  await db.put("daily", row).catch(() => {});
  checkDailyDone(todayItems());
}
function testResultNode(row){
  const t = row.test;
  return h("section", { class: "panel stack center" }, h("div", { class: "label", text: `오늘의 시험 · ${row.id}` }),
    h("div", { class: "score-rows" },
      h("div", { class: "score-row" }, h("span", { text: "단어" }), h("b", { class: "mono", text: `${t.word.right}/${t.word.total}` }), h("span"), barNode(t.word.total ? t.word.right / t.word.total * 100 : 0, "ok")),
      h("div", { class: "score-row" }, h("span", { text: "문법" }), h("b", { class: "mono", text: `${t.grammar.right}/${t.grammar.total}` }), h("span"), barNode(t.grammar.total ? t.grammar.right / t.grammar.total * 100 : 0, "ok"))),
    h("p", { class: "hint", text: t.wrong.length ? `틀린 ${t.wrong.length}개는 내일 카드 맨 앞에 나와요.` : "모두 맞았어요!" }),
    h("div", { class: "row center" }, h("a", { class: "btn primary", href: "#/home" }, "홈으로"), h("a", { class: "btn", href: "#/rec" }, "기록")));
}

/* ---------- 일일 보고서 (#/report/YYYY-MM-DD) ---------- */
/* daily 행(넘긴 카드·시험 문항) + 그날의 풀이 기록(history)·오답노트(notes)로 만든다 */
const reportOpen = new Set();
const dayStart = key => new Date(key + "T00:00:00+09:00").getTime();
const inDay = (t, key) => t >= dayStart(key) && t < dayStart(addDays(key, 1));
const fmtDay = key => { const [, m, d] = key.split("-"); const w = "일월화수목금토"[new Date(key + "T12:00:00+09:00").getDay()]; return `${+m}월 ${+d}일(${w})`; };
/* 기록이 있는 날짜(데일리·풀이 기록·오답노트) */
function studyDays(){
  const s = new Set([...dailyRows.keys(), dayKey()]);
  for (const r of history) s.add(dayKey(r.at));
  for (const n of notes) s.add(dayKey(n.at));
  return [...s].sort();
}
const dayNotes = key => notes.filter(n => n.kind !== "vocabtest" && inDay(n.at, key));
async function renderReport(){
  const v = $("view-report"), day = /^\d{4}-\d{2}-\d{2}$/.test(route.args[0] || "") ? route.args[0] : dayKey();
  v.replaceChildren();
  $("title").textContent = `학습 보고서 · ${fmtDay(day)}`;
  const days = studyDays(), i = days.indexOf(day);
  const prev = i > 0 ? days[i - 1] : days.filter(d => d < day).pop(), next = i >= 0 ? days[i + 1] : days.find(d => d > day);
  const pick = h("input", { type: "date", value: day, max: dayKey(), "aria-label": "날짜 고르기", onchange: e => e.target.value && go(`report/${e.target.value}`, { replace: true }) });
  v.append(h("div", { class: "day-nav" },
    h("button", { class: "btn", disabled: !prev, "aria-label": "이전 기록 날짜", onclick: () => go(`report/${prev}`, { replace: true }) }, "◀"),
    pick,
    h("button", { class: "btn", disabled: !next, "aria-label": "다음 기록 날짜", onclick: () => go(`report/${next}`, { replace: true }) }, "▶")));
  const row = dailyRows.get(day) || (day === dayKey() ? todayRow() : null);
  const all = await vocabById();
  if (route.name !== "report") return;
  const hist = history.filter(r => inDay(r.at, day)), wrongNotes = dayNotes(day);
  if (!row && !hist.length && !wrongNotes.length){ v.append(h("div", { class: "panel empty" }, h("p", { text: "이 날은 기록이 없어요." }))); return; }

  /* 카드 */
  const missIds = [];
  for (const deck of ["words", "grammar"]){
    const d = row?.cards?.[deck];
    if (!d?.swiped?.length && !d?.ids?.length) continue;
    const sec = h("section", { class: "panel stack report-sec" }, h("div", { class: "label", text: `${DECK_LABEL[deck]} 카드 · 넘김 ${d.swiped.length}/${d.ids.length} · ○ ${d.swiped.filter(s => s.ok).length} ✕ ${d.swiped.filter(s => !s.ok).length}` }));
    const list = h("div", { class: "rep-cards" });
    for (const s of d.swiped){
      const e = all.get(s.id); if (!e) continue;
      if (!s.ok) missIds.push(s.id);
      const key = `${day}:${s.id}`, open = reportOpen.has(key);
      list.append(h("div", { class: "rep-card" + (s.ok ? "" : " miss") + (open ? " open" : "") },
        h("button", { class: "rep-head", type: "button", "aria-expanded": String(open), onclick: () => { open ? reportOpen.delete(key) : reportOpen.add(key); renderReport(); } },
          h("span", { class: "mark", text: s.ok ? "○" : "✕" }), h("b", { lang: "ja", text: e.kind === "grammar" ? e.it.pattern : e.it.word }), h("span", { class: "hint", text: e.it.meaning })),
        open ? h("div", { class: "rep-back" }, ...cardBackNodes(e)) : null));
    }
    if (!d.swiped.length) list.append(h("p", { class: "hint", text: "아직 넘긴 카드가 없어요." }));
    sec.append(list);
    v.append(sec);
  }
  /* 오늘의 시험 */
  if (row?.test){
    const t = row.test, sec = h("section", { class: "panel stack report-sec" },
      h("div", { class: "label", text: `오늘의 시험 · 단어 ${t.word.right}/${t.word.total} · 문법 ${t.grammar.right}/${t.grammar.total}` }));
    if (t.items?.length){
      const ol = h("ol", { class: "rep-test" });
      for (const q of t.items){
        const ok = q.sel === q.answer;
        ol.append(h("li", { class: ok ? null : "ng" },
          h("div", { class: "rq" }, h("span", { class: "mark", text: ok ? "○" : "✕" }), h("span", { lang: q.type === "word" ? null : "ja", text: q.prompt }), h("span", { class: "hint", text: ` ${q.ask?.split(" · ")[0] || ""}` })),
          h("div", { class: "ra" }, h("span", { text: "정답 " }), h("b", { lang: "ja", text: q.choices[q.answer] }),
            ok ? null : h("span", { class: "my" }, " · 내 답 ", h("s", { lang: "ja", text: q.sel == null ? "–" : q.choices[q.sel] })))));
      }
      sec.append(ol);
    } else sec.append(h("p", { class: "hint", text: "이 날의 시험은 점수만 남아 있어요(문항별 기록은 2026-10-15부터)." }));
    v.append(sec);
  }
  /* 오늘 푼 문제 */
  if (hist.length || wrongNotes.length){
    const by = new Map();
    for (const r of hist){ const x = by.get(r.kind) || { right: 0, total: 0, exam: 0 }; x.right += r.right; x.total += r.total; if (r.exam) x.exam++; by.set(r.kind, x); }
    const sec = h("section", { class: "panel stack report-sec" }, h("div", { class: "label", text: `푼 문제 · ${hist.reduce((a, r) => a + r.total, 0)}문항` }));
    if (by.size) sec.append(h("table", { class: "tagstat" }, h("tbody", null, [...by].map(([k, x]) => h("tr", null,
      h("td", null, h("span", { text: KINDS[k]?.label || k }), x.exam ? h("span", { class: "hint", text: " (모의고사 포함)" }) : null),
      h("td", { class: "mono", text: `${x.right}/${x.total}` }), h("td", { class: "mono", text: x.total ? Math.round(x.right / x.total * 100) + "%" : "–" }))))));
    if (wrongNotes.length) sec.append(h("div", { class: "label", text: `틀린 문제 ${wrongNotes.length}개` }),
      h("ul", { class: "rep-wrong" }, wrongNotes.map(n => h("li", null, h("button", { class: "linkish", type: "button", onclick: () => { noteOpen.add(n.id); noteFilter = "전체"; go("note"); } },
        h("span", { class: "tag", lang: "ja", text: KINDS[n.kind]?.jp || "" }), h("span", { lang: "ja", text: (n.q.stem || "即時応答").replace(/__/g, "").slice(0, 40) }))))));
    v.append(sec);
  }
  v.append(h("div", { class: "row report-acts" },
    h("button", { class: "btn primary", disabled: !missIds.length, onclick: () => go(`cards/review/${day}`) }, `✕만 다시 보기${missIds.length ? ` (${missIds.length})` : ""}`),
    h("button", { class: "btn primary", disabled: !wrongNotes.length, onclick: () => retryWrong(day) }, `틀린 것만 다시 풀기${wrongNotes.length ? ` (${wrongNotes.length})` : ""}`)));
}
/* 틀린 문제 다시 풀기: 그날 오답노트 문항을 한 세트로(풀이 기록·복습 일정·오답노트에는 남기지 않음) */
function retryWrong(day){
  const list = dayNotes(day); if (!list.length) return;
  const passages = {};
  const questions = list.map(n => { if (n.passage?.trim()) passages[n.id] = { title: n.title, topic: "", passage: n.passage, ...passageFields(n) };
    return { stem: n.q.stem, choices: n.q.choices, answer: n.q.answer, ex: n.q.ex, gloss: n.q.gloss || [], patternTags: n.q.patternTags || [], unitId: n.id, ...(n.q.script ? { script: n.q.script } : {}) }; });
  const set = prepSet({ kind: list[0].kind, title: `${fmtDay(day)} 틀린 문제 ${list.length}`, questions }, { shuffle: true, fallbackKind: list[0].kind });
  set.passages = passages; set.retry = true;
  openSet(set);
}
/* ✕만 다시 보기: 그날 ✕ 카드를 넘겨 보기만(복습 일정·외웠어요는 그대로) */
let reviewPos = 0, reviewDay = null;
async function renderReview(v, day){
  const row = dailyRows.get(day), all = await vocabById();
  if (route.name !== "cards") return;
  v.replaceChildren();
  const ids = ["words", "grammar"].flatMap(d => (row?.cards?.[d]?.swiped || []).filter(s => !s.ok).map(s => s.id)).filter(id => all.has(id));
  $("title").textContent = `✕ 다시 보기 · ${fmtDay(day)}`;
  if (reviewDay !== day){ reviewDay = day; reviewPos = 0; flashFlip = false; }
  if (!ids.length){ v.append(h("div", { class: "panel empty" }, h("p", { text: "다시 볼 ✕ 카드가 없어요." }))); return; }
  const n = ids.length, i = Math.min(reviewPos, n);
  v.append(h("div", { class: "play-head" }, barNode(i / n * 100), h("div", { class: "meta" }, h("b", { class: "mono", text: i < n ? `${i + 1} / ${n}` : "끝" }), h("span", { class: "hint", text: "복습 일정은 바뀌지 않아요" }))));
  if (i >= n){
    v.append(h("section", { class: "panel stack center flash-done" }, h("b", { text: "다 봤어요" }),
      h("div", { class: "row center" }, h("button", { class: "btn", onclick: () => { reviewPos = 0; renderCards(); } }, "처음부터"), h("a", { class: "btn primary", href: `#/report/${day}` }, "보고서로"))));
    return;
  }
  const card = flashCard(all.get(ids[i]), vcards.get(ids[i]), false);
  const move = d => { reviewPos = Math.max(0, Math.min(n, reviewPos + d)); flashFlip = false; renderCards(); };
  v.append(h("div", { class: "flash-stage" }, card),
    h("div", { class: "flash-btns" }, h("button", { class: "btn big", disabled: i === 0, onclick: () => move(-1) }, "← 이전"), h("span"), h("button", { class: "btn big primary", onclick: () => move(1) }, "다음 →")));
  dragCard(card, ok => move(ok ? 1 : -1));
}

/* ---------- 내 단어장(☆) ---------- */
const CARD_TYPES = { all: "전체", kanji: "한자", grammar: "문법", compare: "비슷한 말", keigo: "경어" };
let cardFilter = "all", cardQuery = "", hideMeaning = false;
const revealed = new Set();
function renderCardsCount(){}
function myCards(v){
  if (!cards.length){
    v.append(h("div", { class: "panel empty" }, h("p", { text: "단어장이 비어 있어요." }),
      h("p", { class: "hint", text: "해설의 한자·문법·비슷한 말 옆 ☆를 누르면 여기에 저장돼요. 이 기기 안에 저장되고 오프라인에서도 볼 수 있어요." })));
    return;
  }
  const top = h("section", { class: "panel stack" });
  const chips = h("div", { class: "chips" });
  for (const [key, label] of Object.entries(CARD_TYPES)){
    const n = key === "all" ? cards.length : cards.filter(c => c.type === key).length;
    chips.append(h("button", { class: "chip", "aria-pressed": String(cardFilter === key), onclick: () => { cardFilter = key; renderCards(); } }, label, h("small", { text: String(n) })));
  }
  top.append(chips);
  const search = h("input", { id: "card-q", type: "search", placeholder: "단어·읽기·뜻으로 찾기", value: cardQuery });
  search.addEventListener("input", e => { cardQuery = e.target.value; renderCardList(); });
  const hideBox = h("input", { id: "hide-meaning", type: "checkbox", onchange: e => { hideMeaning = e.target.checked; revealed.clear(); renderCardList(); } });
  hideBox.checked = hideMeaning;
  top.append(h("div", { class: "row" }, h("label", { class: "field", for: "card-q" }, search),
    h("label", { class: "check", for: "hide-meaning" }, hideBox, "뜻 가리기 (탭하면 보여요)")));
  v.append(top);
  v.append(h("div", { id: "card-list", class: "card-list" }));
  renderCardList();
}
function renderCardList(){
  const box = $("card-list"); if (!box) return;
  box.replaceChildren();
  const q = cardQuery.trim().toLowerCase();
  const list = cards.filter(c => (cardFilter === "all" || c.type === cardFilter) &&
    (!q || [c.front, c.reading, c.meaning, c.extra].some(x => (x || "").toLowerCase().includes(q))));
  if (!list.length){ box.append(h("p", { class: "hint", text: "조건에 맞는 카드가 없어요." })); return; }
  for (const c of list){
    const hidden = hideMeaning && !revealed.has(c.id);
    const card = h("article", { class: "card" + (hidden ? " covered" : ""), onclick: () => { if (hideMeaning){ revealed.has(c.id) ? revealed.delete(c.id) : revealed.add(c.id); renderCardList(); } } },
      h("div", { class: "card-top" },
        h("b", { class: "front", lang: "ja", text: c.front }),
        c.reading ? h("span", { class: "r", lang: "ja", text: hidden ? "" : `（${c.reading}）` }) : null,
        h("span", { class: "tag", text: CARD_TYPES[c.type] || "" }),
        h("button", { class: "btn small ghost del", "aria-label": `${c.front} 삭제`, onclick: async e => { e.stopPropagation(); cards = cards.filter(x => x.id !== c.id); cardIds.delete(c.id); await db.del("cards", c.id); renderCards(); } }, "삭제")),
      hidden ? h("div", { class: "hint", text: "탭해서 뜻 보기" }) : h("div", { class: "card-body" },
        c.meaning ? h("div", { text: c.meaning }) : null,
        c.extra ? h("div", { class: "extra", lang: "ja", text: c.extra }) : null,
        c.source ? h("div", { class: "src", lang: "ja", text: "출처: " + c.source }) : null));
    box.append(card);
  }
}

/* ---------- 면접 · 내 답변 노트 ---------- */
const iv = Object.assign({ mode: "notes", cat: "all", scene: "all", cover: false, draft: null }, prefs.get("n1.interview", {}));
const saveIv = () => prefs.set("n1.interview", iv);
const ansOpen = new Set(), memo = new Map();          // memo: 답변 id → 보이는 문장 번호 Set (외우기 모드)
let ivConfirmDel = null, fuBusy = null, fuError = null;
const TIMER_OPTS = [[30, "30초"], [60, "1분"], [90, "1분30초"], [120, "2분"]];
let timer = null;                                     // { id, acc, since, buzzed } since가 null이면 일시정지

const charCount = t => t.replace(/\s/g, "").length;
const estSec = n => Math.round(n / 300 * 60);         // 1분 ≈ 300자
const fmtSec = s => s >= 60 ? `${Math.floor(s / 60)}분${s % 60 ? ` ${s % 60}초` : ""}` : `${s}초`;
function sentences(text){
  const out = [];
  for (const line of text.split(/\n+/))
    for (const s of line.match(/[^。！？!?]+[。！？!?]+[」』）)]*|[^。！？!?]+$/g) || []) if (s.trim()) out.push(s.trim());
  return out;
}
function renderIvCount(){}

function openDraft({ cat, question = "", text = "", editingId = null }){
  iv.draft = { cat: CAT[cat] ? cat : (CAT[iv.cat] ? iv.cat : CATS[0].key), question, text, editingId };
  saveIv(); renderInterview();
  const form = $("ans-form");
  form?.scrollIntoView({ behavior: "smooth", block: "start" });
  (question ? $("ans-text") : $("ans-q"))?.focus({ preventScroll: true });
}
async function saveDraft(){
  const d = iv.draft;
  if (!d.question.trim() || !d.text.trim()){ toast("질문과 답변을 모두 입력하세요"); return; }
  const old = d.editingId ? answers.find(a => a.id === d.editingId) : null;
  const now = Date.now();
  const rec = { ...(old || { id: now.toString(36) + Math.random().toString(36).slice(2, 6), at: now, timerSec: 60, followups: null }),
    cat: d.cat, question: d.question.trim(), text: d.text.trim(), updatedAt: now };
  try { await db.put("answers", rec); } catch { toast("저장하지 못했어요. 기기 저장소를 확인하세요."); return; }
  answers = [rec, ...answers.filter(a => a.id !== rec.id)].sort((a, b) => b.at - a.at);
  if (iv.cat !== "all" && iv.cat !== rec.cat) iv.cat = "all";
  iv.draft = null; saveIv();
  ansOpen.add(rec.id); memo.delete(rec.id);
  ensurePersist(); toast(old ? "수정했어요" : "저장했어요");
  renderInterview();
}

function renderInterview(){
  const v = $("view-iv"); v.replaceChildren();
  renderIvCount();
  v.append(h("div", { class: "chips sub-tabs" },
    h("button", { class: "chip", "aria-pressed": String(iv.mode !== "keigo"), onclick: () => { iv.mode = "notes"; saveIv(); renderInterview(); } }, "내 답변 노트", h("small", { text: String(answers.length) })),
    h("button", { class: "chip", "aria-pressed": String(iv.mode === "keigo"), onclick: () => { iv.mode = "keigo"; saveIv(); renderInterview(); } }, "경어 카드", h("small", { text: String(KEIGO.length) }))));
  v.append(iv.mode === "keigo" ? keigoCards() : answerNotes());
}

/* ---------- 면접 · 경어 상황 카드 ---------- */
const keigoShown = new Set();
function keigoCards(){
  const box = h("div", { class: "stack" });
  const top = h("section", { class: "panel stack" });
  const chips = h("div", { class: "chips" });
  for (const [key, label] of [["all", "전체"], ...Object.entries(SCENES)]){
    const n = key === "all" ? KEIGO.length : KEIGO.filter(c => c.scene === key).length;
    chips.append(h("button", { class: "chip", lang: key === "all" ? null : "ja", "aria-pressed": String(iv.scene === key), onclick: () => { iv.scene = key; saveIv(); renderInterview(); } }, label, h("small", { text: String(n) })));
  }
  const cover = h("input", { id: "keigo-cover", type: "checkbox", onchange: e => { iv.cover = e.target.checked; keigoShown.clear(); saveIv(); renderInterview(); } });
  cover.checked = iv.cover;
  top.append(chips, h("div", { class: "row" },
    h("label", { class: "check", for: "keigo-cover" }, cover, "표현 가리기 (탭하면 보여요)"),
    h("span", { class: "hint", text: "☆를 누르면 단어장(경어)에 저장돼요." })));
  box.append(top);
  const list = h("div", { class: "card-list" });
  for (const c of KEIGO) if (iv.scene === "all" || c.scene === iv.scene){
    const hidden = iv.cover && !keigoShown.has(c.id);
    const source = "경어 카드 · " + SCENES[c.scene];
    list.append(h("article", { class: "card keigo" + (hidden ? " covered" : ""),
      onclick: () => { if (iv.cover){ keigoShown.has(c.id) ? keigoShown.delete(c.id) : keigoShown.add(c.id); renderInterview(); } } },
      h("div", { class: "card-top" }, h("span", { class: "tag", lang: "ja", text: SCENES[c.scene] }), h("b", { class: "sit", text: c.sit }),
        starBtn("keigo", { word: c.jp, meaning: c.sit, note: c.note + (c.ng ? ` ✕ ${c.ng}` : "") }, source)),
      hidden ? h("div", { class: "hint", text: "탭해서 표현 보기" }) : h("div", { class: "card-body" },
        h("div", { class: "kg-jp", lang: "ja", text: c.jp }),
        h("div", { text: c.note }),
        c.ng ? h("div", { class: "kg-ng" }, h("span", { class: "x", text: "✕" }), h("span", { class: "jp", lang: "ja", text: c.ng }), c.ngWhy ? h("span", { class: "why", text: c.ngWhy }) : null) : null)));
  }
  box.append(list);
  return box;
}
function answerNotes(){
  const box = h("div", { class: "stack" });
  if (iv.draft) box.append(answerForm());
  else box.append(h("section", { class: "panel row" },
    h("button", { class: "btn primary", onclick: () => openDraft({}) }, "+ 답변 추가"),
    h("span", { class: "hint", text: "써 둔 일본어 답변을 붙여 넣어 저장하고, 외우기·타이머로 연습해요." })));
  if (!answers.length){
    if (!iv.draft) box.append(h("div", { class: "panel empty" }, h("p", { text: "아직 저장한 답변이 없어요." }),
      h("p", { class: "hint", text: "自己紹介, 志望動機처럼 자주 나오는 질문의 답변을 저장해 두면, 문장을 가리고 외우거나 시간을 재며 연습할 수 있어요." })));
    return box;
  }
  if (!CAT[iv.cat] && iv.cat !== "all") iv.cat = "all";
  const filters = h("div", { class: "chips" });
  for (const [key, label] of [["all", "전체"], ...CATS.map(c => [c.key, c.jp])]){
    const n = key === "all" ? answers.length : answers.filter(a => a.cat === key).length;
    if (!n && key !== iv.cat) continue;
    filters.append(h("button", { class: "chip", lang: key === "all" ? null : "ja", "aria-pressed": String(iv.cat === key), onclick: () => { iv.cat = key; saveIv(); renderInterview(); } }, label, h("small", { text: String(n) })));
  }
  box.append(filters);
  const list = h("div", { class: "stack" });
  for (const a of answers) if (iv.cat === "all" || a.cat === iv.cat) list.append(answerItem(a));
  box.append(list);
  return box;
}
function answerForm(){
  const d = iv.draft, cat = CAT[d.cat] || CATS[0];
  const f = h("section", { class: "panel stack", id: "ans-form" }, h("div", { class: "label", text: d.editingId ? "답변 수정" : "답변 추가" }));
  f.append(h("div", null, h("div", { class: "label", text: "질문 유형" }),
    h("div", { class: "chips" }, CATS.map(c => h("button", { class: "chip", type: "button", "aria-pressed": String(d.cat === c.key), onclick: () => { d.cat = c.key; saveIv(); renderInterview(); } },
      h("span", { lang: "ja", text: c.jp }), h("small", { text: c.ko }))))));
  const qIn = h("input", { id: "ans-q", type: "text", lang: "ja", placeholder: "면접 질문 (일본어)", value: d.question, oninput: e => { d.question = e.target.value; saveIv(); } });
  f.append(h("label", { class: "field", for: "ans-q" }, h("span", { class: "label", text: "질문" }), qIn));
  if (cat.questions.length) f.append(h("div", { class: "chips presets" }, cat.questions.map(q =>
    h("button", { class: "chip", type: "button", lang: "ja", onclick: () => { d.question = q; qIn.value = q; saveIv(); } }, q))));
  const count = h("span", { class: "hint mono" });
  const paintCount = () => { const n = charCount(d.text); count.textContent = `${n}자 · 약 ${fmtSec(estSec(n))} (1분 ≈ 300자)`; };
  const ta = h("textarea", { id: "ans-text", lang: "ja", rows: "9", placeholder: "써 둔 일본어 답변을 붙여 넣으세요", oninput: e => { d.text = e.target.value; saveIv(); paintCount(); } });
  ta.value = d.text; paintCount();
  f.append(h("label", { class: "field", for: "ans-text" }, h("span", { class: "label", text: "내 답변" }), ta), count);
  f.append(h("div", { class: "row" },
    h("button", { class: "btn primary", onclick: saveDraft }, "저장"),
    h("button", { class: "btn ghost", onclick: () => { iv.draft = null; saveIv(); renderInterview(); } }, "취소")));
  return f;
}
function answerItem(a){
  const det = h("details", { class: "note-item" });
  det.open = ansOpen.has(a.id);
  det.addEventListener("toggle", () => { det.open ? ansOpen.add(a.id) : ansOpen.delete(a.id); });
  const n = charCount(a.text);
  det.append(h("summary", null,
    h("div", { class: "meta" }, h("span", { class: "tag", lang: "ja", text: CAT[a.cat]?.jp || "その他" }),
      h("span", { class: "mono", text: `${n}자 · 약 ${fmtSec(estSec(n))}` }),
      a.followups?.items.length ? h("span", { text: `꼬리 질문 ${a.followups.items.length}` }) : null),
    h("div", { class: "stemline", lang: "ja", text: a.question })));
  const body = h("div", { class: "note-body" });

  /* 답변 · 외우기 */
  const m = memo.get(a.id);
  if (!m) body.append(h("p", { class: "ans-text", lang: "ja", text: a.text }));
  else {
    const list = sentences(a.text);
    body.append(h("div", { class: "memo" }, list.map((s, i) => {
      const shown = m.has(i);
      return h("button", { class: "memo-s" + (shown ? " shown" : ""), type: "button", lang: shown ? "ja" : null, "aria-pressed": String(shown),
        onclick: () => { shown ? m.delete(i) : m.add(i); renderInterview(); } }, shown ? s : `${i + 1} · 탭해서 보기 (${charCount(s)}자)`);
    })));
  }
  const memoRow = h("div", { class: "row" });
  if (!m) memoRow.append(h("button", { class: "btn small", onclick: () => { memo.set(a.id, new Set()); renderInterview(); } }, "외우기"));
  else {
    const total = sentences(a.text).length;
    memoRow.append(
      h("button", { class: "btn small primary", disabled: m.size >= total, onclick: () => { for (let i = 0; i < total; i++) if (!m.has(i)){ m.add(i); break; } renderInterview(); } }, "다음 문장"),
      h("button", { class: "btn small", onclick: () => { for (let i = 0; i < total; i++) m.add(i); renderInterview(); } }, "모두 보기"),
      h("button", { class: "btn small", onclick: () => { m.clear(); renderInterview(); } }, "다시 가리기"),
      h("button", { class: "btn small ghost", onclick: () => { memo.delete(a.id); renderInterview(); } }, "외우기 끝"),
      h("span", { class: "hint mono", text: `${m.size} / ${total}문장` }));
  }
  body.append(memoRow, timerNode(a), followupNode(a));

  /* 수정 · 삭제 */
  const acts = h("div", { class: "confirm" }, h("button", { class: "btn small", onclick: () => openDraft({ cat: a.cat, question: a.question, text: a.text, editingId: a.id }) }, "수정"));
  if (ivConfirmDel !== a.id) acts.append(h("button", { class: "btn small ghost", onclick: () => { ivConfirmDel = a.id; renderInterview(); } }, "삭제"));
  else acts.append(h("span", { text: "이 답변을 지울까요? 백업이 없다면 되돌릴 수 없어요." }),
    h("button", { class: "btn small", onclick: async () => {
      await db.del("answers", a.id); answers = answers.filter(x => x.id !== a.id);
      ivConfirmDel = null; memo.delete(a.id); if (timer?.id === a.id) timer = null; renderInterview(); } }, "지우기"),
    h("button", { class: "btn small ghost", onclick: () => { ivConfirmDel = null; renderInterview(); } }, "취소"));
  body.append(acts);
  det.append(body);
  return det;
}

/* 타이머: 한 번에 하나. 답변마다 마지막으로 고른 시간(timerSec)을 기억한다. */
const timerElapsed = () => timer ? timer.acc + (timer.since != null ? Date.now() - timer.since : 0) : 0;
function paintTimer(el, a){
  const left = (a.timerSec || 60) * 1000 - (timer?.id === a.id ? timerElapsed() : 0);
  const over = left < 0;
  el.textContent = over ? "+" + fmtTime(-left) : fmtTime(left + 999);
  el.classList.toggle("over", over);
}
function toggleTimer(a){
  if (!timer || timer.id !== a.id) timer = { id: a.id, acc: 0, since: Date.now(), buzzed: false };
  else if (timer.since != null){ timer.acc += Date.now() - timer.since; timer.since = null; }
  else timer.since = Date.now();
  renderInterview();
}
function timerNode(a){
  const total = a.timerSec || 60, mine = timer?.id === a.id, running = mine && timer.since != null;
  const disp = h("span", { class: "timer-n mono", id: "timer-" + a.id, role: "timer" });
  paintTimer(disp, a);
  return h("div", { class: "timer" },
    h("div", { class: "chips" }, TIMER_OPTS.map(([sec, label]) => h("button", { class: "chip", type: "button", "aria-pressed": String(total === sec),
      onclick: async () => { a.timerSec = sec; if (mine) timer = null; renderInterview(); await db.put("answers", a).catch(() => {}); } }, label))),
    h("div", { class: "row" }, disp,
      h("button", { class: "btn small primary", onclick: () => toggleTimer(a) }, running ? "일시정지" : mine ? "계속" : "시작"),
      mine ? h("button", { class: "btn small ghost", onclick: () => { timer = null; renderInterview(); } }, "초기화") : null,
      h("span", { class: "hint", text: `이 답변 약 ${fmtSec(estSec(charCount(a.text)))}` })));
}
function tickTimer(){
  if (!timer || timer.since == null) return;
  const a = answers.find(x => x.id === timer.id), el = $("timer-" + timer.id);
  if (a && el) paintTimer(el, a);
  if (a && !timer.buzzed && timerElapsed() >= (a.timerSec || 60) * 1000){ timer.buzzed = true; try { navigator.vibrate?.(200); } catch {} }
}
setInterval(tickTimer, 250);
document.addEventListener("visibilitychange", tickTimer);   // 백그라운드에서 늦어진 표시를 돌아오자마자 맞춘다

/* 예상 꼬리 질문: 버튼을 누를 때만 질문과 답변을 Gemini로 보낸다 */
async function makeFollowups(a){
  if (fuBusy) return;
  const ctl = new AbortController();
  fuBusy = { id: a.id, ctl }; fuError = null; renderInterview();
  try {
    const raw = await callGemini(buildFollowupPrompt(CAT[a.cat]?.jp, a.question, a.text), { key: settings.key, model: settings.model, signal: ctl.signal });
    a.followups = { at: Date.now(), model: (settings.model || DEFAULT_MODEL).trim(), items: normalizeFollowups(raw) };
    await db.put("answers", a);
  } catch (e){
    if (!(e && e.name === "AbortError")) fuError = { id: a.id, msg: e?.message || "꼬리 질문을 만들지 못했어요." };
  } finally { fuBusy = null; renderInterview(); }
}
function followupNode(a){
  const sec = h("div", { class: "fu-box" }, h("div", { class: "label", text: "예상 꼬리 질문" }));
  if (a.followups?.items.length) sec.append(h("ol", { class: "fu" }, a.followups.items.map(f => h("li", null,
    h("div", { class: "fu-q", lang: "ja", text: f.q }),
    f.ko ? h("div", { class: "hint", text: f.ko }) : null,
    f.intent ? h("div", { class: "fu-n" }, h("b", { text: "의도 " }), f.intent) : null,
    f.point ? h("div", { class: "fu-n" }, h("b", { text: "답변 포인트 " }), f.point) : null,
    h("div", null, h("button", { class: "btn small ghost", onclick: () => openDraft({ cat: a.cat, question: f.q }) }, "이 질문으로 답변 추가"))))));
  const row = h("div", { class: "row" });
  if (fuBusy?.id === a.id) row.append(h("div", { class: "status" }, h("span", { class: "spin" }), h("span", { text: "Gemini가 꼬리 질문을 만드는 중" }),
    h("button", { class: "btn small", onclick: () => fuBusy?.ctl.abort() }, "중지")));
  else row.append(h("button", { class: "btn small" + (a.followups ? "" : " primary"), disabled: !!fuBusy, onclick: () => makeFollowups(a) }, a.followups ? "다시 만들기" : "예상 꼬리 질문 만들기"),
    h("span", { class: "hint", text: `오늘 ${callsToday()}회 호출` }));
  sec.append(row, h("p", { class: "hint", text: "이 버튼을 누를 때만 질문과 답변이 Google(Gemini)로 전송돼요." }));
  if (fuError?.id === a.id) sec.append(h("div", { class: "status err", role: "alert", text: fuError.msg }));
  return sec;
}

/* ---------- 기록 · 설정 ---------- */
let showKey = false;
async function renderSettings(){
  const v = $("view-set"); v.replaceChildren();

  /* 하루 학습 시간 → 데일리 학습 배분 */
  v.append(h("section", { class: "panel stack" }, h("div", { class: "label", text: "하루 학습 시간" }),
    h("div", { class: "chips" }, DAILY_OPTIONS.map(m => h("button", { class: "chip", type: "button", "aria-pressed": String((settings.dailyMin || 60) === m),
      onclick: () => { settings.dailyMin = m; savePrefs(); renderSettings(); toast(`하루 ${m}분으로 오늘 계획을 다시 짰어요`); } }, `${m}분`))),
    h("p", { class: "hint", text: `홈의 '오늘의 학습'을 이 시간에 맞춰 나눠요: 새 단어 ${NEW_CARDS[settings.dailyMin || 60].words}개 · 문법 ${NEW_CARDS[settings.dailyMin || 60].grammar}개 + 복습할 문제 먼저 + 정답률 낮은 파트에 더 많이. (30분: 단어 15·문법 3, 60분: 25·5, 90분: 35·7)` })));
  /* 보기 설정 */
  const early = h("input", { id: "study-early", type: "checkbox", onchange: e => { settings.studyEarly = e.target.checked; savePrefs(); } });
  early.checked = !!settings.studyEarly;
  v.append(h("section", { class: "panel stack" }, h("div", { class: "label", text: "보기 설정" }),
    h("label", { class: "check", for: "study-early" }, early, "풀기 전에도 본문 해설 보기"),
    h("p", { class: "hint", text: "독해·文章の文法 지문 아래의 문장별 해석·단락 요지·전체 번역은 보통 세트를 다 푼 뒤에 열려요. 켜면 풀기 전에도 볼 수 있어요. (단어 탭은 그대로 다 푼 뒤에만)" }),
    ttsSettings()));

  /* 기기 저장 · 백업 */
  persist = await persistState();
  const store = h("section", { class: "panel stack" }, h("div", { class: "label", text: "이 기기에 저장된 데이터" }),
    h("p", null, `오답노트 ${notes.length}개 · 단어장 ${cards.length}개 · 학습 기록 ${history.length}개 · 면접 답변 ${answers.length}개 · 외운 단어 ${vstate.done.size}개 · 문제은행 기록 ${bank.progress.size}개 · 내 문제 ${bank.local.filter(r => r.source === "mine").length}개 · AI 문제 ${bank.local.filter(r => r.source === "ai").length}개`),
    h("p", { class: "hint" }, persist === "granted"
      ? "영구 저장이 허용돼 있어요. 브라우저가 공간 정리를 할 때도 지워지지 않아요."
      : "브라우저가 공간이 부족할 때 데이터를 지울 수 있어요. 홈 화면에 설치하면 더 안전하고, 가끔 백업 파일을 내보내 두세요.",
      persist === "denied" ? h("button", { class: "btn small ghost", onclick: async () => { persist = await requestPersist(); renderSettings(); } }, "영구 저장 요청") : null),
    h("div", { class: "row" },
      h("button", { class: "btn", onclick: doExport }, "백업 파일 내보내기"),
      h("label", { class: "btn", for: "import-file" }, "백업 불러오기"),
      h("input", { id: "import-file", type: "file", accept: "application/json,.json", hidden: true, onchange: doImport })),
    h("p", { class: "hint", text: "백업 파일로 휴대폰 ↔ PC 사이에 오답노트·단어장·학습 기록·면접 답변·복습 일정·패턴 통계·내 문제·외운 단어를 옮길 수 있어요. 불러오면 기존 데이터와 합쳐져요. (API 키는 들어가지 않아요)" }));
  v.append(store);

  /* Gemini */
  const p = h("section", { class: "panel stack" }, h("div", { class: "label", text: "Gemini API" }));
  const keyIn = h("input", { id: "apikey", type: showKey ? "text" : "password", autocomplete: "off", spellcheck: "false", placeholder: "AIza로 시작하는 키", value: settings.key,
    oninput: e => { settings.key = e.target.value; savePrefs(); } });
  p.append(h("div", { class: "row" },
    h("label", { class: "field", for: "apikey" }, h("span", { class: "label", text: "API 키" }), keyIn),
    h("button", { class: "btn small", onclick: () => { showKey = !showKey; renderSettings(); } }, showKey ? "숨기기" : "보기")));
  p.append(h("div", { class: "hint" }, "키는 ", h("a", { href: "https://aistudio.google.com/apikey", target: "_blank", rel: "noopener" }, "aistudio.google.com/apikey"),
    "에서 무료로 만들 수 있어요. 이 기기에만 저장되고 Google로만 전송돼요. 백업 파일에도 들어가지 않아요."));
  const modelIn = h("input", { id: "model", type: "text", spellcheck: "false", value: settings.model, oninput: e => { settings.model = e.target.value; savePrefs(); } });
  p.append(h("label", { class: "field", for: "model" }, h("span", { class: "label", text: "모델" }), modelIn,
    h("span", { class: "hint", text: `기본값 ${DEFAULT_MODEL}. 한도 초과가 잦으면 gemini-2.5-flash-lite도 시도해 보세요.` })));
  p.append(h("div", { class: "hint" }, "오늘 호출: ", h("b", { class: "mono", text: String(callsToday()) }),
    `회 · 무료 한도는 미국 태평양 시간 자정(한국 ${resetTimeKST()})에 초기화돼요. 문제 세트 1개 = 호출 1회.`));
  v.append(p);
}
/* ---------- 기록 탭 ---------- */
function renderRec(){
  const v = $("view-rec"); v.replaceChildren();
  /* 학습 기록 */
  const rec = h("section", { class: "panel stack" }, h("div", { class: "label", text: "풀이 기록" }));
  if (!history.length) rec.append(h("p", { class: "hint", text: "세트를 끝까지 풀면 여기에 점수와 시간이 쌓여요. (예시 세트는 기록하지 않아요)" }));
  else {
    const weekAgo = Date.now() - 7 * 86400000;
    const recent = history.filter(r => r.at >= weekAgo);
    const stats = GROUPS.map(grp => {
      const rows = history.filter(r => KINDS[r.kind]?.group === grp);
      const t = rows.reduce((a, r) => a + r.total, 0), r = rows.reduce((a, x) => a + x.right, 0);
      return { grp, t, pct: t ? Math.round(r / t * 100) : null };
    });
    rec.append(h("div", { class: "stat-row" },
      h("div", { class: "stat" }, h("span", { class: "stat-n mono", text: String(recent.length) }), h("span", { class: "hint", text: "최근 7일 세트" })),
      ...stats.map(s => h("div", { class: "stat" }, h("span", { class: "stat-n mono", text: s.pct == null ? "–" : s.pct + "%" }), h("span", { class: "hint", text: `${s.grp} 정답률 · ${s.t}문항` })))));
    const ul = h("ul", { class: "hist" });
    for (const r of [...history].sort((a, b) => b.at - a.at).slice(0, 12)){
      const d = new Date(r.at);
      ul.append(h("li", null, h("span", { class: "mono", text: `${d.getMonth() + 1}/${d.getDate()}` }), h("span", { lang: "ja", text: KINDS[r.kind]?.jp || "" }),
        h("span", { class: "mono", text: `${r.right}/${r.total}` }), h("span", { class: "mono hint", text: r.exam ? "모의" : fmtTime(r.elapsedMs) })));
    }
    rec.append(ul);
  }
  const done = exams.filter(e => e.result).sort((a, b) => b.startedAt - a.startedAt);
  const mock = h("section", { class: "panel stack" }, h("div", { class: "label", text: "모의고사" }));
  if (!done.length) mock.append(h("p", { class: "hint", text: "모의고사를 끝내면 회차별 점수(추정)가 여기에 쌓여요." }));
  else mock.append(h("ul", { class: "hist" }, done.map(e => { const d = new Date(e.startedAt), s = e.result.scores;
    return h("li", { class: "link", onclick: () => go(`exam/result/${e.id}`) }, h("span", { class: "mono", text: `${d.getMonth() + 1}/${d.getDate()}` }), h("span", { text: `${e.round}회 · ${e.result.pass ? "합격권" : "불합격권"}` }),
      h("span", { class: "mono", text: `${e.result.total}/${e.result.max}` }), h("span", { class: "mono hint", text: `${s.lang.scaled ?? "–"}·${s.read.scaled ?? "–"}·${s.listen.scaled ?? "–"}` })); })));
  const days = [...dailyRows.values()].sort((a, b) => b.id.localeCompare(a.id)).slice(0, 30);
  const daily = h("section", { class: "panel stack" }, h("div", { class: "cl-head" }, h("div", { class: "label", text: `데일리 학습 · 연속 ${streak(doneDays())}일` }),
    h("a", { class: "btn small", href: `#/report/${dayKey()}` }, "날짜별 보고서")));
  if (!days.length) daily.append(h("p", { class: "hint", text: "홈의 '오늘의 학습'을 하면 날짜별로 쌓여요." }));
  else daily.append(h("ul", { class: "hist daily-hist" }, days.map(r => { const [, m, d] = r.id.split("-"), c = r.cards || {};
    const nCards = ["words", "grammar"].reduce((a, k) => a + (c[k]?.swiped.length || 0), 0);
    return h("li", { class: "link", onclick: () => go(`report/${r.id}`) }, h("span", { class: "mono", text: `${+m}/${+d}` }), h("span", { text: `${r.completedAt ? "✓ 완료" : "진행"} · 카드 ${nCards}장` }),
      h("span", { class: "mono", text: r.test ? `단어 ${r.test.word.right}/${r.test.word.total}` : "–" }), h("span", { class: "mono", text: r.test ? `문법 ${r.test.grammar.right}/${r.test.grammar.total}` : "" })); })));
  v.append(daily, mock, rec, tagStatsPanel());

}
function renderMine(){ const v = $("view-mine"); v.replaceChildren(minePanel()); }
/* 읽어주기 설정: 속도·음성(기기에 있는 일본어 음성) */
function ttsSettings(){
  const box = h("div", { class: "stack tts-set" }, h("div", { class: "label", text: "읽어주기 🔊" }));
  const save = () => { setTtsOpts({ rate: settings.ttsRate, voice: settings.ttsVoice }); savePrefs(); };
  box.append(h("div", { class: "chips" }, h("span", { class: "hint", text: "속도" }), RATES.map(r => h("button", { class: "chip", type: "button", "aria-pressed": String(settings.ttsRate === r),
    onclick: () => { settings.ttsRate = r; save(); renderSettings(); } }, RATE_LABEL[r]))));
  const vs = jaVoices();
  if (!vs.length) box.append(h("p", { class: "hint" }, "이 기기에서 일본어 음성을 찾지 못했어요. ", h("button", { class: "btn small ghost", type: "button", onclick: openTtsHelp }, "설치 방법 보기")));
  else {
    const sel = h("select", { id: "tts-voice", onchange: e => { settings.ttsVoice = e.target.value; save(); } },
      h("option", { value: "", text: "기본 일본어 음성" }), vs.map(v => h("option", { value: v.voiceURI, text: `${v.name}${v.localService ? "" : " (온라인)"}` })));
    sel.value = vs.some(v => v.voiceURI === settings.ttsVoice) ? settings.ttsVoice : "";
    box.append(h("label", { class: "field", for: "tts-voice" }, h("span", { class: "label", text: "음성" }), sel),
      h("p", { class: "hint", text: speakerSplit() === "voice" ? "청해: 남·여 화자를 서로 다른 음성으로 읽어요. (내레이션은 위에서 고른 음성)" : "청해: 이 기기에는 일본어 음성이 하나뿐이라 남·여를 높낮이(pitch)로 구분해요." }));
  }
  box.append(h("div", { class: "row" }, speakBtn("日本語能力試験に向けて、毎日少しずつ勉強を続けましょう。", "예시 문장"), h("span", { class: "hint", text: "예시 문장 들어 보기 · 단어·한자·문법은 읽기(히라가나)로, 문장은 원문 그대로 읽어요." })));
  return box;
}
onVoices(() => { if (route.name === "set") renderSettings(); });
/* 패턴별 통계: 문항의 patternTags 기준 출제 횟수 · 틀린 횟수(찍어서 맞힘 포함) */
let tagGroup = "전체", tagAll = false;
function tagStatsPanel(){
  const sec = h("section", { class: "panel stack" }, h("div", { class: "label", text: "패턴별 통계" }));
  const all = tagList();
  if (!all.length){ sec.append(h("p", { class: "hint", text: "문제은행 문제를 풀면 문법·어휘 패턴별로 출제 횟수와 틀린 횟수가 쌓여요." })); return sec; }
  const chips = h("div", { class: "chips" });
  for (const g of ["전체", ...GROUPS]){
    const n = g === "전체" ? all.length : all.filter(t => t.group === g).length;
    chips.append(h("button", { class: "chip", "aria-pressed": String(tagGroup === g), onclick: () => { tagGroup = g; tagAll = false; renderRec(); } }, g, h("small", { text: String(n) })));
  }
  const rows = all.filter(t => tagGroup === "전체" || t.group === tagGroup);
  const table = h("table", { class: "tagstat" },
    h("thead", null, h("tr", null, h("th", { text: "패턴" }), h("th", { text: "출제" }), h("th", { text: "틀림" }), h("th", { text: "정답률" }))),
    h("tbody", null, (tagAll ? rows : rows.slice(0, 20)).map(t => h("tr", { class: t.wrong ? "ng" : null },
      h("td", { lang: "ja", text: t.id }), h("td", { class: "mono", text: String(t.seen) }), h("td", { class: "mono", text: String(t.wrong) }),
      h("td", { class: "mono", text: t.seen ? Math.round((t.seen - t.wrong) / t.seen * 100) + "%" : "–" })))));
  sec.append(chips, table);
  if (rows.length > 20) sec.append(h("button", { class: "btn small ghost", onclick: () => { tagAll = !tagAll; renderRec(); } }, tagAll ? "접기" : `더 보기 (${rows.length - 20}개)`));
  return sec;
}

/* 내 문제 추가: 교재 문제 등을 이 기기 IndexedDB(localBank)에만 저장. 저장소 파일로는 절대 쓰지 않는다. */
const mine = Object.assign({ open: false, kind: "grammar_blank", mode: "form", passage: "", stem: "", choices: ["", "", "", ""], answer: 0, why: "", tags: "", json: "" }, prefs.get("n1.mine", {}));
const saveMine = () => prefs.set("n1.mine", mine);
let mineDel = null;
function minePanel(){
  const list = bank.local.filter(r => r.source === "mine");
  const det = h("section", { class: "panel mine" });
  det.append(h("div", { class: "label", text: `이 기기에만 저장 (${list.length}개)` }));
  const body = h("div", { class: "stack" });
  body.append(h("p", { class: "hint", text: "교재 문제 등을 직접 넣으면 문제은행에 섞여 나오고, 틀리면 복습 일정에도 들어가요. 이 기기에만 저장되고 백업 파일에는 포함돼요. GitHub 저장소에는 올라가지 않아요." }));
  const sel = h("select", { id: "mine-kind", onchange: e => { mine.kind = e.target.value; saveMine(); renderMine(); } },
    Object.entries(KINDS).filter(([, k]) => !k.listen).map(([key, k]) => { const o = h("option", { value: key }, `${k.group} · ${k.label} (${k.jp})`); o.selected = key === mine.kind; return o; }));
  body.append(h("label", { class: "field", for: "mine-kind" }, h("span", { class: "label", text: "유형" }), sel));
  body.append(h("div", { class: "chips" },
    h("button", { class: "chip", "aria-pressed": String(mine.mode === "form"), onclick: () => { mine.mode = "form"; saveMine(); renderMine(); } }, "직접 입력"),
    h("button", { class: "chip", "aria-pressed": String(mine.mode === "json"), onclick: () => { mine.mode = "json"; saveMine(); renderMine(); } }, "JSON 붙여넣기")));
  const inp = (id, key, attrs = {}) => { const el = h(attrs.rows ? "textarea" : "input", { id, lang: "ja", ...attrs, oninput: e => { mine[key] = e.target.value; saveMine(); } }); el.value = mine[key]; return el; };
  if (mine.mode === "form"){
    const unitKind = !!KINDS[mine.kind].counts;
    if (!unitKind) body.append(h("label", { class: "field", for: "mine-passage" }, h("span", { class: "label", text: "지문 (밑줄은 __문구__)" }), inp("mine-passage", "passage", { rows: "6" })));
    body.append(h("label", { class: "field", for: "mine-stem" }, h("span", { class: "label", text: "문제 (빈칸 （　　）, 밑줄 __문구__)" }), inp("mine-stem", "stem", { rows: "2" })));
    const ch = h("div", { class: "mine-choices" });
    mine.choices.forEach((c, i) => {
      const radio = h("input", { type: "radio", name: "mine-ans", id: `mine-a${i}`, "aria-label": `${i + 1}번이 정답`, onchange: () => { mine.answer = i; saveMine(); } });
      radio.checked = mine.answer === i;
      const t = h("input", { id: `mine-c${i}`, type: "text", lang: "ja", placeholder: `선택지 ${i + 1}`, oninput: e => { mine.choices[i] = e.target.value; saveMine(); } });
      t.value = c;
      ch.append(h("div", { class: "mine-choice" }, radio, h("label", { for: `mine-a${i}`, class: "mono", text: String(i + 1) }), t));
    });
    body.append(h("div", null, h("div", { class: "label", text: "선택지 · 정답에 체크" }), ch));
    body.append(h("label", { class: "field", for: "mine-why" }, h("span", { class: "label", text: "해설 (선택)" }), inp("mine-why", "why", { rows: "3" })));
    body.append(h("label", { class: "field", for: "mine-tags" }, h("span", { class: "label", text: "패턴 (선택, 쉼표로 구분: 〜にすぎない, 手分け)" }), inp("mine-tags", "tags", { type: "text" })));
    body.append(h("div", { class: "row" }, h("button", { class: "btn primary", onclick: saveMineForm }, "저장"),
      h("button", { class: "btn ghost", onclick: () => { Object.assign(mine, { passage: "", stem: "", choices: ["", "", "", ""], answer: 0, why: "", tags: "" }); saveMine(); renderMine(); } }, "비우기")));
  } else {
    body.append(h("label", { class: "field", for: "mine-json" }, h("span", { class: "label", text: "JSON (문제 1개, 배열, {questions:[…]}, {units:[…]} 모두 가능)" }), inp("mine-json", "json", { rows: "8", lang: null, spellcheck: "false" })));
    body.append(h("p", { class: "hint", text: '예: {"stem":"…（　　）…","choices":["","","",""],"answer":0,"patternTags":["〜にすぎない"],"ex":{"why":"…"}} · answer는 0부터. 지문형은 {"passage":"…","questions":[…]}' }));
    body.append(h("div", { class: "row" }, h("button", { class: "btn primary", onclick: saveMineJson }, "검사하고 저장")));
  }
  if (list.length){
    const ul = h("ul", { class: "mine-list" });
    for (const r of list){
      const q = r.unit.questions[0];
      ul.append(h("li", null, h("span", { class: "tag", lang: "ja", text: KINDS[r.kind]?.jp || r.kind }),
        h("span", { class: "stemline", lang: "ja", text: (q?.stem || r.unit.title || "").replace(/__/g, "") + (r.unit.questions.length > 1 ? ` 외 ${r.unit.questions.length - 1}문항` : "") }),
        mineDel === r.id
          ? h("span", { class: "confirm" }, h("button", { class: "btn small", onclick: async () => { await removeLocal(r.id); mineDel = null; renderMine(); } }, "지우기"),
              h("button", { class: "btn small ghost", onclick: () => { mineDel = null; renderMine(); } }, "취소"))
          : h("button", { class: "btn small ghost", onclick: () => { mineDel = r.id; renderMine(); } }, "삭제")));
    }
    body.append(h("div", null, h("div", { class: "label", text: "내가 추가한 문제" }), ul));
  }
  det.append(body);
  return det;
}
async function saveMineForm(){
  const q = { stem: mine.stem.trim(), choices: mine.choices.map(c => c.trim()), answer: mine.answer,
    patternTags: mine.tags.split(/[,、，]/).map(t => t.trim()).filter(Boolean), ex: { why: mine.why.trim() } };
  if (!q.stem || q.choices.some(c => !c)){ toast("문제와 선택지 4개를 모두 입력하세요"); return; }
  const unitKind = !!KINDS[mine.kind].counts;
  try {
    const units = cleanUnits(mine.kind, { title: "내 문제", passage: unitKind ? "" : mine.passage.trim(), questions: [q] });
    await addLocalUnits(mine.kind, units, "mine");
  } catch (e){ toast(e?.message || "저장하지 못했어요"); return; }
  Object.assign(mine, { stem: "", choices: ["", "", "", ""], answer: 0, why: "", tags: "" });   // 지문은 남겨서 같은 지문 문항을 이어서 넣기 쉽게
  saveMine(); toast("내 문제에 저장했어요"); renderMine();
}
async function saveMineJson(){
  let data;
  try { data = JSON.parse(mine.json); } catch { toast("JSON 형식이 올바르지 않아요"); return; }
  const raws = (Array.isArray(data) ? data : data.units ? data.units : [data])
    .map(u => u && (u.questions ? u : u.stem ? { questions: [u] } : null));
  let ok = 0, bad = 0;
  for (const raw of raws){
    if (!raw){ bad++; continue; }
    const kind = KINDS[raw.kind] ? raw.kind : mine.kind;
    try { const units = cleanUnits(kind, { title: raw.title || "내 문제", topic: raw.topic || "", passage: raw.passage || "", questions: raw.questions }); await addLocalUnits(kind, units, "mine"); ok += units.length; }
    catch { bad++; }
  }
  if (ok){ mine.json = ""; saveMine(); }
  toast(`저장 ${ok}개${bad ? ` · 형식 오류로 건너뜀 ${bad}개` : ""}`);
  renderMine();
}

async function doExport(){
  const data = await exportAll();
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const d = new Date(), stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const a = h("a", { href: url, download: `n1-backup-${stamp}.json` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast("백업 파일을 저장했어요");
}
async function doImport(e){
  const file = e.target.files?.[0]; if (!file) return;
  try {
    const counts = await importAll(JSON.parse(await file.text()));
    await loadAll();
    toast(`불러왔어요: 오답 ${counts.notes} · 단어 ${counts.cards} · 기록 ${counts.history} · 답변 ${counts.answers} · 문제 ${counts.localBank}`);
    renderSettings();
  } catch (err){ toast(err?.message || "백업 파일을 읽지 못했어요."); }
  e.target.value = "";
}

/* ---------- 화면 이동: 해시 경로(#/part/문법 …). 안드로이드 뒤로가기가 앱 안에서 동작한다 ---------- */
/* name → [하단 탭, 상단 제목, 부모 경로, 몰입 화면(하단 탭 숨김)] */
const VIEWS = {
  home: ["home", "N1 연습장"], part: ["home", null, "home"], play: ["home", null, "home", true], book: ["home", "문제집", "home"], exam: ["home", "실전 모의고사", "home"],
  cards: ["cards", "단어장"], note: ["note", "오답노트"], rec: ["rec", "기록"],
  more: ["more", "더보기"], iv: ["more", "면접", "more"], set: ["more", "설정", "more"], mine: ["more", "내 문제 추가", "more"], ai: ["more", "AI로 새 문제", "more"], account: ["more", "계정", "more"], report: ["home", "학습 보고서", "home"],
};
const route = { name: "home", args: [] };
/* 앱 안에서 쌓은 깊이를 history.state.d에 둔다. 뒤로 버튼: 깊이가 있으면 브라우저 뒤로, 처음 연 화면이면 부모 화면으로 */
const nav = window.history;                            // (history는 풀이 기록 배열 이름으로 쓰고 있음)
let navDepth = 0;
function parseHash(){
  const [name, ...args] = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(x => { try { return decodeURIComponent(x); } catch { return x; } });
  return VIEWS[name] ? { name, args } : { name: "home", args: [] };
}
function go(path, { replace = false } = {}){
  const hash = "#/" + path;
  if (location.hash === hash){ render(); return; }
  if (replace){ nav.replaceState({ d: navDepth }, "", hash); render(); }
  else location.hash = hash;
}
function goBack(){
  if (navDepth > 0){ nav.back(); return; }
  const partOf = kind => KINDS[kind] ? `part/${encodeURIComponent(KINDS[kind].group)}` : "home";
  const parent = route.name === "play" ? (current?.book ? `book/${current.book.kind}` : current?.sample ? "ai" : partOf(current?.kind))
    : route.name === "book" ? partOf(route.args[0])
    : route.name === "exam" && route.args.length ? (route.args[0] === "review" ? `exam/result/${route.args[1]}` : "exam")
    : route.name === "cards" && route.args[0] === "review" ? `report/${route.args[1] || dayKey()}`
    : route.name === "cards" && route.args.length ? (route.args[0] === "test" || route.args[1] ? "cards/flash" : "cards")
    : VIEWS[route.name][2] || "home";
  go(parent, { replace: true });
}
function parentTitle(){
  if (route.name === "part") return route.args[0] || "";
  if (route.name === "play") return current ? (KINDS[current.kind]?.label || "") : "연습";
  if (route.name === "book") return `${KINDS[route.args[0]]?.label || ""} 문제집`;
  if (route.name === "cards" && route.args[0] === "test") return "오늘의 시험";
  if (route.name === "cards" && route.args[1]) return `${DECK_LABEL[route.args[1]] || ""} 카드`;
  return VIEWS[route.name][1];
}
function render(){
  Object.assign(route, parseHash());
  const [tab, , parent, immersive] = VIEWS[route.name];
  for (const name of Object.keys(VIEWS)) $("view-" + name).hidden = name !== route.name;
  document.querySelectorAll("#tabbar a").forEach(a => { if (a.dataset.tab === tab) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  $("back").hidden = !parent && !(route.name === "cards" && route.args.length);
  $("title").textContent = parentTitle();
  document.body.classList.toggle("immersive", !!immersive || (route.name === "exam" && route.args[0] === "run") || (route.name === "cards" && (route.args[0] === "test" || route.args[0] === "review" || !!route.args[1])));
  document.body.classList.toggle("at-home", route.name === "home");
  closeGloss();
  ({ home: renderHome, part: () => renderPart(route.args[0]), play: renderPlay, book: renderBook, exam: renderExam, cards: renderCards, note: renderNote, rec: renderRec,
     more: renderMore, iv: renderInterview, set: renderSettings, mine: renderMine, ai: renderAI, account: renderAccount, report: renderReport })[route.name]();
}
window.addEventListener("hashchange", () => {
  if (nav.state?.d == null) nav.replaceState({ d: navDepth + 1 }, "", location.hash);   // 새로 들어온 화면
  navDepth = nav.state.d;
  render(); window.scrollTo({ top: 0 });
});
function renderAll(){ render(); renderNoteCount(); }

/* ---------- 계정 · 기기 간 동기화 (구글 로그인 + Firestore, src/sync.js) ---------- */
/* 로그인한 적이 없으면 Firebase SDK를 불러오지 않는다. 계정 화면을 열면 [Google로 로그인]이 바로 팝업을 띄울 수 있게 미리 불러 둔다 */
let sync = null, syncLoading = null, syncState = { status: "signedout", email: "", lastSync: null, error: "" };
const hasFirebase = () => !!firebaseConfig?.apiKey;
function loadSync(){
  if (!hasFirebase()) return Promise.resolve(null);
  if (!syncLoading) syncLoading = import("./sync.js").then(m => m.initSync(firebaseConfig, {
    onState: s => { syncState = s; paintSyncBadge(); if (route.name === "account") renderAccount(); },
    onPulled: async () => { await loadAll(); render(); renderNoteCount(); },
    merge: { daily: mergeDaily },                   // 같은 날짜의 오늘 학습은 덮어쓰지 않고 합친다(덱·넘긴 카드·시험)
    getPrefs: () => ({ u: prefs.get("n1.prefsU", 0), values: syncedPrefs() }),
    applyPrefs: (values, u) => {
      for (const k of SYNC_PREF_KEYS) if (k in values) settings[k] = values[k];
      prefs.set("n1.settings", settings); prefs.set("n1.prefsU", u); prefsSnap = JSON.stringify(syncedPrefs());
      setTtsOpts({ rate: settings.ttsRate, voice: settings.ttsVoice });
    },
  })).then(c => (sync = c)).catch(e => { syncLoading = null; syncState = { ...syncState, status: "error", error: "동기화 모듈을 불러오지 못했어요. 인터넷 연결을 확인하세요." }; paintSyncBadge(); console.warn(e); return null; });
  return syncLoading;
}
const SYNC_LABEL = { ok: "동기화됨", syncing: "동기화 중", offline: "오프라인", error: "동기화 오류" };
function paintSyncBadge(){
  const b = $("sync-badge"), on = syncState.status !== "signedout" && !!SYNC_LABEL[syncState.status];
  b.hidden = !on;
  if (on){ b.textContent = SYNC_LABEL[syncState.status]; b.dataset.st = syncState.status; b.title = syncState.error || (syncState.lastSync ? `마지막 동기화 ${new Date(syncState.lastSync).toLocaleString("ko-KR")}` : ""); }
}
function renderAccount(){
  const v = $("view-account"); v.replaceChildren();
  const what = h("p", { class: "hint", text: "동기화하는 것: 오답노트·내 단어장·풀이 기록·복습 일정·패턴 통계·외웠어요·카드 상태·문제집 진행·북마크·끝난 모의고사·데일리 기록·면접 답변·내 문제(AI 문제 포함)·설정. API 키와 읽기 음성, 풀던 세트, 진행 중인 모의고사는 이 기기에만 있어요." });
  if (!hasFirebase()){
    v.append(h("section", { class: "panel stack" }, h("div", { class: "label", text: "계정 · 설정 필요" }),
      h("p", { text: "Firebase 설정(src/firebase-config.js)이 아직 없어서 로그인할 수 없어요. 로그인 없이도 이 기기에서는 그대로 쓸 수 있어요." }), what));
    return;
  }
  loadSync();
  const s = syncState, signedIn = s.status !== "signedout";
  const box = h("section", { class: "panel stack" }, h("div", { class: "label", text: "계정 · 기기 간 동기화" }));
  if (!signedIn){
    box.append(h("p", { text: "구글로 로그인하면 휴대폰·PC에서 같은 진행 상황을 쓸 수 있어요. 기록은 여전히 이 기기에 먼저 저장되고, 바뀐 것만 내 계정 공간(Firestore)에 올라가요." }),
      h("button", { class: "btn primary big", onclick: async () => { const c = sync || await loadSync(); c?.login(); } }, "Google로 로그인"),
      h("p", { class: "hint", text: "처음 로그인하면 이 기기 기록과 클라우드 기록을 합쳐요(어느 쪽도 지우지 않아요)." }));
  } else {
    box.append(
      h("div", { class: "acct" }, h("b", { text: s.email || "로그인됨" }), h("span", { class: "sync-badge", "data-st": s.status, text: SYNC_LABEL[s.status] || "" })),
      h("p", { class: "hint", text: s.lastSync ? `마지막 동기화 ${new Date(s.lastSync).toLocaleString("ko-KR")}` : "아직 동기화하지 않았어요" }),
      h("div", { class: "row" },
        h("button", { class: "btn primary", disabled: s.status === "syncing", onclick: () => sync?.syncNow() }, s.status === "syncing" ? "동기화 중…" : "지금 동기화"),
        h("button", { class: "btn ghost", onclick: async () => { await sync?.logout(); toast("로그아웃했어요. 이 기기의 기록은 그대로 있어요."); } }, "로그아웃")),
      h("p", { class: "hint", text: "로그아웃해도 이 기기의 기록은 지워지지 않아요. 다른 계정으로 로그인하면 이 기기 기록이 그 계정에도 합쳐져요." }));
  }
  if (s.error) box.append(h("div", { class: "status err", role: "alert", text: s.error }));
  box.append(what);
  v.append(box);
}

/* ---------- 더보기 ---------- */
function renderMore(){
  const v = $("view-more"); v.replaceChildren();
  const row = (href, title, sub) => h("a", { href }, h("div", null, h("span", { text: title }), h("span", { class: "m-sub", text: sub })), h("span", { class: "chev", text: "›" }));
  v.append(h("nav", { class: "menu" },
    row("#/iv", "면접", `내 답변 노트 ${answers.length}개 · 경어 카드 ${KEIGO.length}장`),
    row("#/account", "계정", !hasFirebase() ? "설정 필요" : syncState.status === "signedout" ? "Google로 로그인 · 휴대폰·PC 동기화" : `${syncState.email} · ${SYNC_LABEL[syncState.status] || ""}`),
    row("#/set", "설정", "읽어주기 · 보기 · 백업 · Gemini API 키"),
    row("#/mine", "내 문제 추가", `교재 문제 등 직접 입력 · ${bank.local.filter(r => r.source === "mine").length}개`),
    row("#/ai", "AI로 새 문제", "Gemini로 만들기 · 예시 세트")));
}

/* ---------- boot ---------- */
async function loadAll(){
  let bookRows, markRows, dayRows;
  [notes, cards, history, answers, bookRows, markRows, dayRows] = await Promise.all(["notes", "cards", "history", "answers", "book", "marks", "daily"].map(st => db.all(st)));
  dailyRows = new Map(dayRows.map(r => [r.id, r]));
  books = new Map(bookRows.map(r => [r.id, r])); marks = new Map(markRows.map(r => [r.id, r]));
  exams = (await db.all("exams")).sort((a, b) => a.startedAt - b.startedAt);
  applyReserve();
  notes.sort((a, b) => b.at - a.at); cards.sort((a, b) => b.at - a.at); answers.sort((a, b) => b.at - a.at);
  cardIds.clear(); for (const c of cards) cardIds.add(c.id);
  await loadBankState();
  await loadVocabState();
  await loadCardState();
}
/* 본문 해설이 생기기 전에 저장된 풀던 세트·오답노트: 기본 은행의 같은 지문에서 해석·해설을 채운다 */
async function backfillStudy(o){
  if (!o?.passage?.trim() || hasStudy(o)) return false;
  const u = await findUnitByPassage(o.kind, o.passage);
  if (!u) return false;
  Object.assign(o, { passageKo: o.passageKo || u.passageKo || "", passageGloss: o.passageGloss?.length ? o.passageGloss : (u.passageGloss || []), ...normalizeStudy(u) });
  return true;
}
async function backfillAll(){
  let changed = false;
  if (current && await backfillStudy(current)){ saveCurrent(); changed = true; }
  for (const n of notes) if (await backfillStudy(n)){ await db.put("notes", n).catch(() => {}); changed = true; }
  if (changed && (route.name === "play" || route.name === "note")) render();
}
async function boot(){
  $("back").addEventListener("click", goBack);
  navDepth = nav.state?.d ?? 0;
  if (nav.state?.d == null) nav.replaceState({ d: 0 }, "", location.hash || "#/home");
  const dd = ddayNum();
  $("dday").append(h("span", { text: "시험까지" }), h("b", { text: dd > 0 ? `D-${dd}` : dd === 0 ? "D-DAY" : "끝!" }));

  await Promise.all([loadIndex(), loadVocabIndex(), loadExam(), loadRank()]);
  applyReserve();                                      // 기기 저장소를 못 열어도 예약 문제는 빼 둔다
  try {
    await loadAll();
    /* 이전 버전(한 파일짜리)에서 localStorage에 쌓인 오답노트 옮기기 */
    const legacy = prefs.get("n1.notes", null);
    if (Array.isArray(legacy) && legacy.length && !notes.length){
      await db.putMany("notes", legacy.filter(n => n && n.id));
      await loadAll();
      prefs.set("n1.notes", null);
    }
    const saved = await db.get("meta", "current");
    current = saved?.value || null;
  } catch {
    $("db-warn").hidden = false;
  }
  renderAll();
  backfillAll();
  if (hasFirebase() && prefs.get("n1.sync.uid", null)) loadSync();     // 로그인한 적이 있을 때만 SDK를 불러 동기화

  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("./sw.js").catch(() => {});
}
boot();
