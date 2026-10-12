/*
 * N1 연습장 — 화면과 상태.
 * 데이터 흐름: 문제 생성(gemini.js) → 정리(sets.js) → 풀이 → 오답노트/단어장/기록을 IndexedDB(db.js)에 저장.
 */
import { h, $, prefs, fmtTime } from "./dom.js";
import { KINDS, TOPICS, EXAM } from "./kinds.js";
import { SAMPLES } from "./samples.js";
import { prepSet, normalizeFollowups } from "./sets.js";
import { CATS, CAT } from "./interview.js";
import { buildPrompt, buildFollowupPrompt } from "./prompt.js";
import { callGemini, callsToday, resetTimeKST, DEFAULT_MODEL } from "./gemini.js";
import { db, exportAll, importAll, requestPersist, persistState } from "./db.js";

const GROUPS = ["문자·어휘", "문법", "독해"];
const NUM = ["①", "②", "③", "④"];

/* ---------- state ---------- */
const settings = Object.assign({ key: "", model: DEFAULT_MODEL }, prefs.get("n1.settings", {}));
const gen = Object.assign({ kind: "grammar_blank", count: 5, topic: "", weak: true }, prefs.get("n1.gen", {}));
if (!KINDS[gen.kind]) gen.kind = "grammar_blank";
let current = null;
let notes = [], cards = [], history = [], answers = [];
const cardIds = new Set();
let busy = null, lastError = "", toastTimer = null;
let persist = "unsupported";

const savePrefs = () => { prefs.set("n1.settings", settings); prefs.set("n1.gen", gen); };
let curTimer = null;
function saveCurrent(){ clearTimeout(curTimer); curTimer = setTimeout(() => db.put("meta", { id: "current", value: current }).catch(() => {}), 300); }

