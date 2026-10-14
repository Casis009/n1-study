/*
 * 데일리 학습: 오늘 할 양을 규칙으로 정한다. AI 호출 없이 기기 안 데이터만으로, 오프라인에서도 같은 결과.
 *
 * 입력: 하루 학습 시간(설정 30/60/90분), 시험까지 남은 일수, 파트별 정답률(풀이 기록), 유형별 남은 수·복습할 수(문제은행),
 *      오늘 복습할 카드 수, 최근 모의고사 날짜.
 *
 * 배분 순서
 *  1) 카드·시험 시간 먼저 뺀다: 새 단어·문법 카드 + 복습 카드 × 12초 + 오늘의 시험 5분.
 *     단, 문제 풀 시간이 하루 시간의 절반보다 적어지지 않게 한다(카드가 많은 날은 카드 시간이 넘쳐도 문제 시간은 절반 확보).
 *  2) 복습할 문제를 먼저 넣는다: 복습 기한이 지난 단위를 정답률이 낮은 파트부터, 시간이 남는 만큼.
 *  3) 남은 시간을 파트별로 나눈다. 가중치 = ((1 − 정답률) + 0.2) × 진도 계수.
 *     - 정답률은 풀이 기록의 맞힌 비율. 기록이 없는 파트는 50%로 친다. 0.2는 잘하는 파트도 손을 놓지 않게 하는 바닥값.
 *     - 진도 계수 = 0.5 + 0.5 × (이 파트의 하루 필요량 ÷ 파트 중 가장 큰 하루 필요량).
 *       하루 필요량 = 안 푼 문항 수 ÷ 남은 일수. 남은 문제가 많은 파트일수록 1에 가깝고, 다 푼 파트는 0(배분 없음).
 *  4) 파트 안에서는 안 푼 문제가 많은 유형부터 한 덩어리씩 돌아가며 채운다(문항형 5문항·청해 課題·ポイント 3문항, 지문형 1세트).
 *     남은 시간이 반 덩어리 이상일 때만 한 덩어리를 더 넣는다.
 *  5) 시험 14일 전부터는 최근 7일 안에 모의고사를 안 봤고 남은 회차가 있으면 [모의고사]를 추천한다(시간 예산과 따로).
 *
 * 문항당 예상 시간(분)은 아래 MIN_PER_UNIT. 지문형은 세트(단위) 하나 기준.
 * 계획은 그날 처음 열 때 한 번 정해서 저장하고(daily 스토어), 하루 학습 시간을 바꾸면 그날 계획을 다시 계산한다.
 */
import { KINDS } from "./kinds.js";

export const DAILY_OPTIONS = [30, 60, 90];
/* 하루 학습 시간 → 새 카드 수 */
export const NEW_CARDS = { 30: { words: 15, grammar: 3 }, 60: { words: 25, grammar: 5 }, 90: { words: 35, grammar: 7 } };
export const CARD_SEC = 12, TEST_MIN = 5;
export const MIN_PER_UNIT = {
  kanji_reading: 0.5, context: 0.6, paraphrase: 0.6, usage: 1, grammar_blank: 0.8, grammar_order: 1.5,
  text_grammar: 8, reading_short: 4, reading_mid: 8, reading_long: 12, integrated: 10, info_search: 7,
  listen_task: 3, listen_point: 3, listen_quick: 0.6,
};
const GROUPS = ["문자·어휘", "문법", "독해", "청해"];
const chunkOf = k => KINDS[k]?.counts?.[0] || 1;              // 문항형은 그 유형의 작은 세트 크기(5, 청해 課題·ポイント는 3), 지문형은 1세트

/* 한국 날짜 "YYYY-MM-DD" */
export const dayKey = (t = Date.now()) => new Date(t).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
export const addDays = (key, n) => dayKey(new Date(key + "T12:00:00+09:00").getTime() + n * 86400000);

/*
 * in = { minutes, daysLeft, acc: { 그룹: 0~1 | null }, counts: { kind: { left, due, qPerUnit } }, dueCards, lastMockAt, mockLeft, now }
 * out = { minutes, cards: { words, grammar, due, min }, testMin, parts: [{ kind, group, units, questions, review, min }], mock, budget }
 */
