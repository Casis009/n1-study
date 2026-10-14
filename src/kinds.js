/* JLPT N1 1교시 문제 유형 */
export const KINDS = {
  kanji_reading: { label:"한자 읽기", jp:"漢字読み", group:"문자·어휘", counts:[5,10], vocab:true },
  context:       { label:"문맥 규정", jp:"文脈規定", group:"문자·어휘", counts:[5,10], vocab:true },
  paraphrase:    { label:"유의어", jp:"言い換え類義", group:"문자·어휘", counts:[5,10], vocab:true },
  usage:         { label:"용법", jp:"用法", group:"문자·어휘", counts:[5,10], vocab:true },
  grammar_blank: { label:"문법 빈칸", jp:"文法形式の判断", group:"문법", counts:[5,10] },
  grammar_order: { label:"문장 배열 ★", jp:"文の組み立て", group:"문법", counts:[5,10] },
  text_grammar:  { label:"글의 문법", jp:"文章の文法", group:"문법", fixed:"글 1 · 빈칸 5개" },
  reading_short: { label:"독해 단문", jp:"内容理解（短文）", group:"독해", fixed:"지문 1 · 2문항" },
  reading_mid:   { label:"독해 중문", jp:"内容理解（中文）", group:"독해", fixed:"지문 1 · 3문항" },
  reading_long:  { label:"주장 이해", jp:"主張理解（長文）", group:"독해", fixed:"긴 지문 · 3문항" },
  integrated:    { label:"통합 이해", jp:"統合理解", group:"독해", fixed:"A·B 두 글 · 2문항" },
  info_search:   { label:"정보 검색", jp:"情報検索", group:"독해", fixed:"실용문 1 · 2문항" },
  // 청해: 브라우저 읽어주기(Web Speech API)로 듣는 연습. 문제마다 script(화자별 대사)가 있고 단위 = 문제 1개
  listen_task:   { label:"과제 이해", jp:"課題理解", group:"청해", counts:[3,5], listen:true },
  listen_point:  { label:"포인트 이해", jp:"ポイント理解", group:"청해", counts:[3,5], listen:true },
  listen_quick:  { label:"즉시 응답", jp:"即時応答", group:"청해", counts:[5,10], listen:true, choices:3 },
};
export const TOPICS = ["사회·노동","경제·소비","과학·기술","교육","언어·커뮤니케이션","예술·문학","환경","의료·건강","철학·삶의 태도","도시·지역","미디어·정보","역사·전통문화"];
export const EXAM = new Date("2026-12-06T00:00:00+09:00");
