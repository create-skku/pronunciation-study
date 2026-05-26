/* feedback*.html 공통 앱 로직
   - URL 파싱 (lid, week, group=body.data-group)
   - assignments.json 으로 T 유형 결정
   - content/T{1,2,3}.json + data/{LID}_W{w}.json 로드
   - 슬라이드 빌드 + 전환 + 단어별 행동 로깅
   - 재녹음 (MediaRecorder) → Firebase (OFFLINE_MODE 시 콘솔만)
*/

const cfg = window.FIREBASE_CONFIG;
const OFFLINE = !!window.OFFLINE_MODE;
const STUDY_ID = window.STUDY_ID || 'main_study';
// 관리자 검수 모드 — URL 에 ?admin=1 이 붙으면 Firebase 로깅/업로드 전부 스킵
const IS_ADMIN = new URLSearchParams(location.search).get('admin') === '1';
let db = null, storage = null, fbReady = false;
let SESSION_ID = '';           // 세션 메타 생성 후 채워짐 (학습자 ID 확정 후)
let ATTEMPT_ID = '';           // 학습자의 이번 세션 차수 (01, 02, ...)
let sessionStart = Date.now(); // elapsed 계산 기준 (세션 메타 set 시점에 재설정)
let sessionMetaReady = false;  // SESSION_ID 확정 + 메타 문서 set 완료 여부
let CURRENT = { lid:'', week:1, group:'A', t:'T1', data:null, content:null };
let slideEnter = {};   // slide name → enter timestamp
let slideVisit = {};   // slide name → visit count
let currentSlide = 0;
let slideList = [];    // ['cover','error','correction','viz_baji','viz_bbareuda','viz_paransaek','key_points','practice','rerecord']
let pageEnterTime = Date.now();

// ── 로그 버퍼 (기존 study_week*.html 과 동일 패턴) ─────────────
// 세션 메타 준비 전 / Firebase 실패 시 로컬에 쌓아두고 주기적 flush
const LOG_BUFFER = [];
const BUFFER_FLUSH_INTERVAL = 5000;
let _flushTimer = null;

// ── 유틸 ───────────────────────────────────────────────────────────────
function getParams() {
  const p = new URLSearchParams(location.search);
  const bodyGroup = document.body && document.body.getAttribute('data-group');
  // 주차 우선순위: URL ?week=X > body data-week > 기본 1
  const bodyWeek = document.body && document.body.getAttribute('data-week');
  return {
    lid:   p.get('lid') || '',
    week:  parseInt(p.get('week') || bodyWeek || '1', 10),
    group: bodyGroup || (p.get('lid') || '').charAt(0).toUpperCase(),
  };
}

// ── 화이트리스트 ─────────────────────────────────────────────
// ※ A90/A91, B90/B91 은 내부 테스트용 — 각 그룹 페이지에서만 동작.
//   데이터 집계 시 분석에서 제외 필요. (TEST_IDS_ALL 참조)
const TEST_IDS_BY_GROUP = {
  A: ['A90','A91'],
  B: ['B90','B91'],
  C: ['C90','C91'],
};
const TEST_IDS_ALL = [
  ...TEST_IDS_BY_GROUP.A, ...TEST_IDS_BY_GROUP.B, ...TEST_IDS_BY_GROUP.C
];
const ALLOWED_IDS_BY_GROUP = {
  A: ['A01','A02','A03','A04','A05','A06','A07','A08','A09','A10',
      'A11','A12','A13','A14','A15','A16','A17','A18','A19','A20','A21',
      ...TEST_IDS_BY_GROUP.A],
  B: ['B01','B02','B03','B04','B05','B06','B07','B08','B09','B10',
      'B11','B12','B13','B14','B15','B16','B17','B18','B19','B20',
      ...TEST_IDS_BY_GROUP.B],
  C: ['C01','C02','C03','C04','C05','C06','C07','C08','C09','C10',
      'C11','C12','C13','C14','C15','C16','C17','C18','C19','C20',
      ...TEST_IDS_BY_GROUP.C],
};
const ADMIN_ID = 'ABC';
function getPageGroup() {
  return (document.body && document.body.getAttribute('data-group')) || 'A';
}

// ── 로그인 ────────────────────────────────────────────────────
function onLearnerInput(input) {
  const v = (input.value || '').trim().toUpperCase();
  input.value = v;
  const errEl = document.getElementById('loginError');
  const startBtn = document.getElementById('loginStart');
  if (!v) {
    errEl.textContent = '';
    startBtn.classList.remove('ready');
    return;
  }
  errEl.textContent = '';
  startBtn.classList.add('ready');
}

async function checkAlreadyRerecorded(lid, week) {
  if (lid === ADMIN_ID) return false;
  if (OFFLINE || !fbReady) return false;
  try {
    const doc = await db.collection(window.FEEDBACK_LOG_COLLECTION).doc(lid).get();
    if (!doc.exists) return false;
    const data = doc.data() || {};
    return data['rerecorded_W' + week] === true;
  } catch (e) {
    console.warn('재녹음 검증 실패:', e);
    return false;
  }
}

async function doLogin() {
  const raw = (document.getElementById('learnerInput').value || '').trim().toUpperCase();
  const errEl = document.getElementById('loginError');
  const startBtn = document.getElementById('loginStart');
  const pageGroup = getPageGroup();

  // 화이트리스트 검증
  const allowed = ALLOWED_IDS_BY_GROUP[pageGroup] || [];
  const isAdmin = (raw === ADMIN_ID);
  if (!isAdmin && allowed.indexOf(raw) === -1) {
    errEl.textContent = '⚠ ' + pageGroup + ' 그룹 ID가 아닙니다 · Mã không thuộc nhóm ' + pageGroup;
    return;
  }

  startBtn.disabled = true;
  startBtn.textContent = '🔍 확인 중... · Đang kiểm tra...';

  // Firebase 초기화 보장
  if (!fbReady && !OFFLINE) {
    initFirebase();
    await new Promise(r => setTimeout(r, 250));
  }

  // 재녹음 완료 차단
  const params = getParams();
  const week = params.week || 1;
  const alreadyDone = await checkAlreadyRerecorded(raw, week);
  if (alreadyDone) {
    errEl.textContent = '⚠ 이미 재녹음을 완료했습니다 · Đã hoàn thành ghi âm lại';
    startBtn.disabled = false;
    startBtn.textContent = '피드백 보기 · Xem phản hồi →';
    return;
  }

  // 정상 진입 — URL 에 lid 만 추가 (week 는 body data-week 에 이미 있으면 URL 에 안 박음)
  const newUrl = new URL(location.href);
  newUrl.searchParams.set('lid', raw);
  const bodyWeek = document.body && document.body.getAttribute('data-week');
  if (!bodyWeek) {
    newUrl.searchParams.set('week', String(week));
  } else {
    newUrl.searchParams.delete('week');
  }
  history.replaceState({}, '', newUrl);

  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appScreen').style.display = 'block';
  startBtn.disabled = false;
  startBtn.textContent = '피드백 보기 · Xem phản hồi →';

  // 세션 ID 확정 + 메타 문서 set (await 으로 메타 준비된 후 본 로드)
  const pageGroupForMeta = getPageGroup();
  await initSessionMeta(raw, week, pageGroupForMeta);

  await loadAll();
}

function $(id) { return document.getElementById(id); }
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const k in (attrs||{})) {
    if (k === 'class') e.className = attrs[k];
    else if (k === 'html') e.innerHTML = attrs[k];
    else if (k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
    else e.setAttribute(k, attrs[k]);
  }
  for (const k of kids) {
    if (k == null) continue;
    if (typeof k === 'string') e.appendChild(document.createTextNode(k));
    else e.appendChild(k);
  }
  return e;
}

// ── Firebase ─────────────────────────────────────────────────────────────
//
//  Firestore 계층 구조 (기존 study_week*.html 과 동일 키 정합, 컬렉션만 분리):
//
//  feedback_views/{learnerId}/                       ← 마커 문서 (rerecorded_W{week})
//    sessions/{sessionId}
//      │  learnerId, sessionId, attemptId, studyId, week, group, mode:'feedback'
//      │  startedAt, userAgent, platform, language, screenW, screenH
//      │
//      ├── events/{autoId}    ← 모든 행동 로그
//      │     eventType:  session_start | session_end
//      │                  page_enter   | page_leave
//      │                  audio_play   | tts_speak
//      │                  rec_start    | rec_stop | rec_uploaded | session_complete
//      │     page:       슬라이드 인덱스
//      │     pageLabel:  슬라이드 이름 (cover/personalized/...)
//      │     slidePos:   현재 슬라이드 위치
//      │     elapsed:    세션 시작부터 경과 초
//      │     attemptId:  시도 차수 (01, 02…)
//      │     payload:    { 이벤트별 상세 }
//      │     ts:         서버 타임스탬프
//      │
//      └── recordings/{wordKey}   ← 단어별 재녹음 (doc id = baji/bbareuda/...)
//            word, wordKey, filename, storagePath, fileUrl, mimeType,
//            durationSec, size, attemptCount, uploadedAt
//
//  Storage (재녹음 전용 폴더):
//    recordings/{EXPERIMENT_ID}/{learnerId}/week{WEEK}_feedback/{learnerId}_W{WEEK}_{word}_retry_{ts}.{ext}
//    ※ 본녹음(study_week*.html)은 recordings/{EXPERIMENT_ID}/{learnerId}/week{WEEK}/ 에 저장됨
// ═══════════════════════════════════════════════════════════════════════
function initFirebase() {
  if (OFFLINE) {
    console.log('%c[OFFLINE_MODE]', 'color:#f5820a;font-weight:bold', 'Firebase 비활성');
    return;
  }
  try {
    firebase.initializeApp(cfg);
    db = firebase.firestore();
    storage = firebase.storage();
    fbReady = true;
    console.log('Firebase OK · waiting for learner ID');
  } catch (e) {
    console.warn('Firebase 초기화 실패:', e);
  }
  // 주기적 버퍼 플러시
  if (!_flushTimer) _flushTimer = setInterval(flushLogBuffer, BUFFER_FLUSH_INTERVAL);
}

