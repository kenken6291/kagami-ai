# かがみAI ～ヘア＆メイク試着室

顔写真から、似合う髪型とメイクをAIが提案。髪型の変更・バーチャルメイクを試して、参考動画（YouTube／TikTok）で学べるWebアプリです。

- 公開先（予定）: https://kenken6291.github.io/kagami-ai/
- バージョン: v1.0.0

## ファイル構成

```
kagami-ai/
├── index.html      画面（認証・5ステップ・ガイド・履歴）
├── style.css       デザイン（ライト／ダーク対応）
├── app.js          フロントの処理（カメラ・メイク描画・音声・API連携）
├── config.js       設定（GAS_ENDPOINT など、ここだけ書き換えれば切替可能）
├── assets/         Google Earth Studio の動画を置く（opening.mp4 / bg-loop.mp4）
├── gas/Code.gs     バックエンド（GASに貼り付ける）
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

TikTokは公式の検索APIが無いため、「TikTokで探す」リンク＋URLを貼ると埋め込み再生する方式です。

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

**History**（診断履歴）: historyId / userId / createdAt / imageFileId / faceShape / personalColor / hairStyle / request / analysisJson

**Logs**（操作ログ）: at / userId / action / detail

## 導入手順

### 1. GAS（バックエンド）
1. https://script.google.com で新しいプロジェクトを作成し、`gas/Code.gs` の中身を貼り付けて保存。
2. 「プロジェクトの設定」→「スクリプト プロパティ」に追加:
   - `GEMINI_API_KEY`（必須）
   - `APP_URL` = `https://kenken6291.github.io/kagami-ai/`
   - `YOUTUBE_API_KEY`（任意。Google Cloud で YouTube Data API v3 を有効化して作成）
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
- `GAS_ENDPOINT` … 本番／テスト用GASの切り替え
- `TTS_MODE` … `'gemini'` か `'browser'`
- `STT.SILENCE_MS` … 言葉の間をどれだけ待つか（既定2.5秒）
- `HAIR_STYLES` / `HAIR_COLORS` / `MAKEUP_PALETTE` … 選択肢の追加・変更

## 運用メモ
- AIの利用は1人1日40回まで（`DAILY_AI_LIMIT` で変更）。
- 写真はドライブに7日保存後、自動でゴミ箱へ（`IMAGE_RETENTION_DAYS`）。会員はメニューからいつでも削除可能。
- 会員を停止するには、Usersシートの `status` を `stopped` などに変更。
- 仮パスワードのメールは MailApp で送信（無料アカウントは1日100通程度まで）。
