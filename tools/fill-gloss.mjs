// 단어 탭(gloss) 자동 채우기: ex.kanji와 기본 단어장(kanji/words) 표제어 중 문장에 그대로 나온 단어를 gloss로 넣는다.
// 사용: node --no-warnings tools/fill-gloss.mjs [유형키...] [--vocab] [--extra] [--dry]
//   --extra: 경어 카드·면접 예시 질문(코드 안 문장) gloss를 data/gloss-extra.json에
//   유형키를 주면 그 파일만, 안 주면 문제은행 전부. --vocab은 기본 단어장 예문 gloss도. --dry는 쓰지 않고 집계만.
// 규칙: 이미 있는 gloss는 그대로 두고 덧붙이기만 한다(여러 번 돌려도 같음). 문장당(지문은 단락당) 최대 8개.
//   1순위 그 문항의 ex.kanji(지문은 그 단위 문항들의 ex.kanji), 2순위 전체 사전(모든 ex.kanji + 단어장 표제어, 2글자 이상).
//   활용형이 달라 그대로 안 나오는 단어는 건너뛴다(직접 채울 것). 못 채운 곳(3개 미만)은 마지막에 목록으로 보여 준다.
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";

const BANK = new URL("../data/bank/", import.meta.url), VOCAB = new URL("../data/vocab/", import.meta.url);
const MAX = 8, MIN = 3;
const args = process.argv.slice(2);
const dry = args.includes("--dry"), withVocab = args.includes("--vocab");
const only = args.filter(a => !a.startsWith("--"));
const hasKanji = s => /[一-龯々]/.test(s || "");
const kanaOnly = s => /^[ぁ-ゖァ-ヺー・]+$/.test(s || "");
const hangul = s => /[가-힣]/.test(s || "");
const pieces = s => (s || "").split(/★|__|\n/);              // check-bank과 같은 경계
const readJson = u => JSON.parse(readFileSync(u, "utf8"));
const writeJson = (u, d) => writeFileSync(u, JSON.stringify(d, null, 1) + "\n");

/* 기초 단어(N5~N4 수준)는 단어 탭에 넣지 않는다. ex.kanji에는 있어도 자동으로는 건너뜀 */
const BASIC = new Set(`映画 観る 重い 祖父 祖母 持つ 人気 合格 喜ぶ 将来 思う 親 今回 全体 一部 努力 約束 事実 研究 人数 来月 全国
  都市 開く 自分 都合 情報 信じる 説明 旅館 料理 味 大切 部長 直接 席 着く 弁当 入社 半年 注文 突然 社員 遅刻 会議 欠席 皆様
  健康 毎日 週 一度 運動 足 最後 実際 相手 大会 成功 昼間 真夏 続く 病院 軽い 無理 入院 周り 正しい 進む 計画 真冬 訪れる 孫
  頼み 仕事 部屋 使う 読む 減る 番組 月末 昼食 思い出す 試合 勝つ 客 大声 失礼 簡単 旅行 楽しみ 去年 過ごす 選手 応援 新商品
  理由 走る 友人 覚える 荷物 初めて 他人 規則 水道 歯 磨く 危険 命 社長 音楽 量 定食 値段 平日 資料 来客 困る 忙しい 失敗 鳴る
  生徒 教室 窓 枝 止まる 熱心 反対 動かす 正直 手伝い 地方 家族 先生 図書館 調べる 現代 重要 事故 交差点 食器 家具 地元 宿題
  以前 賞 夢 閉じる 給料 患者 秘密 別 方法 練習 三月 春 本日 当店 閉店 材料 始める 生活 便利 本人 結果 地震 食料 用意 黙る 意見
  試験 顔 最近 兄 弟 必要 発表 休み 確認 学生時代 通う 喫茶店 寂しい 話題 小説 結局 貯金 病気 働く 人前 弾く 医者 吸う 写真 伝える
  戦争 胸 若者 売る 大雪 都内 交通 台風 近づく 遠足 中止 日程 工事 質問 早朝 甘い 体重 最終 散歩 有名 村 商店 経験 医師 通り 祭り
  大勢 負ける 時間 予定 野外 両親 留学 作品 感動 終了 治す 外出 拍手 叱る 手伝う 辞める 海外 駅前 耳 貸す 雪 一言 相談 決める 機械
  間違える 自由 夕食 本番 休む 国内 電車 専門 借りる 返す 姉 妹 忘れ物 少ない 店 忘れる 進学 船 新人 痛み 本当 結婚 一年 息子
  電気 夕日 宿 満点 正解 書類 買う 冷たい 部品 届く 止める 怒る 営業 利用 予約 撮影 紅葉 区別 近況 当初 意識 廊下 画面 景色 記録
  転ぶ 家電 新品 注意 場面 看板 神社 美術館 描く 作業 返事 手紙 珍しい 不安 高価 飾る 目的地 矢印 間違い 片付け 賛成 捨てる 残す
  先輩 丁寧 壁 印刷 癖 流行 時代 暮らし 季節 受け取る 植物 喜び 同僚 出身 様子 欠点 正確 原因 普段 高齢者 夫婦 提案 住民 伝統
  印象 広告 上司 報告 遠慮 包丁 見た目 歌手 現れる 改めて 引き受ける 子育て 物置 共働き 放課後 公共 新刊 予算 購入 習い事 受験生
  歓迎 残業 方針 視力 手段 囲む 道具 書店 店主 人生 失う 目的 技術 理解 都会 育てる 譲る 日常 世代 評判 方言 標準語 記憶 雰囲気
  食事 腕 比べる 特別 検索 能力 避ける 心理学 傾向 習慣 環境 解決 消費 参考 事情 基準 中身 介護 支え 利用者 導入 機会 一目`.split(/\s+/));