// 학습자 ID 확정 후 세션 ID 생성 + 메타 문서 set + ATTEMPT_ID 조회
function initSessionMeta(lid, week, group) {
  if (!lid || sessionMetaReady) return Promise.resolve();
  const iso = new Date().toISOString().slice(0,19).replace(/[T:]/g,'-');
  SESSION_ID = STUDY_ID + '_W' + week + '_' + lid + '_FB_' + iso;   // _FB_ 로 학습 세션과 구별
  sessionStart = Date.now();

  if (IS_ADMIN || OFFLINE || !fbReady) {
    ATTEMPT_ID = '00';
    sessionMetaReady = true;
    console.log('[session] SESSION_ID=' + SESSION_ID + ' (skip meta — admin/offline/no-fb)');
    return Promise.resolve();
  }

  const learnerRef = db.collection(window.FEEDBACK_LOG_COLLECTION).doc(lid);
  return learnerRef.collection('sessions').get()
    .then(snap => {
      const count = snap.size + 1;
      ATTEMPT_ID = (count < 10 ? '0' : '') + count;
    })
    .catch(() => { ATTEMPT_ID = 'T' + Date.now().toString().slice(-4); })
    .then(() => {
      return learnerRef.collection('sessions').doc(SESSION_ID).set({
        learnerId: lid,
        sessionId: SESSION_ID,
        attemptId: ATTEMPT_ID,
        studyId:   STUDY_ID,
        week:      week,
        group:     group,
        mode:      'feedback',
        startedAt: firebase.firestore.FieldValue.serverTimestamp(),
        userAgent: navigator.userAgent.slice(0,120),
        platform:  navigator.platform || '',
        language:  navigator.language || '',
        screenW:   window.screen.width,
        screenH:   window.screen.height
      }, { merge: true });
    })
    .then(() => {
      sessionMetaReady = true;
      console.log('Session meta OK | Learner:', lid, '| Session:', SESSION_ID, '| Attempt:', ATTEMPT_ID);
      flushLogBuffer();
    })
    .catch(e => {
      console.warn('세션 메타 저장 실패 (계속 진행):', e);
      sessionMetaReady = true;   // 메타 실패해도 이벤트 로그는 시도
      flushLogBuffer();
    });
}

function flushLogBuffer() {
  if (IS_ADMIN || OFFLINE || !fbReady || !sessionMetaReady) return;
  if (LOG_BUFFER.length === 0) return;
  const toSend = LOG_BUFFER.splice(0, 20);
  const col = db.collection(window.FEEDBACK_LOG_COLLECTION).doc(CURRENT.lid)
                .collection('sessions').doc(SESSION_ID).collection('events');
  const batch = db.batch();
  toSend.forEach(item => {
    batch.set(col.doc(), Object.assign(item, {
      ts:       firebase.firestore.FieldValue.serverTimestamp(),
      buffered: true
    }));
  });
  batch.commit().catch(() => {
    LOG_BUFFER.unshift.apply(LOG_BUFFER, toSend);
  });
}

// 기존 study_week*.html 의 sendLog() 와 동일한 페이로드 구조
function log(eventType, payload) {
  const page = currentSlide;
  const pageLabel = slideList[currentSlide] || '';
  const logData = {
    eventType,
    page,
    pageLabel,
    slidePos:  page,
    elapsed:   Math.round((Date.now() - sessionStart) / 1000),
    attemptId: ATTEMPT_ID,
    learnerId: CURRENT.lid,
    week:      CURRENT.week,
    group:     CURRENT.group,
    tType:     CURRENT.t,
    sessionId: SESSION_ID,
    payload:   payload || {}
  };

  if (IS_ADMIN) { console.log('[ADMIN/skip]', eventType, logData); return; }
  if (!fbReady || !sessionMetaReady) {
    LOG_BUFFER.push(logData);
    return;
  }
  db.collection(window.FEEDBACK_LOG_COLLECTION)
    .doc(CURRENT.lid).collection('sessions').doc(SESSION_ID)
    .collection('events').add(Object.assign(logData, {
      ts: firebase.firestore.FieldValue.serverTimestamp()
    }))
    .catch(() => { LOG_BUFFER.push(logData); });
}

// ── 데이터 로드 ──────────────────────────────────────────────────────────
async function loadAll() {
  const p = getParams();
  CURRENT.lid = p.lid; CURRENT.week = p.week; CURRENT.group = p.group;
  if (!p.lid) return showError('학습자 ID(lid)가 URL에 없습니다. 예: ?lid=A05&week=1');

  // 캐시 무효화 — 콘텐츠/데이터 JSON 은 매 로드마다 새로 받아옴
  // (브라우저가 끈질기게 캐싱하는 경우 방지 — admin 검수 / 콘텐츠 수정 직후 즉시 반영)
  const _cb = '?_=' + Date.now();
  const _fetchOpt = { cache: 'no-store' };

  // 1) 학습자 측정 데이터 로드 — t_type 이 여기 자동 판정 결과로 들어 있음
  //
  //    ※ 테스트 ID (A90/A91/B90/B91) 는 측정 데이터 파일이 없으므로
  //      같은 그룹의 *01 데이터로 폴백 (A* → A01, B* → B01).
  //      식별자 (CURRENT.lid), Firestore/Storage 경로, 로그는 본인 ID 그대로 유지.
  const isTestId = TEST_IDS_ALL.indexOf(p.lid) !== -1;
  const dataLid  = isTestId ? (p.lid.charAt(0).toUpperCase() + '01') : p.lid;
  const dataUrl  = `data/${dataLid}_W${p.week}.json`;
  if (isTestId) {
    console.log('%c[TEST_ID]', 'color:#9f86ff;font-weight:bold',
      `${p.lid} — 측정 데이터를 ${dataLid} 로 폴백`);
  }
  try {
    const r = await fetch(dataUrl + _cb, _fetchOpt);
    if (!r.ok) throw new Error(`fetch ${r.status}`);
    CURRENT.data = await r.json();
    // 폴백한 사실을 데이터에 표시 (보고용)
    if (isTestId) {
      CURRENT.data._test_fallback_from = dataLid;
      CURRENT.data._test_actual_lid    = p.lid;
    }
  } catch (e) {
    return showError(`측정 데이터 없음: <code>${dataUrl}</code><br>` +
      `<span style="font-size:11px">학습자 녹음 파일이 pipeline/input/에 있는지, build.py 가 돌았는지 확인하세요.</span>`);
  }

  // 2) assignments.json 은 수동 오버라이드용 (선택)
  let assignments = {};
  try {
    assignments = await (await fetch('assets/content/assignments.json' + _cb, _fetchOpt)).json();
  }
  catch (e) { console.warn('assignments.json 로드 실패 (자동 분류만 사용):', e); }

  // 3) 내부 콘텐츠 분기용 식별자 (학습자에게는 노출 안 함)
  //    테스트 ID 는 폴백 ID 의 assignments / t_type 을 사용
  CURRENT.t = assignments[dataLid] || CURRENT.data.t_type;
  if (!CURRENT.t) return showError(
    `<b>${p.lid}</b> 피드백 데이터에 분류 정보가 없습니다.<br>` +
    `<span style="font-size:11px">build.py 가 정상 종료됐는지 확인하세요. (${dataUrl})</span>`
  );

  // 4) content/T?.json 로드
  try {
    CURRENT.content = await (await fetch(`assets/content/${CURRENT.t}.json` + _cb, _fetchOpt)).json();
  }
  catch (e) { return showError(`content/${CURRENT.t}.json 로드 실패: ${e.message}`); }

  buildAll();
}

function showError(msg) {
  $('loading').style.display = 'none';
  $('content').style.display = 'block';
  $('content').innerHTML = `<div class="error" style="padding:30px;color:#ff6b6b;line-height:1.6">⚠️ ${msg}</div>`;
}

