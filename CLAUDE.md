# N1 연습장 (n1-study)

JLPT N1(2026년 12월 6일 시험) 1교시 대비용 개인 학습 웹앱. 직접 쓴 **문제은행**(`data/bank`)에서 출제하고(Gemini 생성은 보조), 정답 확인 후 해설을 보여 주며, 오답노트·단어장·풀이 기록을 **사용자 기기 안(IndexedDB)** 에 저장한다. 서버는 없다.

사용자: 한국어 화자, 일본어 N1 준비 중. 특히 독해와 문법이 약함. 일본어 면접 준비도 예정. 아내와 쓸 앱, 수익화 앱도 구상 중 → `docs/planning.md`.
대화는 한국어로. 앱 화면의 문구도 한국어(문제·지문은 일본어).

## 실행

빌드 단계 없음. ES 모듈이라 `file://`로는 안 열리고 로컬 서버가 필요하다.

```bash
python3 -m http.server 8000      # 또는: npx serve .
# → http://localhost:8000
```

배포는 GitHub Pages(정적 호스팅). 자세한 순서는 README.md.

## 구조

```
index.html             화면 뼈대: 상단 앱바(뒤로·제목·D-day) + 화면(main#view-*) + 하단 탭 5개(홈 / 단어장 / 오답노트 / 기록 / 더보기)
manifest.webmanifest   PWA(홈 화면 설치)
sw.js                  오프라인 캐시(문제은행 포함). 앱 파일·문제은행을 고치면 VERSION을 올릴 것
src/main.js            상태와 렌더링 전부. 해시 경로(#/home, #/part/문법, #/play …)마다 render* 함수(VIEWS 표). 더보기 = 면접·설정·내 문제·AI
src/bank.js            문제은행 로드·출제(안 푼 것 → 복습)·복습 일정·패턴 통계·기기 문제(AI/내 문제)·패턴별 출제·문제집 회차(bookRounds)·모의고사 예약 제외
src/vocab.js           기본 단어장 로드·외웠어요(vocabDone)·틀리면 외웠어요 해제
src/kinds.js           N1 1교시 12개 + 청해 3개 문제 유형 정의, 주제 목록, 시험일
src/exam.js            실전 모의고사: 구성·예약 읽기, 교시 세트 만들기, 시간(문항 수 비례/공식), 점수 환산(추정)
src/prompt.js          문제 생성·면접 꼬리 질문 프롬프트 (출력 JSON 스키마 포함)
src/sets.js            모델 출력 검증·정리(normalizeQ), 선택지 섞기, JSON 관대 파싱
src/gemini.js          Gemini REST 호출, 하루 호출 수 카운터, 한도 초기화 시각
src/db.js              IndexedDB 래퍼, 백업 내보내기/불러오기, 영구 저장 요청
src/samples.js         직접 작성한 예시 세트(어휘·문법·독해). API 없이도 화면 확인 가능
src/interview.js       면접 질문 유형과 유형별 예시 질문(직접 작성)
src/keigo.js           비즈니스 경어 상황 카드 42장(직접 작성, 오프라인)
src/dom.js             h() DOM 도우미, prefs(localStorage), 시간 포맷
src/styles.css         디자인 토큰(:root) + 라이트/다크 테마
data/bank/             문제은행 <유형키>.json + index.json(도구가 생성). 문장은 직접 작성
tools/check-bank.mjs   문제은행 검증 + index.json 생성: node --no-warnings tools/check-bank.mjs
data/vocab/            기본 단어장 grammar/kanji/words.json + index.json(도구가 생성). 뜻풀이·예문은 직접 작성
tools/check-vocab.mjs  단어장 검증 + index.json 생성 + 문제은행 patternTags 누락 경고
tools/check-all.mjs    커밋·push 전 전체 검사(문법 + check-bank + check-vocab + pick-exam). .githooks/pre-commit이 실행
data/exam.json         모의고사 구성(JLPT 대문 순서·공식 문항 수·시간·합격 기준, 대체/건너뜀, 출처는 _source). 1교시 문항 수는 추정(estimated)
data/exam-reserve.json 모의고사 회차별 예약 단위. tools/pick-exam.mjs --add 로 회차 추가(id 큰 쪽부터, 기존 회차 유지)
tools/pick-exam.mjs    예약 검사(인자 없음) / 회차 추가(--add). 문제가 모자라면 실패
docs/                  기획 메모, N1 형식 정리, bank-plan.md(문제은행 계획·진행 현황·빈출 항목)
```

