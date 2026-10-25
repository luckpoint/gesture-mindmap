# マインドマップ試作

[English](README.md) | 日本語

ノードの編集、画像・アイコンの追加、日本語音声入力、カメラを使った手の操作に対応するマインドマップです。複数のマップとUndo/Redoの履歴をブラウザ内に保存できます。

## 公開リンク

- [本番アプリ](https://mindmap.luckpoint.jp/)
- [ランディングページ](https://mindmap.luckpoint.jp/landing)

## 起動

Node.js 22以上を使います。

```sh
npm install
npm run setup
npm start
```

ブラウザで `http://127.0.0.1:8787` を開きます。別ポートを使う場合は `PORT=8790 npm start` で指定します。

手の操作に必要なアセットの取得など、詳しい手順は [ローカル開発ガイド](docs/guides/local-development.md) と [ジェスチャー検証ガイド](docs/guides/gesture-validation.md) を参照してください。

## Codexによる指示入力

指示入力は既定でOFFです。有効にする場合のみ、Codex CLI 0.163.0とログインが必要です。

```sh
codex --version
codex login
ENABLE_CODEX_INSTRUCTIONS=true npm start
```

静的配信では指示入力は無効です。接続状況・制約は [ローカル開発ガイド](docs/guides/local-development.md) に記載しています。

## 検証

```sh
npm test
npm run build:static
npm run verify:assets
```

テストではCodexを模擬し、課金を伴う生成は行いません。HTTPテストにはlocalhostの待受が必要です。アセット検証の前に必要な準備は [デプロイガイド](docs/guides/cloudflare-workers-deployment-design.md) を参照してください。

## 静的デプロイ

`npm run build:static` はvendor・MediaPipe資産を準備し、配信用の `dist/` を生成します。HTMLとインラインJS・CSSは `@minify-html/node`、外部JS・CSSはesbuildでminifyします。サードパーティ資産は元のバイト列を維持します。

資産準備後は `npm run dev:cf` で圧縮済みビルドを確認できます。`npm run deploy:staging` と `npm run deploy:production` は、毎回 `dist/` を再生成・検証してからアップロードします。`npm run build:deploy` はMediaPipeを再取得せず、準備済みの資産から再生成します。`ui-prototype/` はローカル開発用のソースとして保持します。

## ドキュメント

設計・実装計画・調査記録・検証手順は [ドキュメント一覧](docs/README.md) にまとめています。

マップと画像はブラウザ内に保存されます。ブラウザのデータを消すと失われるため、画像込みJSONを保管してください。実マイク・Safari・iPadなどの未確認項目は、各設計書と検証記録を参照してください。

## ライセンス

アイコン画像を含め、[GNU Affero General Public License v3.0 only](LICENSE)（AGPL-3.0-only）で公開しています。改変版をネットワーク経由で提供する場合は、利用者にソースコードを提供する必要があります。公開サイトで再配布している第三者コンポーネントは [THIRD_PARTY_NOTICES.txt](ui-prototype/THIRD_PARTY_NOTICES.txt) を参照してください。