// ── UI 빌드 ──────────────────────────────────────────────────────────────
function buildAll() {
  const c = CURRENT.content, d = CURRENT.data, g = CURRENT.group;

  // 상단 바 (T 유형은 학습자에게 노출하지 않음)
  $('lid-chip').textContent = CURRENT.lid;
  $('group-chip').textContent = `${g} 그룹`;
  $('group-chip').className = `group-chip group-${g}`;
  // t-chip 은 사용 안 함 (CSS display:none 으로 숨김 + 텍스트 빈값)
  const tc = $('t-chip'); if (tc) tc.textContent = '';

  // 슬라이드 빌드
  const root = $('slides');
  root.innerHTML = '';
  slideList = [];

  root.appendChild(buildCover(c));               slideList.push('cover');
  root.appendChild(buildPersonalized(c, d, g));  slideList.push('personalized');
  root.appendChild(buildHowToRead(c, g, d));     slideList.push('how_to_read');
  for (const w of ['baji','bbareuda','paransaek','dari','ddatteut','tada','gabang','ggamansaek','kadeu']) {
    if (d.words[w]) {
      const bw = (d.ai_feedback && d.ai_feedback.by_word) || {};
      root.appendChild(buildVizSlide(d.words[w], w, g, bw[w] || '', bw[w + '_vn'] || ''));
      slideList.push('viz_' + w);
    }
  }
  root.appendChild(buildPractice(c, d));         slideList.push('practice');
  root.appendChild(buildRerecord(c, g));         slideList.push('rerecord');
  root.appendChild(buildComplete(c, CURRENT.week));
  slideList.push('complete');

  // 단어별 녹음 상태 초기화 (W2/W3 진입 시에도 깨끗하게)
  for (let i = 1; i <= 3; i++) {
    recs[i].recording = false; recs[i].blob = null; recs[i].chunks = [];
    recs[i].sec = 0; recs[i].attemptCount = 0; recs[i].uploaded = false;
    if (recs[i].timer) { clearInterval(recs[i].timer); recs[i].timer = null; }
  }

  // 첫 슬라이드 활성화
  $('loading').style.display = 'none';
  $('content').style.display = 'block';
  showSlide(0);
  log('session_start', { slideCount: slideList.length, mode: 'feedback' });
}

function buildCover(c) {
  const s = el('section', {class:'slide', id:'slide-cover'},
    el('div', {class:'hero'},
      el('div', {class:'hero-title', html: c.cover.title}),
      el('div', {class:'hero-title-vn'}, c.cover.title_vn)
    ),
    el('div', {class:'card'},
      el('div', {class:'card-head'},
        el('div', {class:'card-badge blue'}, '01'),
        el('div', null,
          el('div', {class:'card-title'}, c.cover.subtitle),
          el('div', {class:'card-sub'}, c.cover.subtitle_vn)
        )
      ),
      el('div', {class:'flow'},
        el('div', {class:'flow-step'}, '오류 확인'),
        el('span', {class:'flow-arrow'}, '→'),
        el('div', {class:'flow-step'}, '교정 설명'),
        el('span', {class:'flow-arrow'}, '→'),
        el('div', {class:'flow-step'}, '시각화'),
        el('span', {class:'flow-arrow'}, '→'),
        el('div', {class:'flow-step'}, '핵심'),
        el('span', {class:'flow-arrow'}, '→'),
        el('div', {class:'flow-step'}, '연습'),
        el('span', {class:'flow-arrow'}, '→'),
        el('div', {class:'flow-step'}, '재녹음')
      )
    )
  );
  return s;
}

function withVn(text, vn) {
  // 한글 문장 + 베트남어 번역을 한 묶음으로 반환 (DOM Fragment)
  const frag = document.createDocumentFragment();
  if (text) frag.appendChild(document.createTextNode(text));
  if (vn) {
    const v = document.createElement('div');
    v.className = 'vn';
    v.textContent = vn;
    frag.appendChild(v);
  }
  return frag;
}

// ── 음성 (Web Speech API · 브라우저 내장 TTS) ───────────────────────────
const _voiceCache = { ready: false, ko: false, vi: false };
function _refreshVoices() {
  if (!('speechSynthesis' in window)) return;
  const vs = window.speechSynthesis.getVoices();
  _voiceCache.ko = vs.some(v => (v.lang || '').toLowerCase().startsWith('ko'));
  _voiceCache.vi = vs.some(v => (v.lang || '').toLowerCase().startsWith('vi'));
  _voiceCache.ready = vs.length > 0;
}
if ('speechSynthesis' in window) {
  _refreshVoices();
  window.speechSynthesis.onvoiceschanged = _refreshVoices;
}

function speak(text, lang) {
  if (!text || !('speechSynthesis' in window)) return;
  // 이전 발화 중단 (연속 클릭 대응)
  try { window.speechSynthesis.cancel(); } catch (e) {}
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;          // 'ko-KR' / 'vi-VN'
  u.rate = 0.95;
  u.pitch = 1.0;
  u.volume = 1.0;
  window.speechSynthesis.speak(u);
  log('tts_speak', { lang: lang, length: text.length });
}

function speakBtn(text, lang, label) {
  const isKo = lang.startsWith('ko');
  const cls = 'speak-btn ' + (isKo ? 'speak-ko' : 'speak-vi');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = cls;
  btn.title = isKo ? '한국어로 듣기 · Nghe tiếng Hàn' : 'Nghe tiếng Việt · 베트남어로 듣기';
  btn.innerHTML = '🔊' + (label ? ' <span class="speak-lbl">' + label + '</span>' : '');
  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    speak(text, lang);
  });
  // 해당 언어 음성이 없으면 흐리게 표시
  if (_voiceCache.ready && ((isKo && !_voiceCache.ko) || (!isKo && !_voiceCache.vi))) {
    btn.classList.add('speak-na');
    btn.title = (isKo ? '한국어' : 'Tiếng Việt') + ' 음성이 이 기기에 설치되어 있지 않습니다';
  }
  return btn;
}

// ── 오디오 파일 재생 (원어민 견본 · 본인 녹음) ───────────────────────────
let _activeAudio = null;
function playAudioFile(path) {
  if (!path) return;
  try {
    if (_activeAudio) { _activeAudio.pause(); _activeAudio = null; }
  } catch (e) {}
  const a = new Audio(path);
  _activeAudio = a;
  a.play().catch(function (err) {
    console.warn('audio play failed:', err);
  });
  log('audio_play', { path: path });
}

function audioBtn(path, kind, label) {
  // kind: 'native' (원어민 견본) | 'mine' (본인 녹음)
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'speak-btn audio-' + kind;
  const icon = (kind === 'native') ? '🎙️' : '🎤';
  btn.title = (kind === 'native')
    ? '원어민 발음 · Phát âm chuẩn'
    : '내 녹음 · Bản ghi của tôi';
  btn.innerHTML = icon + (label ? ' <span class="speak-lbl">' + label + '</span>' : '');
  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    playAudioFile(path);
  });
  if (!path) {
    btn.classList.add('speak-na');
    btn.title += ' (파일 없음)';
    btn.disabled = true;
  }
  return btn;
}

function withVnSpeak(kr, vn) {
  // 한국어 → 베트남어 → 🔊 버튼 (KR + VN) 순. AI 피드백 본문용.
  const frag = document.createDocumentFragment();
  if (kr) frag.appendChild(document.createTextNode(kr));
  if (vn) {
    const v = document.createElement('div');
    v.className = 'vn';
    v.textContent = vn;
    frag.appendChild(v);
  }
  if (kr) {
    const bar = document.createElement('div');
    bar.className = 'speak-bar';
    bar.appendChild(speakBtn(kr, 'ko-KR', 'KR'));
    if (vn) bar.appendChild(speakBtn(vn, 'vi-VN', 'VN'));
    frag.appendChild(bar);
  }
  return frag;
}

function buildPersonalized(c, d, group) {
  const ai = d.ai_feedback || {};
  const ea = ai.error_analysis || {};
  const cor = ai.correction || {};
  const steps_vn = cor.steps_vn || [];
  const steps = (cor.steps || []).map((s, i) => {
    const li = el('li', null, s);
    if (steps_vn[i]) {
      const v = document.createElement('div');
      v.className = 'vn';
      v.textContent = steps_vn[i];
      li.appendChild(v);
    }
    return li;
  });

  // 단어별 차이 요약 (overview 보조)
  const diffRows = [];
  for (const w of ['baji','bbareuda','paransaek','dari','ddatteut','tada','gabang','ggamansaek','kadeu']) {
    const wd = d.words[w]; if (!wd) continue;
    const diff = wd.diff || {};
    const flags = (wd.learner && wd.learner.flags) || [];
    let line;
    if (flags.length) {
      line = `⚠ 측정 불안정 (${flags.join(', ')})`;
    } else {
      const vot = diff.vot_ms_diff;
      const stD = diff.f0_a_pattern_diff_st;
      const votTxt = (vot != null) ? `VOT ${vot>0?'+':''}${vot.toFixed(0)} ms` : 'VOT 측정실패';
      const f0Txt  = (stD != null) ? `F0 패턴 ${stD>0?'+':''}${stD.toFixed(1)} st` : 'F0 측정실패';
      line = `${votTxt} · ${f0Txt}`;
    }
    diffRows.push(el('div', {class:'overview-row'},
      el('div', {class:'overview-word'}, wd.word_kr),
      el('div', {class:'overview-diff'}, line)
    ));
  }

  return el('section', {class:'slide', id:'slide-personalized'},
    // ─── 카드 1: 오류 분석 ───
    el('div', {class:'card'},
      el('div', {class:'card-head'},
        el('div', {class:'card-badge'}, '01'),
        el('div', null,
          el('div', {class:'card-title'}, '📝 발음 오류 분석'),
          el('div', {class:'card-sub'}, '학습자 측정값을 바탕으로 한 개인화 진단')
        )
      ),
      el('div', {class:'err-feature'},
        el('div', {class:'err-feature-label'}, '◆ 핵심 오류'),
        el('div', null, withVn(ea.summary || '(분석 없음)', ea.summary_vn))
      ),
      el('div', {class:'pers-detail'}, withVn(ea.detail || '', ea.detail_vn)),
      el('div', {class:'overview-summary'},
        el('div', {class:'overview-label'}, '단어별 원어민 대비 차이'),
        ...diffRows
      )
    ),
    // ─── 카드 2: 원인 ───
    el('div', {class:'card'},
      el('div', {class:'card-head'},
        el('div', {class:'card-badge blue'}, '02'),
        el('div', null, el('div', {class:'card-title'}, '🔍 왜 이런 오류가 나타날까?'))
      ),
      el('div', {class:'err-cause'},
        el('div', null, withVn(ai.cause || '', ai.cause_vn))
      )
    ),
    // ─── 카드 3: 교정 가이드 ───
    el('div', {class:'card'},
      el('div', {class:'card-head'},
        el('div', {class:'card-badge teal'}, '03'),
        el('div', null,
          el('div', {class:'card-title'}, '🎯 교정 가이드'),
          el('div', {class:'card-sub'}, withVn(cor.main_focus || '', cor.main_focus_vn))
        )
      ),
      el('ol', {class:'steps'}, ...steps)
    ),
    // ─── 카드 4: 종합 평가 ───
    el('div', {class:'card'},
      el('div', {class:'card-head'},
        el('div', {class:'card-badge'}, '04'),
        el('div', null, el('div', {class:'card-title'}, '📊 종합 평가'))
      ),
      el('div', {class:'pers-overall'}, withVn(ai.overall || '', ai.overall_vn)),
      el('div', {class:'encouragement', style:'margin-top:12px'},
         withVn(ai.encouragement || '', ai.encouragement_vn))
    )
  );
}

