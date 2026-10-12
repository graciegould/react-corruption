/** Test the packed artifact with both TypeScript module formats and server rendering. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = mkdtempSync(join(tmpdir(), 'corruption-package-'));
const [pack] = JSON.parse(
  execFileSync(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', fixture],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ),
);
const target = join(fixture, 'node_modules/react-corruption');
mkdirSync(target, { recursive: true });
execFileSync('tar', [
  '-xzf',
  join(fixture, pack.filename),
  '-C',
  target,
  '--strip-components=1',
]);
for (const dependency of ['react', 'react-dom', '@types']) {
  symlinkSync(
    realpathSync(join(root, 'node_modules', dependency)),
    join(fixture, 'node_modules', dependency),
    'dir',
  );
}
const code = `import { Corrupt, CorruptImage, CorruptVideo } from 'react-corruption';\nimport { CorruptionEngine } from 'react-corruption/core';\nvoid [Corrupt, CorruptImage, CorruptVideo, CorruptionEngine];\n`;
for (const extension of ['mts', 'cts']) {
  const file = join(fixture, `consumer.${extension}`);
  writeFileSync(file, code);
  execFileSync(
    process.execPath,
    [
      join(root, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--module',
      'Node16',
      '--moduleResolution',
      'Node16',
      '--target',
      'ES2020',
      file,
    ],
    { stdio: 'inherit' },
  );
  console.log(`${extension}: consumer types passed`);
}
const runtime = `import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import * as api from 'react-corruption';
import { CorruptionEngine } from 'react-corruption/core';
const cjs = createRequire(import.meta.url)('react-corruption');
assert.equal(typeof CorruptionEngine, 'function');
for (const name of ['Corrupt', 'CorruptImage', 'CorruptVideo']) assert.ok(api[name] && cjs[name]);
assert.ok(renderToString(createElement(api.CorruptVideo, {source:null})).includes('corrupt-video'));
assert.ok(renderToString(createElement(api.Corrupt, null, 'Hello')).includes('Hello'));
console.log('ESM, CommonJS, core, and server rendering passed');`;
writeFileSync(join(fixture, 'runtime.mjs'), runtime);
execFileSync(process.execPath, [join(fixture, 'runtime.mjs')], { stdio: 'inherit' });
assert.ok(pack.files.some(({ path }) => path === 'dist/styles.css'));
console.log(`Packed ${pack.entryCount} files; stylesheet included.`);
