/* 모델이 만든 문제 세트를 검증·정리하고, 선택지를 섞는다. */
import { KINDS } from "./kinds.js";

const asStr = x => typeof x === "string" ? x : (x == null ? "" : String(x));
const arr = v => Array.isArray(v) ? v : [];

/* 단어 탭 gloss: [{ w: 문장에 나온 그대로의 표기, r: 히라가나, m: 한국어 뜻 }] */
export const normalizeGloss = v => arr(v).filter(g => g && g.w).map(g => ({ w: asStr(g.w), r: asStr(g.r), m: asStr(g.m) })).slice(0, 60);

function shuffleIdx(n){
  const a = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/* 청해 스크립트: [{ speaker: "M"|"F"|"N", text, ko }] */
export const normalizeScript = v => arr(v).filter(l => l && asStr(l.text).trim())
  .map(l => ({ speaker: ["M", "F", "N"].includes(l.speaker) ? l.speaker : "N", text: asStr(l.text), ko: asStr(l.ko) }));

export function normalizeQ(q, oneBased){
  const choices = arr(q.choices).slice(0, 4).map(asStr);
  const script = normalizeScript(q.script);
  const n = choices.length;                                // 보통 4지선다, 청해 即時応答은 3지선다
  if (n < (script.length ? 3 : 4) || (!asStr(q.stem).trim() && !script.length)) return null;
  let ans = q.answer;
  if (typeof ans === "string"){ const i = choices.indexOf(ans); ans = i >= 0 ? i : parseInt(ans, 10); }
  ans = Number(ans);
  if (oneBased) ans -= 1;
  if (!Number.isInteger(ans) || ans < 0 || ans >= n) return null;
  const ex = q.ex || q.explanation || {};
  const notes = arr(ex.choiceNotes).map(asStr);
  while (notes.length < n) notes.push("");
  const cko = arr(ex.choicesKo).slice(0, n).map(c => ({ reading: asStr(c?.reading), ko: asStr(c?.ko) }));
  while (cko.length < n) cko.push({ reading: "", ko: "" });
  const tr = ex.translation || {};
  const tags = arr(q.patternTags).map(asStr).map(t => t.trim()).filter(Boolean).slice(0, 6);
  return {
    stem: asStr(q.stem), choices, answer: ans, patternTags: tags,
    ...(typeof q.unitId === "string" ? { unitId: q.unitId } : {}),
    ...(script.length ? { script } : {}),
    gloss: normalizeGloss(q.gloss),
    ex: {
      translation: { full: asStr(tr.full), ko: asStr(tr.ko) },
      choicesKo: cko,
      why: asStr(ex.why),
      kanji: arr(ex.kanji).filter(k => k && k.word).map(k => ({ word: asStr(k.word), reading: asStr(k.reading), meaning: asStr(k.meaning) })).slice(0, 10),
      grammar: arr(ex.grammar).filter(g => g && g.pattern).map(g => ({ pattern: asStr(g.pattern), reading: asStr(g.reading), meaning: asStr(g.meaning), example: asStr(g.example) })).slice(0, 5),
      compare: arr(ex.compare).filter(c => c && c.word).map(c => ({ word: asStr(c.word), reading: asStr(c.reading), meaning: asStr(c.meaning), note: asStr(c.note) })).slice(0, 5),
      pattern: asStr(ex.pattern), tip: asStr(ex.tip), choiceNotes: notes.slice(0, n)
    }
  };
}

/* 본문 해설: sentences [{ja,ko,para,part?,claim?}] / passageNotes [{para,summary,flow,key}] / mainIdea (통합이해는 {A,B,common,diff}) */
export function normalizeStudy(raw){
  const sentences = arr(raw.sentences).filter(s => s && asStr(s.ja)).map(s => ({ ja: asStr(s.ja), ko: asStr(s.ko), para: Number(s.para) || 1,
    ...(/^[AB]$/.test(s.part || "") ? { part: s.part } : {}), ...(s.claim === true ? { claim: true } : {}) }));
  const passageNotes = arr(raw.passageNotes).filter(n => n && Number(n.para)).map(n => ({ para: Number(n.para), summary: asStr(n.summary), flow: asStr(n.flow), key: n.key === true }));
  const m = raw.mainIdea;
  const mainIdea = m && typeof m === "object" ? { A: asStr(m.A), B: asStr(m.B), common: asStr(m.common), diff: asStr(m.diff) } : asStr(m);
  return { sentences, passageNotes, mainIdea };
}
/* 지문에 딸린 필드 묶음 (세트 → 단위·오답노트로 옮길 때) */
export const passageFields = o => ({ passageKo: o.passageKo || "", passageGloss: o.passageGloss || [], sentences: o.sentences || [], passageNotes: o.passageNotes || [], mainIdea: o.mainIdea || "" });

export function prepSet(raw, { shuffle = false, fallbackKind = "grammar_blank" } = {}){
  const list = arr(raw.questions);
  const oneBased = list.some(q => Number(q.answer) === 4) && !list.some(q => Number(q.answer) === 0);
  const questions = list.map(q => normalizeQ(q, oneBased)).filter(Boolean);
  if (!questions.length) throw new Error("문제 형식이 올바르지 않아요. 다시 만들어 보세요.");
  for (const q of questions){
    q.sel = null; q.checked = false; q.saved = false;
    if (shuffle){
      const p = shuffleIdx(q.choices.length);
      q.choices = p.map(i => q.choices[i]);
      q.ex.choiceNotes = p.map(i => q.ex.choiceNotes[i]);
      q.ex.choicesKo = p.map(i => q.ex.choicesKo[i]);
      q.answer = p.indexOf(q.answer);
    }
  }
  const kind = KINDS[raw.kind] ? raw.kind : fallbackKind;
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    sample: !!raw.sample, kind,
    title: asStr(raw.title) || KINDS[kind].label,
    topic: asStr(raw.topic), passage: asStr(raw.passage), engine: asStr(raw.engine),
    passageKo: asStr(raw.passageKo), passageGloss: normalizeGloss(raw.passageGloss), ...normalizeStudy(raw),
    questions, startedAt: Date.now(), elapsed: 0, done: false, logged: false
  };
}

export function parseLoose(text){
  let t = String(text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error("응답에서 JSON을 찾지 못했어요.");
}

/* 꼬리 질문 응답 정리: { items: [{ q, ko, intent, point }] } 최대 5개 */
export function normalizeFollowups(raw){
  const list = Array.isArray(raw) ? raw : arr(raw?.items || raw?.questions);
  const items = list.filter(x => x && asStr(x.q).trim())
    .map(x => ({ q: asStr(x.q).trim(), ko: asStr(x.ko), intent: asStr(x.intent), point: asStr(x.point) })).slice(0, 5);
  if (!items.length) throw new Error("꼬리 질문 형식이 올바르지 않아요. 다시 만들어 보세요.");
  return items;
}
