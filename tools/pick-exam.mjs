// 모의고사 예약 회차 관리: data/exam.json 구성대로 문제은행 단위를 골라 data/exam-reserve.json에 회차를 추가한다.
// 사용: node --no-warnings tools/pick-exam.mjs            예약 파일 검사만 (check-all이 이 모드로 실행)
//       node --no-warnings tools/pick-exam.mjs --add      회차 하나 추가 (기존 회차는 그대로 두고 뒤에 붙임)
//
// 고르는 규칙: 유형마다 아직 어느 회차에도 예약되지 않은 기본 은행 단위 중 id가 큰 쪽(최근에 쓴 문제)부터.
//   → 문제집 회차는 파일 앞쪽부터 묶으므로, 회차를 추가해도 앞쪽 문제집 회차 구성은 바뀌지 않는다.
//   한 회차 안에서 같은 유형이 두 대문에 나오면(内容理解(長文) 대체 + 主張理解) 서로 다른 단위를 쓴다.
// 문제가 모자라면 아무것도 쓰지 않고 실패한다(문제를 더 만든 뒤 다시 --add).
// 검사: 예약 id가 은행에 있는지, 회차끼리 겹치지 않는지, 대문별 문항·세트 수가 exam.json과 맞는지.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = p => JSON.parse(readFileSync(ROOT + p, "utf8"));
const exam = read("data/exam.json");
const RES = "data/exam-reserve.json";
const reserve = existsSync(ROOT + RES) ? read(RES) : { rounds: [] };
const bankIndex = read("data/bank/index.json");
const units = new Map();                       // kind → [{ id, qn }] 파일 순서
for (const [kind, v] of Object.entries(bankIndex.kinds)){
  const f = read("data/bank/" + v.file);
  units.set(kind, f.units.map(u => ({ id: u.id, qn: u.questions.length })));
}
const items = exam.sections.flatMap(s => s.items.filter(it => it.kind).map(it => ({ ...it, section: s.id })));
const key = it => `${it.section}-${it.no}`;    // 회차 안 대문 키 (예: s1-10)

const errors = [];
function check(){
  const seen = new Map();
  for (const r of reserve.rounds){
    for (const it of items){
      const ids = r.items?.[key(it)];
      if (!Array.isArray(ids)){ errors.push(`${r.no}회 ${it.jp}: 예약 없음`); continue; }
      const list = units.get(it.kind) || [];
      for (const id of ids){
        if (!list.some(u => u.id === id)) errors.push(`${r.no}회 ${it.jp}: 은행에 없는 id ${id}`);
        if (seen.has(id)) errors.push(`${r.no}회 ${it.jp}: ${id}가 ${seen.get(id)}에도 예약됨`);
        seen.set(id, `${r.no}회 ${it.jp}`);
      }
      const want = it.count ?? it.sets;
      if (ids.length !== want) errors.push(`${r.no}회 ${it.jp}: ${ids.length}개 (exam.json은 ${want}${it.count != null ? "문항" : "세트"})`);
    }
  }
}

function addRound(){
  const used = new Set(reserve.rounds.flatMap(r => Object.values(r.items || {}).flat()));
  const round = { no: reserve.rounds.length + 1, items: {} };
  for (const it of items){
    const pool = (units.get(it.kind) || []).filter(u => !used.has(u.id)).reverse();   // id 큰 쪽부터
    const n = it.count ?? it.sets;
    if (pool.length < n){ errors.push(`${it.jp}(${it.kind}): 남은 단위 ${pool.length}개 < 필요 ${n}개`); continue; }
    const pick = pool.slice(0, n).map(u => u.id).reverse();                          // 회차 안에서는 id 순서대로 출제
    pick.forEach(id => used.add(id));
    round.items[key(it)] = pick;
  }
  if (errors.length) return null;
  reserve.rounds.push(round);
  return round;
}

if (process.argv.includes("--add")){
  check();
  if (!errors.length){
    const r = addRound();
    if (r){
      check();
      if (!errors.length){
        writeFileSync(ROOT + RES, JSON.stringify({ _comment: "tools/pick-exam.mjs가 만든 모의고사 예약. 회차 추가는 --add, 손으로 고치지 말 것", rounds: reserve.rounds }, null, 1) + "\n");
        const n = Object.values(r.items).flat().length;
        console.log(`${r.no}회 예약 추가: 단위 ${n}개 → ${RES}`);
      }
    }
  }
} else check();

if (errors.length){ console.log(errors.map(e => "✗ " + e).join("\n")); console.log(`오류 ${errors.length}건`); process.exit(1); }
const total = reserve.rounds.reduce((a, r) => a + Object.values(r.items).flat().length, 0);
console.log(`오류 없음 · 예약 ${reserve.rounds.length}회분 · 단위 ${total}개`);
