/**
 * かがみAI  バックエンド設定（Config.gs）
 * GASエディタで「ファイルを追加 → スクリプト」→ 名前を Config にして貼り付けてください。
 * 設定はこのファイルだけ書き換えれば切り替えられます。
 * （APIキーなどの秘密情報は、ここではなく「スクリプト プロパティ」に入れてください）
 *
 * ※スクリプトプロパティに同じ名前の値があれば、そちらが優先されます。
 */

// バージョン（フロントの config.js の VERSION と合わせる。違うと画面に注意が出ます）
const APP_VERSION = 'v1.5.0';

// 規約の版。注意書き・規約を変えたら日付を更新する
const TERMS_VERSION = '2026-11-04';

// 認証まわり
const SESSION_TTL = 21600;      // 6時間（CacheServiceの上限）
const MAX_FAILS = 5;            // ログイン失敗の上限
const LOCK_MINUTES = 15;        // ロック時間
const HASH_ROUNDS = 300;        // パスワードハッシュの反復回数

// 共有（家族・友人への公開）
const SHARE = {
  MAX_MEMBERS: 30,          // 公開相手の上限（1人あたり）
  ADD_LIMIT_PER_HOUR: 20,   // 公開相手の追加を試せる回数（1時間）
  LABEL_MAX: 20,            // 呼び名の最大文字数
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
  MAX_LOOKS: '30',
};
