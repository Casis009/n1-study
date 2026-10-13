/* 읽어주기: 브라우저 내장 Web Speech API(speechSynthesis, ja-JP). 외부 API·비용 없음.
   한 번에 하나만 재생: 새로 읽으면 이전 재생은 멈추고 그 onEnd가 불린다. */
const synth = typeof speechSynthesis !== "undefined" ? speechSynthesis : null;
let voices = [];
const watchers = new Set();
function loadVoices(){
  const list = synth ? synth.getVoices().filter(v => /^ja([-_]|$)/i.test(v.lang)) : [];
  const changed = list.length !== voices.length;
  voices = list;
  if (changed) watchers.forEach(f => f());
}
if (synth){ loadVoices(); synth.addEventListener?.("voiceschanged", loadVoices); setTimeout(loadVoices, 800); }

export const jaVoices = () => voices;
export const ttsReady = () => { if (!voices.length) loadVoices(); return voices.length > 0; };
export const onVoices = f => watchers.add(f);
export const RATES = [0.7, 0.85, 1.0];
const opts = { rate: 0.85, voice: "" };
export function setTtsOpts(o){ if (RATES.includes(o.rate)) opts.rate = o.rate; if (typeof o.voice === "string") opts.voice = o.voice; }

let token = 0, active = null;
const finish = () => { const a = active; active = null; a?.onEnd?.(); };
export function stopSpeak(){ token++; synth?.cancel(); finish(); }
export const speaking = () => !!active;

/* 읽기 전에 정리: 밑줄 표시(__), 빈칸 번호（１）, 〜 기호는 읽지 않는다 */
const clean = t => String(t || "").replace(/__/g, "").replace(/（[１-９]）/g, "").replace(/〜/g, "").trim();

/* texts(문자열 또는 배열)를 차례로 읽는다. onEach(i): i번째를 읽기 시작할 때, onEnd(): 다 읽었거나 멈췄을 때 */
export function speak(texts, { onEach, onEnd } = {}){
  stopSpeak();
  if (!synth || !ttsReady()) return false;
  const list = (Array.isArray(texts) ? texts : [texts]).map(clean);
  const voice = voices.find(v => v.voiceURI === opts.voice) || voices.find(v => /^ja[-_]JP$/i.test(v.lang)) || voices[0];
  const my = ++token;
  active = { onEnd };
  let i = 0;
  const next = () => {
    if (my !== token) return;
    while (i < list.length && !list[i]) i++;
    if (i >= list.length){ finish(); return; }
    const u = new SpeechSynthesisUtterance(list[i]), idx = i;
    Object.assign(u, { lang: "ja-JP", voice, rate: opts.rate });
    u.onstart = () => { if (my === token) onEach?.(idx); };
    u.onend = u.onerror = () => { if (my === token){ i = idx + 1; next(); } };
    synth.speak(u);
  };
  next();
  return true;
}