function toast(msg){
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
async function ensurePersist(){ if (persist !== "granted") persist = await requestPersist(); }

/* ---------- weak points ---------- */
function weakPatterns(limit){
  const m = new Map();
  for (const n of notes) if (!KINDS[n.kind]?.vocab) for (const g of n.q.ex.grammar) m.set(g.pattern, (m.get(g.pattern) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}
function weakWords(limit){
  const m = new Map();
  for (const n of notes) if (KINDS[n.kind]?.vocab) for (const w of n.q.ex.kanji) m.set(w.word, (m.get(w.word) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

/* ---------- notes / cards / history ---------- */
async function addNote(set, q){
  if (q.saved) return;
  q.saved = true;
  const note = { id: set.id + "-" + set.questions.indexOf(q), at: Date.now(), kind: set.kind, title: set.title, passage: set.passage,
    q: { stem: q.stem, choices: q.choices, answer: q.answer, ex: q.ex, mySel: q.sel } };
  notes = [note, ...notes.filter(n => n.id !== note.id)];
  await db.put("notes", note); ensurePersist();
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
    const weak = (KINDS[gen.kind].vocab ? weakWords(8) : weakPatterns(6)).map(([p]) => p);
    const raw = await callGemini(buildPrompt(gen, weak), { key: settings.key, model: settings.model, signal: ctl.signal });
    raw.kind = gen.kind; raw.engine = "Gemini";
    current = prepSet(raw, { shuffle: true, fallbackKind: gen.kind });
    saveCurrent();
  } catch (e){
    if (!(e && e.name === "AbortError")) lastError = e?.message || "문제를 만들지 못했어요.";
  } finally {
    clearInterval(busy.timer); busy = null; renderSolve();
    if (!lastError) document.querySelector(".set")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

/* ---------- shared rendering ---------- */
function stemNode(s){
  const wrap = h("div", { class: "jp", lang: "ja" });
  for (const p of s.split(/(★|__[^_]+__)/)){
    if (p === "★") wrap.append(h("span", { class: "star", text: "★" }));
    else if (/^__[^_]+__$/.test(p)) wrap.append(h("u", { text: p.slice(2, -2) }));
    else if (p) wrap.append(p);
  }
  return wrap;
}
function passageNode(text, kind){
  const box = h("div", { class: "passage" + (kind === "info_search" ? " plain" : ""), lang: "ja" });
  for (const para of text.split(/\n+/).map(t => t.trim()).filter(Boolean)){
    const isAB = /^[AB]$/.test(para);
    const p = h("p", { class: isAB ? "mark-ab" : null });
    for (const seg of para.split(/(__[^_]+__)/)){
      if (/^__[^_]+__$/.test(seg)) p.append(h("u", { text: seg.slice(2, -2) }));
      else if (seg) p.append(seg);
    }
    box.append(p);
  }
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
  if (ex.why) box.append(h("section", null, h("h4", { text: "정답 근거" }), h("p", { text: ex.why })));
  if (ex.kanji.length) box.append(h("section", null, h("h4", { text: "한자 · 읽기" }),
    h("div", { class: "kanji" }, ex.kanji.map(k => h("div", { class: "kj" },
      h("span", { class: "w", lang: "ja", text: k.word }),
      h("span", { class: "r", lang: "ja", text: k.reading ? `（${k.reading}）` : "" }),
      h("span", { class: "m", text: k.meaning }),
      starBtn("kanji", k, source))))));
  if (ex.grammar.length) box.append(h("section", null, h("h4", { text: "주요 문법" }),
    h("div", { class: "gram" }, ex.grammar.map(g => h("div", { class: "gr" },
      h("div", { class: "gr-top" }, h("b", { lang: "ja", text: g.pattern }), h("span", { text: g.meaning ? "· " + g.meaning : "" }), starBtn("grammar", g, source)),
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
  wrap.append(h("div", { class: "q-stem" }, h("span", { class: "q-no", text: ctx.label || `問${idx + 1}` }), stemNode(q.stem)));
  const list = h("ol", { class: "choices" });
  q.choices.forEach((c, i) => {
    let cls = "choice", verdict = null;
    if (q.checked){
      if (i === q.answer){ cls += " right"; verdict = h("span", { class: "verdict ok", text: "정답" }); }
      else if (i === q.sel){ cls += " wrongpick"; verdict = h("span", { class: "verdict ng", text: "내 답" }); }
    }
    list.append(h("li", null, h("button", { class: cls, "aria-pressed": String(q.sel === i), disabled: q.checked, onclick: () => { q.sel = i; ctx.onChange(); } },
      h("span", { class: "bubble", text: String(i + 1) }), h("span", { class: "jp", lang: "ja", text: c }), verdict)));
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
      chips.append(h("button", { class: "chip", "aria-pressed": String(gen.kind === key), onclick: () => { gen.kind = key; savePrefs(); renderSolve(); } },
        k.label, h("small", { lang: "ja", text: k.jp })));
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
  const topicIn = h("input", { id: "topic", type: "text", placeholder: "비우면 무작위 (예: 경제, 의료, 철학)", value: gen.topic, oninput: e => { gen.topic = e.target.value; savePrefs(); } });
  const weakCount = (k.vocab ? weakWords(8) : weakPatterns(6)).length;
  const weakBox = h("input", { id: "weak", type: "checkbox", onchange: e => { gen.weak = e.target.checked; savePrefs(); } });
  weakBox.checked = gen.weak;
  g.append(h("div", { class: "row" },
    h("label", { class: "field", for: "topic" }, h("span", { class: "label", text: "주제" }), topicIn),
    h("label", { class: "check", for: "weak" }, weakBox, `오답노트 약점 ${k.vocab ? "어휘" : "문법"} 반영${weakCount ? ` (${weakCount}개)` : " (아직 없음)"}`)));

  const actions = h("div", { class: "row" });
  if (busy){
    actions.append(h("div", { class: "status" }, h("span", { class: "spin" }),
      h("span", null, "Gemini가 문제와 해설을 쓰는 중 · ", h("span", { id: "busy-sec", class: "mono", text: Math.round((Date.now() - busy.started) / 1000) + "초" })),
      h("button", { class: "btn small", onclick: () => busy?.ctl.abort() }, "중지")));
  } else {
    actions.append(h("button", { class: "btn primary", onclick: generate }, "새 문제 만들기"));
    actions.append(h("span", { class: "hint", text: `오늘 ${callsToday()}회 호출 · 무료 한도 초기화 ${resetTimeKST()}` }));
    if (!settings.key.trim()) actions.append(h("button", { class: "btn small ghost", onclick: () => showTab("set") }, "API 키 입력하기"));
  }
  g.append(actions);
  if (lastError) g.append(h("div", { class: "status err", role: "alert", text: lastError }));
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
      h("span", { class: "tag", lang: "ja", text: KINDS[s.kind]?.jp || "" }),
      s.topic && !s.sample ? h("span", { class: "tag", text: s.topic }) : null,
      h("span", null, "⏱ ", timer))));
  if (s.passage.trim()) sec.append(passageNode(s.passage, s.kind));
  const qs = h("div", { class: "qs" });
  s.questions.forEach((q, i) => qs.append(questionNode(q, i, {
    source: s.title,
    onChange: async () => {
      if (!s.done && s.questions.every(x => x.checked)){ s.done = true; s.elapsed = Date.now() - s.startedAt; await logHistory(s); }
      saveCurrent(); renderSolve();
    },
    onCheck: async qq => { if (qq.sel !== qq.answer) await addNote(s, qq); renderNoteCount(); },
    extraActions: q.sel === q.answer
      ? [q.saved
          ? h("button", { class: "btn small ghost", onclick: async () => { q.saved = false; await removeNote(s.id + "-" + i); saveCurrent(); renderSolve(); renderNoteCount(); } }, "오답노트에서 빼기")
          : h("button", { class: "btn small ghost", onclick: async () => { await addNote(s, q); saveCurrent(); renderSolve(); renderNoteCount(); } }, "찍어서 맞힘 · 오답노트에 저장")]
      : [h("span", { class: "hint", text: "오답노트에 저장됐어요" })]
  })));
  sec.append(qs);
  if (s.done){
    const right = s.questions.filter(q => q.sel === q.answer).length;
    sec.append(h("div", { class: "summary panel" },
      h("div", null, h("div", { class: "label", text: "결과" }), h("span", { class: "score", text: `${right} / ${s.questions.length}` }),
        h("span", { class: "hint", text: `  ·  소요 ${fmtTime(s.elapsed)}` })),
      h("button", { class: "btn primary", disabled: !!busy, onclick: () => { window.scrollTo({ top: 0, behavior: "smooth" }); generate(); } }, "같은 유형 새로 만들기")));
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
  const weak = weakPatterns(12), weakW = weakWords(12);
  const chipsOf = list => h("div", { class: "weak" }, list.map(([p, n]) => h("span", { lang: "ja" }, p, h("i", { text: `×${n}` }))));
  if (weak.length || weakW.length) v.append(h("section", { class: "panel stack" },
    weak.length ? h("div", null, h("div", { class: "label", text: "자주 틀린 문법" }), chipsOf(weak)) : null,
    weakW.length ? h("div", null, h("div", { class: "label", text: "자주 틀린 어휘" }), chipsOf(weakW)) : null,
    h("div", { class: "hint", text: "새 문제를 만들 때 '약점 반영'을 켜 두면 이 문법·어휘가 섞여 나와요." })));

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
    if (n.passage && n.passage.trim()) body.append(passageNode(n.passage, n.kind));
    const r = noteRetry.get(n.id) || { stem: n.q.stem, choices: n.q.choices, answer: n.q.answer, ex: n.q.ex, sel: n.q.mySel, checked: true };
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

/* ---------- 단어장 ---------- */
const CARD_TYPES = { all: "전체", kanji: "한자", grammar: "문법", compare: "비슷한 말" };
let cardFilter = "all", cardQuery = "", hideMeaning = false;
const revealed = new Set();
function renderCardsCount(){ $("card-count").textContent = cards.length; }
function renderCards(){
  const v = $("view-cards"); v.replaceChildren();
  renderCardsCount();
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
const iv = Object.assign({ cat: "all", draft: null }, prefs.get("n1.interview", {}));
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
  v.append(answerNotes());
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
  v.append(rec);

  /* 기기 저장 · 백업 */
  persist = await persistState();
  const store = h("section", { class: "panel stack" }, h("div", { class: "label", text: "이 기기에 저장된 데이터" }),
    h("p", null, `오답노트 ${notes.length}개 · 단어장 ${cards.length}개 · 학습 기록 ${history.length}개 · 면접 답변 ${answers.length}개`),
    h("p", { class: "hint" }, persist === "granted"
      ? "영구 저장이 허용돼 있어요. 브라우저가 공간 정리를 할 때도 지워지지 않아요."
      : "브라우저가 공간이 부족할 때 데이터를 지울 수 있어요. 홈 화면에 설치하면 더 안전하고, 가끔 백업 파일을 내보내 두세요.",
      persist === "denied" ? h("button", { class: "btn small ghost", onclick: async () => { persist = await requestPersist(); renderSettings(); } }, "영구 저장 요청") : null),
    h("div", { class: "row" },
      h("button", { class: "btn", onclick: doExport }, "백업 파일 내보내기"),
      h("label", { class: "btn", for: "import-file" }, "백업 불러오기"),
      h("input", { id: "import-file", type: "file", accept: "application/json,.json", hidden: true, onchange: doImport })),
    h("p", { class: "hint", text: "백업 파일로 휴대폰 ↔ PC 사이에 오답노트와 단어장을 옮길 수 있어요. 불러오면 기존 데이터와 합쳐져요." }));
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
    toast(`불러왔어요: 오답 ${counts.notes} · 단어 ${counts.cards} · 기록 ${counts.history}`);
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
}
async function boot(){
  for (const t of TABS) $("tab-" + t).addEventListener("click", () => showTab(t));
  const today = new Date(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }) + "T00:00:00+09:00");
  const dd = Math.round((EXAM - today) / 86400000);
  $("dday").append(h("span", { text: "12월 6일(일) 시험까지" }), h("b", { text: dd > 0 ? `D-${dd}` : dd === 0 ? "D-DAY" : "끝!" }));

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
  let start = "solve"; try { start = sessionStorage.getItem("n1.tab") || "solve"; } catch {}
  showTab(TABS.includes(start) ? start : "solve");

  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("./sw.js").catch(() => {});
}
boot();
