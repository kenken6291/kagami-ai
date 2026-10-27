/**
 * かがみAI ～ヘア＆メイク試着室  バックエンド（Google Apps Script）
 * v1.0.0
 *
 * ■ スクリプトプロパティ（プロジェクトの設定 → スクリプト プロパティ）
 *   必須  GEMINI_API_KEY        … Gemini APIキー
 *   任意  YOUTUBE_API_KEY       … YouTube Data API v3 キー（無ければ動画は「YouTubeで開く」リンクのみ）
 *   任意  APP_NAME / APP_URL    … メール本文に使うアプリ名・公開URL
 *   任意  GEMINI_TEXT_MODEL / GEMINI_TTS_MODEL / TTS_VOICE
 *   任意  GEMINI_IMAGE_MODEL … カンマ区切りで複数可（例: gemini-3.1-flash-image,gemini-2.5-flash-image）
 *         ※画像生成は無料枠では使えない場合があります（Google AI Studio で課金設定が必要）
 *   任意  DAILY_AI_LIMIT（既定40） / IMAGE_RETENTION_DAYS（既定7）
 *   自動  SPREADSHEET_ID / DRIVE_FOLDER_ID / PEPPER … setup() 実行時に自動作成
 *
 * ■ 初回だけ setup() を実行 → ウェブアプリとしてデプロイ（実行ユーザー: 自分 / アクセス: 全員）
 * ■ コードを変更したら「デプロイを管理 → 編集 → 新バージョン」で再デプロイが必要です
 */

const APP_VERSION = 'v1.0.0';
const TERMS_VERSION = '2026-10-27';
const SESSION_TTL = 21600;      // 6時間（CacheServiceの上限）
const MAX_FAILS = 5;            // ログイン失敗の上限
const LOCK_MINUTES = 15;        // ロック時間
const HASH_ROUNDS = 300;        // パスワードハッシュの反復回数

const SHEETS = {
  USERS: {
    name: 'Users',
    headers: ['userId', 'email', 'nickname', 'passwordHash', 'salt', 'mustChange', 'failCount',
      'lockedUntil', 'status', 'termsVersion', 'agreedAt', 'createdAt', 'lastLoginAt'],
  },
  HISTORY: {
    name: 'History',
    headers: ['historyId', 'userId', 'createdAt', 'imageFileId', 'faceShape', 'personalColor',
      'hairStyle', 'request', 'analysisJson'],
  },
  LOGS: {
    name: 'Logs',
    headers: ['at', 'userId', 'action', 'detail'],
  },
};

const DEFAULTS = {
  APP_NAME: 'かがみAI',
  APP_URL: 'https://kenken6291.github.io/kagami-ai/',
  GEMINI_TEXT_MODEL: 'gemini-2.5-flash',
  // カンマ区切りで複数指定すると、失敗時に順番に試す
  GEMINI_IMAGE_MODEL: 'gemini-3.1-flash-image,gemini-2.5-flash-image,gemini-3.1-flash-lite-image',
  GEMINI_TTS_MODEL: 'gemini-2.5-flash-preview-tts',
  TTS_VOICE: 'Kore',
  DAILY_AI_LIMIT: '40',
  IMAGE_RETENTION_DAYS: '7',
};

/* =========================================================
 * 設定・初期化
 * ========================================================= */
function prop_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  return (v === null || v === '') ? (DEFAULTS[key] || '') : v;
}
function setProp_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, value);
}

