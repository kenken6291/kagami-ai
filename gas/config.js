/**
 * かがみAI 設定ファイル
 * GASのURLや演出用動画は、このファイルだけ書き換えれば切り替えられます。
 */
window.CONFIG = {
  APP_NAME: 'かがみAI',
  APP_SUBTITLE: 'ヘア＆メイク試着室',
  VERSION: 'v1.0.0',

  // GASウェブアプリのURL（デプロイ後に表示される …/exec のURL）
  GAS_ENDPOINT: 'https://script.google.com/macros/s/AKfycbybkQgdG4a9qMdUOg3421jSmaAvYSN5zJ6dzBVybL86WwK6aiCNweBRnB7AH-HaO8Xa/exec',

  // 解説の読み上げ: 'gemini'（Gemini TTS、失敗時はブラウザ音声） / 'browser'（ブラウザ音声のみ）
  TTS_MODE: 'gemini',

  // 音声入力：言葉の間が SILENCE_MS 空いたら確定。話し始める前は INITIAL_WAIT_MS 待つ
  STT: { LANG: 'ja-JP', SILENCE_MS: 2500, INITIAL_WAIT_MS: 8000, MAX_MS: 60000 },

  // 送信前に縮小する写真の長辺（px）と画質
  IMAGE: { MAX_SIZE: 1024, QUALITY: 0.9 },

  // Google Earth Studio で書き出した動画（MP4に変換して assets/ に置く）
  EARTH_STUDIO: {
    OPENING_VIDEO: 'assets/opening.mp4',
    BG_VIDEO: 'assets/bg-loop.mp4',
    SHOW_OPENING: true,
    OPENING_MAX_SEC: 12,
    CREDIT: '映像: Google Earth',
  },

  // バーチャルメイク用の顔ランドマーク検出（MediaPipe）
  MEDIAPIPE: {
    BUNDLE: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs',
    WASM: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
    MODEL: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  },

  HAIR_STYLES: [
    { label: 'ベリーショート', prompt: '襟足とサイドを短く整えた、すっきりしたベリーショート' },
    { label: 'ショート', prompt: '耳が少し見える長さの、軽やかで動きのあるショートヘア' },
    { label: 'ボブ', prompt: 'あご下のラインで揃えた、毛先が内巻きのボブ' },
    { label: 'ミディアム', prompt: '肩につく長さの、レイヤーを入れたミディアムヘア' },
    { label: 'ロング', prompt: '胸下まである、艶のあるストレートロング' },
    { label: 'パーマ', prompt: '肩下の長さで、全体にふんわりした大きめのウェーブパーマ' },
    { label: 'ウルフ', prompt: 'トップを短く襟足を長めに残したウルフカット' },
    { label: 'ツーブロック', prompt: 'サイドと襟足を刈り上げ、トップを長めに残したツーブロック' },
    { label: 'センターパート', prompt: '前髪を真ん中で分けた、あご〜肩くらいの長さのセンターパート' },
  ],

  HAIR_COLORS: [
    { name: 'そのまま', prompt: '', hex: '' },
    { name: '黒髪', prompt: '自然でつやのある黒髪', hex: '#1d1a1c' },
    { name: 'ダークブラウン', prompt: '落ち着いたダークブラウン', hex: '#4a3226' },
    { name: 'ミルクティー', prompt: '明るいミルクティーベージュ', hex: '#b89a7c' },
    { name: 'アッシュグレー', prompt: '青みのあるアッシュグレー', hex: '#7d7f84' },
    { name: 'グレイヘア', prompt: '上品で明るいシルバーのグレイヘア', hex: '#c9c9cc' },
    { name: 'ピンクブラウン', prompt: 'ほんのり赤みのあるピンクブラウン', hex: '#8a5a5a' },
  ],

  MAKEUP_PALETTE: {
    lip: [
      { name: 'コーラル', hex: '#E2725B' },
      { name: 'ローズ', hex: '#C24D6B' },
      { name: 'レッド', hex: '#B0182E' },
      { name: 'ベージュ', hex: '#B7776A' },
      { name: 'ピンク', hex: '#E58BA0' },
      { name: 'ボルドー', hex: '#6E1A2B' },
    ],
    eye: [
      { name: 'ブラウン', hex: '#7A5236' },
      { name: 'ベージュ', hex: '#B8946E' },
      { name: 'ピンク', hex: '#C77D8A' },
      { name: 'カーキ', hex: '#6F6B45' },
      { name: 'グレー', hex: '#6B6770' },
      { name: 'ボルドー', hex: '#6E2C3B' },
    ],
    cheek: [
      { name: 'ピーチ', hex: '#F2A07B' },
      { name: 'ピンク', hex: '#EE8FA6' },
      { name: 'コーラル', hex: '#F07C6C' },
      { name: 'ローズ', hex: '#CC6B7F' },
      { name: 'オレンジ', hex: '#F29A4A' },
    ],
  },
};
