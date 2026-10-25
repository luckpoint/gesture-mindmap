# ドキュメント一覧

使い始める場合は、ルートの [README](../README.md) を参照してください。ローカル起動・機能の詳しい説明・検証上の制約は [ローカル開発ガイド](guides/local-development.md) にあります。

全体像は [プロトタイプ設計](design/mind-map-prototype-design.md)、実装の段階は [実装計画](plans/mind-map-implementation-plan.md) から確認できます。全体設計には過去の方針も残っているため、冒頭の更新注記と各機能の設計書を併せて参照してください。

## 設計 — `design/`

- [Codex app-serverによる指示入力 設計](design/codex-prompt-design.md)
- [編集履歴の永続化 設計](design/edit-history-persistence.md)
- [多言語化（英語・日本語）設計](design/i18n-design.md)
- [アイコンパレット設計](design/icon-palette-design.md)
- [声と手で考えを広げるマインドマップ](design/mind-map-prototype-design.md)
- [複数マップとRxDB＋OPFS保存 設計](design/multi-map-storage-design.md)
- [ノードへの画像追加 設計](design/node-images-design.md)
- [A4印刷設計](design/print-a4-design.md)
- [Web Speech APIによる音声入力の検討](design/web-speech-input-design.md)

## 計画 — `plans/`

- [マインドマップ・プロトタイプ実装計画](plans/mind-map-implementation-plan.md)

## 調査・改善・引き継ぎ — `investigations/`

- [サムダウンで削除確認が開かないケースの調査](investigations/delete-gesture-investigation-2026-10-24.md)
- [ジェスチャー操作の対応状況と未解決課題](investigations/gesture-handoff-2026-10-23.md)
- [ハンドトラッキングの検知候補](investigations/hand-tracking-candidates.md)
- [ハンドトラッキング改善メモ](investigations/hand-tracking-improvements-2026-10-24.md)

## 開発・検証・作業手順 — `guides/`

- [Cloudflare Workers デプロイ調査・設計](guides/cloudflare-workers-deployment-design.md)
- [ジェスチャーの操作・検証記録](guides/gesture-validation.md)
- [アイコン一覧画像を個別PNGに切り分ける](guides/icon-sheet-splitting.md)
- [ローカル開発・機能と検証状況](guides/local-development.md)

## 配置ルール

- ファイル名は内容が分かる名前にし、日付は調査・引き継ぎなど時点が重要な記録に付けます。
- 文書間の参照は相対リンクにします。コマンドは、特記がなければリポジトリのルートで実行します。
- 文書に付随する既存の加工スクリプトは `docs/scripts/` に置きます。
- 文書用画像が必要になったら `docs/assets/` を作成します。アプリで配信する画像は `ui-prototype/` 内で管理します。
