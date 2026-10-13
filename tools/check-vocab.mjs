// 기본 단어장 검증 + data/vocab/index.json 생성.
// 사용: node --no-warnings tools/check-vocab.mjs   (오류가 있으면 index.json을 쓰지 않고 exit 1)
// 검사: 필수 항목, id 중복·접두사, 읽기(히라가나), 헷갈리는 읽기, 예문에 표제어 포함, 한국어 뜻·해석,
//       분류 값, 그리고 문제은행 patternTags가 단어장에 빠짐없이 있는지(경고)
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { VKINDS } from "../src/vocab.js";

const DIR = new URL("../data/vocab/", import.meta.url), BANK = new URL("../data/bank/", import.meta.url);
const PREFIX = { grammar: "g-", kanji: "k-", words: "w-" };
const hangul = s => /[가-힣]/.test(s || "");
const hira = s => /^[ぁ-ゖー]+$/.test(s || "");
const kana = s => /^[ぁ-ゖァ-ヺー]+$/.test(s || "");
const errors = [], warns = [], ids = new Set();
const index = { generated: new Date().toISOString().slice(0, 10), kinds: {} };
const keys = { grammar: new Set(), kanji: new Set(), words: new Set() };

/* 예문에 표제어가 들어 있는지: 활용을 고려해 앞부분(어간)만 본다 */
function stemOf(s){
  const t = s.replace(/^〜/, "").replace(/[（(].*?[）)]/g, "").split(/[・／/]/)[0].replace(/〜.*$/, "");
  const m = t.match(/^[一-龯々ァ-ヺー]+/);           // 한자·가타카나 부분이 있으면 그것
  if (m) return m[0];
  const k = t.slice(0, 2);                           // 가나뿐이면 활용을 고려해 앞 2글자만
  return k.length === 2 && t.length === 2 && /[うくぐすつぬぶむる]$/.test(k) ? k[0] : k;   // めく→め(めいた)
}

for (const kind of Object.keys(VKINDS)){
  const file = `${kind}.json`;
  if (!existsSync(new URL(file, DIR))) continue;
  const err = m => errors.push(`${file} ${m}`), warn = m => warns.push(`${file} ${m}`);
  let data;
  try { data = JSON.parse(readFileSync(new URL(file, DIR), "utf8")); } catch (e){ err("JSON 파싱 실패: " + e.message); continue; }
  if (data.kind !== kind) err(`kind 필드가 ${data.kind}`);
  const items = Array.isArray(data.items) ? data.items : [];
  const seen = new Map();
  for (const it of items){
    const at = it.id || "(id 없음)";
    if (!it.id || !it.id.startsWith(PREFIX[kind])) err(`${at} id 접두사는 ${PREFIX[kind]}`);
    if (ids.has(it.id)) err(`${at} id 중복`); else ids.add(it.id);
    const key = kind === "grammar" ? it.pattern : `${it.word}|${it.reading}`;
    if (seen.has(key)) err(`${at} ${seen.get(key)}와 표제어 중복 (${key})`); else seen.set(key, at);
    if (!it.example || !hangul(it.exampleKo)) err(`${at} 예문/해석 누락`);
    if (!hangul(it.meaning)) err(`${at} 뜻(한국어) 누락`);
    const group = kind === "words" ? it.part : it.group;
    if (!VKINDS[kind].groups.includes(group)) err(`${at} 분류 값이 올바르지 않음: ${group}`);
    if (kind === "grammar"){
      if (!/^〜?\S/.test(it.pattern || "")) err(`${at} pattern 없음`);
      if (!it.connection) err(`${at} connection(접속) 없음`);
      if (!Array.isArray(it.similar)) err(`${at} similar 배열 없음`);
      else for (const s of it.similar) if (!s.pattern || !hangul(s.diff)) err(`${at} similar 항목 누락(${s.pattern || "?"})`);
      keys.grammar.add(it.pattern);
    } else {
      if (!it.word) err(`${at} word 없음`);
      if (kind === "kanji" ? !hira(it.reading) : !kana(it.reading)) err(`${at} reading이 가나가 아님: ${it.reading}`);
      keys[kind].add(it.word);
    }
    if (kind === "kanji"){
      if (!/[一-龯々]/.test(it.word || "")) err(`${at} 한자가 없음`);
      if (!Array.isArray(it.confusable) || !it.confusable.length) err(`${at} confusable 없음`);
      else if (it.confusable.some(c => !hira(c) || c === it.reading)) err(`${at} confusable이 히라가나가 아니거나 정답 읽기와 같음`);
    }
    if (kind === "words"){
      if (!it.pos) err(`${at} pos 없음`);
      if (!Array.isArray(it.synonyms)) err(`${at} synonyms 배열 없음`);
      if (!it.usage) err(`${at} usage(연어) 없음`);
    }
    const head = kind === "grammar" ? it.pattern : it.word;
    if (head && it.example && !it.example.includes(stemOf(head))) warn(`${at} 예문에 표제어(${stemOf(head)})가 안 보임`);
  }
  if (items.length) index.kinds[kind] = { file, count: items.length };
  console.log(`${kind.padEnd(8)} ${String(items.length).padStart(4)}개  ` +
    VKINDS[kind].groups.map(g => `${g} ${items.filter(i => (kind === "words" ? i.part : i.group) === g).length}`).join(" · "));
}

/* 문제은행 patternTags가 단어장에 있는지 (문법 유형 → grammar, 문자·어휘 유형 → kanji/words) */
const GRAMMAR_KINDS = ["grammar_blank", "grammar_order", "text_grammar"], VOCAB_KINDS = ["kanji_reading", "context", "paraphrase", "usage"];
if (existsSync(BANK)) for (const f of readdirSync(BANK).filter(f => f.endsWith(".json") && f !== "index.json")){
  const kind = f.replace(/\.json$/, "");
  const target = GRAMMAR_KINDS.includes(kind) ? "grammar" : VOCAB_KINDS.includes(kind) ? "vocab" : null;
  if (!target) continue;
  const data = JSON.parse(readFileSync(new URL(f, BANK), "utf8"));
  const missing = new Set();
  for (const u of data.units) for (const q of u.questions) for (const t of q.patternTags || [])
    if (target === "grammar" ? (t.startsWith("〜") && !keys.grammar.has(t)) : !(keys.kanji.has(t) || keys.words.has(t))) missing.add(t);   // 文章の文法의 유형 태그(接続表現 등)는 제외
  if (missing.size) warns.push(`문제은행 ${f}의 patternTags가 단어장에 없음: ${[...missing].join(" ")}`);
}

if (warns.length) console.log(`\n경고 ${warns.length}\n  ` + warns.join("\n  "));
if (errors.length){ console.log(`\n오류 ${errors.length}\n  ` + errors.join("\n  ")); console.log("\nindex.json을 쓰지 않았어요."); process.exit(1); }
writeFileSync(new URL("index.json", DIR), JSON.stringify(index) + "\n");
console.log("\n오류 없음 · data/vocab/index.json 갱신");
