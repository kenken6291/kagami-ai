/* かがみAI app.js v1.0.0 */
const C = window.CONFIG;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const TOKEN_KEY = 'kagami_token';
const GUIDE_KEY = 'kagami_guide_seen';

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  user: null,
  forceChange: false,
  original: null,       // dataURL（縮小済みJPEG）
  hairResult: null,     // dataURL
  analysis: null,
  historyId: null,
  hair: { style: '', label: '', color: '' },
  makeup: {
    lip: { color: null, amount: 0.55 },
    eye: { color: null, amount: 0.45 },
    cheek: { color: null, amount: 0.40 },
  },
  baseImgs: {},                              // { original: Image, hair: Image }
  landmarks: { original: null, hair: null }, // null=未検出 / false=顔なし / 配列
  audio: null,
  narrating: false,
};

/* =========================================================
 * 共通
 * ========================================================= */
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.setAttribute('style', v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  children.flat().forEach(c => { if (c != null && c !== false) e.append(c instanceof Node ? c : String(c)); });
  return e;
}

function toast(msg, type = 'info') {
  const t = $('#toast');
  t.textContent = msg;
  t.dataset.type = type;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, type === 'error' ? 6500 : 3800);
}

function loading(on, text = '処理しています…') {
  $('#loading-text').textContent = text;
  $('#loading').hidden = !on;
}

function showView(name) {
  $$('[data-view]').forEach(v => { v.hidden = v.dataset.view !== name; });
  $('#user-area').hidden = !(name === 'main' || (name === 'change' && !state.forceChange));
  $('#voice-dock').hidden = name !== 'main' || !voiceCmd.supported;
  $('#menu').hidden = true;
  window.scrollTo(0, 0);
}

async function api(action, data = {}) {
  if (!C.GAS_ENDPOINT || C.GAS_ENDPOINT.includes('XXXX')) {
    throw new Error('config.js の GAS_ENDPOINT に、GASウェブアプリのURLを設定してください。');
  }
  let res;
  try {
    res = await fetch(C.GAS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, token: state.token, ...data }),
    });
  } catch (e) {
    throw new Error('サーバーに接続できませんでした。通信状態を確認してください。');
  }
  let json;
  try { json = await res.json(); } catch (e) {
    throw new Error('サーバーの応答を読み取れませんでした。GASのデプロイ設定（アクセス：全員）を確認してください。');
  }
  if (!json.ok) {
    if (json.code === 'AUTH') { clearSession(); showView('login'); }
    if (json.code === 'MUST_CHANGE') openChange(true);
    throw new Error(json.error || 'エラーが発生しました。');
  }
  return json;
}

async function run(task, text) {
  loading(true, text);
  try { return await task(); }
  catch (e) { toast(e.message, 'error'); return null; }
  finally { loading(false); }
}

const b64 = dataUrl => dataUrl.split(',')[1];

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('画像を読み込めませんでした。'));
    img.src = src;
  });
}

function resizeToDataUrl(src) {
  const w = src.naturalWidth || src.videoWidth || src.width;
  const h = src.naturalHeight || src.videoHeight || src.height;
  const s = Math.min(1, C.IMAGE.MAX_SIZE / Math.max(w, h));
  const cv = document.createElement('canvas');
  cv.width = Math.round(w * s);
  cv.height = Math.round(h * s);
  cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
  return cv.toDataURL('image/jpeg', C.IMAGE.QUALITY);
}

function downloadDataUrl(url, name) {
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
}

function hexToRgba(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
const isHex = v => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);

/* =========================================================
 * 初期化
 * ========================================================= */
function applyConfig() {
  document.title = `${C.APP_NAME} ～${C.APP_SUBTITLE}`;
  $('#app-name').textContent = C.APP_NAME;
  $('#app-sub').textContent = C.APP_SUBTITLE;
  $$('.js-app-name').forEach(e => { e.textContent = C.APP_NAME; });
  $$('.js-version').forEach(e => { e.textContent = C.VERSION; });
}

function setupEarthStudio() {
  const es = C.EARTH_STUDIO || {};
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  $$('.js-earth-credit').forEach(e => { e.textContent = es.CREDIT || ''; });

  const bg = $('#bg-video');
  if (es.BG_VIDEO && !reduce) {
    bg.addEventListener('error', () => bg.remove(), { once: true });
    bg.addEventListener('loadeddata', () => { bg.hidden = false; bg.play().catch(() => {}); }, { once: true });
    bg.src = es.BG_VIDEO;
  } else {
    bg.remove();
  }

  const op = $('#opening');
  if (!es.OPENING_VIDEO || !es.SHOW_OPENING || reduce || sessionStorage.getItem('kagami_opening')) {
    op.remove();
    return;
  }
  sessionStorage.setItem('kagami_opening', '1');
  const v = $('#opening-video');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    op.classList.add('is-closing');
    setTimeout(() => op.remove(), 500);
  };
  v.addEventListener('ended', close);
  v.addEventListener('error', () => op.remove());
  v.addEventListener('loadeddata', () => { op.hidden = false; v.play().catch(close); }, { once: true });
  $('#opening-skip').addEventListener('click', close);
  v.src = es.OPENING_VIDEO;
  setTimeout(close, (es.OPENING_MAX_SEC || 12) * 1000);
}

