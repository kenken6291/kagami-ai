/**
 * かがみAI ～ヘア＆メイク試着室  バックエンド（Google Apps Script）
 * v1.5.0
 *
 * ■ ファイル構成（GASエディタ）
 *   Config.gs … バージョン・各種上限・既定値（設定はここだけ書き換え）
 *   Code.gs   … 本体（このファイル）
 *
 * ■ スクリプトプロパティ（プロジェクトの設定 → スクリプト プロパティ）
 *   必須  GEMINI_API_KEY        … Gemini APIキー
 *   任意  YOUTUBE_API_KEY       … YouTube Data API v3 キー（無ければ動画は「YouTubeで開く」リンクのみ）
 *   任意  APP_NAME / APP_URL    … メール本文に使うアプリ名・公開URL
 *   任意  GEMINI_TEXT_MODEL / GEMINI_TTS_MODEL / TTS_VOICE
 *   任意  GEMINI_IMAGE_MODEL … カンマ区切りで複数可（例: gemini-3.1-flash-image,gemini-2.5-flash-image）
 *         ※画像生成は無料枠では使えない場合があります（Google AI Studio で課金設定が必要）
 *   任意  DAILY_AI_LIMIT（既定40） / IMAGE_RETENTION_DAYS（既定7） / MAX_LOOKS（ギャラリー上限、既定30）
 *         ※既定値は Config.gs の DEFAULTS。プロパティに書けばそちらが優先
 *   自動  SPREADSHEET_ID / DRIVE_FOLDER_ID / PEPPER … setup() 実行時に自動作成
 *
 * ■ 初回だけ setup() を実行 → ウェブアプリとしてデプロイ（実行ユーザー: 自分 / アクセス: 全員）
 * ■ コードを変更したら「デプロイを管理 → 編集 → 新バージョン」で再デプロイが必要です
 */

// APP_VERSION / TERMS_VERSION / SESSION_TTL / MAX_FAILS / LOCK_MINUTES / HASH_ROUNDS / SHARE / DEFAULTS は Config.gs にあります

