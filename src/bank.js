/*
 * 문제은행: 기본 은행(data/bank/*.json) + 기기 은행(localBank: AI로 만든 문제, 내 문제).
 * 출제 단위(unit): 문항형 유형은 문제 1개, 지문형 유형은 지문 1개 + 딸린 문항.
 * 복습: 틀리거나 "찍어서 맞힘"으로 저장하면 1일 → 3일 → 7일 → 14일 뒤 다시 내고, 14일 복습까지 맞히면 졸업.
 */
import { KINDS } from "./kinds.js";
import { db } from "./db.js";
import { prepSet } from "./sets.js";

export const REVIEW_DAYS = [1, 3, 7, 14];
const DAY = 86400000;
const isUnitKind = kind => !!KINDS[kind]?.counts;          // 문항형: 문제 1개가 단위

let index = { kinds: {} };
const files = new Map();                                    // kind → 기본 은행 units
export const state = { progress: new Map(), local: [], tags: new Map() };

export async function loadIndex(){
  try { const r = await fetch("./data/bank/index.json"); if (r.ok) index = await r.json(); } catch {}
  return index;
}
export async function loadBankState(){
  const [p, l, t] = await Promise.all([db.all("progress"), db.all("localBank"), db.all("tagStats")]);
  state.progress = new Map(p.map(x => [x.id, x]));
  state.local = l.sort((a, b) => b.at - a.at);
  state.tags = new Map(t.map(x => [x.id, x]));
}

function unitIds(kind){
  return [...(index.kinds[kind]?.ids || []), ...state.local.filter(r => r.kind === kind).map(r => r.id)];
}
function status(id, now){
  const p = state.progress.get(id);
  if (!p) return "new";
  if (p.due != null) return p.due <= now ? "due" : "wait";
  return "done";
}
/* 유형별 남은 수(안 푼 단위) / 전체 / 지금 복습할 것 / 다음 복습 시각 */
export function bankCounts(kind, now = Date.now()){
  const c = { total: 0, left: 0, due: 0, wait: 0, nextDue: null, unit: isUnitKind(kind) ? "문항" : "세트" };
  for (const id of unitIds(kind)){
    c.total++;
    const s = status(id, now);
    if (s === "new") c.left++;
    else if (s === "due") c.due++;
    else if (s === "wait"){ c.wait++; const d = state.progress.get(id).due; if (c.nextDue == null || d < c.nextDue) c.nextDue = d; }
  }
  return c;
}

