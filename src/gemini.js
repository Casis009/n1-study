/*
 * Gemini API 호출 (Google AI Studio 키). 키는 이 기기의 localStorage에만 있고 Google로만 전송된다.
 * 무료 등급 한도는 프로젝트·모델 단위이며 미국 태평양 시간 자정에 초기화된다.
 */
import { prefs } from "./dom.js";
import { parseLoose } from "./sets.js";

export const DEFAULT_MODEL = "gemini-2.5-flash";

const ptDay = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
export function callsToday(){ const c = prefs.get("n1.calls", {}); return c.day === ptDay() ? c.n : 0; }
function bumpCalls(){ prefs.set("n1.calls", { day: ptDay(), n: callsToday() + 1 }); }

/* 다음 태평양 시간 자정을 한국 시간으로 */
export function resetTimeKST(){
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(now);
    const hh = Number(parts.find(p => p.type === "hour").value), mm = Number(parts.find(p => p.type === "minute").value);
    const t = new Date(now.getTime() + (1440 - (hh * 60 + mm)) * 60000);
    return t.toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour: "numeric", minute: "2-digit" });
  } catch { return "오후 4~5시"; }
}

export async function callGemini(prompt, { key, model, signal }){
  key = (key || "").trim();
  model = (model || DEFAULT_MODEL).trim();
  if (!key) throw new Error("설정 탭에서 Gemini API 키를 먼저 입력하세요.");
  let res;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 1 }
      })
    });
  } catch (e){
    if (e && e.name === "AbortError") throw e;
    throw new Error(navigator.onLine === false ? "오프라인이에요. 새 문제는 인터넷이 연결됐을 때 만들 수 있어요. 오답노트와 단어장은 오프라인에서도 볼 수 있어요." : "Google 서버에 연결하지 못했어요. 인터넷 연결을 확인하세요.");
  }
  bumpCalls();
  if (!res.ok){
    let msg = "";
    try { msg = (await res.json()).error?.message || ""; } catch {}
    if (res.status === 429) throw new Error(`요청 한도에 걸렸어요. 분당 한도라면 1분 뒤에, 하루 한도라면 ${resetTimeKST()} 이후에 다시 시도하세요.`);
    if (res.status === 400 && /api key/i.test(msg)) throw new Error("API 키가 올바르지 않아요. 설정에서 키를 다시 확인하세요.");
    if (res.status === 403) throw new Error("이 키로는 해당 모델을 쓸 수 없어요. 키 제한(웹사이트·API 제한) 설정이나 모델 이름을 확인하세요.");
    if (res.status === 404) throw new Error(`모델 "${model}"을 찾지 못했어요. 설정에서 모델 이름을 확인하세요.`);
    throw new Error(`Gemini 오류 (${res.status}) ${msg}`.trim());
  }
  const data = await res.json();
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).map(p => p.text || "").join("");
  if (!text) throw new Error(cand?.finishReason === "SAFETY" ? "응답이 안전 필터에 걸렸어요. 주제를 바꿔 보세요." : "빈 응답이 왔어요. 다시 시도하세요.");
  return parseLoose(text);
}