/** 初回に1回だけ実行してください（スプレッドシート・Driveフォルダ・トリガーを作成） */
function setup() {
  let ss;
  const ssId = prop_('SPREADSHEET_ID');
  if (ssId) {
    ss = SpreadsheetApp.openById(ssId);
  } else {
    ss = SpreadsheetApp.create(prop_('APP_NAME') + '_DB');
    setProp_('SPREADSHEET_ID', ss.getId());
  }
  Object.keys(SHEETS).forEach(function (k) {
    const def = SHEETS[k];
    let sh = ss.getSheetByName(def.name);
    if (!sh) sh = ss.insertSheet(def.name);
    if (sh.getLastRow() === 0) {
      sh.appendRow(def.headers);
      sh.setFrozenRows(1);
      sh.getRange(1, 1, 1, def.headers.length).setFontWeight('bold');
    }
  });
  ['Sheet1', 'シート1'].forEach(function (n) {
    const s = ss.getSheetByName(n);
    if (s && ss.getSheets().length > 1 && s.getLastRow() === 0) ss.deleteSheet(s);
  });

  if (!prop_('DRIVE_FOLDER_ID')) {
    const folder = DriveApp.createFolder(prop_('APP_NAME') + '_images');
    setProp_('DRIVE_FOLDER_ID', folder.getId());
  }
  if (!prop_('PEPPER')) setProp_('PEPPER', Utilities.getUuid() + Utilities.getUuid());

  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'cleanupOldImages'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('cleanupOldImages').timeBased().everyDays(1).atHour(3).create();

  Logger.log('セットアップ完了');
  Logger.log('スプレッドシート: ' + ss.getUrl());
  Logger.log('画像フォルダID: ' + prop_('DRIVE_FOLDER_ID'));
  if (!prop_('GEMINI_API_KEY')) Logger.log('⚠ GEMINI_API_KEY が未設定です');
}

/** 動作確認用：Gemini APIに簡単な質問を送ります */
function testGemini() {
  const res = callGemini_(prop_('GEMINI_TEXT_MODEL'), {
    contents: [{ role: 'user', parts: [{ text: '「こんにちは」とだけ返してください。' }] }],
  });
  Logger.log(extractText_(res));
}

/* =========================================================
 * エントリーポイント
 * ========================================================= */
function doGet() {
  return json_({ ok: true, app: prop_('APP_NAME'), version: APP_VERSION });
}

function doPost(e) {
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const fn = ROUTES[req.action];
    if (!fn) throw new Error('不明な操作です: ' + req.action);
    out = Object.assign({ ok: true, version: APP_VERSION }, fn(req));
  } catch (err) {
    out = { ok: false, error: (err && err.message) || String(err), code: (err && err.code) || '' };
  }
  return json_(out);
}

const ROUTES = {
  register: register_,
  login: login_,
  logout: logout_,
  me: me_,
  changePassword: changePassword_,
  forgotPassword: forgotPassword_,
  analyze: analyze_,
  hairEdit: hairEdit_,
  tts: tts_,
  videos: videos_,
  history: history_,
  deleteMyImages: deleteMyImages_,
};

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* =========================================================
 * 会員登録・認証
 * ========================================================= */
function register_(req) {
  const email = normEmail_(req.email);
  const nickname = String(req.nickname || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('メールアドレスの形式が正しくありません。');
  if (!nickname || nickname.length > 20) throw new Error('ニックネームは1〜20文字で入力してください。');

  const a = req.agreements || {};
  if (!(a.terms === true && a.disclaimer === true && a.selfResponsibility === true && a.dispute === true)) {
    throw new Error('すべての同意項目にチェックが必要です。');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (findUser_('email', email)) {
      throw new Error('このメールアドレスは登録済みです。パスワードを忘れた場合は「パスワードを忘れた方」から再発行してください。');
    }
    const temp = tempPassword_();
    const salt = Utilities.getUuid();
    const now = new Date();
    const user = {
      userId: 'u_' + now.getTime().toString(36) + Utilities.getUuid().slice(0, 6),
      email: email,
      nickname: safe_(nickname),
      passwordHash: hash_(temp, salt),
      salt: salt,
      mustChange: true,
      failCount: 0,
      lockedUntil: '',
      status: 'active',
      termsVersion: TERMS_VERSION,
      agreedAt: now,
      createdAt: now,
      lastLoginAt: '',
    };
    // メール送信に失敗した場合は登録しない
    sendTempPasswordMail_(email, nickname, temp, false);
    sheet_('USERS').appendRow(SHEETS.USERS.headers.map(function (h) { return user[h]; }));
    log_(user.userId, 'register', '');
  } finally {
    lock.releaseLock();
  }
  return { message: '仮パスワードを ' + email + ' に送りました。メールを確認してログインしてください。' };
}

function login_(req) {
  const email = normEmail_(req.email);
  const pw = String(req.password || '');
  const generic = 'メールアドレスまたはパスワードが違います。';
  const f = findUser_('email', email);
  if (!f) throw new Error(generic);
  const u = f.obj;

  if (u.status !== 'active') throw new Error('このアカウントは利用停止中です。');
  if (u.lockedUntil && new Date(u.lockedUntil) > new Date()) {
    throw new Error('ログイン失敗が続いたため一時的にロックしています。' + LOCK_MINUTES + '分ほど待ってからお試しください。');
  }

  if (hash_(pw, u.salt) !== u.passwordHash) {
    const fails = Number(u.failCount || 0) + 1;
    if (fails >= MAX_FAILS) {
      updateUser_(f.row, { failCount: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60000) });
      log_(u.userId, 'lock', '');
      throw new Error('ログインに' + MAX_FAILS + '回失敗したため、' + LOCK_MINUTES + '分間ロックしました。');
    }
    updateUser_(f.row, { failCount: fails });
    throw new Error(generic + '（あと' + (MAX_FAILS - fails) + '回失敗するとロックされます）');
  }

  updateUser_(f.row, { failCount: 0, lockedUntil: '', lastLoginAt: new Date() });
  const mustChange = isTrue_(u.mustChange);
  const token = createSession_(u, mustChange);
  return { token: token, user: { nickname: u.nickname, email: u.email }, mustChange: mustChange };
}

