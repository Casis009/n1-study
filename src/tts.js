/* 읽어주기: 브라우저 내장 Web Speech API(speechSynthesis, ja-JP). 외부 API·비용 없음.
   한 번에 하나만 재생: 새로 읽으면 이전 재생은 멈추고 그 onEnd가 불린다.
   청해: 화자(M 남 / F 여 / N 내레이션)마다 다른 음성. 남·여 음성을 못 찾으면 pitch로 구분. */
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

/* 음성 이름으로 성별 추정 (기기마다 이름이 다름: Windows Ayumi/Haruka/Ichiro, macOS·iOS Kyoko/Otoya, Android·Chrome "Google 日本語" 등) */
const FEMALE = /female|女|kyoko|haruka|ayumi|nanami|sayaka|mizuki|aoi|shiori|mayu|hikari|o-ren|nozomi|naoko|mei|sakura/i;
const MALE = /\bmale|男|ichiro|otoya|keita|daichi|naoki|hattori|takumi|kenji|hiroshi|shun|kazuki|ryo/i;
const gender = v => FEMALE.test(v.name) && !/\bmale\b/i.test(v.name) ? "F" : MALE.test(v.name) ? "M" : "";
const baseVoice = () => voices.find(v => v.voiceURI === opts.voice) || voices.find(v => /^ja[-_]JP$/i.test(v.lang)) || voices[0];

/* 화자 → { voice, pitch }: 남·여 음성이 다 있으면 각각, 한쪽만 있으면 다른 음성(성별 모름)으로 짝,
   음성이 하나뿐이면 같은 음성에 pitch 차이(남 0.75 · 여 1.3). 내레이션은 설정에서 고른 음성 */
export function voiceFor(speaker){
  const base = baseVoice();
  if (speaker !== "M" && speaker !== "F") return { voice: base, pitch: 1 };
  const pickOf = g => { const list = voices.filter(v => gender(v) === g); return list.includes(base) ? base : list[0] || null; };
  let F = pickOf("F"), M = pickOf("M");
  const spare = voices.filter(v => v !== F && v !== M && !gender(v));
  if (F && !M) M = spare[0] || null;
  else if (M && !F) F = spare[0] || null;
  else if (!F && !M && voices.length > 1){ F = voices[0]; M = voices[1]; }
  const voice = speaker === "M" ? M : F;
  return voice ? { voice, pitch: 1 } : { voice: base, pitch: speaker === "M" ? 0.75 : 1.3 };
}
/* 남·여가 실제로 다른 음성인지 (설정 화면 안내용) */
export const speakerSplit = () => voiceFor("M").voice !== voiceFor("F").voice ? "voice" : "pitch";

let token = 0, active = null;
const finish = () => { const a = active; active = null; a?.onEnd?.(); };
export function stopSpeak(){ token++; synth?.cancel(); finish(); }
export const speaking = () => !!active;

/* 읽기 전에 정리: 밑줄 표시(__), 빈칸 번호（１）, 〜 기호는 읽지 않는다 */
const clean = t => String(t || "").replace(/__/g, "").replace(/（[１-９]）/g, "").replace(/〜/g, "").trim();

/* items: 문자열, 또는 { text, speaker, pause(ms, 읽은 뒤 쉼) }의 배열. 차례로 읽는다.
   onEach(i): i번째를 읽기 시작할 때, onEnd(): 다 읽었거나 멈췄을 때 */
export function speak(items, { onEach, onEnd } = {}){
  stopSpeak();
  if (!synth || !ttsReady()) return false;
  const list = (Array.isArray(items) ? items : [items]).map(x => typeof x === "string" ? { text: clean(x) } : { ...x, text: clean(x.text) });
  const my = ++token;
  active = { onEnd };
  let i = 0;
  const next = () => {
    if (my !== token) return;
    while (i < list.length && !list[i].text) i++;
    if (i >= list.length){ finish(); return; }
    const it = list[i], idx = i;
    const { voice, pitch } = voiceFor(it.speaker);
    const u = new SpeechSynthesisUtterance(it.text);
    Object.assign(u, { lang: "ja-JP", voice, pitch, rate: opts.rate });
    u.onstart = () => { if (my === token) onEach?.(idx); };
    u.onend = u.onerror = () => {
      if (my !== token) return;
      i = idx + 1;
      it.pause ? setTimeout(next, it.pause) : next();
    };
    synth.speak(u);
  };
  next();
  return true;
}
