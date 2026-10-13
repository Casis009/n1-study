/*
 * 오프라인용 서비스 워커.
 * 앱 파일은 캐시해서 오프라인에서도 열리게 하고(오답노트·단어장 열람), Gemini API 요청은 절대 캐시하지 않는다.
 * 문제은행·기본 단어장(data/bank, data/vocab의 index.json에 적힌 파일)도 설치 때 캐시해서 오프라인에서 풀 수 있게 한다.
 * 앱 파일이나 문제은행을 고치면 VERSION을 올려야 사용자 기기에 새 버전이 반영된다.
 */
const VERSION = "n1-study-v56";
const SHELL = [
  "./", "./index.html", "./manifest.webmanifest",
  "./src/styles.css", "./src/main.js", "./src/dom.js", "./src/db.js", "./src/sets.js",
  "./src/prompt.js", "./src/gemini.js", "./src/kinds.js", "./src/samples.js", "./src/interview.js", "./src/keigo.js", "./src/bank.js", "./src/vocab.js",
  "./icons/icon.svg", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png", "./icons/apple-touch-icon.png",
  "./data/bank/index.json", "./data/vocab/index.json"
];
async function cacheData(c){   // 문제은행·기본 단어장: index.json에 적힌 파일만 (아직 없는 유형 때문에 설치가 실패하지 않게)
  for (const dir of ["./data/bank/", "./data/vocab/"]){
    try {
      const idx = await (await fetch(dir + "index.json", { cache: "no-cache" })).json();
      await c.addAll(Object.values(idx.kinds || {}).map(k => dir + k.file));
    } catch {}   // 못 받아도 앱 설치는 계속(네트워크 우선이라 다음에 열 때 다시 캐시됨)
  }
}

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL).then(() => cacheData(c))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;                                  // API 호출(POST)은 그대로 통과
  if (url.hostname === "generativelanguage.googleapis.com") return;

  // 웹폰트: 한 번 받으면 캐시에서
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com"){
    e.respondWith(caches.open(VERSION + "-fonts").then(async c => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok || res.type === "opaque") c.put(e.request, res.clone());
      return res;
    }).catch(() => caches.match(e.request)));
    return;
  }

  // 앱 파일: 네트워크 우선, 실패하면 캐시 (수정한 코드가 바로 보이게)
  if (url.origin === self.location.origin){
    e.respondWith(fetch(e.request, { cache: "no-cache" }).then(res => {   // HTTP 캐시도 재검증(304)
      if (res.ok){ const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match("./index.html"))));
  }
});
