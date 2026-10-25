import { build } from 'esbuild';

await build({
  stdin: {
    contents:
      "export { createRxDatabase } from 'rxdb'; export { getRxStorageDexie } from 'rxdb/plugins/storage-dexie';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  outfile: 'ui-prototype/vendor/rxdb.js',
});
