// 문제은행 검증 + data/bank/index.json 생성.
// 사용: node tools/check-bank.mjs [--md]   (오류가 있으면 index.json을 쓰지 않고 exit 1)
// 검사: JSON 파싱, prepSet/normalizeQ 통과, id 중복, 유형별 형식, patternTags, 해설 항목(한국어), 선택지 번호 지칭
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { prepSet } from "../src/sets.js";
import { KINDS } from "../src/kinds.js";
import { readingErr } from "../src/furigana.js";

const DIR = new URL("../data/bank/", import.meta.url);
const hangul = s => /[가-힣]/.test(s || "");
const jpLen = s => (s || "").replace(/\s|__/g, "").length;
const EXPECT_Q = { text_grammar: 5, reading_short: 2, reading_mid: 3, reading_long: 3, integrated: 2, info_search: 2 };
const LEN = { reading_short: [200, 350], reading_mid: [450, 700], reading_long: [800, 1100], integrated: [450, 700], info_search: [500, 900], text_grammar: [550, 800] };

const errors = [], warns = [], ids = new Set(), stems = new Map(), tagCount = new Map();
// 새 해설 필드(translation·choicesKo·gloss·passageKo·passageGloss): 기존 데이터 보완이 끝나면 true로 바꿔 누락을 오류로
const NEW_FIELDS_STRICT = true;
// choicesKo.reading은 20자 이하 선택지(단어·구)에 한자가 있을 때 필수. 문장 선택지는 ""이고 그 속 단어는 gloss로
const hasKanji = s => /[一-龯々]/.test(s || "");
const kanaOnly = s => /^[ぁ-ゖァ-ヺー・、。]+$/.test(s || "");
const pieces = s => s.split(/★|__|\n/);                       // 화면에서 단어 탭이 나뉘는 경계
const BLANK_KINDS = ["grammar_blank", "context", "text_grammar", "grammar_order"];
/* gloss 검사: w가 문장 조각 안에 그대로 있는지, r·m 형식 */
function checkGloss(list, texts, at, err){
  const segs = texts.flatMap(pieces);
  const seen = new Set();
  for (const g of list){
    if (!segs.some(t => t.includes(g.w))) err(`${at} gloss「${g.w}」가 문장에 없음`);
    if (!kanaOnly(g.r)) err(`${at} gloss「${g.w}」 읽기가 가나가 아님: ${g.r}`);
    if (!hangul(g.m)) err(`${at} gloss「${g.w}」 뜻(한국어) 누락`);
    if (seen.has(g.w)) err(`${at} gloss「${g.w}」 중복`); else seen.add(g.w);
  }
}
/* 본문 해설(필수): sentences를 이으면 지문(줄바꿈·A/B 줄 제외)과 같아야 하고, 단락마다 passageNotes, mainIdea */
function checkStudy(u, kind, p, at, err){
  const S = u.sentences, N = u.passageNotes, M = u.mainIdea;
  if (!Array.isArray(S) || !S.length){ err(`${at} sentences 없음`); return; }
  const body = p.split(/\n/).map(l => l.trim()).filter(l => l && !/^[AB]$/.test(l)).join("");
  if (S.map(s => s.ja).join("") !== body) err(`${at} sentences를 이은 것이 지문과 다름`);
  let prev = 0;
  S.forEach((s, i) => {
    const t = `${at} 문장${i + 1}`;
    if (!s.ja?.trim()) err(`${t} ja 없음`);
    if (/[ぁ-んァ-ン一-龯]/.test(s.ja) ? !hangul(s.ko) : !s.ko?.trim()) err(`${t} ko(한국어) 없음`);   // 시간·숫자만 있는 줄은 그대로
    if (!Number.isInteger(s.para) || s.para < prev || s.para > prev + 1) err(`${t} para 순서 오류(${s.para})`); else prev = s.para;
    if (kind === "integrated" ? !/^[AB]$/.test(s.part || "") : s.part != null) err(`${t} part ${kind === "integrated" ? "없음(A/B)" : "는 통합이해만"}`);
    if (s.claim != null && typeof s.claim !== "boolean") err(`${t} claim은 true/false`);
  });
  if (S[0]?.para !== 1) err(`${at} para는 1부터`);
  if (!Array.isArray(N)) err(`${at} passageNotes 없음`);
  else {
    const paras = [...new Set(S.map(s => s.para))];
    if (N.map(n => n.para).join() !== paras.join()) err(`${at} passageNotes 단락(${N.map(n => n.para)})이 문장 단락(${paras})과 다름`);
    for (const n of N){
      if (!hangul(n.summary)) err(`${at} 단락${n.para} summary(한국어) 없음`);
      if (!n.flow?.trim()) err(`${at} 단락${n.para} flow 없음`);
      if (typeof n.key !== "boolean") err(`${at} 단락${n.para} key는 true/false`);
    }
    if (kind !== "info_search" && !N.some(n => n.key)) err(`${at} 필자 주장 단락(key) 없음`);
  }
  if (kind === "integrated"){
    if (!M || ["A", "B", "common", "diff"].some(x => !hangul(M[x]))) err(`${at} mainIdea {A,B,common,diff} 누락`);
  } else if (!hangul(M)) err(`${at} mainIdea 없음`);
}
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
  const missing = new Map();   // 새 필드 누락 개수
  const miss = name => missing.set(name, (missing.get(name) || 0) + 1);
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
    if (p.trim()){
      if (!u.passageKo) miss("passageKo"); else if (!hangul(u.passageKo)) err(`${at} passageKo가 한국어가 아님`);
      if (!set.passageGloss.length) miss("passageGloss"); else checkGloss(set.passageGloss, [p], `${at} 지문`, err);
      checkStudy(u, kind, p, at, err);
    }
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
        if (((q.stem.match(/[＿★]*＿[＿★]*/g) || []).length) !== 4) err(`${t} 빈칸 4개 형식 아님`);   // ＿★＿도 한 칸
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
      for (const g of ex.grammar){ const e = readingErr(g); if (e) err(`${t} grammar「${g.pattern}」 ${e}`); }
      if (k.vocab && ex.compare.length < 2) err(`${t} compare ${ex.compare.length}개 (필수 2~4)`);
      if (ex.compare.some(c => !hangul(c.meaning) || !hangul(c.note))) err(`${t} compare 한국어 누락`);
      if (!hangul(ex.pattern)) err(`${t} pattern 없음`);
      if (!hangul(ex.tip)) err(`${t} tip 없음`);
      if (!ex.choiceNotes.every(hangul)) err(`${t} choiceNotes 누락`);
      const tr = ex.translation;
      if (!tr.full && !tr.ko) miss("translation");
      else {
        if (!tr.full.trim() || !hangul(tr.ko)) err(`${t} translation full/ko 누락`);
        if (BLANK_KINDS.includes(kind) && !tr.full.includes(q.choices[q.answer])) err(`${t} translation.full에 정답「${q.choices[q.answer]}」이 없음`);
      }
      if (!ex.choicesKo.some(c => c.ko || c.reading)) miss("choicesKo");
      else ex.choicesKo.forEach((c, j) => {
        if (!hangul(c.ko)) err(`${t} choicesKo[${j}] 한국어 뜻 누락`);
        if (hasKanji(q.choices[j]) && q.choices[j].length <= 20 ? !kanaOnly(c.reading) : c.reading && !kanaOnly(c.reading)) err(`${t} choicesKo[${j}] 읽기 누락/가나 아님 (${q.choices[j]})`);
      });
      if (!q.gloss.length) miss("gloss"); else {
        checkGloss(q.gloss, [q.stem, ...q.choices], t, err);
        if (q.gloss.length > 12) warn(`${t} gloss ${q.gloss.length}개 (문장당 3~8개 기준)`);
      }
      if ([ex.why, ...ex.choiceNotes].some(n => /[①②③④]|[1-4]번|선택지 ?[1-4]/.test(n))) err(`${t} 해설이 선택지를 번호로 지칭(선택지는 섞임)`);
    });
  }
  for (const [name, n] of missing) (NEW_FIELDS_STRICT ? err : warn)(`새 필드 ${name} 누락 ${n}곳`);
  const tags = {};
  for (const u of units) for (const q of u.questions || []) for (const t of q.patternTags || []){ (tags[t] ||= []); if (!tags[t].includes(u.id)) tags[t].push(u.id); }
  if (units.length) index.kinds[kind] = { file, units: units.length, questions: qn, ids: units.map(u => u.id), tags };
  console.log(`${kind.padEnd(14)} ${String(units.length).padStart(4)}단위 ${String(qn).padStart(4)}문항`);
}