## 데이터

- **IndexedDB `n1-study`**: `notes`(오답노트), `cards`(단어장), `history`(풀이 기록), `meta`(풀던 세트 `current`), `answers`(면접 내 답변 노트, v2), `progress`(문제은행 단위별 풀이·복습 일정, v3), `localBank`(기기에만 있는 AI 문제·내 문제, v3), `tagStats`(패턴별 출제·틀림, v3), `vocabDone`(기본 단어장 외웠어요, v4), `book`(문제집 회차)·`marks`(북마크)·`exams`(모의고사)·`daily`(데일리 학습)·`vcards`(카드 암기 상태) (v5). 스키마는 `src/db.js` 상단 주석.
- **localStorage**: `n1.settings`(API 키·모델), `n1.gen`(생성 옵션), `n1.calls`(오늘 호출 수), `n1.interview`(답변 노트 필터·쓰던 답변), `n1.mine`(내 문제 입력 중인 내용), `n1.vocab`(단어장 보기 설정).
- 백업 JSON(`app: "n1-study"`, `version: 5`)에는 notes/cards/history/answers/progress/localBank/tagStats/vocabDone/book/marks/exams/daily/vcards만 들어가고 **API 키는 절대 넣지 않는다.** v1(answers 없음) 파일도 불러올 수 있고, 앱보다 새 version은 거부한다. 스토어를 백업에 추가하면 `BACKUP_VERSION`(db.js)을 올릴 것.
- 스토어 구조를 바꾸면 `DB_VERSION`을 올리고 `onupgradeneeded`에서 마이그레이션.

## 문제 데이터 형식 (prompt.js ↔ sets.js가 공유)

```json
{ "title": "", "topic": "", "passage": "",
  "passageKo": "", "passageGloss": [{"w":"","r":"","m":""}],
  "questions": [{ "stem": "", "choices": ["","","",""], "answer": 0, "gloss": [{"w":"","r":"","m":""}],
    "ex": { "translation": {"full":"","ko":""}, "choicesKo": [{"reading":"","ko":""}],
            "why": "", "kanji": [{"word":"","reading":"","meaning":""}],
            "grammar": [{"pattern":"","meaning":"","example":""}],
            "compare": [{"word":"","reading":"","meaning":"","note":""}],
            "pattern": "", "tip": "", "choiceNotes": ["","","",""] } }] }
```

- 문항마다 `patternTags`(예: `["〜にすぎない"]`)를 붙인다. 패턴별 통계와 약점 반영에 쓰이므로 표기를 docs/bank-plan.md 목록과 맞출 것.
- 문제은행 파일은 `{ kind, units: [{ id, title, topic, passage, questions }] }`. 문항형 유형은 단위 하나에 문제 1개, 지문형은 지문 1개 + 딸린 문항.
- 밑줄은 `__문구__`로 표기 (지문·문제 모두). ★는 문장 배열 문제의 정답 칸.
- `answer`는 0부터. 1부터 온 경우 sets.js가 보정한다.
- 새 해설 필드(translation·choicesKo·gloss·passageKo·passageGloss)의 작성 규칙은 docs/bank-plan.md "작성 규칙". 단어 탭(gloss)과 지문 해석은 정답 확인 뒤에만 보인다.
- 선택지는 클라이언트에서 섞고 `choiceNotes`·`choicesKo`도 같은 순서로 섞는다. 그래서 해설에서 선택지를 번호로 부르지 않게 프롬프트에 지시해 둠.
- 프롬프트를 바꾸면 normalizeQ와 explanationNode(main.js)도 같이 맞출 것.

## 규칙