const SHEETS = {
  USERS: {
    name: 'Users',
    headers: ['userId', 'email', 'nickname', 'passwordHash', 'salt', 'mustChange', 'failCount',
      'lockedUntil', 'status', 'termsVersion', 'agreedAt', 'createdAt', 'lastLoginAt', 'agreementsJson'],
  },
  HISTORY: {
    name: 'History',
    headers: ['historyId', 'userId', 'createdAt', 'imageFileId', 'faceShape', 'personalColor',
      'hairStyle', 'request', 'analysisJson'],
  },
  LOOKS: {
    name: 'Looks',
    // shared: TRUE＝公開中（既定は非公開）／ audience: 見せる相手のuserId配列（空＝公開相手の全員）
    headers: ['lookId', 'userId', 'createdAt', 'fileId', 'thumb', 'hairLabel', 'summary', 'metaJson',
      'shared', 'audience', 'sharedAt'],
  },
  MEMBERS: {
    // 公開相手（ownerId が memberId に見せてよい、という登録）
    name: 'Members',
    headers: ['ownerId', 'memberId', 'label', 'active', 'addedAt'],
  },
  LOGS: {
    name: 'Logs',
    headers: ['at', 'userId', 'action', 'detail'],
  },
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
  return json_({ ok: true, app: prop_('APP_NAME'), version: APP_VERSION, terms: TERMS_VERSION });
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
  recommendVideos: recommendVideos_,
  history: history_,
  deleteMyImages: deleteMyImages_,
  makeupPlan: makeupPlan_,
  saveLook: saveLook_,
  listLooks: listLooks_,
  getLooks: getLooks_,
  deleteLook: deleteLook_,
  // 共有（v1.5.0〜）
  listMembers: listMembers_,
  addMember: addMember_,
  updateMember: updateMember_,
  removeMember: removeMember_,
  setLookShare: setLookShare_,
  setAllPrivate: setAllPrivate_,
  sharedWithMe: sharedWithMe_,
  getSharedLook: getSharedLook_,
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
  const AGREE_KEYS = ['cautions', 'terms', 'disclaimer', 'selfResponsibility', 'dispute'];
  if (!AGREE_KEYS.every(function (k) { return a[k] === true; })) {
    throw new Error('注意書き・利用規約・免責事項・自己責任・当事者間での問題解決のすべてにチェックが必要です。');
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
      agreementsJson: JSON.stringify({ version: TERMS_VERSION, items: AGREE_KEYS, at: now.toISOString() }),
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
  return { token: token, user: { userId: u.userId, nickname: u.nickname, email: u.email }, mustChange: mustChange };
}

function logout_(req) {
  if (req.token) CacheService.getScriptCache().remove('s_' + req.token);
  return {};
}

function me_(req) {
  const s = requireSession_(req.token);
  return { user: { userId: s.userId, nickname: s.nickname, email: s.email }, mustChange: !!s.mustChange };
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
  '   "base": {"name": "ファンデーションの色名（ライト・ピンク系・ナチュラル・オークル・ダークオークル等）", "hex": "#RRGGBB（肌に近い色）"},',
  '   "lip": {"name": "色名", "hex": "#RRGGBB"},',
  '   "eye": {"name": "色名", "hex": "#RRGGBB"},',
  '   "cheek": {"name": "色名", "hex": "#RRGGBB"},',
  '   "tips": "メイクのコツ（80字以内）"',
  ' },',
  ' "videoQueries": [{"title": "動画で学ぶ内容（20字以内）", "query": "YouTubeの検索ワード"}],',
  ' "narration": "話し言葉の解説本文（200〜300字）"',
  '}',
  '',
  '条件:',
  '- hairSuggestions は3件、videoQueries は3件（メイク方法2件・ヘアセット術1件を目安）。',
  '- 断定を避け「〜が似合いやすい傾向です」のようにやわらかく表現する。',
  '- 人種・年齢・体型・健康状態については触れない。性別を決めつけない。',
  '- narration には「読み上げます」「〜で読み上げてください」「〜な声で」「AIによる解説です」「以下は」などの前置き・演出指示・メタ表現、括弧書き、記号、絵文字を一切入れず、最初の一文から解説の中身で始まる、そのまま声に出せる本文だけを書く。',
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
  return { available: true, items: ytSearch_(q, 4, key, req.kind === 'short' ? 'short' : 'long') };
}

/** YouTube検索（6時間キャッシュ）。kind='short' はショート動画 */
function ytSearch_(q, max, key, kind) {
  const isShort = kind === 'short';
  const query = isShort ? q + ' #shorts' : q;
  const cache = CacheService.getScriptCache();
  const ck = 'yt' + (isShort ? 's' : 'l') + max + '_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, query, Utilities.Charset.UTF_8));
  const hit = cache.get(ck);
  if (hit) return JSON.parse(hit);

  const url = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=' + max +
    '&videoEmbeddable=true&safeSearch=strict&relevanceLanguage=ja&regionCode=JP' +
    '&videoDuration=' + (isShort ? 'short' : 'medium') +
    '&q=' + encodeURIComponent(query) + '&key=' + encodeURIComponent(key);
  const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) return [];

  const items = (JSON.parse(r.getContentText()).items || []).map(function (it) {
    const th = it.snippet.thumbnails || {};
    return {
      id: it.id.videoId,
      title: decodeEntities_(it.snippet.title),
      channel: decodeEntities_(it.snippet.channelTitle),
      thumb: (th.high || th.medium || th.default || {}).url || '',
    };
  });
  cache.put(ck, JSON.stringify(items), 21600);
  return items;
}

const VIDEO_TOPIC_PROMPT = [
  'あなたはヘアメイクの先生です。次の人に合う「やり方動画」をYouTube（通常動画・ショート動画）で探すための検索テーマを4つ考えてください。',
  '',
  '顔の形: {FACE}',
  'パーソナルカラーの傾向: {PC}',
  '試している髪型: {HAIR}',
  'メイク: {MAKEUP}',
  '本人の要望: {REQUEST}',
  '参考の検索ワード: {HINTS}',
  '',
  '次のJSONだけを返してください（説明文やコードブロックは不要）。',
  '{"topics": [{"title": "学べる内容（20字以内）", "query": "日本語の検索ワード（2〜5語、やり方・コツ等を含める）", "reason": "この人におすすめの理由（40字以内）"}]}',
  '',
  '条件: ヘアのセット・スタイリング方法を1〜2件、メイクのやり方を2〜3件。指定されたメイクの印象（鼻を高く・あごすっきり等）があれば必ず含める。',
  '情報が少ない場合は、顔の形やパーソナルカラーに合うものを選ぶ。',
].join('\n');