function logout_(req) {
  if (req.token) CacheService.getScriptCache().remove('s_' + req.token);
  return {};
}

function me_(req) {
  const s = requireSession_(req.token);
  return { user: { nickname: s.nickname, email: s.email }, mustChange: !!s.mustChange };
}

function changePassword_(req) {
  const s = requireSession_(req.token);
  const f = findUser_('userId', s.userId);
  if (!f) throw authErr_();
  const cur = String(req.currentPassword || '');
  const nw = String(req.newPassword || '');
  if (hash_(cur, f.obj.salt) !== f.obj.passwordHash) throw new Error('現在のパスワード（仮パスワード）が違います。');
  validatePassword_(nw);
  if (nw === cur) throw new Error('新しいパスワードは、現在のパスワードと別のものにしてください。');

  const salt = Utilities.getUuid();
  updateUser_(f.row, { passwordHash: hash_(nw, salt), salt: salt, mustChange: false });
  s.mustChange = false;
  CacheService.getScriptCache().put('s_' + req.token, JSON.stringify(s), SESSION_TTL);
  log_(s.userId, 'changePassword', '');
  return { message: 'パスワードを変更しました。' };
}

function forgotPassword_(req) {
  const email = normEmail_(req.email);
  const msg = '登録済みのメールアドレスであれば、新しい仮パスワードを送りました。メールをご確認ください。';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('メールアドレスの形式が正しくありません。');

  const cache = CacheService.getScriptCache();
  if (cache.get('fp_' + email)) return { message: msg }; // 5分以内の連続依頼は無視
  const f = findUser_('email', email);
  if (!f || f.obj.status !== 'active') return { message: msg };

  const temp = tempPassword_();
  const salt = Utilities.getUuid();
  sendTempPasswordMail_(email, f.obj.nickname, temp, true);
  updateUser_(f.row, { passwordHash: hash_(temp, salt), salt: salt, mustChange: true, failCount: 0, lockedUntil: '' });
  cache.put('fp_' + email, '1', 300);
  log_(f.obj.userId, 'forgotPassword', '');
  return { message: msg };
}

/* ---------- セッション ---------- */
function createSession_(u, mustChange) {
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const s = { userId: u.userId, email: u.email, nickname: u.nickname, mustChange: !!mustChange };
  CacheService.getScriptCache().put('s_' + token, JSON.stringify(s), SESSION_TTL);
  return token;
}
function requireSession_(token) {
  if (!token) throw authErr_();
  const cache = CacheService.getScriptCache();
  const v = cache.get('s_' + token);
  if (!v) throw authErr_();
  cache.put('s_' + token, v, SESSION_TTL); // 利用のたびに延長
  return JSON.parse(v);
}
function requireActive_(token) {
  const s = requireSession_(token);
  if (s.mustChange) {
    const e = new Error('先に新しいパスワードを設定してください。');
    e.code = 'MUST_CHANGE';
    throw e;
  }
  return s;
}
function authErr_() {
  const e = new Error('ログインの有効期限が切れました。もう一度ログインしてください。');
  e.code = 'AUTH';
  return e;
}

