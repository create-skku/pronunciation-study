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

window.FEEDBACK_LOG_COLLECTION = "feedback_views_TEST"; // 분리된 테스트 컬렉션
window.EXPERIMENT_ID = "main_study";