/** AIが選んだテーマごとに動画を探す */
function recommendVideos_(req) {
  const s = requireActive_(req.token);
  let topics = (Array.isArray(req.topics) ? req.topics : []).slice(0, 5).map(function (t) {
    return {
      title: sanitizeText_(t && t.title, 40),
      query: sanitizeText_(t && t.query, 100),
      reason: sanitizeText_(t && t.reason, 80),
    };
  }).filter(function (t) { return t.query; });

  if (!topics.length) {
    useQuota_(s.userId);
    const c = req.context || {};
    const prompt = VIDEO_TOPIC_PROMPT
      .replace('{FACE}', sanitizeText_(c.faceShape, 30) || '不明')
      .replace('{PC}', sanitizeText_(c.personalColor, 30) || '不明')
      .replace('{HAIR}', sanitizeText_(c.hair, 60) || '未選択')
      .replace('{MAKEUP}', sanitizeText_(c.makeup, 200) || '未選択')
      .replace('{REQUEST}', sanitizeText_(c.request, 200) || '特になし')
      .replace('{HINTS}', (Array.isArray(c.hints) ? c.hints : []).map(function (h) { return sanitizeText_(h, 60); }).join('、') || 'なし');
    const res = callGemini_(prop_('GEMINI_TEXT_MODEL'), {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.7 },
    });
    try {
      const j = JSON.parse(extractText_(res).replace(/```json|```/g, '').trim());
      topics = (j.topics || []).slice(0, 4).map(function (t) {
        return { title: sanitizeText_(t.title, 40), query: sanitizeText_(t.query, 100), reason: sanitizeText_(t.reason, 80) };
      }).filter(function (t) { return t.query; });
    } catch (e) {
      throw new Error('AIのおすすめを読み取れませんでした。もう一度お試しください。');
    }
    if (!topics.length) throw new Error('おすすめのテーマを作れませんでした。');
  }

  const key = prop_('YOUTUBE_API_KEY');
  const kind = req.kind === 'short' ? 'short' : 'long';
  const out = topics.map(function (t) {
    return Object.assign({}, t, { title: t.title || t.query, videos: key ? ytSearch_(t.query, 3, key, kind) : [] });
  });
  log_(s.userId, 'recommendVideos', topics.map(function (t) { return t.query; }).join(' / ').slice(0, 200));
  return { available: !!key, kind: kind, topics: out };
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
  let temp = 0;
  let looks = 0;
  if (it.hasNext()) {
    const folder = it.next();
    const files = folder.getFiles();
    while (files.hasNext()) { files.next().setTrashed(true); temp++; }
    const lf = folder.getFoldersByName('looks');
    if (lf.hasNext()) {
      const lfiles = lf.next().getFiles();
      while (lfiles.hasNext()) { lfiles.next().setTrashed(true); }
    }
  }
  // ギャラリーの行も削除（下から）
  const sh = sheet_('LOOKS');
  const data = sh.getDataRange().getValues();
  for (let r = data.length - 1; r >= 1; r--) {
    if (data[r][1] === s.userId) { sh.deleteRow(r + 1); looks++; }
  }
  log_(s.userId, 'deleteMyImages', temp + '/' + looks);
  return { message: '一時保存の写真 ' + temp + ' 枚と、ギャラリーの写真 ' + looks + ' 枚を削除しました。' };
}

/* =========================================================
 * メイクの指示 → AIがメイク設定を作る
 * ========================================================= */