function setupPasswordToggles() {
  $$('.pw-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', show ? 'パスワードを隠す' : 'パスワードを表示');
    });
  });
}

/* =========================================================
 * 認証
 * ========================================================= */
function setSession(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem(TOKEN_KEY, token);
}
function clearSession() {
  state.token = '';
  state.user = null;
  localStorage.removeItem(TOKEN_KEY);
}
function checkPassword(p) {
  if (p.length < 8 || p.length > 64) return 'パスワードは8〜64文字にしてください。';
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return 'パスワードには英字と数字を両方含めてください。';
  return '';
}

function openChange(forced) {
  state.forceChange = forced;
  $('#cp-cancel').hidden = forced;
  $('#change-note').textContent = forced
    ? '仮パスワードから、ご自身で決めたパスワードに変更してください。'
    : '現在のパスワードと、新しいパスワードを入力してください。';
  showView('change');
}

function enterMain() {
  state.forceChange = false;
  $('#user-name').textContent = state.user?.nickname || '';
  showView('main');
  if (!localStorage.getItem(GUIDE_KEY)) openGuide();
}

async function restoreSession() {
  if (!state.token) { showView('login'); return; }
  try {
    const r = await api('me');
    state.user = r.user;
    if (r.mustChange) openChange(true);
    else enterMain();
  } catch (e) {
    clearSession();
    showView('login');
  }
}

function bindAuth() {
  $('#to-register').addEventListener('click', () => showView('register'));
  $('#to-forgot').addEventListener('click', () => showView('forgot'));
  $$('.to-login').forEach(b => b.addEventListener('click', () => showView('login')));

  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('#login-email').value.trim();
    const password = $('#login-password').value;
    if (!email || !password) return toast('メールアドレスとパスワードを入力してください。', 'error');
    const r = await run(() => api('login', { email, password }), 'ログインしています…');
    if (!r) return;
    setSession(r.token, r.user);
    $('#login-password').value = '';
    if (r.mustChange) {
      $('#cp-current').value = password;
      openChange(true);
      toast('仮パスワードでログインしました。新しいパスワードを決めてください。');
    } else {
      enterMain();
    }
  });

  const agrees = $$('.agree');
  const regBtn = $('#reg-submit');
  const updateAgree = () => {
    const all = agrees.every(c => c.checked);
    regBtn.disabled = !all;
    $('#agree-hint').hidden = all;
  };
  agrees.forEach(c => c.addEventListener('change', updateAgree));
  updateAgree();

  $('#register-form').addEventListener('submit', async e => {
    e.preventDefault();
    if (regBtn.disabled) return;
    const email = $('#reg-email').value.trim();
    const nickname = $('#reg-nickname').value.trim();
    if (!email || !nickname) return toast('メールアドレスとニックネームを入力してください。', 'error');
    const agreements = {
      terms: $('#agree-terms').checked,
      disclaimer: $('#agree-disclaimer').checked,
      selfResponsibility: $('#agree-self').checked,
      dispute: $('#agree-dispute').checked,
    };
    const r = await run(() => api('register', { email, nickname, agreements }), '登録しています…');
    if (!r) return;
    $('#register-form').reset();
    updateAgree();
    $('#login-email').value = email;
    showView('login');
    toast(r.message, 'success');
  });

  $('#forgot-form').addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('#forgot-email').value.trim();
    if (!email) return toast('メールアドレスを入力してください。', 'error');
    const r = await run(() => api('forgotPassword', { email }), '送信しています…');
    if (!r) return;
    $('#login-email').value = email;
    showView('login');
    toast(r.message, 'success');
  });

  $('#change-form').addEventListener('submit', async e => {
    e.preventDefault();
    const cur = $('#cp-current').value;
    const nw = $('#cp-new').value;
    const cf = $('#cp-confirm').value;
    const err = checkPassword(nw);
    if (err) return toast(err, 'error');
    if (nw !== cf) return toast('確認用のパスワードが一致しません。', 'error');
    const r = await run(() => api('changePassword', { currentPassword: cur, newPassword: nw }), '変更しています…');
    if (!r) return;
    $('#change-form').reset();
    toast(r.message, 'success');
    enterMain();
  });
  $('#cp-cancel').addEventListener('click', () => { $('#change-form').reset(); showView('main'); });
}

/* =========================================================
 * メニュー・ガイド・履歴
 * ========================================================= */
function openGuide() {
  const d = $('#guide');
  if (!d.open) d.showModal();
}