// 그룹별 그림 읽는 법 — T 유형과 무관하게 항상 같음 (각 단어의 시각화 형식이 동일하므로)
const VIZ_GUIDE = {
  A: {
    pts: [
      '① 가로축은 시간 — 왼쪽에서 오른쪽으로 흐릅니다. 단위는 ms (밀리초). 그림 아래 숫자로 각 구간 길이가 표시됩니다.',
      '② 위 그래프 = 파형 — 검은 선이 위아래로 흔들리는 정도가 소리 크기. 자음·모음 경계가 눈에 보입니다.',
      '③ 아래 그래프 = 스펙트로그램 — 세로축은 주파수(0–5 kHz). 검정/회색이 진할수록 그 주파수에 에너지가 많다는 뜻.',
      '④ 파란 곡선 = F0 (모음의 음높이, Hz) — 위로 올라갈수록 높은 소리. 그림 아래 「F0(ㅏ) ___ Hz」 숫자가 모음 ㅏ 구간의 평균 음높이입니다.',
      '⑤ 맨 아래 칸 = 단어를 자음·모음으로 나눈 표시 — 첫 칸의 너비가 VOT (자음이 터지고 모음이 시작되기까지 시간). 격음(파/ㅍ)일수록 넓고, 경음(빠/ㅃ)일수록 좁고, 평음(바/ㅂ)은 그 사이.',
      '⑥ 왼쪽 = 원어민 견본 / 오른쪽 = 학습자 본인. 두 패널을 나란히 두고 ① 첫 칸 너비(VOT) ② 파란 곡선 높이(F0) 가 얼마나 비슷한지 확인하세요.',
    ],
    ptsVn: [
      '① Trục ngang là thời gian — chạy từ trái sang phải, đơn vị ms (mili giây). Bên dưới hình có số đo độ dài từng đoạn.',
      '② Biểu đồ trên = dạng sóng — độ dao động lên xuống của đường đen thể hiện độ lớn âm thanh. Có thể thấy ranh giới giữa phụ âm và nguyên âm.',
      '③ Biểu đồ dưới = phổ — trục dọc là tần số (0–5 kHz). Càng đậm thì tại tần số đó càng nhiều năng lượng.',
      '④ Đường xanh = F0 (cao độ nguyên âm, Hz) — càng cao càng là âm cao. Số «F0(ㅏ) ___ Hz» dưới hình là cao độ trung bình của đoạn ㅏ.',
      '⑤ Ô dưới cùng = chia từ thành phụ âm và nguyên âm — độ rộng của ô đầu chính là VOT (thời gian từ khi phụ âm bật ra đến khi nguyên âm bắt đầu). Bật hơi (격음 - 파/ㅍ) thì rộng nhất, căng (경음 - 빠/ㅃ) thì hẹp nhất, bình (평음 - 바/ㅂ) ở giữa.',
      '⑥ Trái = mẫu người bản xứ / Phải = bản ghi của bạn. Đặt hai bên cạnh nhau và kiểm tra: ① độ rộng ô đầu (VOT) và ② độ cao đường xanh (F0) giống nhau bao nhiêu.',
    ],
  },
  B: {
    pts: [
      '① 가로축 = VOT (자음이 터지고 모음이 시작되기까지의 숨 길이, ms). 왼쪽은 짧음(경음 ㅃ 영역), 오른쪽은 김(격음 ㅍ 영역).',
      '② 세로축 = F0 (모음의 음높이) — 단위는 semitone. 화자 자기 평균에서 얼마나 위/아래로 떨어졌는지를 나타냅니다. **남녀의 절대 음높이 차이를 자동으로 보정**해 학습자와 원어민을 같은 기준으로 비교합니다.',
      '③ 베트남어 4성조 메타포: 위쪽 = ▲ sắc (소리 높게), 아래쪽 = ▼ huyền (소리 낮게), 왼쪽 = ◀ nặng (목 조이고 짧게), 오른쪽 = bật hơi ▶ (숨 길게 내쉬기). 익숙한 성조 방향으로 한국어 자음 위치를 떠올리세요.',
      '④ 색깔 타원 3개 = 원어민이 한국어 평음/경음/격음을 발음할 때 떨어지는 영역 — **이 학습 단어의 원어민 견본 측정값**을 중심으로 그려져 있습니다.',
      '⑤ 파란 점 = 원어민 견본 위치 / 빨간 점 = 학습자 본인 위치. 두 점이 같은 클러스터 안에 있어야 발음이 비슷한 것입니다.',
      '⑥ 초록 화살표 = 학습자가 원어민 위치로 이동하기 위한 방향. 화살표가 위로 향하면 음높이를 더 높게, 오른쪽이면 숨을 더 길게.',
    ],
    ptsVn: [
      '① Trục ngang = VOT (độ dài hơi từ khi bật phụ âm đến khi nguyên âm bắt đầu, ms). Trái = ngắn (vùng âm căng ㅃ), phải = dài (vùng âm bật hơi ㅍ).',
      '② Trục dọc = F0 (cao độ nguyên âm) — đơn vị semitone, thể hiện bạn lệch lên/xuống bao nhiêu so với cao độ trung bình của chính mình. **Tự động bù trừ chênh lệch giọng nam/nữ** để so sánh người học và người bản xứ trên cùng một thang.',
      '③ Phép ẩn dụ 4 thanh điệu tiếng Việt: trên = ▲ sắc (giọng cao), dưới = ▼ huyền (giọng thấp), trái = ◀ nặng (siết cổ họng, ngắn), phải = bật hơi ▶ (hơi dài). Hãy hình dung vị trí phụ âm Hàn theo các hướng thanh điệu quen thuộc.',
      '④ Ba hình elip màu = vùng mà người bản xứ phát âm âm thường/căng/bật hơi của tiếng Hàn — được vẽ quanh **giá trị đo của người bản xứ ở chính từ này**.',
      '⑤ Chấm xanh = vị trí mẫu người bản xứ / Chấm đỏ = vị trí của bạn. Hai chấm cần nằm trong cùng một cụm thì phát âm mới giống.',
      '⑥ Mũi tên xanh lá = hướng bạn cần di chuyển để tới vị trí người bản xứ. Mũi tên hướng lên = nâng cao độ; hướng phải = kéo dài hơi.',
    ],
  },
};

function buildHowToRead(c, group, d) {
  const k = c.key_points;
  // A·B 그룹: 그림 읽는 법으로 교체 (T 유형 무관)
  // C 그룹: 기존 T 유형별 학습 포인트 사용
  let pts, ptsVn;
  if (VIZ_GUIDE[group]) {
    pts   = VIZ_GUIDE[group].pts;
    ptsVn = VIZ_GUIDE[group].ptsVn;
  } else {
    pts   = (k.points_by_group && k.points_by_group[group]) || [];
    ptsVn = (k.points_vn_by_group && k.points_vn_by_group[group]) || [];
  }

  const subtitle    = group === 'C' ? '발음 학습 포인트' : '시각화를 보는 법';
  const subtitle_vn = group === 'C' ? 'Điểm học phát âm' : 'Cách đọc hình ảnh trực quan';
  const cardSub    = group === 'A' ? 'PRAAT 파형·스펙트로그램 보는 법'
                   : group === 'B' ? '발음 나침반(VOT × F0) 보는 법'
                                   : '핵심 학습 포인트';
  const cardSub_vn = group === 'A' ? 'Cách đọc dạng sóng và phổ PRAAT'
                   : group === 'B' ? 'Cách đọc la bàn phát âm (VOT × F0)'
                                   : 'Điểm học cốt lõi';
  const intro    = group === 'C'
    ? '아래 포인트를 머릿속에 두고 다음 단계로 넘어가세요.'
    : '다음 페이지부터 단어별 시각화가 나옵니다. 그림의 각 요소가 무엇을 뜻하는지 먼저 익혀 두세요.';
  const intro_vn = group === 'C'
    ? 'Hãy ghi nhớ các điểm dưới đây rồi chuyển sang bước tiếp theo.'
    : 'Từ trang tiếp theo bạn sẽ thấy hình minh hoạ từng từ. Trước tiên hãy nắm rõ ý nghĩa của từng thành phần trong hình.';

  // 페이지 3 은 정적 시각화 가이드만 — compass_overview 카드는 폐기됨 (by_word 와 중복)
  return el('section', {class:'slide', id:'slide-howtoread'},
    el('div', {class:'card'},
      el('div', {class:'card-head'},
        el('div', {class:'card-badge orange'}, '🧭'),
        el('div', null,
          el('div', {class:'card-title'}, subtitle),
          el('div', {class:'card-title-vn', style:'font-size:12px;color:var(--muted);margin-top:2px'}, subtitle_vn),
          el('div', {class:'card-sub'}, cardSub),
          el('div', {class:'card-sub vn'}, cardSub_vn)
        )
      ),
      el('div', {class:'howto-intro'}, withVn(intro, intro_vn)),
      el('ul', {class:'key-list'}, ...pts.map((p, i) => el('li', null, withVn(p, ptsVn[i] || '')))),
      el('div', {class:'overview-next'}, withVn('↓ 단어 하나씩 살펴보겠습니다', '↓ Xem từng từ một'))
    )
  );
}

