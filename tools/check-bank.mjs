// 문제은행 검증 + data/bank/index.json 생성.
// 사용: node tools/check-bank.mjs [--md]   (오류가 있으면 index.json을 쓰지 않고 exit 1)
// 검사: JSON 파싱, prepSet/normalizeQ 통과, id 중복, 유형별 형식, patternTags, 해설 항목(한국어), 선택지 번호 지칭
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { prepSet } from "../src/sets.js";
import { KINDS } from "../src/kinds.js";

const DIR = new URL("../data/bank/", import.meta.url);
const hangul = s => /[가-힣]/.test(s || "");
const jpLen = s => (s || "").replace(/\s|__/g, "").length;
const EXPECT_Q = { text_grammar: 5, reading_short: 2, reading_mid: 3, reading_long: 3, integrated: 2, info_search: 2 };
const LEN = { reading_short: [200, 350], reading_mid: [450, 700], reading_long: [800, 1100], integrated: [450, 700], info_search: [500, 900], text_grammar: [550, 800] };

const errors = [], warns = [], ids = new Set(), stems = new Map(), tagCount = new Map();
const index = { generated: new Date().toISOString().slice(0, 10), kinds: {} };

for (const file of readdirSync(DIR).filter(f => f.endsWith(".json") && f !== "index.json").sort()){
  const kind = file.replace(/\.json$/, "");
  const err = m => errors.push(`${file} ${m}`), warn = m => warns.push(`${file} ${m}`);
  if (!KINDS[kind]){ err("알 수 없는 유형 파일"); continue; }
  let data;
  try { data = JSON.parse(readFileSync(new URL(file, DIR), "utf8")); } catch (e){ err("JSON 파싱 실패: " + e.message); continue; }
  if (data.kind !== kind) err(`kind 필드가 ${data.kind}`);
  const units = Array.isArray(data.units) ? data.units : [];
  const k = KINDS[kind];
  let qn = 0;
  for (const u of units){
    const at = `${u.id || "(id 없음)"}`;
    if (!u.id || typeof u.id !== "string") err(`${at} id 없음`);
    else if (ids.has(u.id)) err(`${at} id 중복`); else ids.add(u.id);
    const rawN = Array.isArray(u.questions) ? u.questions.length : 0;
    let set;
    try { set = prepSet(structuredClone({ ...u, kind }), { fallbackKind: kind }); } catch (e){ err(`${at} prepSet 실패: ${e.message}`); continue; }
    if (set.questions.length !== rawN) err(`${at} normalizeQ 탈락 ${rawN - set.questions.length}문항`);
    if (k.counts && rawN !== 1) err(`${at} 문항형 단위는 문제 1개여야 함 (${rawN})`);
    if (!k.counts && EXPECT_Q[kind] && rawN !== EXPECT_Q[kind]) warn(`${at} 문항 수 ${rawN} (보통 ${EXPECT_Q[kind]})`);
    const p = set.passage;
    if (k.fixed && !p.trim()) err(`${at} 지문 없음`);
    if (!k.fixed && p.trim()) err(`${at} 문항형인데 지문이 있음`);
    if (LEN[kind] && p.trim()){ const n = jpLen(p); if (n < LEN[kind][0] || n > LEN[kind][1]) warn(`${at} 지문 ${n}자 (기준 ${LEN[kind].join("~")})`); }
    if (kind === "text_grammar") for (const n of "１２３４５") if (!p.includes(`（${n}）`)) err(`${at} 지문에 （${n}） 없음`);
    if (kind === "info_search" && /\|.*\||^#|\*\*/m.test(p)) err(`${at} 지문에 표/마크다운`);
    if (kind === "integrated" && !(/^A\s*$/m.test(p) && /^B\s*$/m.test(p))) err(`${at} A/B 구분 줄 없음`);
    set.questions.forEach((q, i) => {
      qn++;
      const t = `${at} Q${i + 1}`, ex = q.ex;
      const key = q.stem + (p ? "|" + p.slice(0, 40) : "");
      if (stems.has(key)) err(`${t} 문제가 ${stems.get(key)}와 같음`); else stems.set(key, t);
      if (new Set(q.choices).size !== 4) err(`${t} 선택지 중복`);
      if (q.choices.some(c => !c.trim())) err(`${t} 빈 선택지`);
      if (!q.patternTags.length) err(`${t} patternTags 없음`);
      for (const tag of q.patternTags) tagCount.set(tag, (tagCount.get(tag) || 0) + 1);
      if (kind === "grammar_order"){
        if ((q.stem.match(/★/g) || []).length !== 1) err(`${t} ★가 1개가 아님`);
        if (((q.stem.match(/＿+/g) || []).length) !== 4) err(`${t} 빈칸 4개 형식 아님`);
      }
      if (kind === "usage" && !/^「.+」$/.test(q.stem)) err(`${t} stem이 「단어」 형식 아님`);
      if ((kind === "kanji_reading" || kind === "paraphrase") && !/__[^_]+__/.test(q.stem)) err(`${t} 밑줄 없음`);
      if ((kind === "context" || kind === "grammar_blank") && !/（[　\s]*）/.test(q.stem)) err(`${t} 빈칸（　　） 없음`);
      const m = q.stem.match(/「([^」]+)」とあるが/);
      if (m && !p.includes(`__${m[1]}__`)) err(`${t} 「${m[1].slice(0, 12)}」 밑줄이 지문에 없음`);
      if (!hangul(ex.why)) err(`${t} why 없음/한국어 아님`);
      if (!ex.kanji.length) warn(`${t} kanji 없음`);
      else if (!ex.kanji.every(x => x.reading && hangul(x.meaning))) err(`${t} kanji 읽기/뜻 누락`);
      if (!k.vocab && !ex.grammar.length) warn(`${t} grammar 없음`);
      if (ex.grammar.some(g => !hangul(g.meaning) || !g.example)) err(`${t} grammar 뜻/예문 누락`);
      if (k.vocab && ex.compare.length < 2) err(`${t} compare ${ex.compare.length}개 (필수 2~4)`);
      if (ex.compare.some(c => !hangul(c.meaning) || !hangul(c.note))) err(`${t} compare 한국어 누락`);
      if (!hangul(ex.pattern)) err(`${t} pattern 없음`);
      if (!hangul(ex.tip)) err(`${t} tip 없음`);
      if (!ex.choiceNotes.every(hangul)) err(`${t} choiceNotes 누락`);
      if ([ex.why, ...ex.choiceNotes].some(n => /[①②③④]|[1-4]번|선택지 ?[1-4]/.test(n))) err(`${t} 해설이 선택지를 번호로 지칭(선택지는 섞임)`);
    });
  }
  const tags = {};
  for (const u of units) for (const q of u.questions || []) for (const t of q.patternTags || []){ (tags[t] ||= []); if (!tags[t].includes(u.id)) tags[t].push(u.id); }
  if (units.length) index.kinds[kind] = { file, units: units.length, questions: qn, ids: units.map(u => u.id), tags };
  console.log(`${kind.padEnd(14)} ${String(units.length).padStart(4)}단위 ${String(qn).padStart(4)}문항`);
}

console.log(`\n패턴 ${tagCount.size}개 (출현 많은 순 상위 30)`);
console.log([...tagCount].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([t, n]) => `${t}×${n}`).join("  "));
if (warns.length) console.log(`\n경고 ${warns.length}\n  ` + warns.join("\n  "));
if (errors.length){ console.log(`\n오류 ${errors.length}\n  ` + errors.join("\n  ")); console.log("\nindex.json을 쓰지 않았어요."); process.exit(1); }
writeFileSync(new URL("index.json", DIR), JSON.stringify(index) + "\n");
console.log("\n오류 없음 · data/bank/index.json 갱신");
if (process.argv.includes("--md")){
  console.log("\n| 유형 | 단위 | 문항 |\n|---|---|---|");
  for (const [kind, v] of Object.entries(index.kinds)) console.log(`| ${KINDS[kind].jp} (\`${kind}\`) | ${v.units} | ${v.questions} |`);
}