/* ---------- パスワード ---------- */
function hash_(pw, salt) {
  let h = salt + '|' + pw + '|' + prop_('PEPPER');
  for (let i = 0; i < HASH_ROUNDS; i++) {
    const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h, Utilities.Charset.UTF_8);
    h = raw.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
  }
  return h;
}
function tempPassword_() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const all = letters + digits;
  let p = '';
  for (let i = 0; i < 8; i++) p += all.charAt(Math.floor(Math.random() * all.length));
  p += letters.charAt(Math.floor(Math.random() * letters.length));
  p += digits.charAt(Math.floor(Math.random() * digits.length));
  return p.split('').sort(function () { return Math.random() - 0.5; }).join('');
}
function validatePassword_(p) {
  if (p.length < 8 || p.length > 64) throw new Error('パスワードは8〜64文字にしてください。');
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) throw new Error('パスワードには英字と数字を両方含めてください。');
}

function sendTempPasswordMail_(email, nickname, temp, isReset) {
  const app = prop_('APP_NAME');
  const url = prop_('APP_URL');
  const subject = '【' + app + '】' + (isReset ? '仮パスワード再発行のお知らせ' : '会員登録ありがとうございます');
  const body = [
    nickname + ' さん',
    '',
    isReset ? 'パスワード再発行のご依頼を受け付けました。' : app + ' にご登録いただき、ありがとうございます。',
    '',
    '仮パスワード： ' + temp,
    '',
    '下記のページから、メールアドレスと仮パスワードでログインしてください。',
    'ログインすると、ご自身で決めるパスワードへの変更画面が表示されます。',
    url,
    '',
    '※このメールにお心当たりがない場合は、破棄してください。',
    '※このメールは送信専用です。',
    '',
    app,
  ].join('\n');
  MailApp.sendEmail({ to: email, subject: subject, body: body, name: app });
}

/* =========================================================
 * AI機能
 * ========================================================= */
const ANALYZE_PROMPT = [
  'あなたは経験豊富なヘアメイクアップアーティスト兼パーソナルカラーアナリストです。',
  '写真の人物の顔立ちを観察し、似合うヘアスタイルとメイクを提案してください。',
  '',
  '次のJSONだけを返してください（説明文やコードブロックは不要）。',
  '{',
  ' "faceShape": "卵型・丸型・面長・ベース型・逆三角形・ひし形 のいずれか",',
  ' "faceShapeReason": "そう判断した輪郭の特徴（60字以内）",',
  ' "personalColor": "イエベ春・イエベ秋・ブルベ夏・ブルベ冬 のいずれか",',
  ' "personalColorReason": "肌・瞳・髪の色味から見た傾向（60字以内）",',
  ' "features": ["パーツ配置や印象の特徴を3〜4個、各30字以内"],',
  ' "hairSuggestions": [{"name": "髪型名（10字以内）", "prompt": "画像編集用の具体的な髪型の説明（長さ・前髪・質感）", "reason": "似合う理由（40字以内）"}],',
  ' "hairColorSuggestion": {"name": "髪色名", "prompt": "画像編集用の髪色の説明", "hex": "#RRGGBB"},',
  ' "makeup": {',
  '   "lip": {"name": "色名", "hex": "#RRGGBB"},',
  '   "eye": {"name": "色名", "hex": "#RRGGBB"},',
  '   "cheek": {"name": "色名", "hex": "#RRGGBB"},',
  '   "tips": "メイクのコツ（80字以内）"',
  ' },',
  ' "videoQueries": [{"title": "動画で学ぶ内容（20字以内）", "query": "YouTube/TikTokの検索ワード"}],',
  ' "narration": "話し言葉の解説本文（200〜300字）"',
  '}',
  '',
  '条件:',
  '- hairSuggestions は3件、videoQueries は3件（メイク方法2件・ヘアセット術1件を目安）。',
  '- 断定を避け「〜が似合いやすい傾向です」のようにやわらかく表現する。',
  '- 人種・年齢・体型・健康状態については触れない。性別を決めつけない。',
  '- narration には「読み上げます」「AIによる解説です」「以下は」などの前置きやメタ表現、記号、絵文字を入れず、そのまま声に出せる解説本文だけを書く。',
  '- 写真に顔がはっきり写っていない場合は {"error": "顔がはっきり写った正面の写真でお試しください。"} だけを返す。',
  '',
  'ユーザーの要望: {REQUEST}',
].join('\n');

