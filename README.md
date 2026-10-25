![Mind Map app preview](ui-prototype/landing/map.webp)

# Mind Map Prototype

English | [日本語](README.ja.md)

A mind map app with editable nodes, images and icons, Japanese voice input, and camera-based hand gestures. Multiple maps and Undo/Redo history are saved in your browser.

## Live links

- [Production app](https://mindmap.luckpoint.jp/)
- [Landing page](https://mindmap.luckpoint.jp/landing)

## Getting started

Use Node.js 22 or later.

```sh
npm install
npm run setup
npm start
```

Open `http://127.0.0.1:8787` in your browser. To use a different port, run `PORT=8790 npm start`.

For detailed setup instructions, including downloading assets for hand gestures, see the [local development guide](docs/guides/local-development.md) and [gesture validation guide](docs/guides/gesture-validation.md) (in Japanese).

## Instructions with Codex

Instruction input is disabled by default. Enabling it requires Codex CLI 0.163.0 and a signed-in session.

```sh
codex --version
codex login
ENABLE_CODEX_INSTRUCTIONS=true npm start
```

Instruction input is disabled when served statically. See the [local development guide](docs/guides/local-development.md) for connection details and limitations.

## Validation

```sh
npm test
npm run verify:assets
```

Tests mock Codex and do not make billable generation requests. HTTP tests require a local listening socket. See the [deployment guide](docs/guides/cloudflare-workers-deployment-design.md) for the preparation required before validating assets.

## Documentation

Design documents, implementation plans, investigations, and validation procedures are listed in the [documentation index](docs/README.md) (in Japanese).

Maps and images are stored in your browser and are lost if you clear its data. Keep JSON exports that include images as backups. For items awaiting validation, including real microphone input, Safari, and iPad behavior, see the relevant design documents and validation records.
