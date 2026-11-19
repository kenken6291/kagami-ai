# かがみAI ～ヘア＆メイク試着室

顔写真から、似合う髪型とメイクをAIが提案。髪型の変更・バーチャルメイクを試して、参考動画（YouTube 通常動画／ショート動画）で学べるWebアプリです。

- 公開先（予定）: https://kenken6291.github.io/kagami-ai/
- バージョン: v1.6.0（画面のフッターに「画面のバージョン（サーバーのバージョン）」を表示。違うときは注意が出ます）

## ファイル構成

```
kagami-ai/
├── index.html      画面（認証・9ステップ・ガイド・履歴・共有）
├── style.css       デザイン（ライト／ダーク対応）
├── app.js          フロントの処理（カメラ・メイク描画・音声・API連携）
├── config.js       フロント設定（GAS_ENDPOINT・VERSION・音声入力・共有の文言）
├── assets/         Google Earth Studio の動画を置く（opening.mp4 / bg-loop.mp4）
├── gas/Config.gs   バックエンド設定（APP_VERSION・規約の版・各種上限・既定値）
├── gas/Code.gs     バックエンド本体
└── README.md
```

## 全体アーキテクチャ

```
[ブラウザ (GitHub Pages)]
  ├ カメラ撮影 / 画像アップロード → 長辺1024pxに縮小
  ├ バーチャルメイク …… MediaPipe Face Landmarker（端末内で顔の点を検出しCanvasに描画、API代ゼロ）
  ├ 比較スライダー ……… 重ねて比較／並べて比較
  ├ 音声入力 …………… Web Speech API（continuous＋無音タイマー）
  └ 読み上げ …………… Gemini TTS（失敗時は Web Speech Synthesis）
        │ fetch POST（Content-Type: text/plain → CORSのプリフライト回避）
        ▼
[Google Apps Script ウェブアプリ]
  ├ 認証（SHA-256×300回＋salt＋pepper、セッションはCacheService 6時間）
  ├ analyze  … Gemini（画像認識→顔の形・パーソナルカラー・提案・動画検索ワード・解説文をJSONで）
  ├ hairEdit … Gemini画像モデル（髪型だけを変えた写真を生成）
  ├ tts      … Gemini TTS（PCM音声を返す → ブラウザでWAV化）
  ├ videos   … YouTube Data API v3（任意。キーが無ければリンク表示のみ）
  ├ Googleスプレッドシート（会員・履歴・ログ）
  └ Googleドライブ（写真を会員ごとのフォルダに一時保存、7日で自動削除）
```

動画はYouTube Data API v3で検索します。通常の動画は `videoDuration=medium`、ショート動画は検索ワードに `#shorts` を付けて `videoDuration=short` で探します（ショートは切り替えたときだけ検索し、APIの使用量を抑えています）。

## スプレッドシートのカラム構成

**Users**（会員）

| 列 | 内容 |
|---|---|
| userId | 会員ID（u_…） |
| email | メールアドレス（小文字） |
| nickname | ニックネーム |
| passwordHash | ハッシュ化したパスワード |
| salt | ソルト（パスワード変更ごとに更新） |
| mustChange | TRUE＝仮パスワード状態（次回ログインで変更画面へ） |
| failCount | ログイン失敗回数 |
| lockedUntil | ロック解除日時（5回失敗で15分） |
| status | active／停止する場合は別の値に |
| termsVersion | 同意した規約の版 |
| agreedAt | 同意日時 |
| createdAt | 登録日時 |
| lastLoginAt | 最終ログイン日時 |

| agreementsJson | 同意した項目（注意書き・利用規約・免責事項・自己責任・当事者間での解決）と日時（v1.5.0〜、自動で列追加） |

**History**（診断履歴）: historyId / userId / createdAt / imageFileId / faceShape / personalColor / hairStyle / request / analysisJson