function bindMenu() {
  const btn = $('#menu-btn');
  const menu = $('#menu');
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', e => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    btn.setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', e => { if (!menu.contains(e.target)) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

  $('#guide').addEventListener('close', () => localStorage.setItem(GUIDE_KEY, '1'));
  $('#menu-guide').addEventListener('click', () => { close(); openGuide(); });
  $('#menu-password').addEventListener('click', () => { close(); openChange(false); });
  $('#menu-history').addEventListener('click', async () => {
    close();
    const r = await run(() => api('history'), '履歴を読み込んでいます…');
    if (!r) return;
    const list = $('#history-list');
    list.replaceChildren(...(r.items.length ? r.items.map(it => {
      const d = new Date(it.createdAt);
      return el('li', {},
        el('time', { datetime: it.createdAt }, d.toLocaleString('ja-JP')),
        `${it.faceShape || '—'}／${it.personalColor || '—'}`,
        it.hairStyle ? el('div', { class: 'muted' }, '試した髪型: ' + it.hairStyle) : null,
        it.request && it.request !== '特になし' ? el('div', { class: 'muted' }, '要望: ' + it.request) : null);
    }) : [el('li', {}, 'まだ履歴はありません。')]));
    $('#history-dlg').showModal();
  });
  $('#menu-delete-images').addEventListener('click', async () => {
    close();
    if (!confirm('サーバーに一時保存されているあなたの写真をすべて削除します。よろしいですか？')) return;
    const r = await run(() => api('deleteMyImages'), '削除しています…');
    if (r) toast(r.message, 'success');
  });
  $('#menu-logout').addEventListener('click', async () => {
    close();
    stopNarration();
    try { await api('logout'); } catch (e) { /* noop */ }
    clearSession();
    showView('login');
    toast('ログアウトしました。');
  });
}

/* =========================================================
 * 1. 写真
 * ========================================================= */
let camStream = null;

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('この端末ではカメラを使えません。「写真を選ぶ」をお使いください。', 'error');
    return;
  }
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false,
    });
  } catch (e) {
    toast('カメラを起動できませんでした。ブラウザでカメラの使用を許可してください。', 'error');
    return;
  }
  const v = $('#cam-video');
  v.srcObject = camStream;
  $('#cam-wrap').hidden = false;
  await v.play().catch(() => {});
  $('#cam-wrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function stopCamera() {
  camStream?.getTracks().forEach(t => t.stop());
  camStream = null;
  $('#cam-video').srcObject = null;
  $('#cam-wrap').hidden = true;
}

function shoot() {
  const v = $('#cam-video');
  if (!v.videoWidth) return toast('カメラの準備中です。少し待ってからもう一度押してください。', 'error');
  const cv = document.createElement('canvas');
  cv.width = v.videoWidth;
  cv.height = v.videoHeight;
  const ctx = cv.getContext('2d');
  ctx.translate(cv.width, 0);
  ctx.scale(-1, 1); // 見たまま（鏡像）で保存
  ctx.drawImage(v, 0, 0);
  stopCamera();
  setPhoto(resizeToDataUrl(cv));
}