function analyze_(req) {
  const s = requireActive_(req.token);
  useQuota_(s.userId);
  const img = checkImage_(req.image, req.mimeType);
  const request = sanitizeText_(req.request, 300) || '特になし';

  const res = callGemini_(prop_('GEMINI_TEXT_MODEL'), {
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: img.mime, data: img.b64 } },
        { text: ANALYZE_PROMPT.replace('{REQUEST}', request) },
      ],
    }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.7 },
  });

  let a;
  try {
    a = JSON.parse(extractText_(res).replace(/```json|```/g, '').trim());
  } catch (e) {
    throw new Error('AIの分析結果を読み取れませんでした。もう一度お試しください。');
  }
  if (a.error) throw new Error(String(a.error));
  a.narration = cleanNarration_(a.narration || '');

  const fileId = saveImage_(s.userId, img.b64, img.mime, 'original');
  const historyId = 'h_' + Date.now().toString(36) + Utilities.getUuid().slice(0, 4);
  sheet_('HISTORY').appendRow([
    historyId, s.userId, new Date(), fileId,
    safe_(a.faceShape || ''), safe_(a.personalColor || ''), '', safe_(request),
    JSON.stringify(a).slice(0, 45000),
  ]);
  log_(s.userId, 'analyze', '');
  return { analysis: a, historyId: historyId };
}

function hairEdit_(req) {
  const s = requireActive_(req.token);
  useQuota_(s.userId);
  const img = checkImage_(req.image, req.mimeType);
  const style = sanitizeText_(req.style, 200);
  const color = sanitizeText_(req.color, 100);
  const extra = sanitizeText_(req.extra, 200);
  if (!style) throw new Error('試したい髪型を選んでください。');

  // 英語の指示のほうが画像編集が安定しやすいため、英語→日本語の順で試す
  const prompts = [
    [
      'Edit this photo. Change ONLY the hairstyle.',
      'New hairstyle: ' + style,
      'Hair color: ' + (color || 'keep the original hair color'),
      extra ? 'Additional request: ' + extra : '',
      'Keep the same face, facial features, skin, expression, makeup, clothing, background, framing and lighting exactly as in the original photo.',
      'Photorealistic hair salon style preview. Do not add any text, logos or borders.',
    ].filter(Boolean).join('\n'),
    [
      'この写真の髪型だけを変更してください（美容院のヘアスタイル試着イメージ）。',
      '新しい髪型: ' + style,
      '髪色: ' + (color || '元の髪色のまま'),
      extra ? '追加の要望: ' + extra : '',
      '顔・表情・肌・メイク・服装・背景・構図・照明は元の写真のまま、同じ人物のままにしてください。',
      '写実的な写真に仕上げ、文字やロゴは入れないでください。',
    ].filter(Boolean).join('\n'),
  ];

  const models = prop_('GEMINI_IMAGE_MODEL').split(',').map(function (m) { return m.trim(); }).filter(String);
  const reasons = [];

  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];
    for (let pi = 0; pi < prompts.length; pi++) {
      const r = callGeminiRaw_(model, {
        contents: [{
          role: 'user',
          parts: [{ inlineData: { mimeType: img.mime, data: img.b64 } }, { text: prompts[pi] }],
        }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
      });

      if (r.code !== 200) {
        const why = 'HTTP ' + r.code + (r.message ? ' ' + r.message.slice(0, 150) : '');
        reasons.push({ model: model, kind: r.code === 429 ? 'quota' : 'http', detail: why });
        log_(s.userId, 'hairEditFail', model + ' ' + why);
        break; // このモデルは使えないので次のモデルへ
      }

      const part = findInline_(r.json, 'image/');
      if (part) {
        const mime = part.mimeType || 'image/png';
        const fileId = saveImage_(s.userId, part.data, mime, 'hair');
        if (req.historyId) updateHistoryHair_(String(req.historyId), s.userId, style);
        log_(s.userId, 'hairEdit', model + ' ' + style.slice(0, 40));
        return { image: part.data, mimeType: mime, fileId: fileId, model: model };
      }

      const why = describeNoImage_(r.json);
      reasons.push({ model: model, kind: why.safety ? 'safety' : 'noimage', detail: why.text });
      log_(s.userId, 'hairEditFail', model + ' ' + why.text);
    }
  }
  throw new Error(hairErrorMessage_(reasons));
}

