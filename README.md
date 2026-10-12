# N1 연습장

JLPT N1 1교시(문자·어휘, 문법, 독해) 12개 유형 문제를 Gemini로 만들어 풀고,
정답 확인 후 **정답 근거 · 한자(읽기) · 주요 문법 · 비슷한 말 비교 · 출제 패턴 · 풀이 팁 · 선택지 분석** 해설을 보는 웹앱입니다.

- 틀린 문제는 **오답노트**에 자동 저장, 자주 틀린 문법·어휘는 다음 문제에 섞여 나와요.
- 해설의 ☆를 누르면 **단어장**에 저장되고, "뜻 가리기"로 암기할 수 있어요.
- 모든 기록은 **이 기기 안(IndexedDB)** 에 저장돼요. 서버가 없고, 백업 파일로 기기 간에 옮길 수 있어요.
- 홈 화면에 설치하면 앱처럼 열리고, 오프라인에서도 오답노트·단어장을 볼 수 있어요.

## 1. PC에서 실행

```bash
cd n1-study
python3 -m http.server 8000
```

브라우저에서 http://localhost:8000 을 열고, **기록·설정** 탭에 Gemini API 키를 넣으세요.
키는 https://aistudio.google.com/apikey 에서 무료로 만들 수 있어요.

> `index.html`을 더블클릭해서 열면 동작하지 않아요(모듈 보안 정책). 꼭 로컬 서버로 여세요.

## 2. 휴대폰에서 쓰기 (GitHub Pages, 무료)

1. GitHub에서 새 저장소 만들기 (예: `n1-study`, Public)
2. 이 폴더의 파일을 전부 올리기 (웹에서 끌어다 놓기 또는 `git push`)
   ```bash
   git init && git add . && git commit -m "N1 연습장"
   git branch -M main
   git remote add origin https://github.com/<아이디>/n1-study.git
   git push -u origin main
   ```
3. 저장소 **Settings → Pages → Source: Deploy from a branch → main / (root)** 저장
4. 1~2분 뒤 `https://<아이디>.github.io/n1-study/` 접속
5. 홈 화면에 추가
   - 아이폰(사파리): 공유 버튼 → **홈 화면에 추가**
   - 안드로이드(크롬): 메뉴 → **앱 설치** 또는 **홈 화면에 추가**
6. 설치한 앱의 **기록·설정**에서 API 키 입력 (기기마다 한 번)

### API 키 보호 (권장)

Google Cloud Console → API 및 서비스 → 사용자 인증 정보 → 해당 키:
- 애플리케이션 제한: 웹사이트 → `https://<아이디>.github.io/*` (PC에서 쓰려면 `http://localhost:8000/*`도 추가)
- API 제한: Generative Language API
- 결제 수단을 연결하지 않으면 무료 등급만 쓰여서 요금이 나오지 않아요.

키는 코드나 저장소에 절대 넣지 마세요. 앱 화면에서 입력하면 그 기기에만 저장돼요.

## 3. 데이터 백업

**기록·설정 → 백업 파일 내보내기**로 오답노트·단어장·기록을 JSON 파일로 저장하고,
다른 기기에서 **백업 불러오기**로 합칠 수 있어요. (API 키는 백업에 들어가지 않아요)

아이폰 사파리는 홈 화면에 설치하지 않은 사이트의 저장 데이터를 오래 안 쓰면 지울 수 있어요. 홈 화면 설치 + 가끔 백업을 권장해요.

## 4. 코드를 고친 뒤

`sw.js`의 `VERSION`을 올려야 설치된 앱에 새 버전이 확실히 반영돼요.

## Claude Code로 이어서 작업

이 폴더에서 `claude`를 실행하면 `CLAUDE.md`에 정리된 맥락(구조, 데이터 형식, 규칙, 다음 할 일)을 읽고 시작해요.
기획·조사 메모는 `docs/`에 있어요.