async function onUpload(e) {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  if (!f.type.startsWith('image/')) return toast('画像ファイルを選んでください。', 'error');
  const url = URL.createObjectURL(f);
  try {
    const img = await loadImage(url);
    setPhoto(resizeToDataUrl(img));
  } catch (err) {
    toast('この画像は読み込めませんでした。JPEGかPNGの写真でお試しください。', 'error');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function setPhoto(dataUrl) {
  stopNarration();
  state.original = dataUrl;
  state.hairResult = null;
  state.analysis = null;
  state.historyId = null;
  state.baseImgs = {};
  state.landmarks = { original: null, hair: null };

  $('#photo-preview').src = dataUrl;
  $('#photo-mirror').classList.add('has-photo');
  $('#analyze-btn').disabled = false;
  $('#hair-btn').disabled = false;
  $('#analysis').hidden = true;
  $('#hair-ai-wrap').hidden = true;
  $('#mk-apply-ai').hidden = true;
  $('#mk-tips').hidden = true;
  $$('.swatch.ai, .chip.ai').forEach(x => x.remove());
  resetCompare($('#hair-compare'));
  $('#hair-result-actions').hidden = true;
  const hairBase = $('input[name="makeup-base"][value="hair"]');
  hairBase.disabled = true;
  $('input[name="makeup-base"][value="original"]').checked = true;

  toast('写真をセットしました。次は「AIに分析してもらう」です。', 'success');
  prepareMakeup();
}

/* =========================================================
 * 2. AI分析
 * ========================================================= */
async function analyze() {
  if (!state.original) return toast('先に写真をセットしてください。', 'error');
  stopNarration();
  const request = $('#request-input').value.trim();
  const r = await run(() => api('analyze', { image: b64(state.original), mimeType: 'image/jpeg', request }),
    'AIが顔立ちを見ています…（20秒ほどかかります）');
  if (!r) return;
  state.analysis = r.analysis;
  state.historyId = r.historyId;
  renderAnalysis(r.analysis);
  $('#analysis').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderAnalysis(a) {
  $('#analysis').hidden = false;
  $('#a-face').textContent = a.faceShape || '—';
  $('#a-face-reason').textContent = a.faceShapeReason || '';
  $('#a-color').textContent = a.personalColor || '—';
  $('#a-color-reason').textContent = a.personalColorReason || '';
  $('#a-features').replaceChildren(...(a.features || []).map(t => el('li', {}, t)));
  $('#a-narration').textContent = cleanNarration(a.narration || '');
  renderAiHair(a.hairSuggestions || [], a.hairColorSuggestion);
  renderAiMakeup(a.makeup);
  renderVideos(a.videoQueries || []);
}

/* =========================================================
 * 3. ヘア
 * ========================================================= */
function selectChip(group, btn) {
  $$(`.chip[data-group="${group}"]`).forEach(x => x.setAttribute('aria-pressed', 'false'));
  btn.setAttribute('aria-pressed', 'true');
}

function hairChip({ label, prompt, reason, ai }) {
  const b = el('button', { type: 'button', class: 'chip' + (ai ? ' ai' : ''), 'data-group': 'hair-style', 'data-label': label, 'aria-pressed': 'false', title: reason || '' },
    ai ? el('span', {}, label, reason ? el('small', {}, reason) : null) : label);
  b.addEventListener('click', () => {
    selectChip('hair-style', b);
    state.hair.style = prompt || label;
    state.hair.label = label;
    $('#hair-selected').textContent = label;
  });
  return b;
}

function colorChip({ name, prompt, hex, ai }) {
  const b = el('button', { type: 'button', class: 'chip' + (ai ? ' ai' : ''), 'data-group': 'hair-color', 'aria-pressed': 'false' },
    isHex(hex) ? el('span', { class: 'dot', style: `--c:${hex}` }) : null,
    ai ? `AI: ${name}` : name);
  b.addEventListener('click', () => { selectChip('hair-color', b); state.hair.color = prompt || ''; });
  return b;
}

function renderHairPresets() {
  $('#hair-styles').replaceChildren(...C.HAIR_STYLES.map(h => hairChip(h)));
  const colors = C.HAIR_COLORS.map(c => colorChip(c));
  $('#hair-colors').replaceChildren(...colors);
  colors[0]?.click();
}

function renderAiHair(list, colorSug) {
  const box = $('#hair-ai');
  box.replaceChildren(...list.slice(0, 3).map(h =>
    hairChip({ label: h.name, prompt: h.prompt || h.name, reason: h.reason, ai: true })));
  $('#hair-ai-wrap').hidden = list.length === 0;
  $$('#hair-colors .chip.ai').forEach(x => x.remove());
  if (colorSug?.name) {
    $('#hair-colors').prepend(colorChip({ name: colorSug.name, prompt: colorSug.prompt || colorSug.name, hex: colorSug.hex, ai: true }));
  }
}

async function tryHair() {
  if (!state.original) return toast('先に写真をセットしてください。', 'error');
  if (!state.hair.style) return toast('試したい髪型を選んでください。', 'error');
  stopNarration();
  const r = await run(() => api('hairEdit', {
    image: b64(state.original),
    mimeType: 'image/jpeg',
    style: state.hair.style,
    color: state.hair.color,
    extra: $('#hair-extra').value.trim(),
    historyId: state.historyId,
  }), `「${state.hair.label}」に変えています…（30秒ほどかかります）`);
  if (!r) return;
  state.hairResult = `data:${r.mimeType};base64,${r.image}`;
  state.landmarks.hair = null;
  delete state.baseImgs.hair;
  await setCompare($('#hair-compare'), state.original, state.hairResult);
  $('#hair-result-actions').hidden = false;
  $('input[name="makeup-base"][value="hair"]').disabled = false;
  $('#hair-compare').scrollIntoView({ behavior: 'smooth', block: 'center' });
  toast('鏡の上を左右になぞると、前後を比べられます。', 'success');
}

/* ---------- 比較スライダー ---------- */
function setupCompare(box) {
  const range = $('.cmp-range', box);
  const update = () => box.style.setProperty('--pos', range.value + '%');
  range.addEventListener('input', update);
  update();
}
async function setCompare(box, before, after) {
  $('.cmp-before', box).src = before;
  const afterImg = $('.cmp-after img', box);
  if (afterImg && after) afterImg.src = after;
  const img = await loadImage(before);
  box.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
  box.classList.add('is-ready');
}
function resetCompare(box) {
  box.classList.remove('is-ready');
  $('.cmp-before', box).removeAttribute('src');
  $('.cmp-after img', box)?.removeAttribute('src');
}
function bindSideToggles() {
  $$('.side-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const box = document.getElementById(btn.dataset.target);
      const on = box.classList.toggle('is-side');
      btn.setAttribute('aria-pressed', String(on));
      btn.textContent = on ? '重ねて比べる' : '並べて比べる';
    });
  });
}

/* =========================================================
 * 4. バーチャルメイク（MediaPipe Face Landmarker）
 * ========================================================= */
const LIP_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
const LIP_INNER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];
const R_LID = [33, 246, 161, 160, 159, 158, 157, 173, 133];
const R_BROW = [70, 63, 105, 66, 107];
const L_LID = [263, 466, 388, 387, 386, 385, 384, 398, 362];
const L_BROW = [300, 293, 334, 296, 336];
const CHEEKS = [50, 280];

let landmarkerPromise = null;
function getLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const vision = await import(C.MEDIAPIPE.BUNDLE);
      const files = await vision.FilesetResolver.forVisionTasks(C.MEDIAPIPE.WASM);
      return vision.FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: C.MEDIAPIPE.MODEL, delegate: 'CPU' },
        runningMode: 'IMAGE',
        numFaces: 1,
      });
    })().catch(e => { landmarkerPromise = null; throw e; });
  }
  return landmarkerPromise;
}

const currentBase = () => $('input[name="makeup-base"]:checked')?.value || 'original';

async function getBaseImg(key) {
  if (!state.baseImgs[key]) {
    state.baseImgs[key] = await loadImage(key === 'hair' ? state.hairResult : state.original);
  }
  return state.baseImgs[key];
}

