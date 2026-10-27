/* かがみAI app.js v1.1.0 */
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
  hair: { style: '', label: '', color: '', appliedLabel: '' },
  makeup: {
    lip: { color: null, name: '', amount: 0.55 },
    eye: { color: null, name: '', amount: 0.45 },
    cheek: { color: null, name: '', amount: 0.40 },
    effects: new Set(),   // 'nose' | 'jaw' | 'small' | 'bright' | 'eyes'
    strength: 0.6,        // 印象効果の強さ
    preset: '',           // 雰囲気の名前
    instruction: '',      // 言葉での指示
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

/** 画像を保存（毎回ちがうファイル名にして「再ダウンロード」確認を出さない） */
async function downloadDataUrl(url, name) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '.jpg';
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const fileName = `${base}-${stamp}${ext}`;
  let href = url;
  let revoke = null;
  try {
    const blob = await (await fetch(url)).blob(); // dataURLをBlobに変換（スマホで安定）
    href = URL.createObjectURL(blob);
    revoke = href;
  } catch (e) { /* dataURLのまま保存 */ }
  const a = el('a', { href, download: fileName });
  document.body.append(a);
  a.click();
  a.remove();
  if (revoke) setTimeout(() => URL.revokeObjectURL(revoke), 10000);
  toast(`「${fileName}」を保存しました。`, 'success');
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
  loadGallery(true);
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
    if (!confirm('サーバーに保存されているあなたの写真（一時保存とギャラリー）をすべて削除します。よろしいですか？')) return;
    const r = await run(() => api('deleteMyImages'), '削除しています…');
    if (r) { toast(r.message, 'success'); resetGallery(); }
  });
  $('#menu-logout').addEventListener('click', async () => {
    close();
    stopNarration();
    try { await api('logout'); } catch (e) { /* noop */ }
    clearSession();
    resetGallery();
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

  state.hair.appliedLabel = '';

  toast('写真をセットしました。次は「AIに分析してもらう」です。', 'success');
  prepareMakeup();
  prepareSet();
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
  state.hair.appliedLabel = state.hair.label;
  await setCompare($('#hair-compare'), state.original, state.hairResult);
  $('#hair-result-actions').hidden = false;
  const hairBase = $('input[name="makeup-base"][value="hair"]');
  hairBase.disabled = false;
  hairBase.checked = true; // メイクは新しい髪型の写真にのせる
  prepareMakeup();
  prepareSet();
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
const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const NOSE_LINE = [168, 6, 197, 195, 5];
const JAW_R = [323, 361, 288, 397, 365, 379, 378];
const JAW_L = [93, 132, 58, 172, 136, 150, 149];
const SIDE_R = [297, 332, 284, 251, 389, 356, 454, 323, 361];
const SIDE_L = [67, 103, 54, 21, 162, 127, 234, 93, 132];
const SHADE = '#6B4A3C';   // シェーディング色
const LIGHT = '#FFF4EC';   // ハイライト色
const LINER = '#2B1F22';   // アイライン色

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

/** 顔の点を検出（写真ごとに1回だけ）。失敗時は例外 */
async function ensureLandmarks(key) {
  const img = await getBaseImg(key);
  if (state.landmarks[key] == null) {
    const lm = await getLandmarker();
    state.landmarks[key] = lm.detect(img).faceLandmarks?.[0] || false;
  }
  return img;
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
  if (state.landmarks[key] == null) status.textContent = '顔の位置を読み取っています…';
  try {
    await ensureLandmarks(key);
  } catch (e) {
    console.error(e);
    msg = 'メイク機能を読み込めませんでした。通信状態を確認して、もう一度写真をセットしてください。';
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
  if (img) drawMakeup($('#makeup-canvas'), img, state.landmarks[key]);
  renderSet();
}

/** 写真にメイクを重ねてキャンバスに描く */
function drawMakeup(cv, img, lm) {
  cv.width = img.naturalWidth;
  cv.height = img.naturalHeight;
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0);
  if (!lm) return;

  const W = cv.width, H = cv.height;
  const P = i => ({ x: lm[i].x * W, y: lm[i].y * H });
  const faceW = Math.hypot(P(454).x - P(234).x, P(454).y - P(234).y);
  const m = state.makeup;
  const fx = { ctx, P, faceW, k: m.strength, on: key => m.effects.has(key) && m.strength > 0 };

  drawShading(fx);

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
  // 目元ぱっちり（アイライン）
  if (fx.on('eyes')) drawLiner(fx);
  // リップ（内側の口の中は塗らない）
  if (m.lip.color && m.lip.amount > 0) {
    const outer = LIP_OUTER.map(P);
    const inner = LIP_INNER.map(P);
    const path = p => { poly(p, outer); poly(p, inner); };
    const blur = faceW * 0.004;
    paint(ctx, { fill: m.lip.color, alpha: m.lip.amount * 0.55, mode: 'multiply', blur, path });
    paint(ctx, { fill: m.lip.color, alpha: m.lip.amount * 0.35, mode: 'soft-light', blur, path });
  }

  drawHighlights(fx);
}

/* ---------- 見せたい印象（シェーディング・ハイライト・アイライン） ---------- */
const lerpPt = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** 輪郭の点と、そこから顔の中心へ寄せた点で帯状の形を作る */
function bandToward(P, idx, t) {
  const center = P(1);
  const outer = idx.map(P);
  const inner = outer.map(p => lerpPt(p, center, t));
  return [...outer, ...inner.reverse()];
}

/** 鼻筋に沿った帯（side: -1/1 で左右、0 で中央） */
function noseStrip(P, faceW, offsetRate, widthRate, side, idx = NOSE_LINE) {
  const line = idx.map(P);
  const a = line[0], b = line[line.length - 1];
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const perp = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
  const off = faceW * offsetRate * side;
  const w = faceW * widthRate / 2;
  const outer = line.map(p => ({ x: p.x + perp.x * (off + w), y: p.y + perp.y * (off + w) }));
  const inner = line.map(p => ({ x: p.x + perp.x * (off - w), y: p.y + perp.y * (off - w) }));
  return [...outer, ...inner.reverse()];
}

function glow(ctx, c, r, alpha) {
  const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
  g.addColorStop(0, hexToRgba(LIGHT, 1));
  g.addColorStop(1, hexToRgba(LIGHT, 0));
  paint(ctx, { fill: g, alpha, mode: 'screen', blur: 0, path: p => p.arc(c.x, c.y, r, 0, Math.PI * 2) });
}

function drawShading({ ctx, P, faceW, k, on }) {
  // 明るく見せる：顔全体をトーンアップ
  if (on('bright')) {
    paint(ctx, { fill: LIGHT, alpha: k * 0.18, mode: 'screen', blur: faceW * 0.06, path: p => poly(p, FACE_OVAL.map(P)) });
  }
  // 小顔に見せる：こめかみ〜頬の外側
  if (on('small')) {
    [SIDE_R, SIDE_L].forEach(idx => paint(ctx, {
      fill: SHADE, alpha: k * 0.38, mode: 'multiply', blur: faceW * 0.05, path: p => poly(p, bandToward(P, idx, 0.12)),
    }));
  }
  // あごをすっきり：フェイスラインの下側
  if (on('jaw')) {
    [JAW_R, JAW_L].forEach(idx => paint(ctx, {
      fill: SHADE, alpha: k * 0.42, mode: 'multiply', blur: faceW * 0.04, path: p => poly(p, bandToward(P, idx, 0.16)),
    }));
  }
  // 鼻を高く見せる：鼻筋の両脇に影
  if (on('nose')) {
    [-1, 1].forEach(side => paint(ctx, {
      fill: SHADE, alpha: k * 0.42, mode: 'multiply', blur: faceW * 0.02, path: p => poly(p, noseStrip(P, faceW, 0.058, 0.035, side)),
    }));
  }
}

function drawLiner({ ctx, P, faceW, k }) {
  [R_LID, L_LID].forEach(lid => {
    const pts = lid.map(P);
    const outer = pts[0], inner = pts[pts.length - 1];
    const eyeW = Math.hypot(outer.x - inner.x, outer.y - inner.y);
    const wing = {
      x: outer.x + (outer.x - inner.x) * 0.16,
      y: outer.y + (outer.y - inner.y) * 0.16 - eyeW * 0.07,
    };
    ctx.save();
    ctx.globalAlpha = Math.min(1, k * 0.85);
    ctx.globalCompositeOperation = 'multiply';
    if ('filter' in ctx) ctx.filter = `blur(${(faceW * 0.002).toFixed(1)}px)`;
    ctx.strokeStyle = LINER;
    ctx.lineWidth = faceW * 0.008 * (0.6 + k);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(wing.x, wing.y);
    pts.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.stroke();
    ctx.restore();
  });
}

function drawHighlights({ ctx, P, faceW, k, on }) {
  if (on('nose')) {
    paint(ctx, {
      fill: LIGHT, alpha: k * 0.45, mode: 'screen', blur: faceW * 0.012,
      path: p => poly(p, noseStrip(P, faceW, 0, 0.028, 0, [6, 197, 195, 5])),
    });
  }
  if (on('jaw')) glow(ctx, lerpPt(P(152), P(17), 0.3), faceW * 0.07, k * 0.35);
  if (on('bright')) {
    glow(ctx, P(151), faceW * 0.12, k * 0.35);                         // おでこ
    glow(ctx, lerpPt(P(145), P(50), 0.45), faceW * 0.075, k * 0.32);   // 目の下（右）
    glow(ctx, lerpPt(P(374), P(280), 0.45), faceW * 0.075, k * 0.32);  // 目の下（左）
    if (!on('jaw')) glow(ctx, lerpPt(P(152), P(17), 0.3), faceW * 0.06, k * 0.25);
  }
}

/* ---------- 5. ヘア＋メイク セット ---------- */
const MAKEUP_LABELS = [['lip', 'リップ'], ['eye', 'アイシャドウ'], ['cheek', 'チーク']];

function makeupSummaryText() {
  const m = state.makeup;
  const parts = [];
  if (m.preset) parts.push(`雰囲気：${m.preset}`);
  MAKEUP_LABELS.filter(([p]) => m[p].color).forEach(([p, l]) => parts.push(`${l}：${m[p].name}`));
  const eff = C.MAKEUP_EFFECTS.filter(e => m.effects.has(e.key)).map(e => e.label);
  if (eff.length && m.strength > 0) parts.push(`印象：${eff.join('・')}`);
  return parts.length ? parts.join('／') : 'メイク：なし';
}
const hasMakeup = () => MAKEUP_LABELS.some(([p]) => state.makeup[p].color) || (state.makeup.effects.size > 0 && state.makeup.strength > 0);

function setSummaryText() {
  return `髪型：${state.hair.appliedLabel || '—'}／` + makeupSummaryText();
}

async function prepareSet() {
  const box = $('#set-compare');
  const status = $('#set-status');
  if (!state.hairResult) {
    resetCompare(box);
    $('#set-actions').hidden = true;
    $('#set-summary').textContent = '';
    status.textContent = '';
    return;
  }
  const orig = await getBaseImg('original');
  const hair = await getBaseImg('hair');
  $('.cmp-before', box).src = orig.src;
  box.style.aspectRatio = `${hair.naturalWidth} / ${hair.naturalHeight}`;
  box.classList.add('is-ready');
  $('#set-actions').hidden = false;
  renderSet();
  if (state.landmarks.hair == null) {
    status.textContent = '顔の位置を読み取っています…';
    try { await ensureLandmarks('hair'); } catch (e) { console.error(e); }
    renderSet();
  }
}

function renderSet() {
  const img = state.baseImgs.hair;
  if (!state.hairResult || !img) return;
  const lm = state.landmarks.hair;
  drawMakeup($('#set-canvas'), img, lm);
  $('#set-summary').textContent = setSummaryText();
  const status = $('#set-status');
  const noMakeup = !hasMakeup();
  if (lm === false) status.textContent = '髪型を変えた写真から顔を見つけられなかったため、メイクはのせていません。';
  else if (lm == null) status.textContent = '顔の位置を読み取っています…';
  else status.textContent = noMakeup ? '4でメイクの色を選ぶと、ここにも重なります。' : '';
}

/** 「いま」と「ヘア＋メイク」を並べた1枚の画像を保存 */
async function saveSetImage() {
  if (!state.hairResult) return toast('先に髪型を試してください。', 'error');
  renderSet();
  const orig = await getBaseImg('original');
  const fin = $('#set-canvas');
  const H = Math.min(1024, fin.height);
  const w1 = Math.round(orig.naturalWidth * H / orig.naturalHeight);
  const w2 = Math.round(fin.width * H / fin.height);
  const pad = 28, labelH = 64, footH = 72;
  const cv = document.createElement('canvas');
  cv.width = w1 + w2 + pad * 3;
  cv.height = H + pad * 2 + labelH + footH;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#F3F1F5';
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#2A2230';
  ctx.font = 'bold 34px "Zen Kaku Gothic New", sans-serif';
  ctx.fillText('いま', pad, pad + labelH / 2);
  ctx.fillStyle = '#B3264A';
  ctx.fillText('ヘア＋メイク', pad * 2 + w1, pad + labelH / 2);
  ctx.drawImage(orig, pad, pad + labelH, w1, H);
  ctx.drawImage(fin, pad * 2 + w1, pad + labelH, w2, H);
  ctx.fillStyle = '#5E5566';
  ctx.font = '24px "Zen Kaku Gothic New", sans-serif';
  const footY = pad + labelH + H + footH / 2;
  ctx.fillText(setSummaryText(), pad, footY, cv.width - pad * 3 - 160);
  ctx.textAlign = 'right';
  ctx.font = 'bold 26px "Shippori Mincho B1", serif';
  ctx.fillStyle = '#2A2230';
  ctx.fillText(C.APP_NAME, cv.width - pad, footY);
  downloadDataUrl(cv.toDataURL('image/jpeg', 0.92), 'kagami-hair-makeup.jpg');
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
  b.addEventListener('click', () => { clearPreset(); setMakeupColor(part, hex, name); });
  return b;
}

function setMakeupColor(part, hex, name = '') {
  state.makeup[part].color = hex || null;
  state.makeup[part].name = hex ? name : '';
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
    range.addEventListener('input', () => { clearPreset(); state.makeup[part].amount = range.value / 100; renderMakeup(); });
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
  clearPreset();
  ['lip', 'eye', 'cheek'].forEach(part => { if (isHex(mk[part]?.hex)) setMakeupColor(part, mk[part].hex, mk[part].name || 'おすすめ'); });
  $('#makeup-compare').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ---------- 雰囲気・見せたい印象・言葉での指示 ---------- */
const EFFECT_KEYS = () => C.MAKEUP_EFFECTS.map(e => e.key);
const clamp01 = v => Math.max(0, Math.min(1, Number(v) || 0));

function clearPreset() {
  state.makeup.preset = '';
  $$('#mk-presets .chip').forEach(b => b.setAttribute('aria-pressed', 'false'));
}

function setAmount(part, a) {
  state.makeup[part].amount = clamp01(a);
  $(`#mk-${part}-amt`).value = Math.round(state.makeup[part].amount * 100);
}

function setEffects(keys, strength) {
  state.makeup.effects = new Set(keys.filter(k => EFFECT_KEYS().includes(k)));
  $$('#mk-effects .chip').forEach(b => b.setAttribute('aria-pressed', String(state.makeup.effects.has(b.dataset.key))));
  if (strength != null) {
    state.makeup.strength = clamp01(strength);
    $('#mk-effect-amt').value = Math.round(state.makeup.strength * 100);
  }
}

function applyPreset(p, btn) {
  ['lip', 'eye', 'cheek'].forEach(part => {
    const c = p[part];
    if (c && isHex(c.hex)) { setAmount(part, c.amount); setMakeupColor(part, c.hex, c.name); }
  });
  setEffects(p.effects || [], p.strength);
  state.makeup.preset = p.label;
  $$('#mk-presets .chip').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
  renderMakeup();
}

function setupMakeupStyle() {
  $('#mk-presets').replaceChildren(...C.MAKEUP_PRESETS.map(p => {
    const b = el('button', { type: 'button', class: 'chip', 'aria-pressed': 'false', 'data-key': p.key }, p.label);
    b.addEventListener('click', () => applyPreset(p, b));
    return b;
  }));
  $('#mk-effects').replaceChildren(...C.MAKEUP_EFFECTS.map(e => {
    const b = el('button', { type: 'button', class: 'chip', 'aria-pressed': 'false', 'data-key': e.key }, e.label);
    b.addEventListener('click', () => {
      const on = !state.makeup.effects.has(e.key);
      if (on) state.makeup.effects.add(e.key); else state.makeup.effects.delete(e.key);
      b.setAttribute('aria-pressed', String(on));
      clearPreset();
      renderMakeup();
    });
    return b;
  }));
  const amt = $('#mk-effect-amt');
  state.makeup.strength = amt.value / 100;
  amt.addEventListener('input', () => { state.makeup.strength = amt.value / 100; clearPreset(); renderMakeup(); });

  $('#mk-instruct-btn').addEventListener('click', makeupByInstruction);
  $('#mk-instruct').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); makeupByInstruction(); } });
  $('#mk-instruct-mic').addEventListener('click', () => instructVoice.toggle());
  $('#mk-instruct-mic').hidden = !instructVoice.supported;
}

