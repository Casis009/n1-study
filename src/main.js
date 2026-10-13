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
import { state as bank, loadIndex, loadBankState, bankCounts, pickSet, pickByTag, tagUnitCount, buildSet, recordSet, tagList, splitUnits, addLocalUnits, removeLocal, findUnitByPassage } from "./bank.js";
import { hasKanji, rubyParts } from "./furigana.js";
import { speak, stopSpeak, ttsReady, onVoices, jaVoices, setTtsOpts, RATES } from "./tts.js";
import { VKINDS, vocabKey, vocabGroup, vocabCount, loadVocabIndex, loadVocab, loadVocabState, setDone, undoDoneFor, vstate } from "./vocab.js";

const GROUPS = ["문자·어휘", "문법", "독해"];
const NUM = ["①", "②", "③", "④"];

/* ---------- state ---------- */
const settings = Object.assign({ key: "", model: DEFAULT_MODEL, studyEarly: false, ttsRate: 0.85, ttsVoice: "" }, prefs.get("n1.settings", {}));
setTtsOpts({ rate: settings.ttsRate, voice: settings.ttsVoice });
const gen = Object.assign({ kind: "grammar_blank", count: 5, topic: "", weak: true }, prefs.get("n1.gen", {}));
if (!KINDS[gen.kind]) gen.kind = "grammar_blank";
let current = null;
let notes = [], cards = [], history = [], answers = [];
const cardIds = new Set();
let busy = null, lastError = "", bankMsg = "", toastTimer = null, aiOpen = false;
let persist = "unsupported";

const savePrefs = () => { prefs.set("n1.settings", settings); prefs.set("n1.gen", gen); };
let curTimer = null;
function saveCurrent(){ clearTimeout(curTimer); curTimer = setTimeout(() => db.put("meta", { id: "current", value: current }).catch(() => {}), 300); }

