import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 20000;
const IGNORED = /(^|\/)(\.DS_Store|\.assetsignore|_headers)$|\.(map|download)$/;

function listFiles(dir, root = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path, root) : [relative(root, path)];
  });
}

export function verifyAssets(root, pinned) {
  const errors = [];
  const sha256 = path =>
    createHash('sha256')
      .update(readFileSync(join(root, path)))
      .digest('hex');
  const files = listFiles(root).filter(path => !IGNORED.test(path));
  const present = new Set(files);
  for (const path of ['index.html', 'features.js', 'vendor/rxdb.js'])
    if (!present.has(path)) errors.push(`${path}: 見つかりません`);
  for (const [name, { sha256: expected }] of Object.entries(pinned)) {
    const path = `mediapipe/${name}`;
    if (!present.has(path)) errors.push(`${path}: 見つかりません`);
    else if (sha256(path) !== expected) errors.push(`${path}: SHA-256が一致しません`);
  }
  for (const path of files)
    if (statSync(join(root, path)).size > MAX_FILE_BYTES) errors.push(`${path}: 25 MiBを超えています`);
  if (files.length > MAX_FILES) errors.push(`ファイル数が${MAX_FILES}件を超えています`);
  if (present.has('features.js')) {
    const context = Object.create(null);
    try {
      runInNewContext(readFileSync(join(root, 'features.js'), 'utf8'), context, { timeout: 1000 });
    } catch {
      errors.push('features.js: 実行できません');
    }
    if (context.MindmapFeatures?.instructions !== false)
      errors.push('features.js: instructions が false ではありません');
  }
  return { errors, files: files.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pinned = JSON.parse(readFileSync(new URL('./mediapipe-assets.json', import.meta.url)));
  const { errors, files } = verifyAssets(process.argv[2] || fileURLToPath(new URL('../dist', import.meta.url)), pinned);
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log(`配信資産を確認しました: ${files} ファイル`);
}
