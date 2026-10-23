#!/usr/bin/env python3
"""Fetch pinned MediaPipe assets for same-origin static serving. Run once before hand input."""
from pathlib import Path
import hashlib
import json
import sys
import urllib.error
import urllib.request

VERSION = '0.10.32'
BASE = f'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@{VERSION}/'
DEST = Path(__file__).resolve().parents[1] / 'ui-prototype' / 'mediapipe'
FILES = {name: BASE + name for name in (
    'vision_bundle.mjs', 'wasm/vision_wasm_internal.js',
    'wasm/vision_wasm_internal.wasm', 'wasm/vision_wasm_nosimd_internal.js',
    'wasm/vision_wasm_nosimd_internal.wasm',
)}
FILES['vision_bundle.js'] = BASE + 'vision_bundle.cjs'
FILES['hand_landmarker.task'] = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

def main():
    manifest = {'package': '@mediapipe/tasks-vision', 'version': VERSION, 'files': {}}
    for name, url in FILES.items():
        target = DEST / name
        target.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(url, timeout=90) as response:
            data = response.read()
        temp = target.with_suffix(target.suffix + '.download')
        temp.write_bytes(data)
        temp.replace(target)
        manifest['files'][name] = {'url': url, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
        print(f'{name}: {len(data)} bytes')
    (DEST / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')

if __name__ == '__main__':
    try:
        main()
    except (urllib.error.URLError, OSError) as error:
        print(f'認識資産を取得できませんでした: {error}\n接続を確認して同じコマンドを再実行してください。', file=sys.stderr)
        sys.exit(1)