async function prepareMakeup() {
  if (!state.original) return;
  const key = currentBase();
  if (key === 'hair' && !state.hairResult) return;
  const status = $('#makeup-status');
  const box = $('#makeup-compare');
  const img = await getBaseImg(key);
  $('.cmp-before', box).src = img.src;
  box.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
  box.classList.add('is-ready');

  let msg = '色を選ぶと、すぐにメイクが反映されます。';
  if (state.landmarks[key] == null) {
    status.textContent = '顔の位置を読み取っています…';
    try {
      const lm = await getLandmarker();
      state.landmarks[key] = lm.detect(img).faceLandmarks?.[0] || false;
    } catch (e) {
      console.error(e);
      msg = 'メイク機能を読み込めませんでした。通信状態を確認して、もう一度写真をセットしてください。';
    }
  }
  if (state.landmarks[key] === false) msg = '顔を見つけられませんでした。正面を向いた明るい写真でお試しください。';
  if (key === currentBase()) {
    status.textContent = msg;
    renderMakeup();
  }
}

function renderMakeup() {
  const key = currentBase();
  const img = state.baseImgs[key];
  if (!img) return;
  const cv = $('#makeup-canvas');
  cv.width = img.naturalWidth;
  cv.height = img.naturalHeight;
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0);

  const lm = state.landmarks[key];
  if (!lm) return;
  const W = cv.width, H = cv.height;
  const P = i => ({ x: lm[i].x * W, y: lm[i].y * H });
  const faceW = Math.hypot(P(454).x - P(234).x, P(454).y - P(234).y);
  const m = state.makeup;

  // チーク
  if (m.cheek.color && m.cheek.amount > 0) {
    CHEEKS.forEach(i => {
      const c = P(i);
      const r = faceW * 0.13;
      const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
      g.addColorStop(0, hexToRgba(m.cheek.color, 0.9));
      g.addColorStop(1, hexToRgba(m.cheek.color, 0));
      paint(ctx, { fill: g, alpha: m.cheek.amount * 0.6, mode: 'multiply', blur: 0, path: p => p.arc(c.x, c.y, r, 0, Math.PI * 2) });
    });
  }
  // アイシャドウ
  if (m.eye.color && m.eye.amount > 0) {
    [[R_LID, R_BROW], [L_LID, L_BROW]].forEach(([lid, brow]) => {
      const pts = shadowPolygon(lid.map(P), brow.map(P));
      paint(ctx, { fill: m.eye.color, alpha: m.eye.amount * 0.55, mode: 'multiply', blur: faceW * 0.018, path: p => poly(p, pts) });
    });
  }
  // リップ（内側の口の中は塗らない）
  if (m.lip.color && m.lip.amount > 0) {
    const outer = LIP_OUTER.map(P);
    const inner = LIP_INNER.map(P);
    const path = p => { poly(p, outer); poly(p, inner); };
    const blur = faceW * 0.004;
    paint(ctx, { fill: m.lip.color, alpha: m.lip.amount * 0.55, mode: 'multiply', blur, path });
    paint(ctx, { fill: m.lip.color, alpha: m.lip.amount * 0.35, mode: 'soft-light', blur, path });
  }
}

function paint(ctx, { fill, alpha, mode, blur, path }) {
  ctx.save();
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.globalCompositeOperation = mode;
  if (blur > 0 && 'filter' in ctx) ctx.filter = `blur(${blur.toFixed(1)}px)`;
  ctx.fillStyle = fill;
  ctx.beginPath();
  path(ctx);
  ctx.fill('evenodd');
  ctx.restore();
}
function poly(ctx, pts) {
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}
function shadowPolygon(lid, brow) {
  const upper = lid.map((p, i) => {
    const b = brow[Math.round(i * (brow.length - 1) / (lid.length - 1))];
    return { x: p.x + (b.x - p.x) * 0.45, y: p.y + (b.y - p.y) * 0.45 };
  });
  return [...lid, ...upper.reverse()];
}

function swatch(part, hex, name, ai = false) {
  const b = el('button', {
    type: 'button',
    class: 'swatch' + (hex ? '' : ' none') + (ai ? ' ai' : ''),
    style: hex ? `--c:${hex}` : null,
    'data-part': part,
    'data-hex': hex || '',
    'aria-pressed': 'false',
    'aria-label': (ai ? 'AIのおすすめ ' : '') + name,
    title: (ai ? 'AIのおすすめ：' : '') + name,
  });
  b.addEventListener('click', () => setMakeupColor(part, hex));
  return b;
}

function setMakeupColor(part, hex) {
  state.makeup[part].color = hex || null;
  $$(`.swatch[data-part="${part}"]`).forEach(s => {
    s.setAttribute('aria-pressed', String((s.dataset.hex || null) === (hex || null)));
  });
  renderMakeup();
}

function renderMakeupControls() {
  ['lip', 'eye', 'cheek'].forEach(part => {
    $('#mk-' + part).replaceChildren(
      swatch(part, null, 'なし'),
      ...C.MAKEUP_PALETTE[part].map(c => swatch(part, c.hex, c.name)));
    const range = $(`#mk-${part}-amt`);
    state.makeup[part].amount = range.value / 100;
    range.addEventListener('input', () => { state.makeup[part].amount = range.value / 100; renderMakeup(); });
    setMakeupColor(part, null);
  });
}

function renderAiMakeup(mk) {
  $$('.swatch.ai').forEach(x => x.remove());
  if (!mk) return;
  let any = false;
  ['lip', 'eye', 'cheek'].forEach(part => {
    const s = mk[part];
    if (s && isHex(s.hex)) {
      $('#mk-' + part).firstChild.after(swatch(part, s.hex, s.name || 'おすすめ', true));
      any = true;
    }
  });
  $('#mk-apply-ai').hidden = !any;
  $('#mk-tips').textContent = mk.tips || '';
  $('#mk-tips').hidden = !mk.tips;
}