function buildErrorType(c, group) {
  const e_ = c.error_type;
  return el('section', {class:'slide', id:'slide-error'},
    el('div', {class:'card'},
      el('div', {class:'card-head'},
        el('div', {class:'card-badge'}, e_.number),
        el('div', null, el('div', {class:'card-title'}, e_.title))
      ),
      el('div', {class:'err-feature'},
        el('div', {class:'err-feature-label'}, '◆ 오류 특징'),
        el('div', null, e_.features),
        el('div', {class:'vn'}, e_.features_vn)
      ),
      el('div', {class:'err-examples'}, '예) ' + e_.examples),
      el('div', {class:'err-cause'},
        el('div', {class:'err-label cause'}, '● 원인'),
        el('div', null, e_.cause),
        el('div', {class:'vn'}, e_.cause_vn)
      ),
      el('div', {class:'err-goal'},
        el('div', {class:'err-label goal'}, '● 이번 교정 목표'),
        el('div', null, e_.goal_by_group[group]),
        el('div', {class:'vn'}, e_.goal_vn_by_group[group])
      )
    )
  );
}

function buildCorrection(c) {
  const cor = c.correction;
  const sections = cor.sections.map(sec =>
    el('div', {class:'corr-section'},
      el('div', {class:'corr-heading'},
        sec.heading,
        el('span', {class:'vn'}, sec.heading_vn)
      ),
      ...sec.items.map(it =>
        el('div', {class:'corr-item'},
          el('div', null, it.k),
          el('div', {class:'vn'}, it.vn)
        )
      )
    )
  );
  return el('section', {class:'slide', id:'slide-correction'},
    el('div', {class:'card'},
      el('div', {class:'card-head'},
        el('div', {class:'card-badge teal'}, cor.number),
        el('div', null, el('div', {class:'card-title'}, cor.title))
      ),
      el('div', {class:'corr-intro'},
        cor.intro,
        el('div', {class:'vn'}, cor.intro_vn)
      ),
      ...sections,
      el('div', {class:'corr-warning'},
        cor.warning,
        el('div', {class:'vn'}, cor.warning_vn)
      )
    )
  );
}

function buildOverview(c, d, group) {
  const ai = d.ai_feedback || {};
  const wordSummaries = [];
  for (const w of ['baji','bbareuda','paransaek','dari','ddatteut','tada','gabang','ggamansaek','kadeu']) {
    const wd = d.words[w]; if (!wd) continue;
    const diff = wd.diff || {};
    wordSummaries.push(el('div', {class:'overview-row'},
      el('div', {class:'overview-word'}, wd.word_kr),
      el('div', {class:'overview-diff'},
        `VOT ${(diff.vot_ms_diff>0?'+':'')}${(diff.vot_ms_diff||0).toFixed(0)} ms · ` +
        `F0 ${(diff.f0_a_hz_diff>0?'+':'')}${(diff.f0_a_hz_diff||0).toFixed(0)} Hz`)
    ));
  }
  return el('section', {class:'slide', id:'slide-overview'},
    el('div', {class:'card'},
      el('div', {class:'card-head'},
        el('div', {class:'card-badge blue'}, '🔍'),
        el('div', null,
          el('div', {class:'card-title'}, '종합 의견'),
          el('div', {class:'card-sub'}, '세 단어를 종합한 학습자별 평가')
        )
      ),
      el('div', {class:'overview-text', html: (ai.overview || '(AI 평가 없음)').replace(/\n/g,'<br>')}),
      el('div', {class:'overview-summary'},
        el('div', {class:'overview-label'}, '단어별 원어민 대비 차이'),
        ...wordSummaries
      ),
      el('div', {class:'overview-next'},
        '이제 단어 하나씩 자세히 살펴보겠습니다. →')
    )
  );
}

function buildVizSlide(wordData, wordKey, group, comment, comment_vn) {
  // 시각화 슬라이드는 현재 placeholder 상태.
  // 추후 group A/B 별로 다른 시각화 PNG (wordData.images.A, .B) 를 끼워 넣음.
  const wd = wordData;
  const lrn = wd.learner, diff = wd.diff;
  const wordColorMap = {
    baji:'ba', bbareuda:'bba', paransaek:'pa',
    dari:'ba', ddatteut:'bba', tada:'pa',
    gabang:'ba', ggamansaek:'bba', kadeu:'pa',
  };
  const col = wordColorMap[wordKey] || 'ba';

  // 이미지: A 그룹은 wd.images.A, B 그룹은 wd.images.B, C 그룹은 없음
  const imgSrc = (group === 'A' || group === 'B') ? wd.images[group] : null;

  const placeholder = el('div', {class:'viz-placeholder'},
    el('strong', null, '시각화 슬라이드 (작성 예정)'),
    el('div', null, group === 'C' ? '통제 그룹: 시각화 없이 텍스트 핵심 포인트만' :
                                     `${group} 시각화 + 보는 법 안내 페이지가 여기 들어갈 예정입니다.`)
  );

  return el('section', {class:'slide', id:`slide-viz-${wordKey}`},
    el('div', {class:'card viz-card'},
      el('div', {class:'card-head'},
        el('div', {class:`viz-word-chip ${col}`}, wd.word_kr),
        el('div', null,
          el('div', {class:'card-title'},
            wd.word_kr + '  ·  단어별 분석'
          ),
          el('div', {class:'card-sub'}, group === 'C' ? '통제 그룹 · 텍스트 피드백' : `${group} 그룹 · 시각화 + AI 코멘트`),
          el('div', {class:'audio-bar'},
            audioBtn(wd.native_audio, 'native', '원어민'),
            audioBtn(wd.local_audio,  'mine',   '내 녹음')
          )
        )
      ),
      // ── 80% 영역: 시각화 ──
      el('div', {class:'viz-80'},
        imgSrc
          ? el('div', {class:'viz-image'}, el('img', {src: imgSrc, alt: `${wd.word_kr} ${group} 시각화`}))
          : placeholder,
        el('div', {class:'viz-metrics'},
          metricBox('VOT',
            (lrn.vot_ms != null) ? (lrn.vot_ms.toFixed(0)+' ms') : '(불안정)',
            diff.vot_ms_diff),
          metricBox('F0(ㅏ)',
            (lrn.f0_a_hz != null) ? (lrn.f0_a_hz.toFixed(0)+' Hz') : '(불안정)',
            diff.f0_a_hz_diff),
          metricBox('발화', (lrn.duration_s*1000).toFixed(0)+' ms', null)
        )
      ),
      // ── 20% 영역: AI 짧은 코멘트 (한·베 짝) ──
      el('div', {class:'viz-20'},
        el('div', {class:'viz-comment-label'}, '💬 AI 코멘트'),
        el('div', {class:'viz-comment'}, withVn(comment || '코멘트 없음', comment_vn))
      )
    )
  );
}

function metricBox(label, value, diff) {
  const kids = [
    el('div', {class:'viz-metric-label'}, label),
    el('div', {class:'viz-metric-value'}, value),
  ];
  if (diff != null && !isNaN(diff)) {
    const sign = diff > 0 ? '+' : '';
    kids.push(el('div', {class:'viz-metric-diff'}, `원어민 대비 ${sign}${diff.toFixed(0)}`));
  }
  return el('div', {class:'viz-metric'}, ...kids);
}

function buildKeyPoints(c, group) {
  const k = c.key_points;
  const pts = k.points_by_group[group] || [];
  return el('section', {class:'slide', id:'slide-key'},
    el('div', {class:'card'},
      el('div', {class:'card-head'},
        el('div', {class:'card-badge'}, k.number),
        el('div', null, el('div', {class:'card-title'}, k.title))
      ),
      el('ul', {class:'key-list'}, ...pts.map(p => el('li', null, p)))
    )
  );
}