/* 사전 항목으로 쓸 수 있는지: 한자가 있고, 읽기는 가나만, 뜻은 한국어, 기초 단어가 아님 */
const usable = e => e && hasKanji(e.w) && kanaOnly(e.r) && hangul(e.m) && !BASIC.has(e.w);
const fromKanji = k => ({ w: (k.word || "").trim(), r: (k.reading || "").trim(), m: (k.meaning || "").trim() });

const bankFiles = readdirSync(BANK).filter(f => f.endsWith(".json") && f !== "index.json").sort();
const banks = new Map(bankFiles.map(f => [f.replace(/\.json$/, ""), readJson(new URL(f, BANK))]));

/* 전체 사전: 처음 나온 뜻을 쓴다 */
const dict = new Map();
const addDict = e => { if (usable(e) && e.w.length >= 2 && !dict.has(e.w)) dict.set(e.w, e); };
for (const data of banks.values()) for (const u of data.units) for (const q of u.questions) for (const k of q.ex?.kanji || []) addDict(fromKanji(k));
for (const kind of ["kanji", "words"]){
  const u = new URL(`${kind}.json`, VOCAB);
  if (existsSync(u)) for (const it of readJson(u).items || []) addDict({ w: it.word, r: it.reading, m: it.meaning });
}

/* texts에 그대로 나오는 후보를 긴 것부터 골라 list에 덧붙인다. 이미 고른 단어 안에 들어가는 짧은 단어는 뺀다 */
function fill(list, texts, local, cap = MAX){
  const segs = texts.flatMap(pieces);
  const appears = w => segs.some(t => t.includes(w));
  const have = new Set(list.map(g => g.w));
  const pick = cands => {
    const sorted = cands.filter(usable).filter(e => !have.has(e.w) && appears(e.w)).sort((a, b) => b.w.length - a.w.length);
    for (const e of sorted){
      if (list.length >= cap) return;
      if ([...have].some(w => w.includes(e.w))) continue;
      list.push({ w: e.w, r: e.r, m: e.m }); have.add(e.w);
    }
  };
  pick(local);
  pick([...dict.values()]);
  return list;
}

const weak = [];
let added = 0;
for (const [kind, data] of banks){
  if (only.length && !only.includes(kind)) continue;
  let n = 0;
  for (const u of data.units){
    const unitKanji = u.questions.flatMap(q => (q.ex?.kanji || []).map(fromKanji));
    if ((u.passage || "").trim()){
      const before = (u.passageGloss ||= []).length;
      for (const para of u.passage.split(/\n+/).filter(s => s.trim())){
        const inPara = u.passageGloss.filter(g => pieces(para).some(t => t.includes(g.w))).length;
        const extra = fill([...u.passageGloss], [para], unitKanji, u.passageGloss.length + Math.max(0, MAX - inPara)).slice(u.passageGloss.length);
        u.passageGloss.push(...extra);
        if (inPara + extra.length < MIN) weak.push(`${u.id} 지문 단락「${para.slice(0, 12)}…」 ${inPara + extra.length}개`);
      }
      n += u.passageGloss.length - before;
    }
    u.questions.forEach((q, i) => {
      const before = (q.gloss ||= []).length;
      fill(q.gloss, [q.stem, ...q.choices], (q.ex?.kanji || []).map(fromKanji));
      n += q.gloss.length - before;
      if (q.gloss.length < MIN) weak.push(`${u.id} Q${i + 1} ${q.gloss.length}개`);
    });
  }
  added += n;
  console.log(`${kind.padEnd(14)} +${n}`);
  if (!dry && n) writeJson(new URL(`${kind}.json`, BANK), data);
}

