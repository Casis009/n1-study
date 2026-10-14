// 기본 단어장 학습 우선순위 + 문법 예문 빈칸 위치 → data/vocab/rank.json (데일리 단어·문법 카드와 오늘의 시험이 쓴다)
// 사용: node --no-warnings tools/rank-vocab.mjs              다시 계산해서 rank.json을 쓴다
//       node --no-warnings tools/rank-vocab.mjs --no-write   쓰지 않고 rank.json이 최신인지만 확인(check-all)
//
// 우선순위(앞에서부터). "자주 틀림"은 기기 데이터라 앱이 실행할 때 맨 앞에 끼운다. 여기서는 A → B → C:
//   A: 문제은행의 정답(patternTags)이나 선택지에 나온 항목
//   B: 지문·문제 문장·청해 스크립트·gloss(단어 탭)·ex.kanji(해설 한자)·ex.grammar(해설 문법)에 나온 항목
//   C: 나머지
//   같은 등급 안에서는 은행에 나온 횟수가 많은 순, 같으면 id 순.
// 덱: words = 한자 읽기(kanji.json) + 어휘(words.json), grammar = 문법(grammar.json).
// 문법 빈칸: 예문 속 패턴 부분 [시작, 끝]. 규칙은 tools/grammar-blank.mjs(항목의 blank 직접 지정 → 없으면 자동).
//   못 찾은 항목은 시험에서 빠지고, check-vocab이 경고한다.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { blankOf, cores } from "./grammar-blank.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = p => JSON.parse(readFileSync(ROOT + p, "utf8"));
const OUT = "data/vocab/rank.json";
const noWrite = process.argv.includes("--no-write");

const vindex = read("data/vocab/index.json");
const vitems = kind => vindex.kinds[kind] ? read("data/vocab/" + vindex.kinds[kind].file).items : [];
const kanji = vitems("kanji"), words = vitems("words"), grammar = vitems("grammar");

/* 문제은행 텍스트 모으기 */
const A_exact = new Map(), A_text = [], B_exact = new Map(), B_text = [];
const bump = (m, k) => { if (k) m.set(k, (m.get(k) || 0) + 1); };
const bindex = read("data/bank/index.json");
for (const v of Object.values(bindex.kinds)){
  for (const u of read("data/bank/" + v.file).units){
    if (u.passage) B_text.push(u.passage);
    for (const g of u.passageGloss || []) bump(B_exact, g.w);
    for (const q of u.questions){
      for (const t of q.patternTags || []) bump(A_exact, t);
      for (const c of q.choices || []){ bump(A_exact, c); A_text.push(c); }
      if (q.stem) B_text.push(q.stem);
      for (const l of q.script || []) B_text.push(l.text);
      for (const g of q.gloss || []) bump(B_exact, g.w);
      for (const k of q.ex?.kanji || []) bump(B_exact, k.word);
      for (const g of q.ex?.grammar || []) bump(B_exact, g.pattern);
      for (const c of q.ex?.compare || []) bump(B_exact, c.word);
    }
  }
}
/* 문장 속 포함 횟수. 가나로만 된 짧은 말(ことに·なり 등)은 다른 말 속에 섞여 부풀므로 4자 이상만 센다 */
const KANA_ONLY = /^[ぁ-ヿ〜]+$/;
const countIn = (list, s) => s && s.length >= 2 && !(KANA_ONLY.test(s) && s.length < 4) ? list.reduce((a, t) => a + (t.includes(s) ? 1 : 0), 0) : 0;

function rankOf(key, isGrammar){
  let a = A_exact.get(key) || 0, b = B_exact.get(key) || 0;
  if (isGrammar){ const cs = cores(key), main = cs.sort((x, y) => y.length - x.length)[0] || ""; a += countIn(A_text, main); b += countIn(B_text, main); }
  else { a += countIn(A_text, key); b += countIn(B_text, key); }
  return a ? ["A", a] : b ? ["B", b] : ["C", 0];
}
function order(items, keyOf, isGrammar){
  const r = items.map((it, i) => { const [tier, n] = rankOf(keyOf(it), isGrammar); return { id: it.id, key: keyOf(it), tier, n, i }; });
  r.sort((x, y) => x.tier.localeCompare(y.tier) || y.n - x.n || x.i - y.i);
  return r.map(x => [x.id, x.tier, x.key]);
}

/* 문법 예문 빈칸 */
const blanks = {}, noBlank = [];
for (const it of grammar){ const b = blankOf(it).range; if (b) blanks[it.id] = b; else noBlank.push(it.id); }

const data = {
  _comment: "tools/rank-vocab.mjs가 만듦. 손으로 고치지 말 것. words/grammar = [id, 등급(A/B/C), 표제어] 우선순위 순, blanks = 문법 예문 빈칸 [시작, 끝]",
  words: order([...kanji, ...words], it => it.word, false),
  grammar: order(grammar, it => it.pattern, true),
  blanks, noBlank,
};
const text = JSON.stringify(data) + "\n";
const tiers = list => ["A", "B", "C"].map(t => `${t} ${list.filter(x => x[1] === t).length}`).join(" · ");
const summary = `단어 ${data.words.length}개(${tiers(data.words)}) · 문법 ${data.grammar.length}개(${tiers(data.grammar)}) · 빈칸 ${Object.keys(blanks).length}/${grammar.length}${noBlank.length ? ` (못 찾음 ${noBlank.join(", ")})` : ""}`;
if (noWrite){
  const cur = existsSync(ROOT + OUT) ? readFileSync(ROOT + OUT, "utf8").replace(/\r/g, "") : "";   // 체크아웃에서 CRLF로 바뀌어도 같은 내용으로 본다
  if (cur !== text){ console.log(`✗ ${OUT}가 최신이 아니에요 → node --no-warnings tools/rank-vocab.mjs`); process.exit(1); }
  console.log(`오류 없음 · ${OUT} 최신 · ${summary}`);
} else {
  writeFileSync(ROOT + OUT, text);
  console.log(`${OUT} 씀 · ${summary}`);
}
