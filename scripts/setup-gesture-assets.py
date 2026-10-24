#!/usr/bin/env python3
"""Fetch pinned MediaPipe assets for same-origin static serving. Run once before hand input."""
from pathlib import Path
import hashlib
import json
import sys
import urllib.error
import urllib.request

VERSION = '0.10.32'
ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'ui-prototype' / 'mediapipe'
FILES = json.loads((ROOT / 'scripts' / 'mediapipe-assets.json').read_text())

def main():
    manifest = {'package': '@mediapipe/tasks-vision', 'version': VERSION, 'files': {}}
    for name, expected in FILES.items():
        target = DEST / name
        target.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(expected['url'], timeout=90) as response:
            data = response.read()
        digest = hashlib.sha256(data).hexdigest()
        if digest != expected['sha256']:
            raise ValueError(f'{name}: SHA-256が一致しません ({digest})')
        temp = target.with_suffix(target.suffix + '.download')
        temp.write_bytes(data)
        temp.replace(target)
        manifest['files'][name] = {'url': expected['url'], 'sha256': digest, 'bytes': len(data)}
        print(f'{name}: {len(data)} bytes')
    (DEST / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')

if __name__ == '__main__':
    try:
        main()
    except (urllib.error.URLError, OSError, ValueError) as error:
        print(f'認識資産を取得できませんでした: {error}\n接続を確認して同じコマンドを再実行してください。', file=sys.stderr)
        sys.exit(1)
