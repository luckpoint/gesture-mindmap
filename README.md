# マインドマップ試作

Node.js 22以上を使います。指示欄は機能フラグで切り替え、既定ではOFFです。指示欄をONにする場合のみ **Codex CLI 0.163.0** とログインが必要です。マップの保存にRxDBを使うため、最初に `npm install && npm run setup` で `ui-prototype/vendor/rxdb.js` を生成します（静的配信のときも同梱してください）。

```sh
npm install && npm run setup
npm start
```

端末内に複数のマップを持てます。左上の「マップ」から作成・切り替え・削除ができ、JSONの読み込みは新しいマップとして追加します。同じマップを別のタブで開くと、そのタブは閲覧専用になります。Undo/Redoの履歴（最大1000件）もマップごとに保存し、再読み込み後も続けられます。仕様は [複数マップとRxDB＋OPFS保存](docs/multi-map-storage-design.md) にあります。

表示された `http://127.0.0.1:8787` をMacのブラウザで開きます。別ポートは `PORT=8790 npm start` で指定できます。指示欄とCodex連携をONにする場合は、次のように起動します。

```sh
codex --version
codex login
ENABLE_CODEX_INSTRUCTIONS=true npm start
```

`ENABLE_CODEX_INSTRUCTIONS` は文字列 `true` の場合だけONになり、未指定・`false`・その他の値はOFFです。OFFでは指示欄・開閉ボタンを表示せず、⌘K / Ctrl+Kも無効です。Codexプロセスと指示サービスを起動せず、`/api/codex/*` と `/api/instructions` 以下は404を返します。通常のマップ編集・保存・画像の読み込み／表示はそのまま使えます。

Cloudflare Workersで公開する際は、`ui-prototype/` を静的アセットとして配信し、同梱の `features.js`（`instructions: false`）を使用します。Node.jsの中継サーバーは公開構成に含めません。ローカル中継では環境変数から同じURLの設定を返すため、ONで使った後も静的ファイルの設定はOFFのままです。機能フラグはブラウザの保存設定やURLパラメータでは切り替えません。

ONでは既存のCLIログインを使い、認証情報をブラウザへ渡しません。CLIの版が異なる場合や起動・認証に失敗した場合も、通常のマップ編集・JSON書き出しは使えます。静的ファイルの配信では指示欄とCodex連携は無効です。

下部の入力欄に指示を入力し、Enterまたは送信ボタンで実行します。Shift+Enterで改行、⌘K / Ctrl+Kで入力欄に移動できます。送信時点の選択ノードとマップ全体を渡し、毎回新しいスレッドを使います。削除を含む指示は、範囲と同時変更を確認してからまとめて反映します。一回のUndoで指示全体を戻せます。

```sh
npm test
```

テストではCodexを模擬し、課金を伴う生成は行いません。HTTPテストのためlocalhostの待受が必要です。採用版から生成したJSON Schemaは `server/schemas/protocol/`、操作案のSchemaは `server/schemas/instruction-output.schema.json` にあります。実際の出力検証はブラウザ・中継で共用する `ui-prototype/instructions/operations.js` が行います。

現段階の中継はMacのloopbackに限定しています。HTTPS・アクセス認証・Origin検証と、iPad接続・カメラの受入確認は後続対応です。サーバーをインターネットへ公開する構成にはしていません。

設計・実装状況・未確認項目は [Codex指示入力の設計](docs/codex-prompt-design.md) を参照してください。

画像対応の仕様と進捗は [ノードへの画像追加の設計](docs/node-images-design.md) にあります。画像参照の保存、画像付きJSONの読み込み・書き出し、表示、取り外し、Undo/Redoの基盤を実装しています。画像本体はOPFS（`/images/<SHA-256>`）に保存します。以前の版でIndexedDBに置いた画像は起動時に移します。どのマップからも参照されず24時間たった画像は、ほかのタブがないときの起動時に消します。ブラウザのデータを消すと失われるため、画像込みJSONを保管してください。OPFSとWeb Locksは安全な接続（`http://127.0.0.1` など）でしか使えません。

Codex接続は通常・画像用とも `config/read` の内部エラー（`-32603`）で停止しており、新規画像の生成・追加・置き換えUIは未接続です。`node scripts/probe-image-startup.mjs` で秘密情報を表示せず起動を再確認できます。実ブラウザの受入確認用に `node scripts/verify-node-images.cjs`（別途PlaywrightとChromiumが必要。`--chrome` でGoogle Chromeを使用）を用意していますが、今回の環境ではブラウザの起動権限制限により実行完了していません。
