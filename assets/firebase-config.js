// ══════════════════════════════════════════════════════
//  OFFLINE_MODE = true  → Firebase 호출 전부 skip
//                         (행동 로그는 콘솔에만, 음성은 로컬 파일 사용)
//  OFFLINE_MODE = false → 실서비스 모드 (Firebase 저장)
// ══════════════════════════════════════════════════════
window.OFFLINE_MODE = false;

// Firebase 설정 (OFFLINE_MODE = false 일 때만 사용)
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyDgjCXlw3U10ZNbxS3IfSlyFZt0ZoLOg-o",
  authDomain: "test01-b9256.firebaseapp.com",
  projectId: "test01-b9256",
  storageBucket: "test01-b9256.firebasestorage.app",
  messagingSenderId: "506014539335",
  appId: "1:506014539335:web:caf85876d582609a75db62"
};

window.FEEDBACK_LOG_COLLECTION = "feedback_views"; // 운영용 컬렉션 (기존 study_week*.html 구조와 키 정합)
window.EXPERIMENT_ID = "main_study";
window.STUDY_ID = "main_study";   // 세션 ID prefix — 기존 study 와 동일 형식 유지