const MAKEUP_PROMPT = [
  'あなたはプロのメイクアップアーティストです。',
  '次の希望に合うメイクを、バーチャルメイクの設定値として提案してください。',
  '',
  '希望: {TEXT}',
  '参考: 顔の形={FACE}、パーソナルカラーの傾向={PC}',
  '',
  '次のJSONだけを返してください（説明文やコードブロックは不要）。',
  '{',
  ' "base":  {"name": "ファンデーションの色名", "hex": "#RRGGBB（肌に近い色）", "amount": 0〜1（カバー力。シミや小じわを隠したい希望なら0.6〜0.8）},',
  ' "lip":   {"name": "色名", "hex": "#RRGGBB", "amount": 0〜1},',
  ' "eye":   {"name": "色名", "hex": "#RRGGBB", "amount": 0〜1},',
  ' "cheek": {"name": "色名", "hex": "#RRGGBB", "amount": 0〜1},',
  ' "effects": {"nose": 0〜1, "jaw": 0〜1, "small": 0〜1, "bright": 0〜1, "eyes": 0〜1},',
  ' "comment": "どんな狙いで仕上げたか（80字以内、やわらかい話し言葉）"',
  '}',
  '',
  'base=ファンデーション（シミ・くすみ・小じわを目立たなくする）。effects の意味: nose=鼻を高く見せるシェーディングとハイライト、jaw=あご・フェイスラインをすっきり見せるシェーディング、',
  'small=小顔に見せる輪郭のシェーディング、bright=顔を明るく見せるトーンアップとハイライト、eyes=目元をぱっちり見せるアイライン。',
  '希望に関係ない効果は0にする。amount は自然に見える範囲（リップ0.3〜0.7、アイ0.2〜0.6、チーク0.2〜0.5目安）。',
  'その部位を塗らない方がよい場合は、その部位を null にする。',
].join('\n');

function makeupPlan_(req) {
  const s = requireActive_(req.token);
  useQuota_(s.userId);
  const text = sanitizeText_(req.text, 300);
  if (!text) throw new Error('どんなメイクにしたいか入力してください。');
  const ctx = req.context || {};
  const prompt = MAKEUP_PROMPT
    .replace('{TEXT}', text)
    .replace('{FACE}', sanitizeText_(ctx.faceShape, 30) || '不明')
    .replace('{PC}', sanitizeText_(ctx.personalColor, 30) || '不明');
  const res = callGemini_(prop_('GEMINI_TEXT_MODEL'), {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.6 },
  });
  let plan;
  try {
    plan = JSON.parse(extractText_(res).replace(/```json|```/g, '').trim());
  } catch (e) {
    throw new Error('AIの提案を読み取れませんでした。もう一度お試しください。');
  }
  log_(s.userId, 'makeupPlan', text.slice(0, 60));
  return { plan: plan };
}

/* =========================================================
 * ギャラリー（保存した ヘア＋メイク）
 * ========================================================= */
function looksFolder_(userId) {
  const uf = userFolder_(userId);
  const it = uf.getFoldersByName('looks');
  return it.hasNext() ? it.next() : uf.createFolder('looks');
}

function saveLook_(req) {
  const s = requireActive_(req.token);
  const img = checkImage_(req.image, 'image/jpeg');
  const thumb = String(req.thumb || '').replace(/^data:[^,]+,/, '');
  if (!thumb || thumb.length > 45000) throw new Error('サムネイル画像を作れませんでした。');

  const max = Number(prop_('MAX_LOOKS'));
  const sh = sheet_('LOOKS');
  const data = sh.getDataRange().getValues();
  let count = 0;
  for (let r = 1; r < data.length; r++) if (data[r][1] === s.userId) count++;
  if (count >= max) throw new Error('ギャラリーは' + max + '枚までです。不要な写真を削除してから保存してください。');

  const meta = req.meta || {};
  const now = new Date();
  const name = 'look_' + Utilities.formatDate(now, 'Asia/Tokyo', 'yyyyMMdd_HHmmss') + '.jpg';
  const fileId = looksFolder_(s.userId).createFile(
    Utilities.newBlob(Utilities.base64Decode(img.b64), 'image/jpeg', name)).getId();
  const lookId = 'L' + now.getTime().toString(36) + Utilities.getUuid().slice(0, 4);
  const hairLabel = sanitizeText_(meta.hair, 60);
  const summary = sanitizeText_(meta.summary, 300);
  // 公開設定は必ず「非公開」で保存する
  sh.appendRow([lookId, s.userId, now, fileId, thumb, safe_(hairLabel), safe_(summary), JSON.stringify(meta).slice(0, 5000),
    false, '[]', '']);
  log_(s.userId, 'saveLook', lookId);
  return {
    message: 'ギャラリーに保存しました。',
    look: { lookId: lookId, createdAt: now.toISOString(), thumb: thumb, hairLabel: hairLabel, summary: summary, shared: false, audience: [] },
  };
}

