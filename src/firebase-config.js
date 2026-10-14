/*
 * Firebase 웹 앱 설정 (Firebase 콘솔 → 프로젝트 설정 → 내 앱 → SDK 설정 및 구성).
 * 이 값들은 비밀이 아니다: 브라우저에서 Firebase 프로젝트를 찾는 식별값이라 웹페이지에 공개돼도 된다.
 * 데이터 보호는 저장소의 firestore.rules(본인 uid의 users/{uid}/** 만 읽기·쓰기)가 맡는다.
 * (Gemini API 키와는 다른 값. Gemini 키는 여전히 저장소·동기화에 절대 넣지 않는다.)
 * measurementId(Analytics)는 쓰지 않는다.
 * 비우면(null) 계정 메뉴에 "설정 필요"가 보이고, 앱은 로그인 없이 그대로 동작한다.
 */
export const firebaseConfig = {
  apiKey: "AIzaSyAw8qFKjHORYcnH4hJlfciKBw_9pU31f6s",
  authDomain: "n1-study.firebaseapp.com",
  projectId: "n1-study",
  storageBucket: "n1-study.firebasestorage.app",
  messagingSenderId: "979211865907",
  appId: "1:979211865907:web:643ed0611ce15c4baaf846",
};