function buildPractice(c, d) {
  const p = c.practice;
  // 단어(한글) → 음원 경로 매핑 (학습자 데이터에서 끌어옴)
  const audioMap = {};
  const wordsData = (d && d.words) || {};
  for (const wk in wordsData) {
    const w = wordsData[wk];
    if (w && w.word_kr) {
      audioMap[w.word_kr] = { native: w.native_audio, mine: w.local_audio };
    }
  }
  // 주차별 단어 자동 매핑 — T*.json practice.syllables 는 W1 단어로 고정되어 있어
  // W2/W3 학습자에게는 학습자 본인의 word_kr 으로 교체하고 원어민 음원도 연결.
  // 순서 [평음, 경음, 격음] — build.py WEEK_WORDS 순서와 동일.
  const wordKeysOrdered = Object.keys(wordsData);

  return el('section', {class:'slide', id:'slide-practice'},
    el('div', {class:'card'},
      el('div', {class:'card-head'},
        el('div', {class:'card-badge teal'}, p.number),
        el('div', null,
          el('div', {class:'card-title'}, p.title),
          el('div', {class:'card-sub'}, p.title_vn)
        )
      ),
      el('div', {class:'card-body', style:'margin-bottom:14px'},
        el('p', null, p.instruction),
        el('p', {class:'vn'}, p.instruction_vn)
      ),
      ...p.syllables.map((s, i) => {
        // 학습자의 word_kr 으로 표시 + 원어민 음원 연결 (주차별 자동)
        const learnerWord = (wordsData[wordKeysOrdered[i]] || {}).word_kr || s.word;
        const aud = audioMap[learnerWord] || {};
        return el('div', {class:'practice-row'},
          el('div', {class:'practice-syl'},
            el('div', {class:'practice-type ' + s.type_color}, s.type),
            el('div', {class:'practice-char'}, s.syl)
          ),
          el('div', null,
            el('div', {class:'practice-word'}, learnerWord),
            el('div', {class:'practice-vn'}, s.word_vn),
            el('div', {class:'audio-bar'},
              audioBtn(aud.native, 'native', '원어민')     // 단어: 원어민 음원만
            )
          )
        );
      })
    )
  );
}

// ═════════════════════════════════════════════════════════════════════
//  단어별 재녹음 상태 — study_week1.html 와 동일한 패턴
//  s.recording (boolean) 로 idle/recording 토글 — state 머신 충돌 방지
// ═════════════════════════════════════════════════════════════════════
const REC_WORDS_BY_WEEK = {
  1: { 1:'baji',     2:'bbareuda',    3:'paransaek' },
  2: { 1:'dari',     2:'ddatteut',    3:'tada' },
  3: { 1:'gabang',   2:'ggamansaek',  3:'kadeu' },
};
const REC_KO_BY_WEEK = {
  1: { 1:'바지',    2:'빠르다',     3:'파란색' },
  2: { 1:'다리',    2:'따뜻',       3:'타다' },
  3: { 1:'가방',    2:'까만색',     3:'카드' },
};
// 현재 주차의 단어 매핑은 buildRerecord 에서 CURRENT.week 기준으로 선택
let REC_WORDS = REC_WORDS_BY_WEEK[1];
let REC_KO    = REC_KO_BY_WEEK[1];

const recs = {
  1: { recording:false, mediaRec:null, chunks:[], blob:null, mime:'', timer:null, sec:0, attemptCount:0, uploaded:false },
  2: { recording:false, mediaRec:null, chunks:[], blob:null, mime:'', timer:null, sec:0, attemptCount:0, uploaded:false },
  3: { recording:false, mediaRec:null, chunks:[], blob:null, mime:'', timer:null, sec:0, attemptCount:0, uploaded:false },
};

// ═════════════════════════════════════════════════════════════════════
//  buildRerecord — study_week1.html 와 동일한 친절 UI
//    🔴 메인 녹음 버튼 + 타이머
//    녹음 후: ↩다시 / ▶듣기 / 💾저장 / 📤업로드 4버튼 노출
//    인라인 audio 미리듣기
//    업로드 상태 (대기/성공/실패) 색깔 표시
// ═════════════════════════════════════════════════════════════════════
function buildRerecord(c, group) {
  const r = c.rerecord;
  const inst    = (r.instructions_by_group && r.instructions_by_group[group]) || [];
  const inst_vn = (r.instructions_vn_by_group && r.instructions_vn_by_group[group]) || [];

  // 현재 주차에 맞는 단어 매핑 적용 (W1: 바지/빠르다/파란색, W2: 다리/따뜻/타다, W3: 가방/까만색/카드)
  REC_WORDS = REC_WORDS_BY_WEEK[CURRENT.week] || REC_WORDS_BY_WEEK[1];
  REC_KO    = REC_KO_BY_WEEK[CURRENT.week]    || REC_KO_BY_WEEK[1];

  // 단어 박스 3개 — study_week1.html 의 rec-word-item 패턴
  const wordBoxes = c.practice.syllables.slice(0,3).map((s, i) => {
    const idx = i + 1;
    const syl = s.syl || '';
    const word = s.word || REC_KO[idx];
    const wordVn = s.word_vn || '';

    const recItem = el('div', {class:'rec-word-item', id:`recItem_${idx}`});

    // 헤더 (단어 라벨)
    recItem.appendChild(
      el('div', {class:'rec-word-head'},
        el('div', {class:'rec-word-label'},
          el('div', {class:`rec-num-badge n${idx}`, html: `${syl}<br>0${idx}`}),
          el('div', null,
            el('div', {class:'rec-word-ko'}, word),
            el('div', {class:'rec-word-viet'}, wordVn)
          )
        )
      )
    );

    // 메인 녹음 컨트롤 (🔴 + 타이머)
    const mainBtn = el('button', {class:'rec-main-btn', id:`recBtn_${idx}`,
                                  type:'button'}, '🔴');
    mainBtn.addEventListener('click', () => toggleRec(idx));
    recItem.appendChild(
      el('div', {class:'rec-controls'},
        mainBtn,
        el('div', {class:'rec-timer', id:`recTimer_${idx}`}, '0:00')
      )
    );

    // 녹음 후 4버튼 (다시/듣기/저장/업로드) — 처음엔 hidden
    const retryBtn = el('button', {class:'rec-mini-btn btn-retry', type:'button'}, '↩ 다시 · Thử lại');
    retryBtn.addEventListener('click', () => retryRec(idx));

    const playBtn = el('button', {class:'rec-mini-btn btn-play', id:`recPlayBtn_${idx}`, type:'button'}, '▶ 듣기 · Nghe lại');
    playBtn.addEventListener('click', () => playRec(idx));

    const downloadBtn = el('button', {class:'rec-mini-btn btn-download', type:'button'}, '💾 저장 · Lưu');
    downloadBtn.addEventListener('click', () => downloadRec(idx));

    const uploadBtn = el('button', {class:'rec-mini-btn btn-upload', id:`recUpBtn_${idx}`, type:'button'}, '📤 업로드 · Tải lên');
    uploadBtn.addEventListener('click', () => uploadRec(idx));

    recItem.appendChild(
      el('div', {class:'rec-post-btns', id:`recPost_${idx}`},
        retryBtn, playBtn, downloadBtn, uploadBtn
      )
    );

    // 인라인 오디오 플레이어
    recItem.appendChild(
      el('div', {class:'rec-player-wrap', id:`recPlayer_${idx}`},
        el('audio', {id:`recAudio_${idx}`, controls:''})
      )
    );

    // 상태 메시지
    recItem.appendChild(
      el('div', {class:'rec-status-text', id:`recStatus_${idx}`},
        '🎙️ 버튼을 눌러 녹음을 시작하세요 · Nhấn nút để bắt đầu ghi âm')
    );
    recItem.appendChild(
      el('div', {class:'rec-up-status', id:`recUpStatus_${idx}`})
    );

    return recItem;
  });

  // 지시 사항 (지침이 있으면 표시)
  const instList = inst.length > 0
    ? el('ol', {class:'rerec-list', style:'margin: 10px 0 16px; padding-left: 22px; font-size: 13px; line-height: 1.7;'},
        ...inst.map((line, i) =>
          el('li', null, line, el('div', {class:'vn'}, inst_vn[i] || ''))
        ))
    : null;

  // 게이트 — 모든 단어 업로드 완료 시 .done 클래스가 추가됨
  const gate = el('div', {class:'complete-gate', id:'rerec-gate'},
    '🔒 모든 파일을 업로드해야 다음으로 넘어가며 학습이 종료됩니다.',
    el('small', null, 'Cần tải lên tất cả các bản ghi để tiếp tục và hoàn thành bài học.')
  );

  return el('section', {class:'slide', id:'slide-rerecord'},
    el('div', {class:'card'},
      el('div', {class:'card-head'},
        el('div', {class:'card-badge red'}, r.number),
        el('div', null,
          el('div', {class:'card-title'}, r.title),
          el('div', {class:'card-sub'}, r.title_vn)
        )
      ),
      instList,
      el('div', {class:'rec-status', style:'margin:10px 0 16px; padding:10px 12px; background:rgba(79,128,255,.08); border:1px solid rgba(79,128,255,.2); border-radius:10px; font-size:12px; color:var(--blue);'},
        '🎙️ 단어 3개를 각각 녹음하고 업로드해 주세요',
        el('div', {class:'vn', style:'margin-top:4px;'}, '🎙️ Ghi âm và tải lên từng từ trong 3 từ')),
      ...wordBoxes,
      el('div', {class:'rec-encourage', style:'margin-top:16px; padding:12px 14px; border-radius:12px; background:rgba(26,184,166,.08); border:1px solid rgba(26,184,166,.2); color:var(--teal); font-size:13px; line-height:1.6;'},
        r.encouragement || '천천히, 또박또박 발음해 보세요.',
        el('div', {class:'vn'}, r.encouragement_vn || 'Hãy phát âm chậm rãi và rõ ràng.')
      ),
      gate
    )
  );
}