function listLooks_(req) {
  const s = requireActive_(req.token);
  const data = sheet_('LOOKS').getDataRange().getValues();
  const h = data[0];
  const items = [];
  for (let r = data.length - 1; r >= 1; r--) {
    const o = rowToObj_(h, data[r]);
    if (o.userId !== s.userId) continue;
    items.push({
      lookId: o.lookId,
      createdAt: o.createdAt instanceof Date ? o.createdAt.toISOString() : String(o.createdAt),
      thumb: String(o.thumb),
      hairLabel: String(o.hairLabel || ''),
      summary: String(o.summary || ''),
      shared: isTrue_(o.shared),
      audience: parseIds_(o.audience),
    });
  }
  return { items: items };
}

function getLooks_(req) {
  const s = requireActive_(req.token);
  const ids = (Array.isArray(req.ids) ? req.ids : []).slice(0, 4).map(String);
  const data = sheet_('LOOKS').getDataRange().getValues();
  const items = [];
  for (let r = 1; r < data.length; r++) {
    if (data[r][1] !== s.userId || ids.indexOf(String(data[r][0])) < 0) continue;
    try {
      const blob = DriveApp.getFileById(String(data[r][3])).getBlob();
      items.push({ lookId: String(data[r][0]), mimeType: blob.getContentType() || 'image/jpeg', image: Utilities.base64Encode(blob.getBytes()) });
    } catch (e) {
      items.push({ lookId: String(data[r][0]), mimeType: 'image/jpeg', image: String(data[r][4]) }); // 本画像が無い場合はサムネイル
    }
  }
  return { items: items };
}

function deleteLook_(req) {
  const s = requireActive_(req.token);
  const id = String(req.lookId || '');
  const sh = sheet_('LOOKS');
  const data = sh.getDataRange().getValues();
  for (let r = data.length - 1; r >= 1; r--) {
    if (String(data[r][0]) === id && data[r][1] === s.userId) {
      try { DriveApp.getFileById(String(data[r][3])).setTrashed(true); } catch (e) { /* noop */ }
      sh.deleteRow(r + 1);
      log_(s.userId, 'deleteLook', id);
      return { message: '削除しました。' };
    }
  }
  throw new Error('写真が見つかりませんでした。');
}

/* =========================================================
 * 共有（家族・友人など、指定した会員にだけ公開）
 *   ・公開相手は、登録済み会員のメールアドレスで追加
 *   ・写真ごとに「公開／非公開」（既定は非公開）と見せる相手を選べる
 *   ・相手を「一時停止」「削除」すれば、すぐ見られなくなる
 * ========================================================= */
function parseIds_(v) {
  try {
    const a = JSON.parse(String(v || '[]'));
    return Array.isArray(a) ? a.map(String) : [];
  } catch (e) { return []; }
}

/** userId → ニックネーム の対応表 */
function nicknameMap_() {
  const data = sheet_('USERS').getDataRange().getValues();
  const h = data[0];
  const ci = h.indexOf('userId');
  const cn = h.indexOf('nickname');
  const cs = h.indexOf('status');
  const map = {};
  for (let r = 1; r < data.length; r++) {
    map[String(data[r][ci])] = { nickname: String(data[r][cn] || ''), active: String(data[r][cs]) === 'active' };
  }
  return map;
}

function membersOf_(ownerId) {
  const data = sheet_('MEMBERS').getDataRange().getValues();
  const out = [];
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][0]) !== ownerId) continue;
    out.push({ row: r + 1, memberId: String(data[r][1]), label: String(data[r][2] || ''), active: isTrue_(data[r][3]), addedAt: data[r][4] });
  }
  return out;
}

function listMembers_(req) {
  const s = requireActive_(req.token);
  const names = nicknameMap_();
  const items = membersOf_(s.userId).map(function (m) {
    const u = names[m.memberId] || { nickname: '（退会した会員）', active: false };
    return {
      memberId: m.memberId,
      label: m.label,
      nickname: u.nickname,
      active: m.active,
      available: u.active,
      addedAt: m.addedAt instanceof Date ? m.addedAt.toISOString() : String(m.addedAt || ''),
    };
  });
  return { items: items, max: SHARE.MAX_MEMBERS };
}