async function loadUnits(kind){
  if (!files.has(kind)){
    const f = index.kinds[kind]?.file;
    let units = [];
    if (f){ const r = await fetch("./data/bank/" + f); if (!r.ok) throw new Error("문제은행 파일을 읽지 못했어요. 인터넷 연결을 확인하세요."); units = (await r.json()).units || []; }
    files.set(kind, units);
  }
  return [...files.get(kind), ...state.local.filter(r => r.kind === kind).map(r => ({ ...r.unit, id: r.id, source: r.source }))];
}
const shuffle = a => { for (let i = a.length - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/* 출제: 안 푼 것(무작위) → 복습 시각이 지난 것(오래된 순). force면 가장 오래전에 푼 것부터. */
export async function pickSet(kind, count, { force = false } = {}){
  const now = Date.now();
  const units = await loadUnits(kind);
  let order;
  if (!force){
    const fresh = shuffle(units.filter(u => status(u.id, now) === "new"));
    const due = units.filter(u => status(u.id, now) === "due").sort((a, b) => state.progress.get(a.id).due - state.progress.get(b.id).due);
    order = [...fresh, ...due];
  } else order = [...units].sort((a, b) => (state.progress.get(a.id)?.lastAt || 0) - (state.progress.get(b.id)?.lastAt || 0));
  if (!order.length) return null;
  return buildSet(kind, isUnitKind(kind) ? order.slice(0, count) : order.slice(0, 1));
}
export function buildSet(kind, units){
  const k = KINDS[kind];
  let raw;
  if (isUnitKind(kind)){
    const qs = shuffle(units.flatMap(u => u.questions.map(q => ({ ...q, unitId: u.id }))));
    raw = { kind, title: `${k.label} ${qs.length}문항`, topic: "", passage: "", questions: qs };
  } else {
    const u = units[0];
    raw = { kind, title: u.title, topic: u.topic, passage: u.passage, questions: u.questions.map(q => ({ ...q, unitId: u.id })) };
  }
  const set = prepSet(structuredClone(raw), { shuffle: true, fallbackKind: kind });
  set.bank = true; set.recorded = {}; set.snap = {};
  set.review = units.some(u => state.progress.get(u.id)?.due != null);
  return set;
}

/* 특정 패턴(patternTags) 문제만 출제: 그 패턴 문제가 가장 많은 유형에서, 안 푼 것 → 복습 → 오래전에 푼 것 순. */
function tagUnits(tag){
  const byKind = new Map();
  for (const [kind, v] of Object.entries(index.kinds)) if (v.tags?.[tag]?.length) byKind.set(kind, new Set(v.tags[tag]));
  for (const r of state.local) if (r.unit.questions?.some(q => q.patternTags?.includes(tag))){
    if (!byKind.has(r.kind)) byKind.set(r.kind, new Set());
    byKind.get(r.kind).add(r.id);
  }
  return byKind;
}
export function tagUnitCount(tag){ let n = 0; for (const ids of tagUnits(tag).values()) n += ids.size; return n; }
export async function pickByTag(tag, count = 5){
  const byKind = tagUnits(tag);
  if (!byKind.size) return null;
  const [kind, ids] = [...byKind].sort((a, b) => b[1].size - a[1].size)[0];
  const now = Date.now(), rank = u => ({ new: 0, due: 1 }[status(u.id, now)] ?? 2);
  const order = shuffle((await loadUnits(kind)).filter(u => ids.has(u.id)))
    .sort((a, b) => rank(a) - rank(b) || (state.progress.get(a.id)?.lastAt || 0) - (state.progress.get(b.id)?.lastAt || 0));
  const set = buildSet(kind, isUnitKind(kind) ? order.slice(0, count) : order.slice(0, 1));
  set.focusTag = tag;
  return set;
}

/* 결과 기록. 같은 세트에서 "찍어서 맞힘" 저장/취소로 결과가 바뀌면 처음 상태(snap)에서 다시 계산한다. */
function nextProgress(prev, id, kind, ok, now){
  const p = prev ? { ...prev } : { id, kind, seen: 0, wrong: 0, step: -1, due: null };
  p.seen++; p.lastAt = now;
  if (!ok){ p.wrong++; p.step = 0; p.due = now + REVIEW_DAYS[0] * DAY; }
  else if (p.due != null){
    p.step++;
    if (p.step >= REVIEW_DAYS.length){ p.due = null; p.graduated = true; }
    else p.due = now + REVIEW_DAYS[p.step] * DAY;
  }
  return p;
}
const qOk = q => q.sel === q.answer && !q.saved;
export async function recordSet(set){
  if (!set.bank) return;
  const now = Date.now(), byUnit = new Map();
  for (const q of set.questions) if (q.unitId){ if (!byUnit.has(q.unitId)) byUnit.set(q.unitId, []); byUnit.get(q.unitId).push(q); }
  const rows = [];
  for (const [id, qs] of byUnit){
    const ok = qs.every(qOk), res = ok ? "ok" : "ng";
    if (set.recorded[id] === res) continue;
    if (!(id in set.snap)) set.snap[id] = state.progress.get(id) || null;
    const p = nextProgress(set.snap[id], id, set.kind, ok, now);
    state.progress.set(id, p); rows.push(p);
    set.recorded[id] = res;
  }
  if (rows.length) await db.putMany("progress", rows);
  await recordTags(set);
}

/* 패턴별 통계: 문항마다 출제 1회, 틀림(찍어서 맞힘 포함) 1회. 세트가 끝난 뒤 결과가 바뀌면 차이만 반영. */
async function recordTags(set){
  const group = KINDS[set.kind]?.group || "";
  const changed = new Map();
  set.questions.forEach(q => {
    const tags = q.patternTags || [];
    if (!tags.length) return;
    const was = q.tagged, now = qOk(q) ? "ok" : "ng";
    if (was === now) return;
    for (const t of tags){
      const r = changed.get(t) || state.tags.get(t) || { id: t, group, seen: 0, wrong: 0 };
      if (!was) r.seen++;
      r.wrong += (now === "ng" ? 1 : 0) - (was === "ng" ? 1 : 0);
      r.lastAt = Date.now(); r.group = group;
      changed.set(t, r);
    }
    q.tagged = now;
  });
  for (const r of changed.values()) state.tags.set(r.id, r);
  if (changed.size) await db.putMany("tagStats", [...changed.values()]);
}
export function tagList({ group = null } = {}){
  return [...state.tags.values()].filter(t => !group || t.group === group)
    .sort((a, b) => b.wrong - a.wrong || b.seen - a.seen || a.id.localeCompare(b.id, "ja"));
}

/* 기기 은행: AI 문제·내 문제 추가 */
const newId = p => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export function splitUnits(kind, raw){
  const base = { title: raw.title || "", topic: raw.topic || "", passage: raw.passage || "" };
  return isUnitKind(kind) ? (raw.questions || []).map(q => ({ ...base, passage: "", questions: [q] })) : [{ ...base, questions: raw.questions || [] }];
}
export async function addLocalUnits(kind, units, source){
  const rows = units.map(u => ({ id: newId(source), kind, source, at: Date.now(), unit: u }));
  await db.putMany("localBank", rows);
  state.local = [...rows, ...state.local];
  return rows;
}
export async function removeLocal(id){
  state.local = state.local.filter(r => r.id !== id);
  await db.del("localBank", id);
}