// ═════════════════════════════════════════════════════════════════════
//  buildComplete — 학습 종료 슬라이드 (모든 업로드 완료 후 → '다음' 클릭으로 진입)
// ═════════════════════════════════════════════════════════════════════
function buildComplete(c, week) {
  return el('section', {class:'slide', id:'slide-complete'},
    el('div', {class:'complete-slide-hero'},
      el('div', {class:'complete-emoji'}, '🎉'),
      el('div', {class:'complete-title'},
        `${week}주차 학습 완료 · TUẦN ${week} HOÀN THÀNH`),
      el('div', {class:'complete-sub'}, '수고하셨습니다!'),
      el('div', {class:'complete-vn'},
        'Bạn đã hoàn thành rồi!', el('br', null),
        'Cảm ơn bạn rất nhiều')
    ),
    el('div', {class:'complete-card'},
      el('div', {class:'complete-check'}, '✅'),
      el('div', {class:'complete-card-title', html:
        '오늘의 한국어 파열음 학습을<br>모두 마쳤습니다.'}),
      el('div', {class:'complete-card-sub', html:
        'Bạn đã hoàn thành toàn bộ bài học<br>về phụ âm tắc tiếng Hàn của hôm nay.'})
    ),
    el('div', {class:'complete-tip'},
      '💡 다음 학습에서 또 만나요!',
      el('small', null, 'Hẹn gặp lại ở buổi học tiếp theo!')
    )
  );
}

// ── 슬라이드 전환 ───────────────────────────────────────────────────────
function showSlide(idx) {
  if (idx < 0 || idx >= slideList.length) return;
  const slides = document.querySelectorAll('.slide');

  // 이전 슬라이드 leave 로그
  if (slides[currentSlide]) {
    const prevName = slideList[currentSlide];
    const enterTs = slideEnter[prevName];
    if (enterTs) {
      log('page_leave', { slide: prevName, slideIdx: currentSlide,
                          duration_ms: Date.now() - enterTs });
    }
    slides[currentSlide].classList.remove('active');
  }

  // 새 슬라이드 enter
  currentSlide = idx;
  slides[idx].classList.add('active');
  const name = slideList[idx];
  slideEnter[name] = Date.now();
  slideVisit[name] = (slideVisit[name] || 0) + 1;
  log('page_enter', { slide: name, slideIdx: idx, visitNo: slideVisit[name] });

  // 상단 진행률
  $('prog-fill').style.width = ((idx+1)/slideList.length*100) + '%';
  $('top-prog').textContent = `${idx+1} / ${slideList.length}`;

  // 네비게이션 버튼
  $('btn-prev').disabled = (idx === 0);
  const isLast = (idx === slideList.length - 1);
  const isRerec = (slideList[idx] === 'rerecord');
  if (isLast) {
    // complete 슬라이드 — 더 이상 진행 불가
    $('btn-next').disabled = true;
  } else if (isRerec) {
    // rerecord — 3개 단어 모두 업로드 완료해야 활성화
    const allUp = [1,2,3].every(i => recs[i] && recs[i].uploaded);
    $('btn-next').disabled = !allUp;
    // 게이트 안내문 갱신
    setTimeout(updateRerecordGate, 0);
  } else {
    $('btn-next').disabled = false;
  }

  window.scrollTo({top:0, behavior:'smooth'});
}

window.goNext = () => showSlide(currentSlide + 1);
window.goPrev = () => showSlide(currentSlide - 1);

// ═════════════════════════════════════════════════════════════════════
//  단어별 재녹음 — study_week1.html 와 동일한 분리 함수 패턴
//  ※ 이전 toggleRecord 단일 함수에는 s.state 가 'recording' 으로
//    바뀌지 않아 stop() 분기가 도달 불가능했던 치명적 버그가 있었음.
//    분리 함수 + boolean flag (s.recording) 로 재구현.
// ═════════════════════════════════════════════════════════════════════

function pickMime() {
  const cands = ['audio/webm;codecs=opus', 'audio/webm',
                 'audio/ogg;codecs=opus',  'audio/mp4'];
  for (const c of cands) if (MediaRecorder.isTypeSupported(c)) return c;
  return '';
}

// 페이지 안내음 등 다른 audio 재생 중단
function stopAllAudio() {
  if (_activeAudio) { try { _activeAudio.pause(); } catch(e){} _activeAudio = null; }
  for (let i = 1; i <= 3; i++) {
    const a = document.getElementById('recAudio_' + i);
    if (a && !a.paused) { try { a.pause(); } catch(e){} }
  }
}

function toggleRec(idx) {
  stopAllAudio();
  const s = recs[idx];
  if (s.recording) stopRec(idx);
  else             startRec(idx);
}

function startRec(idx) {
  navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream) {
    const s = recs[idx];
    s.chunks = []; s.blob = null; s.sec = 0;
    s.attemptCount = (s.attemptCount || 0) + 1;

    const mime = pickMime();
    s.mime = mime || 'audio/webm';
    s.mediaRec = mime
      ? new MediaRecorder(stream, { mimeType: mime })
      : new MediaRecorder(stream);

    s.mediaRec.ondataavailable = function(e) {
      if (e.data && e.data.size > 0) s.chunks.push(e.data);
    };
    s.mediaRec.onstop = function() {
      s.blob = new Blob(s.chunks, { type: s.mime });
      // 스트림 트랙은 onstop 안에서 확실하게 정리 (메모리/마이크 LED 해제)
      stream.getTracks().forEach(function(t){ t.stop(); });
      onRecDone(idx);
    };
    s.mediaRec.start();
    s.recording = true;  // ★ 핵심: 시작 직후 즉시 flag 세팅

    const word = REC_WORDS[idx];
    const btn = $(`recBtn_${idx}`);
    btn.className = 'rec-main-btn recording';
    btn.textContent = '⏹';
    $(`recStatus_${idx}`).textContent =
      '🔴 녹음 중 · Đang ghi âm... 단어를 발음하세요';
    $(`recPost_${idx}`).classList.remove('show');
    $(`recPlayer_${idx}`).classList.remove('show');
    const upStatus = $(`recUpStatus_${idx}`);
    upStatus.className = 'rec-up-status';
    upStatus.textContent = '';

    s.timer = setInterval(function() {
      s.sec++;
      const m  = Math.floor(s.sec / 60);
      const ss = ('0' + (s.sec % 60)).slice(-2);
      $(`recTimer_${idx}`).textContent = m + ':' + ss;
    }, 1000);

    log('rec_start', { word, idx, attempt: s.attemptCount });
  }).catch(function(e) {
    alert('마이크 권한이 필요합니다: ' + e.message);
  });
}

function stopRec(idx) {
  const s = recs[idx];
  if (s.mediaRec && s.mediaRec.state !== 'inactive') s.mediaRec.stop();
  clearInterval(s.timer); s.timer = null;
  s.recording = false;  // ★ 핵심: flag 해제

  const btn = $(`recBtn_${idx}`);
  btn.className = 'rec-main-btn done';
  btn.textContent = '✅';
  log('rec_stop', { word: REC_WORDS[idx], idx, duration_sec: s.sec, attempt: s.attemptCount });
}

function onRecDone(idx) {
  const s = recs[idx];
  $(`recStatus_${idx}`).textContent =
    '✅ 녹음 완료 · Ghi âm xong! 아래에서 듣거나 업로드하세요.';
  $(`recPost_${idx}`).classList.add('show');

  // 인라인 audio 에 blob URL 연결
  const audioEl = $(`recAudio_${idx}`);
  if (audioEl && s.blob) {
    if (audioEl._prevUrl) URL.revokeObjectURL(audioEl._prevUrl);
    const url = URL.createObjectURL(s.blob);
    audioEl._prevUrl = url;
    audioEl.src = url;
    audioEl.load();
  }
}

function playRec(idx) {
  stopAllAudio();
  const audioEl    = $(`recAudio_${idx}`);
  const playerWrap = $(`recPlayer_${idx}`);
  const playBtn    = $(`recPlayBtn_${idx}`);
  const s = recs[idx];
  if (!s.blob) return;

  const isShown = playerWrap.classList.contains('show');
  if (isShown) {
    audioEl.pause();
    playerWrap.classList.remove('show');
    playBtn.textContent = '▶ 듣기 · Nghe lại';
    playBtn.classList.remove('playing');
  } else {
    playerWrap.classList.add('show');
    playBtn.textContent = '⏹ 닫기 · Đóng';
    playBtn.classList.add('playing');
    audioEl.play().catch(function(){});
    audioEl.onended = function() {
      playBtn.textContent = '▶ 듣기 · Nghe lại';
      playBtn.classList.remove('playing');
    };
  }
  log('rec_playback', { word: REC_WORDS[idx], idx });
}

function retryRec(idx) {
  stopAllAudio();
  const s = recs[idx];
  s.blob = null; s.chunks = []; s.uploaded = false;

  $(`recBtn_${idx}`).className = 'rec-main-btn';
  $(`recBtn_${idx}`).textContent = '🔴';
  $(`recTimer_${idx}`).textContent = '0:00';
  $(`recStatus_${idx}`).textContent =
    '🎙️ 버튼을 눌러 녹음을 시작하세요 · Nhấn nút để bắt đầu ghi âm';
  $(`recPost_${idx}`).classList.remove('show');
  const upStatus = $(`recUpStatus_${idx}`);
  upStatus.className = 'rec-up-status';
  upStatus.textContent = '';

  // 플레이어 초기화
  const audioEl    = $(`recAudio_${idx}`);
  const playerWrap = $(`recPlayer_${idx}`);
  const playBtn    = $(`recPlayBtn_${idx}`);
  if (audioEl)    { audioEl.pause(); audioEl.src = ''; }
  if (playerWrap) playerWrap.classList.remove('show');
  if (playBtn)    { playBtn.textContent = '▶ 듣기 · Nghe lại';
                    playBtn.classList.remove('playing'); }

  // 업로드 버튼도 다시 활성
  const upBtn = $(`recUpBtn_${idx}`);
  if (upBtn) { upBtn.disabled = false; upBtn.textContent = '📤 업로드 · Tải lên'; }

  updateRerecordGate();
  log('rec_retry', { word: REC_WORDS[idx], idx });
}