function addMember_(req) {
  const s = requireActive_(req.token);
  const email = normEmail_(req.email);
  const label = sanitizeText_(req.label, SHARE.LABEL_MAX);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('メールアドレスの形式が正しくありません。');

  // 総当たりで会員のメールアドレスを調べられないよう、回数を制限
  const cache = CacheService.getScriptCache();
  const ck = 'am_' + s.userId;
  const n = Number(cache.get(ck) || 0);
  if (n >= SHARE.ADD_LIMIT_PER_HOUR) throw new Error('公開相手の追加は1時間に' + SHARE.ADD_LIMIT_PER_HOUR + '回までです。しばらく待ってからお試しください。');
  cache.put(ck, String(n + 1), 3600);

  if (email === normEmail_(s.email)) throw new Error('ご自身は公開相手に追加できません。');
  const f = findUser_('email', email);
  if (!f || f.obj.status !== 'active') {
    throw new Error('このメールアドレスの会員が見つかりません。相手に、先に会員登録をしてもらってください（「登録を案内する」からLINEで案内できます）。');
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const list = membersOf_(s.userId);
    if (list.some(function (m) { return m.memberId === f.obj.userId; })) throw new Error('この方は、すでに公開相手に入っています。');
    if (list.length >= SHARE.MAX_MEMBERS) throw new Error('公開相手は' + SHARE.MAX_MEMBERS + '人までです。');
    sheet_('MEMBERS').appendRow([s.userId, f.obj.userId, safe_(label), true, new Date()]);
  } finally {
    lock.releaseLock();
  }
  log_(s.userId, 'addMember', f.obj.userId);
  return {
    message: (label || f.obj.nickname) + 'さんを公開相手に追加しました。',
    member: { memberId: f.obj.userId, label: label, nickname: String(f.obj.nickname), active: true, available: true, addedAt: new Date().toISOString() },
  };
}

function updateMember_(req) {
  const s = requireActive_(req.token);
  const id = String(req.memberId || '');
  const m = membersOf_(s.userId).filter(function (x) { return x.memberId === id; })[0];
  if (!m) throw new Error('公開相手が見つかりませんでした。');
  const sh = sheet_('MEMBERS');
  if (typeof req.active === 'boolean') sh.getRange(m.row, 4).setValue(req.active);
  if (typeof req.label === 'string') sh.getRange(m.row, 3).setValue(safe_(sanitizeText_(req.label, SHARE.LABEL_MAX)));
  log_(s.userId, 'updateMember', id + (typeof req.active === 'boolean' ? (req.active ? ' on' : ' off') : ''));
  return { message: '変更しました。' };
}

function removeMember_(req) {
  const s = requireActive_(req.token);
  const id = String(req.memberId || '');
  const m = membersOf_(s.userId).filter(function (x) { return x.memberId === id; })[0];
  if (!m) throw new Error('公開相手が見つかりませんでした。');
  sheet_('MEMBERS').deleteRow(m.row);
  // 写真ごとの「見せる相手」からも外す
  const sh = sheet_('LOOKS');
  const data = sh.getDataRange().getValues();
  const h = data[0];
  const ca = h.indexOf('audience');
  for (let r = 1; r < data.length; r++) {
    if (data[r][1] !== s.userId) continue;
    const ids = parseIds_(data[r][ca]);
    if (ids.indexOf(id) >= 0) sh.getRange(r + 1, ca + 1).setValue(JSON.stringify(ids.filter(function (x) { return x !== id; })));
  }
  log_(s.userId, 'removeMember', id);
  return { message: '公開相手から外しました。この方はもう写真を見られません。' };
}

