/*
 * 실전 모의고사: data/exam.json(대문 구성·시간·합격 기준·출처) + data/exam-reserve.json(회차별 예약 단위, tools/pick-exam.mjs가 만듦).
 * - 예약 단위는 연습·문제집·패턴 출제에 나오지 않는다(bank.setReserved). 그 회차 시험을 끝내면 예약을 풀어 돌려준다.
 * - 시간: 기본 "문항 수 비례" = 공식 시간 × 앱 문항 수 ÷ 공식 문항 수(건너뛴 대문 포함). 시작 화면에서 "공식 시간"을 고를 수 있다.
 * - 점수: 언어지식·독해·청해를 각각 맞힌 비율 × 60 (공식 점수는 문항별 배점·등화를 거치므로 이 값은 추정).
 */
import { setFromIds } from "./bank.js";

export let EXAM_CFG = null;
let reserve = { rounds: [] };

export async function loadExam(){
  try {
    const [c, r] = await Promise.all([fetch("./data/exam.json"), fetch("./data/exam-reserve.json")]);
    if (c.ok) EXAM_CFG = await c.json();
    if (r.ok) reserve = await r.json();
  } catch {}
  return EXAM_CFG;
}
export const examRounds = () => reserve.rounds.map(r => r.no);
export const itemKey = (sec, it) => `${sec.id}-${it.no}`;
/* 아직 예약 중인 단위 id (released: 끝낸 회차 번호 Set) */
export function reservedIds(released){
  return reserve.rounds.filter(r => !released.has(r.no)).flatMap(r => Object.values(r.items).flat());
}
const officialQn = sec => sec.items.reduce((a, it) => a + it.official, 0);

/* 교시 하나: 대문 순서대로 문항을 이어 붙인 세트. 문항마다 kind·dai(대문 번호)·score(lang/read/listen)·unitId */
export async function buildSection(no, sec){
  const round = reserve.rounds.find(r => r.no === no);
  if (!round) throw new Error("예약 회차를 찾지 못했어요.");
  const questions = [], passages = {}, items = [];
  for (const it of sec.items){
    const row = { no: it.no, jp: it.jp, kind: it.kind, official: it.official, note: it.note || "", score: it.score, n: 0 };
    items.push(row);
    if (!it.kind) continue;                                   // 앱에 없는 유형 → 건너뜀
    const set = await setFromIds(it.kind, round.items[itemKey(sec, it)] || [], { keepOrder: true });
    if (!set) continue;
    for (const q of set.questions) questions.push(Object.assign(q, { kind: it.kind, dai: it.no, score: it.score, exam: true }));
    Object.assign(passages, set.passages || {});
    row.n = set.questions.length;
  }
  return { id: sec.id, label: sec.label, questions, passages, items, officialQn: officialQn(sec), officialMin: sec.minutes, pos: 0, flags: [], ends: null };
}
export const sectionMinutes = (s, timing) => timing === "official" ? s.officialMin : Math.max(1, Math.round(s.officialMin * s.questions.length / s.officialQn));

/* 결과: 과목별 0~60 환산(추정), 총점, 합격 판정, 대문별 정답률 */
export function scoreExam(row){
  const cfg = EXAM_CFG, by = { lang: [0, 0], read: [0, 0], listen: [0, 0] }, dai = [];
  for (const s of Object.values(row.sections)){
    for (const it of s.items){
      const qs = s.questions.filter(q => q.dai === it.no), right = qs.filter(q => q.sel === q.answer).length;
      dai.push({ section: s.id, no: it.no, jp: it.jp, note: it.note, official: it.official, total: qs.length, right });
      if (by[it.score]){ by[it.score][0] += right; by[it.score][1] += qs.length; }
    }
  }
  const max = cfg?.pass.sectionMax ?? 60;
  const scores = Object.fromEntries(Object.entries(by).map(([k, [r, t]]) => [k, { right: r, total: t, scaled: t ? Math.round(r / t * max) : null }]));
  const total = Object.values(scores).reduce((a, x) => a + (x.scaled || 0), 0);
  const sectionOk = Object.values(scores).every(x => x.scaled != null && x.scaled >= (cfg?.pass.sectionMin ?? 19));
  return { scores, total, max: cfg?.pass.max ?? 180, pass: total >= (cfg?.pass.total ?? 100) && sectionOk, sectionOk, dai, at: Date.now() };
}