function applyAiMakeup() {
  const mk = state.analysis?.makeup;
  if (!mk) return;
  ['lip', 'eye', 'cheek'].forEach(part => { if (isHex(mk[part]?.hex)) setMakeupColor(part, mk[part].hex); });
  $('#makeup-compare').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* =========================================================
 * 5. 動画
 * ========================================================= */
function renderVideos(list) {
  $('#video-list').replaceChildren(...list.map(q => videoRow(q.title || q.query, q.query)));
  $('#videos-empty').hidden = list.length > 0;
}

function videoRow(title, query) {
  const ytFrame = el('div', { class: 'vframe' }, el('p', { class: 'muted' }, '「YouTubeで探す」を押すと、ここで再生できます。'));
  const ytThumbs = el('div', { class: 'vthumbs' });
  const yt = el('div', { class: 'vpanel' },
    el('h4', {}, 'YouTube'), ytFrame, ytThumbs,
    el('div', { class: 'vactions' },
      el('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => loadYouTube(ytFrame, ytThumbs, query) }, 'YouTubeで探す'),
      el('a', { class: 'link', href: 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query), target: '_blank', rel: 'noopener' }, 'YouTubeアプリで開く')));

  const ttFrame = el('div', { class: 'vframe tall' }, el('p', { class: 'muted' }, 'TikTokで見つけた動画のURLを貼ると、ここで再生できます。'));
  const ttInput = el('input', { type: 'url', placeholder: 'https://www.tiktok.com/@…/video/…', 'aria-label': 'TikTok動画のURL' });
  const tt = el('div', { class: 'vpanel' },
    el('h4', {}, 'TikTok'), ttFrame,
    el('div', { class: 'vactions' },
      el('a', { class: 'btn btn-small btn-ghost', href: 'https://www.tiktok.com/search?q=' + encodeURIComponent(query), target: '_blank', rel: 'noopener' }, 'TikTokで探す')),
    el('div', { class: 'vpaste' }, ttInput,
      el('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => embedTikTok(ttFrame, ttInput.value) }, '表示')));

  return el('article', { class: 'vrow' },
    el('h3', {}, title),
    el('p', { class: 'vquery' }, '検索ワード：' + query),
    el('div', { class: 'vgrid' }, yt, tt));
}

async function loadYouTube(frame, thumbs, query) {
  frame.replaceChildren(el('p', { class: 'muted' }, '探しています…'));
  try {
    const r = await api('videos', { query });
    if (!r.available || !r.items.length) {
      frame.replaceChildren(el('p', { class: 'muted' }, r.available
        ? '動画が見つかりませんでした。「YouTubeアプリで開く」からお探しください。'
        : 'ここでの再生は準備中です。「YouTubeアプリで開く」からご覧ください。'));
      return;
    }
    const play = it => frame.replaceChildren(el('iframe', {
      src: 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(it.id),
      title: it.title,
      allow: 'accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen',
      allowfullscreen: true,
      loading: 'lazy',
    }));
    play(r.items[0]);
    thumbs.replaceChildren(...r.items.map(it =>
      el('button', { type: 'button', class: 'vthumb', title: it.title, onclick: () => play(it) },
        it.thumb ? el('img', { src: it.thumb, alt: '', loading: 'lazy' }) : null,
        el('span', {}, it.title))));
  } catch (e) {
    frame.replaceChildren(el('p', { class: 'muted' }, e.message));
  }
}

function embedTikTok(frame, url) {
  const m = String(url).match(/\/video\/(\d+)/);
  if (!m) {
    toast('TikTokの動画URL（…/video/数字）を貼ってください。短いURLの場合は一度ブラウザで開いてからコピーしてください。', 'error');
    return;
  }
  frame.replaceChildren(el('iframe', {
    src: 'https://www.tiktok.com/embed/v2/' + m[1],
    title: 'TikTok動画',
    allow: 'encrypted-media; fullscreen',
    loading: 'lazy',
  }));
}

function freeVideoSearch() {
  const q = $('#video-free-input').value.trim();
  if (!q) return toast('検索ワードを入力してください。', 'error');
  const row = videoRow(q, q);
  $('#video-list').prepend(row);
  $('#videos-empty').hidden = true;
  $('#video-free-input').value = '';
  $('button', row).click();
}

/* =========================================================
 * 音声ナレーション（TTS）
 * ========================================================= */
/** 読み上げ前のクリーニング：メタ指示・前置き・記号・絵文字を除く */
function cleanNarration(t) {
  let s = String(t || '');
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/[*#_`>~|]/g, '');
  s = s.replace(/[（(【\[〈《][^）)】\]〉》]{0,30}(読み|声|トーン|口調|ゆっくり|明るく|優しく|やさしく|BGM|SE|効果音|ナレーション|間を)[^）)】\]〉》]{0,30}[）)】\]〉》]/g, '');
  s = s.replace(/^\s*(ナレーション|ナレーター|解説|原稿|本文|読み上げ文|AI)\s*[:：]\s*/gm, '');
  const meta = /(読み上げ(て|ます|る|を)|ナレーション(を|です|します|開始|原稿)|AIによる(解説|ナレーション|分析結果をお伝え)|以下(は|が|の).{0,15}(解説|ナレーション|原稿|文章|読み上げ)|音声(で|にて)(お届け|解説|お伝え)|(トーン|口調|声)で(話|読|お届け)|それでは.{0,8}(始め|読み))/;
  s = s.split(/(?<=[。！？!?\n])/).filter(x => !meta.test(x)).join('');
  s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '');
  return s.replace(/\s+/g, ' ').trim();
}

