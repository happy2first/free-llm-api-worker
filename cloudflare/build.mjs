import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
const settings = {
  entryPoints: ['cloudflare/src/worker.ts'], outfile: 'cloudflare/dist/worker.js',
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  external: ['cloudflare:*', 'node:*', ...builtinModules],
  alias: {
    'ajv/dist/2020.js': resolve('cloudflare/src/schema-validator.ts'),
    sharp: resolve('cloudflare/src/unavailable.ts'),
    undici: resolve('cloudflare/src/unavailable.ts'),
    'socks-proxy-agent': resolve('cloudflare/src/unavailable.ts'),
  },
  define: { 'import.meta.url': JSON.stringify('file:///worker.js') },
  banner: { js: "import { createRequire as __workerCreateRequire } from 'node:module'; const require = __workerCreateRequire('file:///worker.js');" },
  metafile: true, sourcemap: true,
};
const result = await build(settings);
if (process.argv.includes('--test')) await build({ ...settings, entryPoints: ['cloudflare/test/entry.ts'], outfile: 'cloudflare/dist/test.js' });
const { writeFile, mkdir } = await import('node:fs/promises');
await mkdir('cloudflare/dist', { recursive: true });
await writeFile('cloudflare/dist/meta.json', JSON.stringify(result.metafile, null, 2));
console.log('Cloudflare bundle built');
