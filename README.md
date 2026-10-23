# マインドマップ試作

Node.js 22以上と **Codex CLI 0.163.0** を使います。追加のnpm依存はありません。

```sh
codex --version
codex login
npm start
```

表示された `http://127.0.0.1:8787` をMacのブラウザで開きます。別ポートは `PORT=8790 npm start` で指定できます。既存のCLIログインを使い、認証情報をブラウザへ渡しません。CLIの版が異なる場合や起動・認証に失敗した場合も、通常のマップ編集・JSON書き出しは使えます。静的ファイルだけを開いた場合、Codexへの指示は動きません。

下部の入力欄に指示を入力し、Enterまたは送信ボタンで実行します。Shift+Enterで改行、⌘K / Ctrl+Kで入力欄に移動できます。送信時点の選択ノードとマップ全体を渡し、毎回新しいスレッドを使います。削除を含む指示は、範囲と同時変更を確認してからまとめて反映します。一回のUndoで指示全体を戻せます。

```sh
npm test
```

テストではCodexを模擬し、課金を伴う生成は行いません。HTTPテストのためlocalhostの待受が必要です。採用版から生成したJSON Schemaは `server/schemas/protocol/`、操作案のSchemaは `server/schemas/instruction-output.schema.json` にあります。実際の出力検証はブラウザ・中継で共用する `ui-prototype/instructions/operations.js` が行います。

現段階の中継はMacのloopbackに限定しています。HTTPS・アクセス認証・Origin検証と、iPad接続・カメラの受入確認は後続対応です。サーバーをインターネットへ公開する構成にはしていません。

設計・実装状況・未確認項目は [Codex指示入力の設計](docs/codex-prompt-design.md) を参照してください。