function pcmToWav(base64, rate) {
  const bin = atob(base64);
  const pcm = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) pcm[i] = bin.charCodeAt(i);
  const buf = new ArrayBuffer(44 + pcm.length);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, pcm.length, true);
  new Uint8Array(buf, 44).set(pcm);
  return new Blob([buf], { type: 'audio/wav' });
}

function setNarrating(on, label) {
  state.narrating = on;
  const btn = $('#narrate-btn');
  btn.disabled = on;
  btn.textContent = label || (on ? '再生中…' : '解説を聞く');
  $('#narrate-stop').hidden = !on;
}

async function playNarration(text) {
  stopNarration();
  const clean = cleanNarration(text);
  if (!clean) return toast('読み上げる解説がありません。', 'error');
  setNarrating(true, '音声を準備中…');

  if (C.TTS_MODE === 'gemini') {
    try {
      const r = await api('tts', { text: clean });
      if (!state.narrating) return; // 準備中に止められた
      const rate = Number((r.mimeType.match(/rate=(\d+)/) || [])[1] || 24000);
      const blob = /wav|mpeg|mp3|ogg/.test(r.mimeType)
        ? new Blob([Uint8Array.from(atob(r.audio), c => c.charCodeAt(0))], { type: r.mimeType })
        : pcmToWav(r.audio, rate);
      const url = URL.createObjectURL(blob);
      const au = new Audio(url);
      state.audio = au;
      au.onended = () => { URL.revokeObjectURL(url); state.audio = null; setNarrating(false); };
      setNarrating(true);
      await au.play();
      return;
    } catch (e) {
      console.warn('Gemini TTSに失敗したため、ブラウザの音声で読み上げます。', e);
      if (!state.narrating) return;
    }
  }
  speakBrowser(clean);
}

function speakBrowser(text) {
  if (!('speechSynthesis' in window)) {
    setNarrating(false);
    return toast('この端末は読み上げに対応していません。', 'error');
  }
  const voices = speechSynthesis.getVoices();
  const ja = voices.find(v => v.lang === 'ja-JP' && /Google|Kyoko|O-ren|Nanami/.test(v.name)) || voices.find(v => v.lang.startsWith('ja'));
  // 長文は途中で止まる端末があるため文ごとに分割
  const chunks = text.match(/[^。！？!?]+[。！？!?]?/g) || [text];
  setNarrating(true);
  chunks.forEach((c, i) => {
    const u = new SpeechSynthesisUtterance(c);
    u.lang = 'ja-JP';
    if (ja) u.voice = ja;
    u.rate = 1.0;
    if (i === chunks.length - 1) u.onend = () => setNarrating(false);
    u.onerror = () => setNarrating(false);
    speechSynthesis.speak(u);
  });
}

function stopNarration() {
  if (state.audio) { state.audio.pause(); state.audio = null; }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  setNarrating(false);
}

/* =========================================================
 * 音声入力（STT）
 * 言葉の間が少し空いても切らずに聞き続け、
 * 無音が SILENCE_MS 続いたときだけ確定する
 * ========================================================= */
class VoiceListener {
  constructor({ onInterim, onFinal, onState }) {
    this.SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.onInterim = onInterim || (() => {});
    this.onFinal = onFinal || (() => {});
    this.onState = onState || (() => {});
    this.active = false;
  }
  get supported() { return !!this.SR; }

  toggle() { this.active ? this.finish() : this.start(); }

  start() {
    if (!this.SR) { toast('この端末は音声入力に対応していません（Chrome・Safariをお使いください）。', 'error'); return; }
    stopNarration();
    this.active = true;
    this.finalText = '';
    this.latest = '';
    this.spoken = false;
    this.startedAt = Date.now();
    this.lastHeard = Date.now();
    this.spawn();
    this.timer = setInterval(() => this.check(), 250);
    this.onState(true);
  }

  spawn() {
    const r = new this.SR();
    r.lang = C.STT.LANG;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) this.finalText += t;
        else interim += t;
      }
      this.latest = (this.finalText + interim).trim();
      this.spoken = this.spoken || this.latest.length > 0;
      this.lastHeard = Date.now();
      this.onInterim(this.latest);
    };
    r.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        toast('マイクの使用が許可されていません。ブラウザの設定を確認してください。', 'error');
        this.cancel();
      }
    };
    // ブラウザが途中で認識を終了しても、まだ聞き取り中なら自動で再開する
    r.onend = () => {
      if (!this.active) return;
      try { this.spawn(); } catch (err) { this.finish(); }
    };
    this.rec = r;
    r.start();
  }

  check() {
    const now = Date.now();
    if (now - this.startedAt > C.STT.MAX_MS) return this.finish();
    if (this.spoken && now - this.lastHeard > C.STT.SILENCE_MS) return this.finish();
    if (!this.spoken && now - this.startedAt > C.STT.INITIAL_WAIT_MS) return this.finish();
  }

  stopRec() {
    this.active = false;
    clearInterval(this.timer);
    try { this.rec?.stop(); } catch (e) { /* noop */ }
    this.onState(false);
  }

  finish() {
    if (!this.active) return;
    this.stopRec();
    if (this.latest) this.onFinal(this.latest);
  }

  cancel() { if (this.active) this.stopRec(); }
}