function downloadRec(idx) {
  stopAllAudio();
  const s = recs[idx];
  if (!s.blob) return;
  const ext = s.mime && s.mime.indexOf('mp4') > -1 ? 'm4a' : 'webm';
  const fn  = `${CURRENT.lid}_W${CURRENT.week}_${REC_WORDS[idx]}_retry.${ext}`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(s.blob); a.download = fn; a.click();
  log('rec_download', { word: REC_WORDS[idx], idx, filename: fn });
}

async function uploadRec(idx) {
  stopAllAudio();
  const s = recs[idx];
  const word = REC_WORDS[idx];
  const stEl  = $(`recUpStatus_${idx}`);
  const upBtn = $(`recUpBtn_${idx}`);
  if (!s.blob) { alert('먼저 녹음하세요 · Hãy ghi âm trước.'); return; }

  // 관리자 / 오프라인 스킵
  if (IS_ADMIN) {
    stEl.className = 'rec-up-status show success';
    stEl.textContent = '✅ 업로드 (관리자 검수 — 스킵)';
    upBtn.disabled = true; upBtn.textContent = '✓ 스킵 (admin)';
    s.uploaded = true;
    updateRerecordGate();
    console.log('[ADMIN/skip] rec_uploaded', { word, idx, duration_sec: s.sec });
    return;
  }
  if (OFFLINE || !fbReady) {
    stEl.className = 'rec-up-status show success';
    stEl.textContent = '✅ 업로드 (오프라인 스킵)';
    upBtn.disabled = true; upBtn.textContent = '✓ 스킵 (offline)';
    s.uploaded = true;
    updateRerecordGate();
    log('rec_uploaded_skipped', { word, idx, duration_sec: s.sec,
        reason: OFFLINE ? 'offline' : 'no_firebase' });
    return;
  }

  stEl.className = 'rec-up-status show uploading';
  stEl.textContent = '⏳ 업로드 중 · Đang tải lên...';
  upBtn.disabled = true;

  const ts = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
  const ext = s.mime.indexOf('mp4') > -1 ? 'm4a' : 'webm';
  // 재녹음(피드백) 파일은 본녹음(study)과 분리된 폴더에 저장
  //   본녹음:  recordings/{exp}/{lid}/week{N}/{lid}_W{N}_{word}_{ts}.{ext}
  //   재녹음:  recordings/{exp}/{lid}/week{N}_feedback/{lid}_W{N}_{word}_retry_{ts}.{ext}
  const fn   = `${CURRENT.lid}_W${CURRENT.week}_${word}_retry_${ts}.${ext}`;
  const path = `recordings/${window.EXPERIMENT_ID}/${CURRENT.lid}/week${CURRENT.week}_feedback/${fn}`;

  try {
    // 1) Storage 업로드
    const snap = await storage.ref(path).put(s.blob, { contentType: s.mime || 'audio/webm' });
    const fileUrl = await snap.ref.getDownloadURL();

    // 2) Firestore: feedback_views/{lid}/sessions/{sid}/recordings/{wordKey}
    const recRef = db.collection(window.FEEDBACK_LOG_COLLECTION)
      .doc(CURRENT.lid).collection('sessions').doc(SESSION_ID)
      .collection('recordings').doc(word);
    const prev = await recRef.get();
    const prevCount = (prev.exists && prev.data().attemptCount) ? prev.data().attemptCount : 0;
    const attemptCount = prevCount + 1;

    await recRef.set({
      word,
      wordKey:      word,
      filename:     fn,
      storagePath:  path,
      fileUrl:      fileUrl,
      mimeType:     s.mime || 'audio/webm',
      durationSec:  s.sec,
      size:         s.blob.size,
      attemptCount,
      uploadedAt:   firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    stEl.className = 'rec-up-status show success';
    stEl.textContent = '✅ 업로드 완료 · Tải lên thành công!';
    upBtn.textContent = `✓ ${REC_KO[idx]} 업로드 완료`;
    upBtn.disabled = true;
    s.uploaded = true;

    log('rec_uploaded', { word, idx, storagePath: path, filename: fn,
                          duration_sec: s.sec, size: s.blob.size, attemptCount });
    showToast(`🎙️ ${REC_KO[idx]} 업로드 완료 · Tải lên xong!`);

    // 게이트 갱신 (모두 업로드되면 nextBtn 활성)
    updateRerecordGate();

    // 3) 3개 모두 업로드 → 완료 마커 set
    try {
      const allDone = [1,2,3].every(i => recs[i].uploaded);
      if (allDone) {
        const marker = {};
        marker['rerecorded_W' + CURRENT.week] = true;
        marker['rerecorded_W' + CURRENT.week + '_at'] = firebase.firestore.FieldValue.serverTimestamp();
        await db.collection(window.FEEDBACK_LOG_COLLECTION)
          .doc(CURRENT.lid).set(marker, { merge: true });
        log('session_complete', { week: CURRENT.week });
      }
    } catch (e) {
      console.warn('재녹음 완료 마커 set 실패:', e);
    }
  } catch (e) {
    stEl.className = 'rec-up-status show error';
    const msg = e.message || '';
    stEl.textContent = (msg.indexOf('unauthorized')>-1 || msg.indexOf('permission-denied')>-1)
      ? '❌ 권한 오류 — Firebase Storage Rules 확인 필요'
      : '❌ 실패: ' + msg.slice(0,60);
    upBtn.disabled = false; upBtn.textContent = '📤 다시 업로드 · Tải lại';
    log('rec_upload_error', { word, idx, error: msg });
  }
}

// 모든 단어 업로드 완료 여부를 검사하여 nextBtn 게이팅 + 안내 문구 갱신
function updateRerecordGate() {
  const onRerec = slideList[currentSlide] === 'rerecord';
  if (!onRerec) return;
  const allUp = [1,2,3].every(i => recs[i] && recs[i].uploaded);

  const gate = document.getElementById('rerec-gate');
  if (gate) {
    if (allUp) {
      gate.className = 'complete-gate done';
      gate.innerHTML =
        '✅ 모든 녹음이 업로드되었습니다. 아래 <b>다음</b> 버튼을 눌러 학습을 종료해 주세요.' +
        '<small>Tất cả bản ghi đã được tải lên. Nhấn <b>Tiếp theo</b> bên dưới để kết thúc bài học.</small>';
    } else {
      gate.className = 'complete-gate';
      gate.innerHTML =
        '🔒 모든 파일을 업로드해야 다음으로 넘어가며 학습이 종료됩니다.' +
        '<small>Cần tải lên tất cả các bản ghi để tiếp tục và hoàn thành bài học.</small>';
    }
  }

  const nextBtn = document.getElementById('btn-next');
  if (nextBtn) {
    // rerecord 가 마지막 슬라이드가 아니라 그 다음 complete 슬라이드가 있음
    nextBtn.disabled = !allUp;
  }
}

// 토스트
function showToast(msg) {
  let t = document.getElementById('feedback-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'feedback-toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(function(){ t.classList.remove('show'); }, 2400);
}

// ── 이탈 ────────────────────────────────────────────────────────────────
window.addEventListener('beforeunload', () => {
  const prevName = slideList[currentSlide];
  if (prevName && slideEnter[prevName]) {
    log('page_leave', { slide: prevName, slideIdx: currentSlide,
                        duration_ms: Date.now() - slideEnter[prevName] });
  }
  log('session_end', { duration_ms: Date.now() - pageEnterTime,
                       elapsed_sec: Math.round((Date.now() - sessionStart) / 1000) });
});

// ── 관리자 배지 ─────────────────────────────────────────────────────────
function showAdminBadge() {
  if (document.getElementById('admin-badge')) return;
  const badge = document.createElement('div');
  badge.id = 'admin-badge';
  badge.textContent = '🛠 ADMIN PREVIEW — Firebase 로그/업로드 비활성';
  badge.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:9999;' +
    'background:#dc3545;color:#fff;font-size:12px;font-weight:700;' +
    'text-align:center;padding:6px 10px;letter-spacing:.5px;' +
    'box-shadow:0 2px 8px rgba(0,0,0,.2)';
  document.body.appendChild(badge);
  document.body.style.paddingTop = '28px';
}

// ── 시작 ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initFirebase();
  if (IS_ADMIN) showAdminBadge();
  const loginScreen = document.getElementById('loginScreen');
  const appScreen   = document.getElementById('appScreen');
  const params = getParams();
  if (loginScreen) {
    if (params.lid) {
      loginScreen.style.display = 'none';
      if (appScreen) appScreen.style.display = 'block';
      if (!fbReady && !OFFLINE) await new Promise(r => setTimeout(r, 250));
      await initSessionMeta(params.lid, params.week, params.group);
      loadAll();
    }
  } else {
    if (params.lid) {
      if (!fbReady && !OFFLINE) await new Promise(r => setTimeout(r, 250));
      await initSessionMeta(params.lid, params.week, params.group);
    }
    loadAll();
  }
});