/** 画像が返ってこなかった理由をまとめる */
function describeNoImage_(json) {
  const fb = json && json.promptFeedback;
  const c = json && json.candidates && json.candidates[0];
  const block = fb && fb.blockReason ? fb.blockReason : '';
  const finish = c && c.finishReason ? c.finishReason : '';
  const text = extractText_(json);
  const safety = /SAFETY|PROHIBITED|BLOCK|RECITATION|OTHER/.test(block + ' ' + finish);
  return {
    safety: safety,
    text: [block && 'block=' + block, finish && 'finish=' + finish, text && 'text=' + text.slice(0, 100)]
      .filter(String).join(' ') || '応答に画像なし',
  };
}

/** 利用者向けのエラーメッセージ */
function hairErrorMessage_(reasons) {
  if (!reasons.length) return '髪型の画像を作れませんでした。';
  const kinds = reasons.map(function (r) { return r.kind; });
  const last = reasons[reasons.length - 1];
  if (kinds.indexOf('safety') >= 0) {
    return 'AIの安全フィルターにより、この写真の加工が止められました。顔が大きく写った正面の写真や、別の髪型でお試しください。（' + last.model + ' ' + last.detail + '）';
  }
  if (kinds.every(function (k) { return k === 'quota' || k === 'http'; })) {
    return '画像を作るAIを利用できませんでした。画像生成は無料枠では使えない場合があるため、Google AI Studio で APIキーの課金設定をご確認ください。（' + last.model + ' ' + last.detail + '）';
  }
  return '髪型の画像を作れませんでした。別の写真や髪型でお試しください。（' + last.model + ' ' + last.detail + '）';
}

function tts_(req) {
  const s = requireActive_(req.token);
  useQuota_(s.userId);
  const text = cleanNarration_(req.text).slice(0, 800);
  if (!text) throw new Error('読み上げる文章がありません。');

  const res = callGemini_(prop_('GEMINI_TTS_MODEL'), {
    contents: [{ parts: [{ text: text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: prop_('TTS_VOICE') } } },
    },
  });
  const part = findInline_(res, 'audio/');
  if (!part) throw new Error('音声を作れませんでした。');
  return { audio: part.data, mimeType: part.mimeType || 'audio/L16;codec=pcm;rate=24000' };
}

function videos_(req) {
  requireActive_(req.token);
  const q = sanitizeText_(req.query, 100);
  if (!q) throw new Error('検索ワードがありません。');
  const key = prop_('YOUTUBE_API_KEY');
  if (!key) return { available: false, items: [] };

  const cache = CacheService.getScriptCache();
  const ck = 'yt_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, q, Utilities.Charset.UTF_8));
  const hit = cache.get(ck);
  if (hit) return { available: true, items: JSON.parse(hit) };

  const url = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=4' +
    '&videoEmbeddable=true&safeSearch=strict&relevanceLanguage=ja&regionCode=JP' +
    '&q=' + encodeURIComponent(q) + '&key=' + encodeURIComponent(key);
  const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) return { available: false, items: [] };

  const items = (JSON.parse(r.getContentText()).items || []).map(function (it) {
    const th = it.snippet.thumbnails || {};
    return {
      id: it.id.videoId,
      title: decodeEntities_(it.snippet.title),
      channel: decodeEntities_(it.snippet.channelTitle),
      thumb: (th.medium || th.default || {}).url || '',
    };
  });
  cache.put(ck, JSON.stringify(items), 21600);
  return { available: true, items: items };
}

