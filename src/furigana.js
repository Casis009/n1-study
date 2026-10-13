/* 후리가나 정렬: 표제어(〜を禁じ得ない)와 읽기(〜をきんじえない)를 맞춰 한자 덩어리마다 읽기를 붙인다.
   DOM을 쓰지 않아 검사 도구(tools/*.mjs)도 같은 함수로 reading이 맞는지 확인한다. */
const KANJI = /[一-龯々〆ヶ]/;
export const hasKanji = s => KANJI.test(s || "");

/* text를 한자 덩어리 / 그 밖으로 나눈 뒤, 한자 덩어리는 (.+?), 나머지는 그대로 맞춰 본다.
   → [{ t: "禁", r: "きん" }, { t: "じ" }, ...] · 맞지 않으면 null (화면은 표제어 뒤 （읽기）로 대신) */
export function rubyParts(text, reading){
  if (!text || !hasKanji(text) || !reading) return null;
  const runs = text.match(/[一-龯々〆ヶ]+|[^一-龯々〆ヶ]+/g);
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = reading.match(new RegExp("^" + runs.map(r => KANJI.test(r) ? "(.+?)" : esc(r)).join("") + "$"));
  if (!m) return null;
  let g = 1;
  return runs.map(r => KANJI.test(r) ? { t: r, r: m[g++] } : { t: r });
}

/* 문법 항목 { pattern, reading } 검사: 한자가 있으면 reading 필수·한자 없음·표제어와 정렬돼야. 없으면 "" */
export function readingErr(o){
  if (typeof o.reading !== "string") return "reading 없음";
  if (!hasKanji(o.pattern)) return o.reading ? "한자가 없는데 reading이 있음" : "";
  if (!o.reading) return "한자가 있는데 reading 없음";
  if (hasKanji(o.reading)) return `reading에 한자가 있음: ${o.reading}`;
  return rubyParts(o.pattern, o.reading) ? "" : `reading이 표제어와 맞지 않음: ${o.reading}`;
}
