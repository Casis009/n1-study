// 문법 단어장 예문의 빈칸 위치(오늘의 시험 문법 문제). rank-vocab.mjs와 check-vocab.mjs가 같이 쓴다.
// 1) 항목에 blank(예문 속 문자열)가 있으면 그 위치를 쓴다. 활용이 커서 자동으로 못 찾는 문법용(예: 〜めく → "めいて").
// 2) 없으면 자동: 패턴에서 〜와 (괄호)를 뺀 조각을 앞에서부터 가장 길게 맞춰 보고(앞부분 절반 이상),
//    활용으로 끝이 달라진 경우(余儀なくされる → 余儀なくされた)는 뒤따르는 히라가나 4자까지 넓힌다.
// 돌려주는 값: { range: [시작, 끝] | null, manual, error }  error = blank가 예문에 없음
export const cores = p => p.replace(/[（(][^）)]*[）)]/g, "").split("〜").map(s => s.trim()).filter(Boolean);
const HIRA = /[ぁ-ゟ]/;

export function blankOf(it){
  const ex = it.example || "";
  if (it.blank != null){
    const at = typeof it.blank === "string" && it.blank ? ex.indexOf(it.blank) : -1;
    return at < 0 ? { range: null, manual: true, error: `blank「${it.blank}」가 예문에 없음` } : { range: [at, at + it.blank.length], manual: true };
  }
  for (const seg of cores(it.pattern || "").sort((x, y) => y.length - x.length)){
    for (let len = seg.length; len >= Math.max(2, Math.ceil(seg.length * 0.5)); len--){
      const at = ex.indexOf(seg.slice(0, len));
      if (at < 0) continue;
      let end = at + len;
      if (len < seg.length) for (let k = 0; k < 4 && end < ex.length && HIRA.test(ex[end]); k++) end++;   // 활용 어미
      return { range: [at, end], manual: false };
    }
  }
  return { range: null, manual: false };
}