/** AIが使えないときのキーワード判定 */
function localPlan(text) {
  const t = text.replace(/\s/g, '');
  const plan = { effects: {} };
  const preset = C.MAKEUP_PRESETS.find(p =>
    (p.key === 'natural' && /ナチュラル|自然|すっぴん風|薄め/.test(t)) ||
    (p.key === 'glam' && /華やか|パーティ|結婚式|派手/.test(t)) ||
    (p.key === 'formal' && /きちんと|仕事|オフィス|面接|上品/.test(t)) ||
    (p.key === 'young' && /若々し|若く|血色|元気/.test(t)));
  if (preset) {
    ['lip', 'eye', 'cheek'].forEach(part => { plan[part] = preset[part]; });
    preset.effects.forEach(k => { plan.effects[k] = preset.strength; });
  }
  const rules = [
    ['nose', /鼻/], ['jaw', /あご|顎|フェイスライン|二重あご/], ['small', /小顔|顔を小さ|輪郭/],
    ['bright', /明る|透明感|ツヤ|くすみ|トーンアップ/], ['eyes', /目|まぶた|アイライン|ぱっちり/],
  ];
  rules.forEach(([k, re]) => { if (re.test(t)) plan.effects[k] = 0.6; });
  return (preset || Object.keys(plan.effects).length) ? plan : null;
}

