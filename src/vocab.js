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
