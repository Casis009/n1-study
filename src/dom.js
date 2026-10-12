/* 작은 DOM 도우미. 모델 출력은 항상 textContent로 넣어서 HTML 주입을 막는다. */
export function h(tag, attrs, ...children){
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)){
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)){
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : String(c));
  }
  return el;
}

export const $ = id => document.getElementById(id);

/* localStorage: 설정처럼 작은 값만. 실패해도 앱은 동작해야 한다. */
export const prefs = {
  get(k, d){ try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};

export function fmtTime(ms){
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