function toast(msg){
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
async function ensurePersist(){ if (persist !== "granted") persist = await requestPersist(); }

/* ---------- weak points: 패턴별 통계(tagStats)에서 틀린 횟수가 많은 순 ---------- */
const weakTags = (vocab, limit) => tagList().filter(t => t.wrong > 0 && (t.group === "문자·어휘") === !!vocab).slice(0, limit);
const fmtWhen = ts => {
  const hrs = Math.round((ts - Date.now()) / 3600000);
  if (hrs < 1) return "곧";
  if (hrs < 24) return `${hrs}시간 후`;
  const d = new Date(ts); return `${Math.round(hrs / 24)}일 후 (${d.getMonth() + 1}/${d.getDate()})`;
};
/* 모델 출력·내 문제를 검증하고 문제은행 단위로 나눈다(풀이용 필드는 뺀다). 형식이 틀리면 throw. */
function cleanUnits(kind, raw){
  const set = prepSet(structuredClone({ ...raw, kind }), { fallbackKind: kind });
  const questions = set.questions.map(({ stem, choices, answer, patternTags, gloss, ex }) => ({ stem, choices, answer, patternTags, gloss, ex }));
  return splitUnits(kind, { title: set.title, topic: set.topic, passage: set.passage, ...passageFields(set), questions });
}

/* ---------- notes / cards / history ---------- */
async function addNote(set, q){
  if (q.saved) return;
  q.saved = true;
  const note = { id: set.id + "-" + set.questions.indexOf(q), at: Date.now(), kind: set.kind, title: set.title, passage: set.passage,
    ...passageFields(set),
    q: { stem: q.stem, choices: q.choices, answer: q.answer, ex: q.ex, mySel: q.sel, patternTags: q.patternTags || [], gloss: q.gloss || [] } };
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
  if (set.logged || set.sample) return;
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
  renderSolve();
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
    clearInterval(busy.timer); busy = null; renderSolve();
    if (!lastError) document.querySelector(".set")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

async function startBank(force = false){
  bankMsg = "";
  try {
    const set = await pickSet(gen.kind, gen.count, { force });
    if (set){ current = set; saveCurrent(); }
    else bankMsg = "이 유형은 문제은행에 아직 문제가 없어요.";
  } catch (e){ bankMsg = e?.message || "문제은행을 열지 못했어요."; }
  renderSolve();
  if (!bankMsg) document.querySelector(".set")?.scrollIntoView({ behavior: "smooth", block: "start" });
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
      Object.assign(vb, { mode: "base", kind, group: "all", view: "all", q: g.w }); vLimit = 50; saveVb(); showTab("cards");
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
  for (const para of text.split(/
+/).map(t => t.trim()).filter(Boolean))
    box.append(h("p", { class: /^[AB]$/.test(para) ? "mark-ab" : null }, segNodes(para, gl)));
  return box;
}

/* ---------- 본문 해설: [문장별 해석] [단락 요지·흐름] [전체 번역] ---------- */
const studyView = new WeakMap();                 // 세트·오답노트 객체 → 켜 둔 보기와 펼친 문장
const studyState = o => { let st = studyView.get(o); if (!st){ st = { sent: false, notes: false, full: false, open: new Set(), speaking: null, playing: false }; studyView.set(o, st); } return st; };
const passageBody = p => p.split("
").map(l => l.trim()).filter(l => l && !/^[AB]$/.test(l)).join("");
const hasStudy = o => o.sentences?.length > 0 && o.sentences.map(s => s.ja).join("") === passageBody(o.passage);
const STUDY_BTNS = [["sent", "문장별 해석"], ["notes", "단락 요지·흐름"], ["full", "전체 번역"]];

/* 지문 + 본문 해설. on = 세트를 다 풀었는지(단어 탭·해설 공개), always = 오답노트처럼 항상 공개 */
function passageBlock(o, kind, on, source, { always = false } = {}){
  const wrap = h("div", { class: "study" });
  const open = always || on || settings.studyEarly;
  const st = studyState(o);
  const paint = () => {
    const gl = glossOf(o.passageGloss, on || always, source);
    wrap.replaceChildren();
    if (!hasStudy(o)){                             // 예전 데이터·AI 문제: 지문 + 접어 둔 전체 번역
      wrap.append(passageNode(o.passage, kind, gl), h("div", { class: "study-bar" }, readAllBtn(o, st, wrap)));
      if (open && o.passageKo?.trim()){
        const d = h("details", { class: "passage-ko" }, h("summary", { text: "지문 해석 보기" }));
        for (const para of o.passageKo.split(/
+/).map(t => t.trim()).filter(Boolean)) d.append(h("p", { text: para }));
        wrap.append(d);
      }
      return;
    }
    const mode = k => open && st[k];
    wrap.append(studyPassage(o, kind, gl, { sent: mode("sent"), notes: mode("notes"), open: st.open, speaking: st.speaking }, i => { st.open.has(i) ? st.open.delete(i) : st.open.add(i); paint(); }));
    const bar = h("div", { class: "study-bar" + (open ? "" : " locked") }, readAllBtn(o, st, wrap),
      STUDY_BTNS.map(([k, label]) => h("button", { class: "chip", type: "button", disabled: !open, "aria-pressed": String(mode(k)),
        onclick: () => { st[k] = !st[k]; paint(); } }, label)),
      open ? null : h("span", { class: "hint", text: "문제를 다 풀면 볼 수 있어요" }));
    wrap.append(bar);
    if (mode("notes")) wrap.append(mainIdeaNode(o.mainIdea, kind));
    if (mode("full") && o.passageKo?.trim()) wrap.append(h("div", { class: "passage-ko full" },
      h("div", { class: "label", text: "전체 번역" }), o.passageKo.split(/
+/).map(t => t.trim()).filter(Boolean).map(t => h("p", { text: t }))));
  };
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
    const texts = study ? o.sentences.map(s => s.ja) : o.passage.split(/
+/).map(t => t.trim()).filter(t => t && !/^[AB]$/.test(t));
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
function questionNode(q, idx, ctx){
  const wrap = h("article", { class: "q" });
  const gl = glossOf(q.gloss, q.checked, ctx.source);   // 단어 탭은 정답 확인 뒤에만 (풀 때 힌트가 되지 않게)
  wrap.append(h("div", { class: "q-stem" }, h("span", { class: "q-no", text: ctx.label || `問${idx + 1}` }), stemNode(q.stem, gl)));
  const list = h("ol", { class: "choices" });
  q.choices.forEach((c, i) => {
    let cls = "choice", verdict = null;
    if (q.checked){
      if (i === q.answer){ cls += " right"; verdict = h("span", { class: "verdict ok", text: "정답" }); }
      else if (i === q.sel){ cls += " wrongpick"; verdict = h("span", { class: "verdict ng", text: "내 답" }); }
    }
    const inner = [h("span", { class: "bubble", text: String(i + 1) }), h("span", { class: "jp", lang: "ja" }, glossNodes(c, gl)), verdict];
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

/* ---------- 문제 풀기 ---------- */
function renderSolve(){
  const v = $("view-solve"); v.replaceChildren();
  const g = h("section", { class: "panel stack" });
  const kindBox = h("div", { class: "kind-groups" });
  for (const grp of GROUPS){
    const chips = h("div", { class: "chips" });
    for (const [key, k] of Object.entries(KINDS)) if (k.group === grp)
    { const c = bankCounts(key);
      chips.append(h("button", { class: "chip", "aria-pressed": String(gen.kind === key), onclick: () => { gen.kind = key; bankMsg = ""; savePrefs(); renderSolve(); } },
        k.label, h("small", { lang: "ja", text: k.jp }),
        h("small", { class: "bank-n mono", text: c.total ? `${c.left}/${c.total}${c.due ? " ·복습" + c.due : ""}` : "준비 중" }))); }
    kindBox.append(h("div", null, h("div", { class: "label", text: grp }), chips));
  }
  g.append(kindBox);

  const k = KINDS[gen.kind];
  if (k.counts){
    if (!k.counts.includes(gen.count)) gen.count = k.counts[0];
    const cc = h("div", { class: "chips" });
    k.counts.forEach(n => cc.append(h("button", { class: "chip", "aria-pressed": String(gen.count === n), onclick: () => { gen.count = n; savePrefs(); renderSolve(); } }, `${n}문항`)));
    g.append(h("div", null, h("div", { class: "label", text: "문항 수" }), cc));
  } else {
    g.append(h("div", null, h("div", { class: "label", text: "구성" }), h("div", { class: "hint", text: k.fixed })));
  }
  /* 문제은행 */
  const c = bankCounts(gen.kind);
  const bankRow = h("div", { class: "row" });
  bankRow.append(h("button", { class: "btn primary", disabled: !(c.left + c.due) || !!busy, onclick: () => startBank() }, "문제은행에서 풀기"));
  if (!c.total) bankRow.append(h("span", { class: "hint", text: "이 유형은 문제은행을 준비 중이에요. 아래 AI 생성이나 기록·설정의 '내 문제 추가'를 쓸 수 있어요." }));
  else {
    bankRow.append(h("span", { class: "hint", text: `남은 ${c.left} / 전체 ${c.total}${c.unit} · 지금 복습 ${c.due}${c.wait ? ` · 복습 대기 ${c.wait}` : ""}` }));
    if (!(c.left + c.due)) bankRow.append(h("span", { class: "hint", text: `다 풀었어요${c.nextDue ? ` · 다음 복습 ${fmtWhen(c.nextDue)}` : ""}` }),
      h("button", { class: "btn small", disabled: !!busy, onclick: () => startBank(true) }, "그래도 풀기"));
  }
  g.append(bankRow);
  if (bankMsg) g.append(h("div", { class: "status err", role: "alert", text: bankMsg }));

  /* AI 생성(보조) */
  const ai = h("details", { class: "ai-box" });
  ai.open = aiOpen || !!busy || !!lastError;
  ai.addEventListener("toggle", () => { aiOpen = ai.open; });
  ai.append(h("summary", { text: "AI로 새 문제 (Gemini)" }));
  const topicIn = h("input", { id: "topic", type: "text", placeholder: "비우면 무작위 (예: 경제, 의료, 철학)", value: gen.topic, oninput: e => { gen.topic = e.target.value; savePrefs(); } });
  const weakCount = weakTags(k.vocab, k.vocab ? 8 : 6).length;
  const weakBox = h("input", { id: "weak", type: "checkbox", onchange: e => { gen.weak = e.target.checked; savePrefs(); } });
  weakBox.checked = gen.weak;
  const aiBody = h("div", { class: "stack" }, h("div", { class: "row" },
    h("label", { class: "field", for: "topic" }, h("span", { class: "label", text: "주제" }), topicIn),
    h("label", { class: "check", for: "weak" }, weakBox, `자주 틀린 ${k.vocab ? "어휘" : "문법"} 반영${weakCount ? ` (${weakCount}개)` : " (아직 없음)"}`)));
  const actions = h("div", { class: "row" });
  if (busy){
    actions.append(h("div", { class: "status" }, h("span", { class: "spin" }),
      h("span", null, "Gemini가 문제와 해설을 쓰는 중 · ", h("span", { id: "busy-sec", class: "mono", text: Math.round((Date.now() - busy.started) / 1000) + "초" })),
      h("button", { class: "btn small", onclick: () => busy?.ctl.abort() }, "중지")));
  } else {
    actions.append(h("button", { class: "btn", onclick: generate }, "AI로 새 문제 만들기"));
    actions.append(h("span", { class: "hint", text: `오늘 ${callsToday()}회 호출 · 무료 한도 초기화 ${resetTimeKST()}` }));
    if (!settings.key.trim()) actions.append(h("button", { class: "btn small ghost", onclick: () => showTab("set") }, "API 키 입력하기"));
  }
  aiBody.append(actions, h("p", { class: "hint", text: "만든 문제는 이 기기의 문제은행에도 추가돼서 나중에 복습으로 다시 나와요." }));
  if (lastError) aiBody.append(h("div", { class: "status err", role: "alert", text: lastError }));
  ai.append(aiBody);
  g.append(ai);
  g.append(h("div", { class: "hint" }, "예시 세트: ",
    ...[["vocab", "어휘 2문항"], ["grammar", "문법 3문항"], ["reading", "독해 단문"]].map(([key, label]) =>
      h("button", { class: "btn small ghost", onclick: () => { current = prepSet(structuredClone(SAMPLES[key])); saveCurrent(); renderSolve(); } }, label))));
  v.append(g);

  if (!current) return;
  const s = current;
  const sec = h("section", { class: "set" });
  const timer = h("span", { class: "mono", id: "set-timer", text: fmtTime(s.done ? s.elapsed : Date.now() - s.startedAt) });
  sec.append(h("div", { class: "set-head" },
    h("h2", { lang: "ja", text: s.title }),
    h("div", { class: "meta" },
      s.sample ? h("span", { class: "tag sample", text: "예시" }) : null,
      s.bank ? h("span", { class: "tag" + (s.review ? " review" : ""), text: s.review ? "복습 포함" : s.engine ? "AI 문제" : "문제은행" }) : null,
      h("span", { class: "tag", lang: "ja", text: KINDS[s.kind]?.jp || "" }),
      s.topic && !s.sample ? h("span", { class: "tag", text: s.topic }) : null,
      h("span", null, "⏱ ", timer))));
  if (s.passage.trim()) sec.append(...passageBlock(s, s.kind, s.done, s.title));
  const qs = h("div", { class: "qs" });
  s.questions.forEach((q, i) => qs.append(questionNode(q, i, {
    source: s.title,
    onChange: async () => {
      if (!s.done && s.questions.every(x => x.checked)){ s.done = true; s.elapsed = Date.now() - s.startedAt; await logHistory(s); await recordSet(s).catch(() => {}); }
      saveCurrent(); renderSolve();
    },
    onCheck: async qq => { if (qq.sel !== qq.answer) await addNote(s, qq); renderNoteCount(); },
    extraActions: q.sel === q.answer
      ? [q.saved
          ? h("button", { class: "btn small ghost", onclick: async () => { q.saved = false; await removeNote(s.id + "-" + i); if (s.done) await recordSet(s).catch(() => {}); saveCurrent(); renderSolve(); renderNoteCount(); } }, "오답노트에서 빼기")
          : h("button", { class: "btn small ghost", onclick: async () => { await addNote(s, q); if (s.done) await recordSet(s).catch(() => {}); saveCurrent(); renderSolve(); renderNoteCount(); } }, "찍어서 맞힘 · 오답노트에 저장 · 복습에 넣기")]
      : [h("span", { class: "hint", text: "오답노트에 저장됐어요" })]
  })));
  sec.append(qs);
  if (s.done){
    const right = s.questions.filter(q => q.sel === q.answer).length;
    sec.append(h("div", { class: "summary panel" },
      h("div", null, h("div", { class: "label", text: "결과" }), h("span", { class: "score", text: `${right} / ${s.questions.length}` }),
        h("span", { class: "hint", text: `  ·  소요 ${fmtTime(s.elapsed)}` })),
      h("button", { class: "btn primary", disabled: !!busy, onclick: () => { window.scrollTo({ top: 0, behavior: "smooth" }); startBank(); } }, "같은 유형 계속 풀기")));
  }
  v.append(sec);
}
setInterval(() => { const t = $("set-timer"); if (t && current && !current.done) t.textContent = fmtTime(Date.now() - current.startedAt); }, 1000);

/* ---------- 오답노트 ---------- */
const noteOpen = new Set(), noteRetry = new Map();
let noteFilter = "전체", confirmClear = false;
function renderNoteCount(){ $("note-count").textContent = notes.length; }
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
    const r = noteRetry.get(n.id) || { stem: n.q.stem, choices: n.q.choices, answer: n.q.answer, ex: n.q.ex, gloss: n.q.gloss || [], sel: n.q.mySel, checked: true };
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
  renderCardsCount();
  const total = Object.keys(VKINDS).reduce((a, k) => a + vocabCount(k), 0);
  v.append(h("div", { class: "chips sub-tabs" },
    h("button", { class: "chip", "aria-pressed": String(vb.mode !== "mine"), onclick: () => { vb.mode = "base"; saveVb(); renderCards(); } }, "기본 단어장", h("small", { text: String(total) })),
    h("button", { class: "chip", "aria-pressed": String(vb.mode === "mine"), onclick: () => { vb.mode = "mine"; saveVb(); renderCards(); } }, "내 단어장", h("small", { text: String(cards.length) }))));
  if (vb.mode === "mine") myCards(v); else baseVocab(v);
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
    current = set; saveCurrent(); showTab("solve");
    document.querySelector(".set")?.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e){ toast(e?.message || "문제를 열지 못했어요"); }
}

/* ---------- 내 단어장(☆) ---------- */
const CARD_TYPES = { all: "전체", kanji: "한자", grammar: "문법", compare: "비슷한 말", keigo: "경어" };
let cardFilter = "all", cardQuery = "", hideMeaning = false;
const revealed = new Set();
function renderCardsCount(){ $("card-count").textContent = cards.length; }
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
function renderIvCount(){ $("iv-count").textContent = answers.length; }

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

  /* 보기 설정 */
  const early = h("input", { id: "study-early", type: "checkbox", onchange: e => { settings.studyEarly = e.target.checked; savePrefs(); renderSolve(); } });
  early.checked = !!settings.studyEarly;
  v.append(h("section", { class: "panel stack" }, h("div", { class: "label", text: "보기 설정" }),
    h("label", { class: "check", for: "study-early" }, early, "풀기 전에도 본문 해설 보기"),
    h("p", { class: "hint", text: "독해·文章の文法 지문 아래의 문장별 해석·단락 요지·전체 번역은 보통 세트를 다 푼 뒤에 열려요. 켜면 풀기 전에도 볼 수 있어요. (단어 탭은 그대로 다 푼 뒤에만)" }),
    ttsSettings()));

  /* 학습 기록 */
  const rec = h("section", { class: "panel stack" }, h("div", { class: "label", text: "학습 기록" }));
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
        h("span", { class: "mono", text: `${r.right}/${r.total}` }), h("span", { class: "mono hint", text: fmtTime(r.elapsedMs) })));
    }
    rec.append(ul);
  }
  v.append(rec, tagStatsPanel(), minePanel());

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
/* 읽어주기 설정: 속도·음성(기기에 있는 일본어 음성) */
function ttsSettings(){
  const box = h("div", { class: "stack tts-set" }, h("div", { class: "label", text: "읽어주기 🔊" }));
  const save = () => { setTtsOpts({ rate: settings.ttsRate, voice: settings.ttsVoice }); savePrefs(); };
  box.append(h("div", { class: "chips" }, h("span", { class: "hint", text: "속도" }), RATES.map(r => h("button", { class: "chip", type: "button", "aria-pressed": String(settings.ttsRate === r),
    onclick: () => { settings.ttsRate = r; save(); renderSettings(); } }, r === 1 ? "1.0 보통" : r === 0.85 ? "0.85 조금 느리게" : "0.7 느리게"))));
  const vs = jaVoices();
  if (!vs.length) box.append(h("p", { class: "hint" }, "이 기기에서 일본어 음성을 찾지 못했어요. ", h("button", { class: "btn small ghost", type: "button", onclick: openTtsHelp }, "설치 방법 보기")));
  else {
    const sel = h("select", { id: "tts-voice", onchange: e => { settings.ttsVoice = e.target.value; save(); } },
      h("option", { value: "", text: "기본 일본어 음성" }), vs.map(v => h("option", { value: v.voiceURI, text: `${v.name}${v.localService ? "" : " (온라인)"}` })));
    sel.value = vs.some(v => v.voiceURI === settings.ttsVoice) ? settings.ttsVoice : "";
    box.append(h("label", { class: "field", for: "tts-voice" }, h("span", { class: "label", text: "음성" }), sel));
  }
  box.append(h("div", { class: "row" }, speakBtn("日本語能力試験に向けて、毎日少しずつ勉強を続けましょう。", "예시 문장"), h("span", { class: "hint", text: "예시 문장 들어 보기 · 단어·한자·문법은 읽기(히라가나)로, 문장은 원문 그대로 읽어요." })));
  return box;
}
onVoices(() => { if (!$("view-set").hidden) renderSettings(); });
/* 패턴별 통계: 문항의 patternTags 기준 출제 횟수 · 틀린 횟수(찍어서 맞힘 포함) */
let tagGroup = "전체", tagAll = false;
function tagStatsPanel(){
  const sec = h("section", { class: "panel stack" }, h("div", { class: "label", text: "패턴별 통계" }));
  const all = tagList();
  if (!all.length){ sec.append(h("p", { class: "hint", text: "문제은행 문제를 풀면 문법·어휘 패턴별로 출제 횟수와 틀린 횟수가 쌓여요." })); return sec; }
  const chips = h("div", { class: "chips" });
  for (const g of ["전체", ...GROUPS]){
    const n = g === "전체" ? all.length : all.filter(t => t.group === g).length;
    chips.append(h("button", { class: "chip", "aria-pressed": String(tagGroup === g), onclick: () => { tagGroup = g; tagAll = false; renderSettings(); } }, g, h("small", { text: String(n) })));
  }
  const rows = all.filter(t => tagGroup === "전체" || t.group === tagGroup);
  const table = h("table", { class: "tagstat" },
    h("thead", null, h("tr", null, h("th", { text: "패턴" }), h("th", { text: "출제" }), h("th", { text: "틀림" }), h("th", { text: "정답률" }))),
    h("tbody", null, (tagAll ? rows : rows.slice(0, 20)).map(t => h("tr", { class: t.wrong ? "ng" : null },
      h("td", { lang: "ja", text: t.id }), h("td", { class: "mono", text: String(t.seen) }), h("td", { class: "mono", text: String(t.wrong) }),
      h("td", { class: "mono", text: t.seen ? Math.round((t.seen - t.wrong) / t.seen * 100) + "%" : "–" })))));
  sec.append(chips, table);
  if (rows.length > 20) sec.append(h("button", { class: "btn small ghost", onclick: () => { tagAll = !tagAll; renderSettings(); } }, tagAll ? "접기" : `더 보기 (${rows.length - 20}개)`));
  return sec;
}

/* 내 문제 추가: 교재 문제 등을 이 기기 IndexedDB(localBank)에만 저장. 저장소 파일로는 절대 쓰지 않는다. */
const mine = Object.assign({ open: false, kind: "grammar_blank", mode: "form", passage: "", stem: "", choices: ["", "", "", ""], answer: 0, why: "", tags: "", json: "" }, prefs.get("n1.mine", {}));
const saveMine = () => prefs.set("n1.mine", mine);
let mineDel = null;
function minePanel(){
  const list = bank.local.filter(r => r.source === "mine");
  const det = h("details", { class: "panel mine" });
  det.open = mine.open;
  det.addEventListener("toggle", () => { mine.open = det.open; saveMine(); });
  det.append(h("summary", null, h("span", { class: "label", text: `내 문제 추가 · 이 기기에만 저장 (${list.length}개)` })));
  const body = h("div", { class: "stack" });
  body.append(h("p", { class: "hint", text: "교재 문제 등을 직접 넣으면 문제은행에 섞여 나오고, 틀리면 복습 일정에도 들어가요. 이 기기에만 저장되고 백업 파일에는 포함돼요. GitHub 저장소에는 올라가지 않아요." }));
  const sel = h("select", { id: "mine-kind", onchange: e => { mine.kind = e.target.value; saveMine(); renderSettings(); } },
    Object.entries(KINDS).map(([key, k]) => { const o = h("option", { value: key }, `${k.group} · ${k.label} (${k.jp})`); o.selected = key === mine.kind; return o; }));
  body.append(h("label", { class: "field", for: "mine-kind" }, h("span", { class: "label", text: "유형" }), sel));
  body.append(h("div", { class: "chips" },
    h("button", { class: "chip", "aria-pressed": String(mine.mode === "form"), onclick: () => { mine.mode = "form"; saveMine(); renderSettings(); } }, "직접 입력"),
    h("button", { class: "chip", "aria-pressed": String(mine.mode === "json"), onclick: () => { mine.mode = "json"; saveMine(); renderSettings(); } }, "JSON 붙여넣기")));
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
      h("button", { class: "btn ghost", onclick: () => { Object.assign(mine, { passage: "", stem: "", choices: ["", "", "", ""], answer: 0, why: "", tags: "" }); saveMine(); renderSettings(); } }, "비우기")));
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
          ? h("span", { class: "confirm" }, h("button", { class: "btn small", onclick: async () => { await removeLocal(r.id); mineDel = null; renderSettings(); renderSolve(); } }, "지우기"),
              h("button", { class: "btn small ghost", onclick: () => { mineDel = null; renderSettings(); } }, "취소"))
          : h("button", { class: "btn small ghost", onclick: () => { mineDel = r.id; renderSettings(); } }, "삭제")));
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
  saveMine(); toast("내 문제에 저장했어요"); renderSettings(); renderSolve();
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
  renderSettings(); renderSolve();
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
    renderAll(); renderSettings();
  } catch (err){ toast(err?.message || "백업 파일을 읽지 못했어요."); }
  e.target.value = "";
}