- **push 전 `node --no-warnings tools/check-all.mjs` 통과 필수.** 모든 .js/.mjs를 ES 모듈 방식으로 문법 검사(그냥 `node --check src/x.js`는 깨진 정규식을 놓침) + check-bank + check-vocab(경고도 실패, index.json 최신 여부). 데이터를 고친 뒤에는 `--write`로 index.json까지 갱신. pre-commit hook(`.githooks/pre-commit`)이 같은 검사를 돌려 실패하면 커밋을 막는다 — 클론마다 `git config core.hooksPath .githooks` 한 번. hook을 `--no-verify`로 건너뛰지 않는다.
- **코드(src/·sw.js·index.html)를 바꿔 push한 뒤에는 배포 페이지(https://casis009.github.io/n1-study/)를 한 번 열어 콘솔 오류가 없는지 확인한다.** (2026-10-14 main.js 문법 오류로 화면이 통째로 비었던 일의 재발 방지)
- 모델 출력은 항상 `textContent`로 넣는다(`h()` 사용). `innerHTML` 금지.
- API 키를 코드·저장소·백업 파일에 넣지 않는다. 키는 설정 화면 입력 → localStorage.
- 기출문제·교재 문장을 그대로 넣지 않는다(저작권). 예시·문제은행은 직접 작성(빈출 항목 목록은 써도 되지만 문장은 새로), 생성은 "새로 쓰기" 지시.
- 사용자가 입력한 '내 문제'(교재 문제 등)는 기기 IndexedDB(`localBank`)에만 저장. `data/`나 커밋에 절대 넣지 않는다(백업 파일에는 포함, 백업 파일은 .gitignore).
- 문제은행을 고치면 `tools/check-bank.mjs` 오류 0을 확인하고 docs/bank-plan.md 진행 현황을 갱신.
- 기본 단어장 문법 `pattern`은 문제은행 `patternTags`와 같은 표기. 단어장을 고치면 `tools/check-vocab.mjs` 오류 0·patternTags 누락 경고 0 확인.
- 남은 작업 순서와 다음 시작 지점은 docs/bank-plan.md "전체 작업 순서"에 있다.
- 외부 라이브러리 없이 유지(오프라인 캐시가 단순해짐). 필요하면 이유를 남길 것.
- 모바일 우선: 400px 폭에서 가로 스크롤 금지, 터치 영역 넉넉하게.
- 색은 `styles.css`의 토큰만 사용(라이트/다크 둘 다 정의).

## Gemini 메모 (2026-10 기준)

- 기본 모델 `gemini-2.5-flash` (무료 등급 사용 가능). 3.x 모델은 무료에서 막히거나 느림.
- 무료 한도는 **프로젝트·모델 단위**, Google이 표를 공개하지 않음. 2026-09 측정 사례로 하루 약 20회. 미국 태평양 시간 자정에 초기화(한국 오후 4~5시).
- 세트 하나 = 호출 1회가 되도록 한 번에 여러 문항을 JSON으로 받는다.
- 무료 등급 입력은 학습에 쓰일 수 있음. 출시(상용)할 때는 유료 등급 + 서버(Cloud Functions 등) 경유로 바꿔야 한다. 브라우저에서 키를 직접 쓰는 지금 구조는 개인용 전제.
- GitHub Pages에 올릴 때는 Google Cloud Console에서 키에 웹사이트 제한(`https://<아이디>.github.io/*`)과 API 제한(Generative Language API)을 걸 것.

## 다음 할 일 후보

1. 문제은행 2단계 작성 (유형별 요청 단위, docs/bank-plan.md). Gemini는 모델이 안정되면 12개 유형 프롬프트 점검(기본 모델 gemini-2.5-flash가 신규 키에서 404)
2. 일본어 면접 대비 탭: 내 답변 노트(써 둔 답변 저장, 문장 가리고 외우기, 30초~2분 타이머, 예상 꼬리 질문 5개) + 비즈니스 경어 상황 카드 완료. 답변 첨삭은 하지 않기로 함(답변은 사용자가 이미 작성)
3. 단어장 간격 반복(SRS) 복습
4. 시험 후: Flutter 앱으로 전환 검토 (iOS 빌드는 Mac 필요, 배포 조건은 docs/planning.md)

## 면접 탭 메모

- 내 답변 노트: 답변 텍스트는 이 기기에만 저장. **[예상 꼬리 질문 만들기]를 누를 때만** 질문과 답변을 Gemini로 보낸다(화면에 안내 문구 유지).
- 글자 수는 공백·줄바꿈 제외, 예상 시간은 1분 ≈ 300자 기준. 타이머 시간은 답변마다 `timerSec`으로 기억.
- 외우기 모드는 。！？와 줄바꿈 기준으로 문장을 나눈다(`sentences()` in main.js).
- 경어 카드 `jp`(정답 표현)에는 이중 경어·バイト敬語·존경어/겸양어 혼동을 넣지 않는다. 관용으로 인정되는 예외(お召し上がりください 등)는 note에 밝힌다. 틀린 예는 `ng`/`ngWhy`에.
- 경어 카드 ☆는 단어장 `type: "keigo"`로 저장(front=표현, meaning=상황, extra=해설+✕예).