function history_(req) {
  const s = requireActive_(req.token);
  const data = sheet_('HISTORY').getDataRange().getValues();
  const h = data[0];
  const rows = [];
  for (let r = data.length - 1; r >= 1 && rows.length < 20; r--) {
    const o = rowToObj_(h, data[r]);
    if (o.userId !== s.userId) continue;
    rows.push({
      createdAt: o.createdAt instanceof Date ? o.createdAt.toISOString() : String(o.createdAt),
      faceShape: o.faceShape, personalColor: o.personalColor, hairStyle: o.hairStyle, request: o.request,
    });
  }
  return { items: rows };
}

function deleteMyImages_(req) {
  const s = requireActive_(req.token);
  const root = DriveApp.getFolderById(prop_('DRIVE_FOLDER_ID'));
  const it = root.getFoldersByName(s.userId);
  let count = 0;
  if (it.hasNext()) {
    const files = it.next().getFiles();
    while (files.hasNext()) { files.next().setTrashed(true); count++; }
  }
  log_(s.userId, 'deleteMyImages', String(count));
  return { message: '保存されていた写真 ' + count + ' 枚を削除しました。' };
}

/* ---------- Gemini ---------- */
function callGeminiRaw_(model, body) {
  const key = prop_('GEMINI_API_KEY');
  if (!key) throw new Error('サーバーにGemini APIキーが設定されていません。');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
  const opt = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': key },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  };
  let res;
  for (let i = 0; i < 2; i++) {
    res = UrlFetchApp.fetch(url, opt);
    const code = res.getResponseCode();
    if (code !== 429 && code !== 503) break;
    Utilities.sleep(2000);
  }
  const code = res.getResponseCode();
  let json = null;
  let message = '';
  try { json = JSON.parse(res.getContentText()); } catch (e) { /* noop */ }
  if (code !== 200 && json && json.error) message = String(json.error.message || '');
  return { code: code, json: json, message: message };
}

function callGemini_(model, body) {
  const r = callGeminiRaw_(model, body);
  if (r.code === 200 && r.json) return r.json;
  if (r.code === 429) throw new Error('AIが混み合っているか、利用上限に達しています。少し待ってからお試しください。');
  throw new Error('AIの処理に失敗しました（' + r.code + '）' + (r.message ? ': ' + r.message.slice(0, 120) : ''));
}

function parts_(res) {
  const c = res && res.candidates && res.candidates[0];
  return (c && c.content && c.content.parts) || [];
}
function extractText_(res) {
  return parts_(res).filter(function (p) { return p.text; }).map(function (p) { return p.text; }).join('').trim();
}
function findInline_(res, prefix) {
  const p = parts_(res).filter(function (x) {
    return x.inlineData && String(x.inlineData.mimeType || '').indexOf(prefix) === 0;
  })[0];
  return p ? p.inlineData : null;
}

/** 読み上げ用テキストのクリーニング（メタ指示・前置き・記号を除去） */
function cleanNarration_(t) {
  let s = String(t || '');
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/[*#_`>~|]/g, '');
  // （明るいトーンで）【BGM】などの演出指示
  s = s.replace(/[（(【\[〈《][^）)】\]〉》]{0,30}(読み|声|トーン|口調|ゆっくり|明るく|優しく|やさしく|BGM|SE|効果音|ナレーション|間を)[^）)】\]〉》]{0,30}[）)】\]〉》]/g, '');
  // 「ナレーション：」「解説:」などのラベル
  s = s.replace(/^\s*(ナレーション|ナレーター|解説|原稿|本文|読み上げ文|AI)\s*[:：]\s*/gm, '');
  const meta = /(読み上げ(て|ます|る|を)|ナレーション(を|です|します|開始|原稿)|AIによる(解説|ナレーション|分析結果をお伝え)|以下(は|が|の).{0,15}(解説|ナレーション|原稿|文章|読み上げ)|音声(で|にて)(お届け|解説|お伝え)|(トーン|口調|声)で(話|読|お届け)|それでは.{0,8}(始め|読み))/;
  s = s.split(/(?<=[。！？!?\n])/).filter(function (x) { return !meta.test(x); }).join('');
  s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '');
  return s.replace(/\s+/g, ' ').trim();
}

/* =========================================================
 * Drive（画像の一時保存）
 * ========================================================= */