export function planDay(inp){
  const total = inp.minutes;
  const nc = NEW_CARDS[total] || NEW_CARDS[60];
  const cardMin = (nc.words + nc.grammar + (inp.dueCards || 0)) * CARD_SEC / 60;
  let budget = Math.max(total / 2, total - cardMin - TEST_MIN);
  const accOf = g => inp.acc[g] ?? 0.5;
  const kindsOf = g => Object.keys(KINDS).filter(k => KINDS[k].group === g && inp.counts[k]);
  const plan = new Map();                                   // kind → { units, review }
  const add = (k, units, review) => { const p = plan.get(k) || { units: 0, review: 0 }; p.units += units; if (review) p.review += units; plan.set(k, p); };

  /* 2) 복습 먼저: 정답률 낮은 파트부터 */
  for (const g of [...GROUPS].sort((a, b) => accOf(a) - accOf(b)))
    for (const k of kindsOf(g)){
      const c = inp.counts[k], per = MIN_PER_UNIT[k] || 1;
      const n = Math.min(c.due, Math.floor(budget / per));
      if (n > 0){ add(k, n, true); budget -= n * per; }
    }

  /* 3) 남은 시간을 파트 가중치로 */
  const leftQ = g => kindsOf(g).reduce((a, k) => a + inp.counts[k].left * (inp.counts[k].qPerUnit || 1), 0);
  const need = Object.fromEntries(GROUPS.map(g => [g, leftQ(g) / Math.max(1, inp.daysLeft)]));
  const maxNeed = Math.max(...Object.values(need), 0);
  const weight = Object.fromEntries(GROUPS.map(g => [g, need[g] > 0 ? ((1 - accOf(g)) + 0.2) * (0.5 + 0.5 * need[g] / maxNeed) : 0]));
  const wsum = Object.values(weight).reduce((a, b) => a + b, 0);
  if (wsum > 0 && budget > 0){
    const pool = budget;
    for (const g of GROUPS){
      let share = pool * weight[g] / wsum;
      /* 4) 파트 안: 안 푼 문제가 많은 유형부터, 덩어리 단위 */
      const kinds = kindsOf(g).filter(k => inp.counts[k].left > 0).sort((a, b) => inp.counts[b].left - inp.counts[a].left);
      const taken = new Map();
      for (let moved = true; moved && share > 0;){          // 한 덩어리씩 돌아가며(한 유형에 몰리지 않게)
        moved = false;
        for (const k of kinds){
          const per = MIN_PER_UNIT[k] || 1, ch = chunkOf(k), room = inp.counts[k].left - (taken.get(k) || 0);
          const n = Math.min(ch, room);
          if (n <= 0 || share < per * n * 0.5) continue;    // 반 덩어리 이상 남았을 때만
          taken.set(k, (taken.get(k) || 0) + n); share -= n * per; budget -= n * per; moved = true;
          if (share <= 0) break;
        }
      }
      for (const [k, n] of taken) add(k, n, false);
    }
  }
  const parts = [...plan].map(([kind, p]) => ({ kind, group: KINDS[kind].group, units: p.units, review: p.review,
    questions: Math.round(p.units * (inp.counts[kind].qPerUnit || 1)), min: Math.round(p.units * (MIN_PER_UNIT[kind] || 1)) }))
    .sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));

  /* 5) 모의고사 추천 */
  const weekAgo = (inp.now || Date.now()) - 7 * 86400000;
  const mock = inp.daysLeft <= 14 && inp.daysLeft >= 0 && inp.mockLeft > 0 && !(inp.lastMockAt && inp.lastMockAt >= weekAgo);
  return { minutes: total, cards: { words: nc.words, grammar: nc.grammar, due: inp.dueCards || 0, min: Math.round(cardMin) }, testMin: TEST_MIN, parts, mock, budget: Math.round(budget) };
}

/* 연속 학습일: 오늘(끝냈으면) 또는 어제부터 거꾸로, 하루 계획을 다 끝낸 날이 이어진 수 */
export function streak(doneDays, today = dayKey()){
  let d = doneDays.has(today) ? today : addDays(today, -1), n = 0;
  while (doneDays.has(d)){ n++; d = addDays(d, -1); }
  return n;
}

/*
 * 기기 간 동기화에서 같은 날짜의 daily 행 합치기(통째로 덮어쓰지 않는다). 순서와 상관없이 같은 결과가 나오게.
 * - 계획(plan): 하루 학습 시간이 다르면 나중에 정한 것(설정을 바꾼 것), 같으면 먼저 만든 것
 * - 카드 덱: 먼저 만든 기기의 덱(ids·newIds)을 기준으로, 넘긴 기록(swiped)은 양쪽을 합침(덱에 있는 카드만, 같은 카드는 한 번)
 * - 오늘의 시험: 있는 쪽, 둘 다면 먼저 본 것 / 완료 시각: 이른 쪽
 */
export function mergeDaily(a, b){
  if (!a) return b; if (!b) return a;
  const pa = a.planAt || 0, pb = b.planAt || 0;
  const planFrom = a.plan && b.plan && a.plan.minutes !== b.plan.minutes ? (pa >= pb ? a : b) : (pa && (pa <= pb || !pb) ? a : b);
  const out = { ...a, plan: planFrom.plan || a.plan || b.plan, planAt: planFrom.planAt || pa || pb, done: { ...(b.done || {}), ...(a.done || {}) } };
  const cards = {};
  for (const deck of new Set([...Object.keys(a.cards || {}), ...Object.keys(b.cards || {})])){
    const x = a.cards?.[deck], y = b.cards?.[deck];
    if (!x || !y){ cards[deck] = x || y; continue; }
    const ka = x.createdAt || Infinity, kb = y.createdAt || Infinity;           // 먼저 만든 덱(시각이 같으면 ids 문자열 순)
    const [base, other] = ka < kb || (ka === kb && JSON.stringify(x.ids) <= JSON.stringify(y.ids)) ? [x, y] : [y, x];
    const inDeck = new Set(base.ids), seen = new Set(), swiped = [];
    for (const s of [...base.swiped, ...other.swiped]) if (inDeck.has(s.id) && !seen.has(s.id)){ seen.add(s.id); swiped.push(s); }
    cards[deck] = { ...base, swiped };
  }
  if (Object.keys(cards).length) out.cards = cards;
  out.test = a.test && b.test ? (a.test.at <= b.test.at ? a.test : b.test) : (a.test || b.test || null);
  out.completedAt = [a.completedAt, b.completedAt].filter(Boolean).sort((p, q) => p - q)[0] || null;
  return out;
}
