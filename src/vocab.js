/*
 * 기본 단어장: data/vocab/{grammar,kanji,words}.json (직접 작성) + "외웠어요" 상태(IndexedDB vocabDone).
 * 파일은 처음 볼 때만 불러온다. 문법 항목의 pattern은 문제은행 patternTags와 같은 표기.
 */
import { db } from "./db.js";

export const VKINDS = {
  grammar: { label: "문법", groups: ["조건·역접", "원인·목적", "시간·순서", "정도·한정", "평가·판단", "감정·강제", "상태·모습", "관계·기준"] },
  kanji: { label: "한자 읽기", groups: ["音読み", "訓読み", "特殊な読み"] },
  words: { label: "어휘", groups: ["文脈規定", "言い換え", "用法"] },
};
export const vocabKey = (kind, it) => kind === "grammar" ? it.pattern : it.word;
export const vocabGroup = (kind, it) => kind === "words" ? it.part : it.group;

let vindex = { kinds: {} };
const files = new Map();
export const vstate = { done: new Map() };

export async function loadVocabIndex(){
  try { const r = await fetch("./data/vocab/index.json"); if (r.ok) vindex = await r.json(); } catch {}
  return vindex;
}
export const vocabCount = kind => vindex.kinds[kind]?.count || 0;
export async function loadVocab(kind){
  if (!files.has(kind)){
    const f = vindex.kinds[kind]?.file;
    let items = [];
    if (f){ const r = await fetch("./data/vocab/" + f); if (!r.ok) throw new Error("단어장 파일을 읽지 못했어요. 인터넷 연결을 확인하세요."); items = (await r.json()).items || []; }
    files.set(kind, items);
  }
  return files.get(kind);
}
export async function loadVocabState(){
  const rows = await db.all("vocabDone");
  vstate.done = new Map(rows.map(r => [r.id, r]));
}
export async function setDone(id, on){
  if (on){ const r = { id, at: Date.now() }; vstate.done.set(id, r); await db.put("vocabDone", r); }
  else { vstate.done.delete(id); await db.del("vocabDone", id); }
}

/* 틀린 문제에 나온 표제어(문법 패턴·단어)의 "외웠어요"를 풀어서 다시 안 외운 것으로. 풀린 개수를 돌려준다. */
export async function undoDoneFor(keys){
  if (!keys.size || !vstate.done.size) return 0;
  let n = 0;
  for (const kind of Object.keys(VKINDS)){
    if (!vocabCount(kind)) continue;
    let items;
    try { items = await loadVocab(kind); } catch { continue; }
    for (const it of items) if (keys.has(vocabKey(kind, it)) && vstate.done.has(it.id)){ await setDone(it.id, false); n++; }
  }
  return n;
}

/*
 * 카드 암기(vcards): 덱 words(한자+어휘) / grammar(문법). 날짜는 한국 날짜 "YYYY-MM-DD".
 * ✕(왼쪽) = 못 외움 → 1일 뒤 다시, 연속 ○ 수 0으로. 외웠어요였으면 해제.
 * ○(오른쪽) = 외웠음 → 연속 ○ 1·2·3번째는 3·7·14일 뒤, 4번째 ○ = 졸업(= 기존 "외웠어요" vocabDone).
 * 행: { id, deck, streak, seen, wrong, dueDay, lastDay, introducedOn, graduated }
 */
export const CARD_DAYS = [3, 7, 14];
export const DECK_KINDS = { words: ["kanji", "words"], grammar: ["grammar"] };
export const vcards = new Map();
export let rank = { words: [], grammar: [], blanks: {} };
export async function loadRank(){
  try { const r = await fetch("./data/vocab/rank.json"); if (r.ok) rank = await r.json(); } catch {}
  return rank;
}
export async function loadCardState(){
  const rows = await db.all("vcards");
  vcards.clear(); for (const r of rows) vcards.set(r.id, r);
}
export const cardDue = (id, today) => { const r = vcards.get(id); return !!r && !r.graduated && r.dueDay != null && r.dueDay <= today; };
/* 넘기기. 되돌리기용으로 이전 상태를 돌려준다 */
export async function swipeCard(id, deck, ok, today, addDays){
  const prev = vcards.get(id) ? { ...vcards.get(id) } : null, prevDone = vstate.done.has(id);
  const r = prev ? { ...prev } : { id, deck, streak: 0, seen: 0, wrong: 0, introducedOn: today };
  r.seen++; r.lastDay = today;
  if (ok){
    r.streak++;
    if (r.streak > CARD_DAYS.length){ r.graduated = true; r.dueDay = null; if (!prevDone) await setDone(id, true); }
    else { r.graduated = false; r.dueDay = addDays(today, CARD_DAYS[r.streak - 1]); }
  } else {
    r.streak = 0; r.wrong++; r.graduated = false; r.dueDay = addDays(today, 1);
    if (prevDone) await setDone(id, false);
  }
  vcards.set(id, r); await db.put("vcards", r);
  return { id, prev, prevDone };
}
export async function restoreCard({ id, prev, prevDone }){
  if (prev){ vcards.set(id, prev); await db.put("vcards", prev); } else { vcards.delete(id); await db.del("vcards", id); }
  if (prevDone !== vstate.done.has(id)) await setDone(id, prevDone);
}