**Looks**（ギャラリー／v1.1.0〜、初回保存時に自動作成）: lookId / userId / createdAt / fileId / thumb（240pxのサムネイルをBase64で保存） / hairLabel / summary / metaJson / shared（TRUE＝公開中、既定FALSE） / audience（見せる相手のuserId配列、空＝公開相手の全員） / sharedAt
※ shared 以降の列は v1.5.0 で追加。既存シートには自動で右端に追加されます。

**Members**（公開相手／v1.5.0〜、自動作成）: ownerId（見せる人） / memberId（見る人） / label（呼び名） / active（TRUE＝見せる、FALSE＝一時停止） / addedAt

**Logs**（操作ログ）: at / userId / action / detail

## 導入手順

### 1. GAS（バックエンド）
1. https://script.google.com で新しいプロジェクトを作成し、`gas/Code.gs` の中身を貼り付けて保存。続けて「＋」→「スクリプト」で `Config` を作り、`gas/Config.gs` を貼り付けて保存。
2. 「プロジェクトの設定」→「スクリプト プロパティ」に追加:
   - `GEMINI_API_KEY`（必須）
   - `APP_URL` = `https://kenken6291.github.io/kagami-ai/`
   - `YOUTUBE_API_KEY`（任意。Google Cloud で YouTube Data API v3 を有効化して作成）
   - 分析・メイク提案・動画おすすめのAIモデルは画面（手順2「分析に使うAIモデル」）で選べます。選択肢は config.js の `GEMINI_MODEL_OPTIONS`。使えないモデルは Config.gs の `TEXT_MODEL_FALLBACKS`（自動＝gemini-flash-latest → 4 Hydrogen → 3.8 Flash → 2.5 Flash）へ自動で切り替わります
   - モデルを変えたいときは `GEMINI_TEXT_MODEL` / `GEMINI_IMAGE_MODEL` / `GEMINI_TTS_MODEL` / `TTS_VOICE`
3. 関数 `setup` を選んで実行 → 権限を承認。スプレッドシート・画像フォルダ・毎日3時の削除トリガーが作られます。
4. 関数 `testGemini` を実行して「こんにちは」がログに出ればAPIキーはOK。
5. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
   - 次のユーザーとして実行: **自分**
   - アクセスできるユーザー: **全員**
6. 表示された `…/exec` のURLをコピー。

> ⚠ Code.gs を修正したら、「デプロイを管理」→ 鉛筆アイコン →「バージョン：新バージョン」→「デプロイ」をしないと反映されません（URLは変わりません）。

### 2. フロントエンド
1. `config.js` の `GAS_ENDPOINT` に、手順1-6のURLを貼り付け。
2. GitHubで `kagami-ai` リポジトリを作成し、`gas/` 以外のファイル（`gas/` も含めて管理してOK）をアップロード。
3. 「Settings」→「Pages」→ Branch: `main` / `/(root)` → Save。
4. 数分後 `https://kenken6291.github.io/kagami-ai/` で表示されます。

カメラ・マイクはHTTPSでのみ動作します（GitHub PagesはHTTPSなのでOK）。

### 3. Google Earth Studio の動画（任意）
1. Earth Studio でオープニング（10秒前後）と背景ループ（20〜30秒）を作成し、画像連番で書き出し。
2. MP4に変換（例）:
   ```
   ffmpeg -framerate 30 -i footage_%03d.jpeg -c:v libx264 -pix_fmt yuv420p -crf 26 -vf scale=1280:-2 assets/opening.mp4
   ```
3. `assets/opening.mp4` と `assets/bg-loop.mp4` に置く。ファイルが無い場合は自動で非表示になります。
4. 画面に「映像: Google Earth」の表記が出ます（Earth Studioの利用条件の帰属表示）。文言は `config.js` の `CREDIT` で変更できます。