console.log(`\n패턴 ${tagCount.size}개 (출현 많은 순 상위 30)`);
console.log([...tagCount].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([t, n]) => `${t}×${n}`).join("  "));
if (warns.length) console.log(`\n경고 ${warns.length}\n  ` + warns.join("\n  "));
if (errors.length){ console.log(`\n오류 ${errors.length}\n  ` + errors.join("\n  ")); console.log("\nindex.json을 쓰지 않았어요."); process.exit(1); }
if (process.argv.includes("--strict") && warns.length){ console.log("\n경고도 0이어야 해요(--strict)."); process.exit(1); }
// --no-write(check-all·pre-commit): index.json을 쓰지 않고, 지금 데이터로 만든 것과 같은지만 확인(날짜 제외)
if (process.argv.includes("--no-write")){
  let old = null;
  try { old = JSON.parse(readFileSync(new URL("index.json", DIR), "utf8")); } catch {}
  if (!old || JSON.stringify({ ...old, generated: "" }) !== JSON.stringify({ ...index, generated: "" })){
    console.log("\ndata/bank/index.json이 데이터와 다름 → node --no-warnings tools/check-all.mjs --write 로 갱신 후 커밋"); process.exit(1);
  }
  console.log("\n오류 없음 · data/bank/index.json 최신");
} else {
  writeFileSync(new URL("index.json", DIR), JSON.stringify(index) + "\n");
  console.log("\n오류 없음 · data/bank/index.json 갱신");
}
if (process.argv.includes("--md")){
  console.log("\n| 유형 | 단위 | 문항 |\n|---|---|---|");
  for (const [kind, v] of Object.entries(index.kinds)) console.log(`| ${KINDS[kind].jp} (\`${kind}\`) | ${v.units} | ${v.questions} |`);
}
