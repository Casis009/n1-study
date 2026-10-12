# 앱 기획 메모 (2026-10-12 대화 정리)

## 1. 다음 앱 후보

### 수익화 가능성이 있는 방향
- **커플·가족 공유형** (추천): 공유 장보기, 가계부, 육아·반려동물 기록, 집안일 분담. 둘이 같이 써야 의미가 있어서 이탈이 적다. 무료 + 프리미엄 구독(월 2,000~4,000원).
- **틈새 도구**: 특정 직군·취미 기록용. 대형 앱이 안 하는 영역.
- **게임**: 수익 편차 큼. 하이퍼캐주얼은 마케팅비 필요. 1인이면 퍼즐·방치형.
- **일본어 학습(N1·경어·면접)**: 이 프로젝트. 본인이 사용자라 개선이 빠르고, 시험 후 출시 후보.

### 부부용 앱 (아내 iPhone, 나 Android)
- 서버 없이 인터넷으로 직접 통신은 사실상 불가 (NAT, P2P도 시그널링 서버 필요). 같은 와이파이/블루투스는 가능하나 iOS 백그라운드 제한.
- 서버를 직접 운영할 필요는 없음 → **Firebase**(Firestore + FCM) 또는 **Supabase** 무료 등급.
- 크로스플랫폼: Flutter 또는 React Native. **iOS 빌드는 Mac 필요.**
- 아이폰 개인 설치: 무료 계정은 7일마다 재설치 + 푸시 불가 → 결국 Apple Developer Program + TestFlight가 현실적.

## 2. Apple Developer Program (연 $99)
- 서명 1년 유지(7일 재설치 없음), 푸시 알림(APNs), TestFlight(내부 100명 / 외부 최대 10,000명), Ad Hoc(연 100대)
- App Store 출시, 인앱 결제·구독, App Store Connect 통계
- iCloud/CloudKit, Sign in with Apple, Apple Pay, HealthKit, App Groups 등
- 해지하면 스토어에서 내려가고 TestFlight 중단. 조직 명의는 D-U-N-S 필요.
- 수수료 기본 30%, Small Business Program(연 매출 100만 달러 이하) 15%.

## 3. 스토어 배포 조건 (2026-10 기준)

### Google Play
- 등록비 $25 (1회)
- **2023-11-13 이후 만든 개인 계정**: 앱마다 **테스터 12명이 14일 연속** 비공개 테스트 후 프로덕션 신청 가능. 조직 계정은 면제.
- Android 개발자 인증: 2026-09-30부터 브라질·인도네시아·싱가포르·태국에서 인증된 개발자 앱만 설치 가능. **2027년 전 세계 확대 예정.** Play Console 인증을 마치면 대부분 자동 충족.

### App Store
- 연 $99, 심사 엄격. 개인정보 처리방침 URL 필수, 회원가입이 있으면 앱 내 계정 삭제 기능 필수.

### 한국 공통
- 유료·인앱 결제 수익: 사업자등록 + 통신판매업 신고
- 위치 정보 사용 시 위치기반서비스사업 신고 대상인지 확인

## 4. LLM API 메모
- Google AI Studio(Gemini) 무료 등급: 한도는 **하루 요청 수(RPD)·분당 요청 수(RPM)·분당 토큰(TPM)**, 프로젝트·모델 단위. 키를 여러 개 만들어도 늘지 않음.
- Google은 무료 한도표를 더 이상 공개하지 않음. 2025-12 이후 크게 줄었고, 2026-09 측정 사례로 하루 약 20회.
- 무료 등급 데이터는 모델 학습에 쓰일 수 있음. 출시용은 유료 + 서버 경유.
- 개인 공부는 "세트 1개 = 호출 1회"로 묶으면 무료로도 충분. 유료(Flash)로 바꿔도 개인 사용량이면 월 몇백~몇천 원 수준, 지출 한도 설정 가능.

## 5. 로드맵
1. **~12/6 시험**: 웹앱(이 프로젝트)으로 공부. 독해·문법 위주, 오답노트·단어장 활용.
2. **시험 후**: 면접 대비 탭(질문 패턴, 답변 첨삭, 비즈니스 경어) 추가.
3. **그다음**: Flutter 앱 전환 검토 → 데이터는 로컬 DB(SQLite/Isar 등) 유지, 수익화 시 서버(Cloud Functions)로 API 호출 이전, 구독 모델.
4. 부부 공유 앱은 Flutter + Firebase로 별도 프로젝트.

## 참고 출처
- Android developer verification: https://developer.android.com/developer-verification/guides
- Google Play 12 testers 규정 정리: https://www.choicely.com/blog/google-play-12-tester-rule
- Gemini 무료 등급 측정(2026-09): https://dev.to/romeroyang/geminis-free-tier-measured-20-requests-a-day-and-google-no-longer-publishes-the-number-4gf2
- Gemini 무료 등급 정리: https://yingtu.ai/en/blog/google-gemini-api-free-tier-limits-2026
