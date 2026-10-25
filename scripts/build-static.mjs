import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import minifyHtml from '@minify-html/node';
import { transform } from 'esbuild';
import { verifyAssets } from './verify-assets.mjs';

const { ja } = createRequire(import.meta.url)('../ui-prototype/i18n.js').messages;

// Crawlers read OGP without running JS, so the Japanese share URL needs its own static tags.
export function japaneseLanding(html) {
  const og = {
    'og:url': 'https://mindmap.luckpoint.jp/ja/landing',
    'og:title': ja['landing.title'],
    'og:description': ja['landing.description'],
    'og:image': 'https://mindmap.luckpoint.jp/landing/og-ja.png',
    'og:locale': 'ja_JP',
  };
  return Object.entries(og).reduce(
    (page, [key, value]) => page.replace(new RegExp(`(property="${key}"\\s+content=")[^"]*`), `$1${value}`),
    html.replace('<head>', '<head>\n    <base href="/" />'),
  );
}

// Keep the source tree and URLs intact; only the deployment copy is transformed.
export async function buildStatic(source, output) {
  await rm(output, { recursive: true, force: true });
  await cp(source, output, {
    recursive: true,
    filter: path => !/(^|\/)(\.DS_Store)$|\.(map|download)$/.test(path),
  });
  if (existsSync(join(output, 'landing.html'))) {
    await mkdir(join(output, 'ja'), { recursive: true });
    await writeFile(
      join(output, 'ja/landing.html'),
      japaneseLanding(await readFile(join(output, 'landing.html'), 'utf8')),
    );
  }
  const stats = { before: 0, after: 0, files: 0 };
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const name = relative(output, path);
      // Third-party assets are already built; MediaPipe must retain its pinned hashes.
      if (name === 'vendor' || name === 'mediapipe') continue;
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      const extension = name.split('.').pop();
      if (!['html', 'js', 'mjs', 'css'].includes(extension)) continue;
      const input = await readFile(path);
      const result =
        extension === 'html'
          ? minifyHtml.minify(input, {
              minify_js: true,
              minify_css: true,
              keep_closing_tags: true,
              keep_html_and_head_opening_tags: true,
            })
          : (
              await transform(input.toString(), {
                loader: extension === 'css' ? 'css' : 'js',
                target: 'es2022',
                minify: true,
              })
            ).code;
      await writeFile(path, result);
      stats.before += input.length;
      stats.after += Buffer.byteLength(result);
      stats.files++;
    }
  }
  await visit(output);
  return stats;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const source = fileURLToPath(new URL('../ui-prototype', import.meta.url));
  const output = fileURLToPath(new URL('../dist', import.meta.url));
  const pinned = JSON.parse(await readFile(new URL('./mediapipe-assets.json', import.meta.url)));
  const { errors } = verifyAssets(source, pinned);
  if (errors.length) throw new Error(errors.join('\n'));
  try {
    const stats = await buildStatic(source, output);
    const { errors } = verifyAssets(output, pinned);
    if (errors.length) throw new Error(errors.join('\n'));
    console.log(`Minify: ${stats.files} ファイル、${stats.before} → ${stats.after} bytes`);
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}