if (withVocab){
  const u = new URL("grammar.json", VOCAB), data = readJson(u);
  let n = 0;
  for (const it of data.items){
    const before = (it.gloss ||= []).length;
    fill(it.gloss, [it.example], []);
    n += it.gloss.length - before;
    if (it.gloss.length < MIN) weak.push(`${it.id} 예문 ${it.gloss.length}개`);
  }
  added += n;
  console.log(`vocab/grammar  +${n}`);
  if (!dry && n) writeJson(u, data);
}

/* --extra: 코드 안 데이터(경어 카드 src/keigo.js, 면접 예시 질문 src/interview.js)의 gloss → data/gloss-extra.json
 * { keigo: { 카드id: { jp: [gloss], ng: [gloss] } }, interview: { 질문 문장: [gloss] } }. 이미 있는 항목은 두고 덧붙이기만. */
if (args.includes("--extra")){
  const { KEIGO } = await import("../src/keigo.js");
  const { CATS } = await import("../src/interview.js");
  const EXTRA = new URL("../data/gloss-extra.json", import.meta.url);
  const data = existsSync(EXTRA) ? readJson(EXTRA) : {};
  data._comment = "tools/fill-gloss.mjs --extra가 채우고, 모자란 것은 직접 쓴다. 코드 안 문장(경어 카드·면접 예시 질문)의 단어 탭 gloss. 검사: check-vocab";
  data.keigo ||= {}; data.interview ||= {};
  /* 사전 보강: 문제은행 gloss(문장에 나온 그대로의 표기)도 낮은 순위 후보로 */
  const bankGloss = [];
  for (const d of banks.values()) for (const u of d.units){ for (const g of u.passageGloss || []) bankGloss.push(g); for (const q of u.questions) for (const g of q.gloss || []) bankGloss.push(g); }
  const extraCands = [...new Map(bankGloss.filter(usable).map(g => [g.w, { w: g.w, r: g.r, m: g.m }])).values()];
  /* 이미 gloss가 있는 문장(직접 쓴 것)은 건드리지 않는다: 자동은 簡単に 속 「単に」처럼 단어 경계를 틀릴 수 있어서 빈 문장만 채운다 */
  const fillX = (list, text) => { if (!list.length){ fill(list, [text], []); fill(list, [text], extraCands); } return list; };
  let n = 0;
  for (const c of KEIGO){
    const e = data.keigo[c.id] ||= { jp: [], ng: [] };
    const b = e.jp.length + e.ng.length;
    fillX(e.jp, c.jp); if (c.ng) fillX(e.ng, c.ng);
    n += e.jp.length + e.ng.length - b;
    if (!e.jp.length && hasKanji(c.jp.replace(/[〇△]/g, ""))) weak.push(`keigo ${c.id} jp 0개: ${c.jp}`);
    if (c.ng && !e.ng.length && hasKanji(c.ng.replace(/[〇△]/g, ""))) weak.push(`keigo ${c.id} ng 0개: ${c.ng}`);
  }
  for (const cat of CATS) for (const q of cat.questions){
    const list = data.interview[q] ||= [], b = list.length;
    fillX(list, q); n += list.length - b;
    if (!list.length && hasKanji(q)) weak.push(`interview 0개: ${q}`);
  }
  added += n;
  console.log(`gloss-extra    +${n}`);
  if (!dry) writeJson(EXTRA, data);
}

console.log(`\n추가 ${added}개${dry ? " (--dry: 쓰지 않음)" : ""} · 사전 ${dict.size}개`);
if (weak.length) console.log(`\n${MIN}개 미만 ${weak.length}곳 (직접 채울 것)\n  ` + weak.join("\n  "));