function setLookShare_(req) {
  const s = requireActive_(req.token);
  const id = String(req.lookId || '');
  const shared = req.shared === true;
  const mine = membersOf_(s.userId).map(function (m) { return m.memberId; });
  let audience = (Array.isArray(req.audience) ? req.audience : []).map(String).filter(function (x) { return mine.indexOf(x) >= 0; });
  if (shared && !mine.length) throw new Error('先に「公開相手」を追加してください。');

  const sh = sheet_('LOOKS');
  const data = sh.getDataRange().getValues();
  const h = data[0];
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][0]) !== id || data[r][1] !== s.userId) continue;
    const row = r + 1;
    sh.getRange(row, h.indexOf('shared') + 1).setValue(shared);
    sh.getRange(row, h.indexOf('audience') + 1).setValue(JSON.stringify(audience));
    sh.getRange(row, h.indexOf('sharedAt') + 1).setValue(shared ? new Date() : '');
    log_(s.userId, 'setLookShare', id + ' ' + (shared ? 'on' : 'off'));
    return { message: shared ? '公開しました。' : '非公開にしました。', shared: shared, audience: audience };
  }
  throw new Error('写真が見つかりませんでした。');
}

function setAllPrivate_(req) {
  const s = requireActive_(req.token);
  const sh = sheet_('LOOKS');
  const data = sh.getDataRange().getValues();
  const c = data[0].indexOf('shared') + 1;
  let n = 0;
  for (let r = 1; r < data.length; r++) {
    if (data[r][1] === s.userId && isTrue_(data[r][c - 1])) { sh.getRange(r + 1, c).setValue(false); n++; }
  }
  log_(s.userId, 'setAllPrivate', String(n));
  return { message: n ? n + '枚を非公開にしました。' : '公開中の写真はありませんでした。' };
}

/** 閲覧者 viewerId が、この写真を見てよいか */
function canView_(look, viewerId, ownerMembers) {
  if (look.userId === viewerId) return true;
  if (!isTrue_(look.shared)) return false;
  const m = ownerMembers.filter(function (x) { return x.memberId === viewerId; })[0];
  if (!m || !m.active) return false;
  const aud = parseIds_(look.audience);
  return aud.length === 0 || aud.indexOf(viewerId) >= 0;
}

function sharedWithMe_(req) {
  const s = requireActive_(req.token);
  // 自分を公開相手にしている人（有効なものだけ）
  const mdata = sheet_('MEMBERS').getDataRange().getValues();
  const owners = {};
  for (let r = 1; r < mdata.length; r++) {
    if (String(mdata[r][1]) === s.userId && isTrue_(mdata[r][3])) owners[String(mdata[r][0])] = true;
  }
  if (!Object.keys(owners).length) return { items: [] };
  const names = nicknameMap_();
  const data = sheet_('LOOKS').getDataRange().getValues();
  const h = data[0];
  const items = [];
  for (let r = data.length - 1; r >= 1; r--) {
    const o = rowToObj_(h, data[r]);
    if (!owners[o.userId] || !isTrue_(o.shared)) continue;
    if (!names[o.userId] || !names[o.userId].active) continue;
    const aud = parseIds_(o.audience);
    if (aud.length && aud.indexOf(s.userId) < 0) continue;
    items.push({
      lookId: o.lookId,
      ownerNickname: names[o.userId].nickname,
      createdAt: o.createdAt instanceof Date ? o.createdAt.toISOString() : String(o.createdAt),
      sharedAt: o.sharedAt instanceof Date ? o.sharedAt.toISOString() : String(o.sharedAt || ''),
      thumb: String(o.thumb),
      hairLabel: String(o.hairLabel || ''),
      summary: String(o.summary || ''),
    });
    if (items.length >= 100) break;
  }
  return { items: items };
}

function getSharedLook_(req) {
  const s = requireActive_(req.token);
  const id = String(req.lookId || '');
  const data = sheet_('LOOKS').getDataRange().getValues();
  const h = data[0];
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][0]) !== id) continue;
    const o = rowToObj_(h, data[r]);
    const names = nicknameMap_();
    const owner = names[o.userId];
    if (!owner || !owner.active || !canView_(o, s.userId, membersOf_(o.userId))) break;
    let image, mimeType = 'image/jpeg';
    try {
      const blob = DriveApp.getFileById(String(o.fileId)).getBlob();
      image = Utilities.base64Encode(blob.getBytes());
      mimeType = blob.getContentType() || mimeType;
    } catch (e) {
      image = String(o.thumb);
    }
    log_(s.userId, 'viewSharedLook', id);
    return {
      look: {
        lookId: id,
        mine: o.userId === s.userId,
        ownerNickname: owner.nickname,
        createdAt: o.createdAt instanceof Date ? o.createdAt.toISOString() : String(o.createdAt),
        hairLabel: String(o.hairLabel || ''),
        summary: String(o.summary || ''),
        mimeType: mimeType,
        image: image,
      },
    };
  }
  // 存在しない場合と権限がない場合は同じ返事にする
  throw new Error('この写真は見られません。非公開になったか、公開相手に入っていない可能性があります。');
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