function applyPlan(plan) {
  clearPreset();
  ['lip', 'eye', 'cheek'].forEach(part => {
    const c = plan[part];
    if (c === null) setMakeupColor(part, null);
    else if (c && isHex(c.hex)) {
      if (c.amount != null) setAmount(part, c.amount);
      setMakeupColor(part, c.hex, c.name || 'AIの提案');
    }
  });
  const eff = plan.effects || {};
  const keys = Object.keys(eff).filter(k => Number(eff[k]) > 0.15);
  const vals = keys.map(k => clamp01(eff[k]));
  setEffects(keys, vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null);
  if (plan.comment) { $('#mk-tips').textContent = plan.comment; $('#mk-tips').hidden = false; }
  renderMakeup();
}

async function makeupByInstruction() {
  const text = $('#mk-instruct').value.trim();
  if (!text) return toast('どんなメイクにしたいか入力してください（例：鼻を高く見せたい）。', 'error');
  if (!state.original) return toast('先に写真をセットしてください。', 'error');
  const context = state.analysis ? { faceShape: state.analysis.faceShape, personalColor: state.analysis.personalColor } : {};
  let plan = null;
  loading(true, 'AIがメイクを考えています…');
  try {
    plan = (await api('makeupPlan', { text, context })).plan;
  } catch (e) {
    console.warn(e);
  } finally {
    loading(false);
  }
  if (!plan) {
    plan = localPlan(text);
    if (!plan) return toast('指示を読み取れませんでした。「鼻を高く」「明るく」などの言葉でお試しください。', 'error');
    toast('キーワードからメイクを組み立てました。');
  }
  state.makeup.instruction = text;
  applyPlan(plan);
  $('#makeup-compare').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* =========================================================
 * 6. ギャラリー
 * ========================================================= */
const gallery = { items: [], selected: [], full: {}, loaded: false, slider: false };

function resetGallery() {
  gallery.items = [];
  gallery.selected = [];
  gallery.full = {};
  gallery.loaded = false;
  gallery.slider = false;
  renderGallery();
}

const fmtDate = iso => {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

async function loadGallery(force = false) {
  if (gallery.loaded && !force) return renderGallery();
  try {
    const r = await api('listLooks');
    gallery.items = r.items || [];
    gallery.loaded = true;
    gallery.selected = gallery.selected.filter(id => gallery.items.some(i => i.lookId === id));
    renderGallery();
  } catch (e) {
    $('#gal-empty').hidden = false;
    $('#gal-empty').textContent = 'ギャラリーを読み込めませんでした：' + e.message;
  }
}

function renderGallery() {
  $('#gal-empty').hidden = gallery.items.length > 0;
  $('#gal-empty').textContent = 'まだ保存した写真はありません。4か5の「ギャラリーに保存」で追加できます。';
  $('#gal-total').textContent = gallery.items.length ? `${gallery.items.length}枚` : '';
  $('#gal-list').replaceChildren(...gallery.items.map(it => {
    const idx = gallery.selected.indexOf(it.lookId);
    const b = el('button', {
      type: 'button', class: 'gal-item', 'aria-pressed': String(idx >= 0),
      'aria-label': `${fmtDate(it.createdAt)} ${it.summary || ''}`,
    },
    idx >= 0 ? el('span', { class: 'gal-badge' }, String(idx + 1)) : null,
    el('img', { src: 'data:image/jpeg;base64,' + it.thumb, alt: '' }),
    el('span', { class: 'gal-cap' }, fmtDate(it.createdAt), el('small', {}, it.hairLabel || '')));
    b.addEventListener('click', () => toggleLook(it.lookId));
    return b;
  }));
  renderGalleryCompare();
}

function toggleLook(id) {
  const i = gallery.selected.indexOf(id);
  if (i >= 0) gallery.selected.splice(i, 1);
  else {
    if (gallery.selected.length >= 4) return toast('見比べられるのは4枚までです。', 'error');
    gallery.selected.push(id);
  }
  renderGallery();
}

async function renderGalleryCompare() {
  const area = $('#gal-compare-area');
  const sel = [...gallery.selected];
  area.hidden = sel.length === 0;
  if (!sel.length) return;
  $('#gal-count').textContent = sel.length === 1 ? '1枚を選択中（もう1枚以上選ぶと見比べられます）' : `${sel.length}枚を見比べる`;

  const grid = $('#gal-grid');
  const need = sel.filter(id => !gallery.full[id]);
  if (need.length) {
    grid.hidden = false;
    $('#gal-slider').hidden = true;
    grid.replaceChildren(el('p', { class: 'muted' }, '写真を読み込んでいます…'));
    try {
      const r = await api('getLooks', { ids: need });
      (r.items || []).forEach(it => { gallery.full[it.lookId] = `data:${it.mimeType};base64,${it.image}`; });
    } catch (e) {
      grid.replaceChildren(el('p', { class: 'muted' }, e.message));
      return;
    }
    if (gallery.selected.join() !== sel.join()) return; // 読み込み中に選択が変わった
  }

  const items = sel.map(id => gallery.items.find(x => x.lookId === id)).filter(Boolean);
  const src = it => gallery.full[it.lookId] || 'data:image/jpeg;base64,' + it.thumb;
  grid.replaceChildren(...items.map((it, i) => el('figure', { class: 'gal-fig' },
    el('span', { class: 'gal-badge' }, String(i + 1)),
    el('img', { src: src(it), alt: `${i + 1}枚目` }),
    el('figcaption', {}, el('strong', {}, fmtDate(it.createdAt)), el('span', {}, it.summary || '')))));

  const two = items.length === 2;
  if (!two) gallery.slider = false;
  const modeBtn = $('#gal-mode');
  modeBtn.hidden = !two;
  modeBtn.setAttribute('aria-pressed', String(gallery.slider));
  modeBtn.textContent = gallery.slider ? '並べて比べる' : 'スライダーで比べる';
  $('#gal-slider').hidden = !gallery.slider;
  if (gallery.slider) await setCompare($('#gal-slider'), src(items[0]), src(items[1]));
}

function scaledJpeg(cv, max, q) {
  const s = Math.min(1, max / Math.max(cv.width, cv.height));
  const c = document.createElement('canvas');
  c.width = Math.round(cv.width * s);
  c.height = Math.round(cv.height * s);
  c.getContext('2d').drawImage(cv, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', q);
}

async function saveToGallery(source) {
  if (!state.original) return toast('先に写真をセットしてください。', 'error');
  let cv, hair;
  if (source === 'set') {
    if (!state.hairResult) return toast('先に3で髪型を試してください。', 'error');
    renderSet();
    cv = $('#set-canvas');
    hair = state.hair.appliedLabel;
  } else {
    renderMakeup();
    cv = $('#makeup-canvas');
    hair = currentBase() === 'hair' ? state.hair.appliedLabel : '元の髪型';
  }
  if (!cv.width) return toast('保存する画像がありません。', 'error');
  const m = state.makeup;
  const meta = {
    source,
    hair,
    summary: `髪型：${hair}／` + makeupSummaryText(),
    preset: m.preset,
    effects: [...m.effects],
    strength: m.strength,
    instruction: m.instruction,
    lip: m.lip, eye: m.eye, cheek: m.cheek,
  };
  const r = await run(() => api('saveLook', {
    image: b64(scaledJpeg(cv, 1024, 0.9)),
    thumb: b64(scaledJpeg(cv, 240, 0.72)),
    meta,
  }), 'ギャラリーに保存しています…');
  if (!r) return;
  gallery.items.unshift(r.look);
  gallery.loaded = true;
  renderGallery();
  toast(r.message + '（6で見比べられます）', 'success');
}

async function deleteSelectedLooks() {
  const ids = [...gallery.selected];
  if (!ids.length) return;
  if (!confirm(`選んだ${ids.length}枚をギャラリーから削除します。よろしいですか？`)) return;
  loading(true, '削除しています…');
  try {
    for (const id of ids) {
      await api('deleteLook', { lookId: id });
      gallery.items = gallery.items.filter(x => x.lookId !== id);
      delete gallery.full[id];
    }
    toast('削除しました。', 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    loading(false);
    gallery.selected = [];
    gallery.slider = false;
    renderGallery();
  }
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

// メイク指示の音声入力
const instructVoice = new VoiceListener({
  onInterim: t => { $('#mk-instruct-live').textContent = t ? `聞き取り中：${t}` : ''; },
  onFinal: t => {
    const input = $('#mk-instruct');
    input.value = (input.value ? input.value + ' ' : '') + t;
    $('#mk-instruct-live').textContent = '';
    makeupByInstruction();
  },
  onState: on => {
    $('#mk-instruct-mic').setAttribute('aria-pressed', String(on));
    $('#mk-instruct-live').textContent = on ? 'どうぞ、お話しください（例：鼻を高く、明るく見せたい）。' : '';
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
  if (/ギャラリー|見比べ|比較/.test(t)) return go('step-gallery');
  if (/セット|仕上が|完成/.test(t)) return go('step-set');
  if (/鼻|あご|顎|小顔|明る|ナチュラル|華やか|ぱっちり/.test(t)) {
    $('#mk-instruct').value = text;
    go('step-makeup');
    return makeupByInstruction();
  }
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
  $('#hair-save').addEventListener('click', () => state.hairResult && downloadDataUrl(state.hairResult, state.hairResult.startsWith('data:image/png') ? 'kagami-hair.png' : 'kagami-hair.jpg'));

  renderMakeupControls();
  $$('input[name="makeup-base"]').forEach(r => r.addEventListener('change', prepareMakeup));
  $('#mk-apply-ai').addEventListener('click', applyAiMakeup);
  $('#mk-reset').addEventListener('click', () => {
    clearPreset();
    state.makeup.instruction = '';
    setEffects([], null);
    ['lip', 'eye', 'cheek'].forEach(p => setMakeupColor(p, null));
  });
  setupMakeupStyle();
  $('#mk-gallery-save').addEventListener('click', () => saveToGallery('makeup'));
  $('#mk-save').addEventListener('click', () => {
    if (!state.original) return toast('先に写真をセットしてください。', 'error');
    downloadDataUrl($('#makeup-canvas').toDataURL('image/jpeg', 0.92), 'kagami-makeup.jpg');
  });

  setupCompare($('#hair-compare'));
  setupCompare($('#makeup-compare'));
  setupCompare($('#set-compare'));
  $('#set-save').addEventListener('click', saveSetImage);
  $('#set-gallery-save').addEventListener('click', () => saveToGallery('set'));
  setupCompare($('#gal-slider'));
  $('#gal-reload').addEventListener('click', () => loadGallery(true));
  $('#gal-clear').addEventListener('click', () => { gallery.selected = []; gallery.slider = false; renderGallery(); });
  $('#gal-delete').addEventListener('click', deleteSelectedLooks);
  $('#gal-mode').addEventListener('click', () => { gallery.slider = !gallery.slider; renderGalleryCompare(); });
  bindSideToggles();

  $('#video-free-btn').addEventListener('click', freeVideoSearch);
  $('#video-free-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); freeVideoSearch(); } });

  $('#voice-cmd').addEventListener('click', () => voiceCmd.toggle());

  // ページを離れるときはカメラ・音声を止める
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopCamera(); requestVoice.cancel(); voiceCmd.cancel(); instructVoice.cancel(); }
  });
  if ('speechSynthesis' in window) speechSynthesis.getVoices();
}

function init() {
  window.__kagamiStarted = true;
  try {
    if (!C) throw new Error('config.js が読み込まれていません。');
    applyConfig();
    setupEarthStudio();
    setupPasswordToggles();
    bindAuth();
    bindMenu();
    bindMain();
  } catch (e) {
    console.error(e);
    window.__kagamiBoot?.fail('起動中にエラーが発生しました：' + e.message);
  }
  // 途中で失敗してもログイン画面は必ず出す
  restoreSession().catch(() => showView('login'));
}

init();
