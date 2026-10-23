#!/usr/bin/env python3
"""Prepare gesture assets, serve on loopback, and open the default browser."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import webbrowser

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / 'ui-prototype'


class PrototypeHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # App code changes frequently; keep model/WASM assets cacheable.
        if not self.path.startswith('/mediapipe/'):
            self.send_header('Cache-Control', 'no-store')
        super().end_headers()


def assets_ready():
    assets = PUBLIC / 'mediapipe'
    required = {
        'vision_bundle.js', 'vision_bundle.mjs', 'hand_landmarker.task',
        'wasm/vision_wasm_internal.js', 'wasm/vision_wasm_internal.wasm',
        'wasm/vision_wasm_nosimd_internal.js', 'wasm/vision_wasm_nosimd_internal.wasm',
    }
    try:
        manifest = json.loads((assets / 'manifest.json').read_text())
        return manifest['version'] == '0.10.32' and required.issubset(manifest['files']) and all(
            hashlib.sha256((assets / name).read_bytes()).hexdigest() == manifest['files'][name]['sha256']
            for name in required
        )
    except (OSError, ValueError, KeyError, TypeError):
        return False


def main():
    if not assets_ready():
        print('手の認識に必要な資産を取得します（初回のみ）。', flush=True)
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/setup-gesture-assets.py')])
        if result.returncode:
            return result.returncode
    handler = partial(PrototypeHandler, directory=str(PUBLIC))
    try:
        server = ThreadingHTTPServer(('127.0.0.1', 8000), handler)
    except OSError:
        server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    url = f'http://localhost:{server.server_port}/'
    print(f'\n開くURL: {url}\n「手で操作」を押してカメラを許可してください。\n終了するときはこのターミナルでControl+Cを押してください。\n', flush=True)
    with server:
        webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print('\nサーバーを停止しました。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