/**
 * 読み上げ用テキストのクリーニング
 * 「〜で読み上げてください」「明るい声で：」などの演出指示・前置き・ラベル・記号を除き、
 * 本文だけを残す（本文そのものは消さない）
 */
function cleanNarration_(t) {
  let s = String(t || '');
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/[*#_`>~|]/g, '');
  // （明るいトーンで）【BGM】などの演出指示
  s = s.replace(/[（(【\[〈《][^）)】\]〉》]{0,30}(読み|読ん|声|トーン|口調|調子|ゆっくり|明るく|優しく|やさしく|落ち着|BGM|SE|効果音|ナレーション|間を|朗読)[^）)】\]〉》]{0,30}[）)】\]〉》]/g, '');
  // 英語の演出指示（Say cheerfully: など）
  s = s.replace(/^\s*(please\s+)?(say|read|speak|narrate)\b[^:\n]{0,80}:\s*/gim, '');
  // 「ナレーション：」「解説:」などのラベル
  s = s.replace(/^\s*(ナレーション|ナレーター|解説|原稿|本文|読み上げ文|セリフ|台本|AI|話者\d*|Speaker\s*\d*)\s*[:：]\s*/gim, '');
  // 行頭の指示文「〜で読み上げてください。」「以下の文章を〜読んでください：」
  const lead = /^\s*[^。！？!?\n]{0,60}?(読み上げ|読みあげ|朗読|ナレーション|読んで|読む|話して|お話しして|お読み)[^。！？!?\n]{0,12}?(ください|下さい|します|しましょう|お願いします)[。：:、！!\s]*/;
  const intro = /^\s*(以下|次)(は|が|の)[^。！？!?\n]{0,30}?(解説|ナレーション|原稿|文章|文|テキスト|内容)[^。！？!?\n]{0,20}?[。：:\n]\s*/;
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.split('\n').map(function (line) { return line.replace(lead, '').replace(intro, ''); }).join('\n');
    if (s === before) break;
  }
  // 文として独立したメタ文（短いものだけ消す。本文は消さない）
  const meta = /(読み上げ(て|ます|る|を)|ナレーション(を|です|します|開始|原稿)|AIによる(解説|ナレーション|分析結果をお伝え)|音声(で|にて)(お届け|解説|お伝え)|(トーン|口調|声)で(話|読|お届け)|それでは.{0,8}(始め|読み))/;
  s = s.split(/(?<=[。！？!?\n])/).filter(function (x) { return !(meta.test(x) && x.trim().length <= 40); }).join('');
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
const SHEET_CACHE_ = {};
function sheet_(key) {
  if (SHEET_CACHE_[key]) return SHEET_CACHE_[key];
  const ss = SpreadsheetApp.openById(prop_('SPREADSHEET_ID'));
  const def = SHEETS[key];
  let sh = ss.getSheetByName(def.name);
  if (!sh) { // 新しいシートは自動で作成（setup の再実行は不要）
    sh = ss.insertSheet(def.name);
    sh.appendRow(def.headers);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, def.headers.length).setFontWeight('bold');
  } else {
    ensureColumns_(sh, def.headers);
  }
  SHEET_CACHE_[key] = sh;
  return sh;
}
/** バージョンアップで増えた列を、既存シートの右端に自動で追加する */
function ensureColumns_(sh, headers) {
  const lastCol = Math.max(1, sh.getLastColumn());
  const cur = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const missing = headers.filter(function (h) { return cur.indexOf(h) < 0; });
  if (!missing.length) return;
  const start = cur.filter(function (h) { return h !== ''; }).length + 1;
  sh.getRange(1, start, 1, missing.length).setValues([missing]).setFontWeight('bold');
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