/* ---------- tabs ---------- */
const TABS = ["solve", "note", "cards", "iv", "set"];
function showTab(name){
  for (const t of TABS){ $("tab-" + t).setAttribute("aria-selected", String(t === name)); $("view-" + t).hidden = t !== name; }
  try { sessionStorage.setItem("n1.tab", name); } catch {}
  if (name === "note") renderNote();
  if (name === "cards") renderCards();
  if (name === "set") renderSettings();
  if (name === "iv") renderInterview();
  if (name === "solve") renderSolve();
  window.scrollTo({ top: 0 });
}
function renderAll(){ renderSolve(); renderNoteCount(); renderCardsCount(); renderIvCount(); }

/* ---------- boot ---------- */
async function loadAll(){
  [notes, cards, history, answers] = await Promise.all([db.all("notes"), db.all("cards"), db.all("history"), db.all("answers")]);
  notes.sort((a, b) => b.at - a.at); cards.sort((a, b) => b.at - a.at); answers.sort((a, b) => b.at - a.at);
  cardIds.clear(); for (const c of cards) cardIds.add(c.id);
  await loadBankState();
  await loadVocabState();
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
  if (changed){ renderSolve(); renderNote(); }
}
async function boot(){
  for (const t of TABS) $("tab-" + t).addEventListener("click", () => showTab(t));
  const today = new Date(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }) + "T00:00:00+09:00");
  const dd = Math.round((EXAM - today) / 86400000);
  $("dday").append(h("span", { text: "12월 6일(일) 시험까지" }), h("b", { text: dd > 0 ? `D-${dd}` : dd === 0 ? "D-DAY" : "끝!" }));

  await Promise.all([loadIndex(), loadVocabIndex()]);
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
  if (!current) current = prepSet(structuredClone(SAMPLES.grammar));
  renderAll();
  backfillAll();
  let start = "solve"; try { start = sessionStorage.getItem("n1.tab") || "solve"; } catch {}
  showTab(TABS.includes(start) ? start : "solve");

  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("./sw.js").catch(() => {});
}
boot();