// 要望欄の音声入力
const requestVoice = new VoiceListener({
  onInterim: t => { $('#request-live').textContent = t ? `聞き取り中：${t}` : ''; },
  onFinal: t => {
    const ta = $('#request-input');
    ta.value = (ta.value ? ta.value + ' ' : '') + t;
    $('#request-live').textContent = '';
  },
  onState: on => {
    $('#request-mic').setAttribute('aria-pressed', String(on));
    $('#request-live').textContent = on ? 'どうぞ、お話しください。' : '';
  },
});

// 音声操作
const voiceCmd = new VoiceListener({
  onInterim: t => { const s = $('#voice-status'); s.hidden = false; s.textContent = t || 'どうぞ、お話しください。'; },
  onFinal: t => handleCommand(t),
  onState: on => {
    $('#voice-cmd').setAttribute('aria-pressed', String(on));
    const s = $('#voice-status');
    if (on) { s.hidden = false; s.textContent = 'どうぞ、お話しください。'; }
    else setTimeout(() => { if (!voiceCmd.active) s.hidden = true; }, 2500);
  },
});

function handleCommand(text) {
  const t = text.replace(/[\s、。]/g, '');
  const go = id => document.getElementById(id).scrollIntoView({ behavior: 'smooth', block: 'start' });

  if (/止め|ストップ|停止|やめ/.test(t)) return stopNarration();
  if (/撮影|撮って|シャッター/.test(t)) return $('#cam-wrap').hidden ? startCamera() : shoot();
  if (/カメラ/.test(t)) return startCamera();
  if (/分析|診断/.test(t)) return analyze();
  if (/読み上げ|読んで|解説|ナレーション/.test(t)) {
    return state.analysis ? playNarration(state.analysis.narration) : toast('先に「AIに分析してもらう」を押してください。');
  }
  if (/おすすめ.*メイク|メイク.*おすすめ/.test(t)) { go('step-makeup'); return applyAiMakeup(); }
  const styles = [...$$('#hair-ai .chip'), ...$$('#hair-styles .chip')]
    .sort((a, b) => b.dataset.label.length - a.dataset.label.length);
  const hit = styles.find(b => t.includes(b.dataset.label));
  if (hit) { hit.click(); go('step-hair'); return tryHair(); }
  if (/メイク/.test(t)) return go('step-makeup');
  if (/髪型|ヘア/.test(t)) return go('step-hair');
  if (/動画/.test(t)) return go('step-videos');
  if (/使い方|ヘルプ/.test(t)) return openGuide();

  $('#request-input').value = text;
  toast(`「${text}」を要望欄に入れました。`);
  go('step-analyze');
}

/* =========================================================
 * イベント登録
 * ========================================================= */
function bindMain() {
  $('#cam-start').addEventListener('click', startCamera);
  $('#cam-shoot').addEventListener('click', shoot);
  $('#cam-cancel').addEventListener('click', stopCamera);
  $('#upload-input').addEventListener('change', onUpload);

  $('#request-mic').addEventListener('click', () => requestVoice.toggle());
  $('#request-mic').hidden = !requestVoice.supported;
  $('#analyze-btn').addEventListener('click', analyze);
  $('#narrate-btn').addEventListener('click', () => state.analysis && playNarration(state.analysis.narration));
  $('#narrate-stop').addEventListener('click', stopNarration);

  renderHairPresets();
  $('#hair-btn').addEventListener('click', tryHair);
  $('#hair-save').addEventListener('click', () => state.hairResult && downloadDataUrl(state.hairResult, 'kagami-hair.png'));

  renderMakeupControls();
  $$('input[name="makeup-base"]').forEach(r => r.addEventListener('change', prepareMakeup));
  $('#mk-apply-ai').addEventListener('click', applyAiMakeup);
  $('#mk-reset').addEventListener('click', () => ['lip', 'eye', 'cheek'].forEach(p => setMakeupColor(p, null)));
  $('#mk-save').addEventListener('click', () => {
    if (!state.original) return toast('先に写真をセットしてください。', 'error');
    downloadDataUrl($('#makeup-canvas').toDataURL('image/jpeg', 0.92), 'kagami-makeup.jpg');
  });

  setupCompare($('#hair-compare'));
  setupCompare($('#makeup-compare'));
  bindSideToggles();

  $('#video-free-btn').addEventListener('click', freeVideoSearch);
  $('#video-free-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); freeVideoSearch(); } });

  $('#voice-cmd').addEventListener('click', () => voiceCmd.toggle());

  // ページを離れるときはカメラ・音声を止める
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopCamera(); requestVoice.cancel(); voiceCmd.cancel(); }
  });
  if ('speechSynthesis' in window) speechSynthesis.getVoices();
}

function init() {
  applyConfig();
  setupEarthStudio();
  setupPasswordToggles();
  bindAuth();
  bindMenu();
  bindMain();
  restoreSession();
}

init();
