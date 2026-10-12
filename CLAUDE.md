# N1 연습장 (n1-study)

JLPT N1(2026년 12월 6일 시험) 1교시 대비용 개인 학습 웹앱. AI(Gemini)로 문제를 만들고, 정답 확인 후 해설을 보여 주며, 오답노트·단어장·풀이 기록을 **사용자 기기 안(IndexedDB)** 에 저장한다. 서버는 없다.

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
index.html             화면 뼈대, 탭 5개(문제 / 오답노트 / 단어장 / 면접 / 기록·설정)
manifest.webmanifest   PWA(홈 화면 설치)
sw.js                  오프라인 캐시. 앱 파일을 고치면 VERSION을 올릴 것
src/main.js            상태와 렌더링 전부 (탭별 render* 함수)
src/kinds.js           N1 1교시 12개 문제 유형 정의, 주제 목록, 시험일
src/prompt.js          문제 생성·면접 꼬리 질문 프롬프트 (출력 JSON 스키마 포함)
src/sets.js            모델 출력 검증·정리(normalizeQ), 선택지 섞기, JSON 관대 파싱
src/gemini.js          Gemini REST 호출, 하루 호출 수 카운터, 한도 초기화 시각
src/db.js              IndexedDB 래퍼, 백업 내보내기/불러오기, 영구 저장 요청
src/samples.js         직접 작성한 예시 세트(어휘·문법·독해). API 없이도 화면 확인 가능
src/interview.js       면접 질문 유형과 유형별 예시 질문(직접 작성)
src/keigo.js           비즈니스 경어 상황 카드 42장(직접 작성, 오프라인)
src/dom.js             h() DOM 도우미, prefs(localStorage), 시간 포맷
src/styles.css         디자인 토큰(:root) + 라이트/다크 테마
docs/                  기획 메모, N1 형식 정리
```

## 데이터

- **IndexedDB `n1-study`**: `notes`(오답노트), `cards`(단어장), `history`(풀이 기록), `meta`(풀던 세트 `current`), `answers`(면접 내 답변 노트, v2에서 추가). 스키마는 `src/db.js` 상단 주석.
- **localStorage**: `n1.settings`(API 키·모델), `n1.gen`(생성 옵션), `n1.calls`(오늘 호출 수), `n1.interview`(답변 노트 필터·쓰던 답변).
- 백업 JSON(`app: "n1-study"`, `version: 2`)에는 notes/cards/history/answers만 들어가고 **API 키는 절대 넣지 않는다.** v1(answers 없음) 파일도 불러올 수 있고, 앱보다 새 version은 거부한다. 스토어를 백업에 추가하면 `BACKUP_VERSION`(db.js)을 올릴 것.
- 스토어 구조를 바꾸면 `DB_VERSION`을 올리고 `onupgradeneeded`에서 마이그레이션.

## 문제 데이터 형식 (prompt.js ↔ sets.js가 공유)

```json
{ "title": "", "topic": "", "passage": "",
  "questions": [{ "stem": "", "choices": ["","","",""], "answer": 0,
    "ex": { "why": "", "kanji": [{"word":"","reading":"","meaning":""}],
            "grammar": [{"pattern":"","meaning":"","example":""}],
            "compare": [{"word":"","reading":"","meaning":"","note":""}],
            "pattern": "", "tip": "", "choiceNotes": ["","","",""] } }] }
```

- 밑줄은 `__문구__`로 표기 (지문·문제 모두). ★는 문장 배열 문제의 정답 칸.
- `answer`는 0부터. 1부터 온 경우 sets.js가 보정한다.
- 선택지는 클라이언트에서 섞고 `choiceNotes`도 같은 순서로 섞는다. 그래서 해설에서 선택지를 번호로 부르지 않게 프롬프트에 지시해 둠.
- 프롬프트를 바꾸면 normalizeQ와 explanationNode(main.js)도 같이 맞출 것.

## 규칙

- 모델 출력은 항상 `textContent`로 넣는다(`h()` 사용). `innerHTML` 금지.
- API 키를 코드·저장소·백업 파일에 넣지 않는다. 키는 설정 화면 입력 → localStorage.
- 기출문제·교재 문장을 그대로 넣지 않는다(저작권). 예시는 직접 작성, 생성은 "새로 쓰기" 지시.
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

1. 실제 Gemini 응답으로 12개 유형을 하나씩 생성해 보고 프롬프트 품질 다듬기 (특히 用法, 情報検索, 文章の文法)
2. 일본어 면접 대비 탭: 내 답변 노트(써 둔 답변 저장, 문장 가리고 외우기, 30초~2분 타이머, 예상 꼬리 질문 5개) + 비즈니스 경어 상황 카드 완료. 답변 첨삭은 하지 않기로 함(답변은 사용자가 이미 작성)
3. 단어장 간격 반복(SRS) 복습
4. 시험 후: Flutter 앱으로 전환 검토 (iOS 빌드는 Mac 필요, 배포 조건은 docs/planning.md)

## 면접 탭 메모

- 내 답변 노트: 답변 텍스트는 이 기기에만 저장. **[예상 꼬리 질문 만들기]를 누를 때만** 질문과 답변을 Gemini로 보낸다(화면에 안내 문구 유지).
- 글자 수는 공백·줄바꿈 제외, 예상 시간은 1분 ≈ 300자 기준. 타이머 시간은 답변마다 `timerSec`으로 기억.
- 외우기 모드는 。！？와 줄바꿈 기준으로 문장을 나눈다(`sentences()` in main.js).
- 경어 카드 `jp`(정답 표현)에는 이중 경어·バイト敬語·존경어/겸양어 혼동을 넣지 않는다. 관용으로 인정되는 예외(お召し上がりください 등)는 note에 밝힌다. 틀린 예는 `ng`/`ngWhy`에.
- 경어 카드 ☆는 단어장 `type: "keigo"`로 저장(front=표현, meaning=상황, extra=해설+✕예).