function userFolder_(userId) {
  const root = DriveApp.getFolderById(prop_('DRIVE_FOLDER_ID'));
  const it = root.getFoldersByName(userId);
  return it.hasNext() ? it.next() : root.createFolder(userId);
}
function saveImage_(userId, b64, mime, kind) {
  const ext = mime.indexOf('png') >= 0 ? 'png' : (mime.indexOf('webp') >= 0 ? 'webp' : 'jpg');
  const name = kind + '_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss') + '.' + ext;
  const blob = Utilities.newBlob(Utilities.base64Decode(b64), mime, name);
  return userFolder_(userId).createFile(blob).getId();
}
/** 毎日3時に実行：保存期間を過ぎた画像をゴミ箱へ移動 */
function cleanupOldImages() {
  const limit = Date.now() - Number(prop_('IMAGE_RETENTION_DAYS')) * 86400000;
  const folders = DriveApp.getFolderById(prop_('DRIVE_FOLDER_ID')).getFolders();
  let count = 0;
  while (folders.hasNext()) {
    const files = folders.next().getFiles();
    while (files.hasNext()) {
      const f = files.next();
      if (f.getDateCreated().getTime() < limit) { f.setTrashed(true); count++; }
    }
  }
  Logger.log('削除した画像: ' + count);
}

/* =========================================================
 * スプレッドシート・共通
 * ========================================================= */
function sheet_(key) {
  return SpreadsheetApp.openById(prop_('SPREADSHEET_ID')).getSheetByName(SHEETS[key].name);
}
function rowToObj_(headers, row) {
  const o = {};
  headers.forEach(function (h, i) { o[h] = row[i]; });
  return o;
}
function findUser_(field, value) {
  const data = sheet_('USERS').getDataRange().getValues();
  const h = data[0];
  const c = h.indexOf(field);
  const v = String(value).toLowerCase();
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][c]).toLowerCase() === v) return { row: r + 1, obj: rowToObj_(h, data[r]) };
  }
  return null;
}
function updateUser_(row, patch) {
  const sh = sheet_('USERS');
  const h = SHEETS.USERS.headers;
  Object.keys(patch).forEach(function (k) {
    const c = h.indexOf(k);
    if (c >= 0) sh.getRange(row, c + 1).setValue(patch[k]);
  });
}
function updateHistoryHair_(historyId, userId, style) {
  const sh = sheet_('HISTORY');
  const data = sh.getDataRange().getValues();
  const h = data[0];
  for (let r = data.length - 1; r >= 1; r--) {
    if (data[r][0] === historyId && data[r][1] === userId) {
      const prev = String(data[r][h.indexOf('hairStyle')] || '');
      const next = (prev ? prev + ' / ' : '') + style.slice(0, 40);
      sh.getRange(r + 1, h.indexOf('hairStyle') + 1).setValue(safe_(next.slice(0, 300)));
      return;
    }
  }
}
function useQuota_(userId) {
  const limit = Number(prop_('DAILY_AI_LIMIT'));
  const key = 'q_' + userId + '_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd');
  const cache = CacheService.getScriptCache();
  const n = Number(cache.get(key) || 0);
  if (n >= limit) throw new Error('本日のAI利用回数の上限（' + limit + '回）に達しました。明日またお試しください。');
  cache.put(key, String(n + 1), 90000);
}
function checkImage_(image, mimeType) {
  const b64 = String(image || '').replace(/^data:[^,]+,/, '');
  if (!b64) throw new Error('写真がありません。');
  if (b64.length > 7 * 1024 * 1024) throw new Error('写真のサイズが大きすぎます。');
  const mime = /^image\/(jpeg|png|webp)$/.test(String(mimeType)) ? String(mimeType) : 'image/jpeg';
  return { b64: b64, mime: mime };
}
function log_(userId, action, detail) {
  try { sheet_('LOGS').appendRow([new Date(), userId, action, safe_(detail || '')]); } catch (e) { /* noop */ }
}
function normEmail_(e) { return String(e || '').trim().toLowerCase(); }
function isTrue_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
function sanitizeText_(t, max) { return String(t || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }
/** スプレッドシートの数式インジェクション対策 */
function safe_(v) {
  const s = String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
function decodeEntities_(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