## 設定でできること（config.js）
- `GAS_ENDPOINT` … 本番／テスト用GASの切り替え（ここだけ書き換え）
- `VERSION` … 画面に出るバージョン（`gas/Config.gs` の `APP_VERSION` と合わせる）
- `STT` … 音声入力の待ち時間（`SILENCE_MS` 既定4.5秒、`INITIAL_WAIT_MS` 既定12秒）
- `SHARE` … 共有リンクの行き先URL、LINEで送る文（`{name}`＝ニックネーム、`{app}`＝アプリ名）
- `TTS_MODE` … `'gemini'` か `'browser'`
- `HAIR_STYLES` / `HAIR_COLORS` / `MAKEUP_PALETTE` … 選択肢の追加・変更

## 設定でできること（gas/Config.gs）
- `APP_VERSION` / `TERMS_VERSION` … バージョンと規約の版
- `SHARE.MAX_MEMBERS` … 公開相手の上限（既定30人）、`SHARE.ADD_LIMIT_PER_HOUR` … 追加を試せる回数（既定20回／時）
- `DEFAULTS` … モデル名・上限などの既定値（スクリプトプロパティに同じ名前があればそちらが優先）

## 共有のしくみ（v1.5.0）
- 公開相手は、相手の**会員登録メールアドレス**で追加します（相手が先に会員登録している必要あり）。
- ギャラリーの写真は保存した時点で必ず**非公開**。8の一覧でスイッチを「公開」にすると見えるようになります。
- 見せる相手は写真ごとに選べます（選ばなければ「公開相手の全員」）。相手ごとのスイッチで一時停止、「外す」で解除。
- 「すべて非公開にする」で、一括で非公開に戻せます。
- 「LINEなどで送る」は `https://kenken6291.github.io/kagami-ai/?look=写真ID` のリンクを送ります。開いた人がログインし、公開相手に入っていて、その写真が公開中のときだけ表示されます（サーバー側で毎回確認）。
- 画像そのものは送らないので、非公開に戻せばリンクからも見られなくなります。

## 更新履歴
- v1.6.0 Geminiのバージョン選択に対応（自動モード／4 Hydrogen／4 Neon／4 Carbon／4 Argon／3.8 Flash／3.5 Flash）。選んだモデルは端末に保存し、使えない場合は汎用の最新モデルへ自動切替。実際に使ったモデルをフッターに表示。文章AIの既定を gemini-2.5-flash から自動（汎用の最新）に変更。
- v1.5.0 家族・友人など指定した会員にだけ公開する共有機能（公開相手の管理・写真ごとの公開／非公開と相手の選択・一括非公開・LINE／メール／ほかのアプリでリンク送信・見せてもらった写真の一覧）。登録時の同意に「注意書き」を追加（5項目）。読み上げの前置き（「〜で読み上げてください」など）を除去する処理を強化。音声入力が言葉の間で切れにくいよう改善（自動再開時の引き継ぎ・重複除去・待ち時間延長）。フッターに画面とサーバーのバージョンを表示し、不一致を通知。GAS側の設定を Config.gs に分離。
- v1.3.0 動画をYouTubeの通常動画／ショート動画の切り替え式に変更（TikTokを廃止）
- v1.2.0 AIのおすすめ動画を一覧表示し、選んで再生する方式に変更
- v1.1.0 メイクの雰囲気（ナチュラル・華やか・きちんと・若々しく）、見せたい印象（鼻を高く・あごすっきり・小顔・明るく・目元ぱっちり）、言葉／音声でのメイク指示（AIにおまかせ）、ギャラリー（保存・一覧・最大4枚の見比べ・削除）を追加
- v1.0.0 初版

## 運用メモ
- ギャラリーの画像は Drive の「会員フォルダ/looks」に保存され、7日の自動削除の対象外です（1人30枚まで、`MAX_LOOKS` で変更）。
- AIの利用は1人1日40回まで（`DAILY_AI_LIMIT` で変更）。
- 写真はドライブに7日保存後、自動でゴミ箱へ（`IMAGE_RETENTION_DAYS`）。会員はメニューからいつでも削除可能。
- 会員を停止するには、Usersシートの `status` を `stopped` などに変更。
- 仮パスワードのメールは MailApp で送信（無料アカウントは1日100通程度まで）。
