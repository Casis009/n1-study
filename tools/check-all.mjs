// 커밋·push 전 전체 검사: 모든 .js/.mjs 문법(브라우저와 같은 ES 모듈 방식) + 문제은행 + 단어장.
// 사용: node --no-warnings tools/check-all.mjs          (index.json은 건드리지 않고 최신인지만 확인 — pre-commit hook이 이 모드)
//       node --no-warnings tools/check-all.mjs --write  (데이터를 고친 뒤 index.json까지 갱신)
// 하나라도 실패하면 exit 1. 경고도 실패로 본다(--strict).
// 왜: `node --check src/main.js`는 .js를 ES 모듈로 읽지 않아 깨진 정규식을 놓쳤고, 배포 페이지가 통째로 비었다(2026-10-14).
import { readdirSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set([".git", "node_modules", "data", "icons", "docs"]);
const CLASSIC = new Set(["sw.js"]);                 // 서비스 워커는 모듈이 아닌 일반 스크립트
const write = process.argv.includes("--write");
let failed = 0;

function files(dir){
  return readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? (SKIP.has(d.name) ? [] : files(join(dir, d.name))) : /\.m?js$/.test(d.name) ? [join(dir, d.name)] : []);
}

/* 1) 문법: 임시 폴더에 .mjs(일반 스크립트는 .cjs)로 복사해 node --check */
const tmp = mkdtempSync(join(tmpdir(), "n1-check-"));
const list = files(ROOT);
list.forEach((f, i) => {
  const rel = relative(ROOT, f).replace(/\\/g, "/");
  const copy = join(tmp, `${i}${CLASSIC.has(rel) ? ".cjs" : ".mjs"}`);
  copyFileSync(f, copy);
  const r = spawnSync(process.execPath, ["--check", copy], { encoding: "utf8" });
  if (r.status !== 0){
    failed++;
    console.log(`✗ 문법 ${rel}\n` + (r.stderr || "").split(copy).join(rel).trim() + "\n");
  }
});
rmSync(tmp, { recursive: true, force: true });
console.log(`문법 검사 ${list.length}개 파일${failed ? ` · 실패 ${failed}` : " · 통과"}`);

/* 2) 문제은행·단어장 */
for (const tool of ["check-bank.mjs", "check-vocab.mjs"]){
  const args = ["--no-warnings", join(ROOT, "tools", tool), "--strict", ...(write ? [] : ["--no-write"])];
  const r = spawnSync(process.execPath, args, { encoding: "utf8", cwd: ROOT });
  const out = (r.stdout || "") + (r.stderr || "");
  if (r.status !== 0){ failed++; console.log(`✗ ${tool}\n${out.trim()}\n`); }
  else console.log(`${tool} · ${out.trim().split("\n").pop()}`);
}

if (failed){ console.log(`\ncheck-all 실패 ${failed}건`); process.exit(1); }
console.log("\ncheck-all 통과");
