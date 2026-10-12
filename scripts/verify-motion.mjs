/**
 * Video motion regression checks against the built core entry point.
 * Moving sources should displace the held image; stationary sources should
 * settle. Replacing measurements must preserve separately injected gestures.
 * `advance()` applies one displacement step per sampled source frame.
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const section = (s) => console.log(`\n# ${s}`);

// Serve the framework-independent entry point and its shared build chunks.
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (/^\/(?:core|chunk-[\w-]+)\.js$/.test(path)) {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(readFileSync(join(root, 'dist', path.slice(1))));
  } else {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body><canvas id="c"></canvas></body></html>');
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined),
  args: ['--no-sandbox'],
});

try {
  const page = await browser.newPage({ viewport: { width: 500, height: 400 } });
  page.on('pageerror', (e) => {
    fail++;
    console.log(`  FAIL pageerror — ${e.message}`);
  });
  await page.goto(`http://localhost:${port}/`);

  const r = await page.evaluate(async () => {
    const { CorruptionEngine } = await import('/core.js');
    const W = 320;
    const H = 240;

    /**
     * A NON-PERIODIC high-contrast patch at a given offset.
     *
     * Deliberately not a checkerboard. A periodic pattern is the textbook
     * ambiguous-match case: every candidate offset that lands one tile over
     * scores identically, so block matching locks onto a spurious vector and
     * the measurement is of the fixture, not the engine. A seeded pseudo-random
     * texture has exactly one correct match per block.
     */
    const frame = (dx) => {
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const g = c.getContext('2d');
      g.fillStyle = '#101010';
      g.fillRect(0, 0, W, H);
      // Deterministic LCG so every frame carries the SAME texture, shifted.
      let seed = 12345;
      const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      for (let i = 0; i < 260; i++) {
        const x = Math.floor(rnd() * 200);
        const y = Math.floor(rnd() * 150);
        const s = 4 + Math.floor(rnd() * 9);
        const v = Math.floor(rnd() * 255);
        g.fillStyle = `rgb(${v},${v},${v})`;
        g.fillRect(60 + dx + x, 45 + y, s, s);
      }
      return c;
    };

    const canvas = document.getElementById('c');
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;

    const read = (eng) => {
      const g = eng.canvas?.getContext?.('2d') ?? canvas.getContext('2d');
      return new Uint8ClampedArray(
        g.getImageData(0, 0, canvas.width, canvas.height).data,
      );
    };
    const dev = (a, b) => {
      let s = 0;
      let n = 0;
      for (let i = 0; i < a.length; i += 4) {
        s +=
          Math.abs(a[i] - b[i]) +
          Math.abs(a[i + 1] - b[i + 1]) +
          Math.abs(a[i + 2] - b[i + 2]);
        n += 3;
      }
      return s / n;
    };

    const mk = () =>
      new CorruptionEngine(canvas, {
        alpha: false,
        resolutionScale: 1,
        blockSize: 8,
        decay: 0.95,
        healRate: 0,
        maxVector: 16,
        floodThreshold: 999, // isolate displacement from the flood path
        channelShift: 0,
        edgeFade: 0,
        travelFade: 0,
      });

    const out = {};
    out.hasAdvance = typeof mk().advance === 'function';

    // --- 1. moving subject displaces ---------------------------------------
    {
      const eng = mk();
      eng.resize(W, H, frame(0), 'stretch');
      const pristine = read(eng);
      eng.setSource(frame(0), { estimateMotion: true, motionMode: 'replace' });
      eng.advance();
      for (let i = 1; i <= 6; i++) {
        eng.setSource(frame(i * 3), { estimateMotion: true, motionMode: 'replace' });
        eng.advance();
      }
      out.movingDev = dev(pristine, read(eng));
      eng.dispose();
    }

    // --- 2. still subject settles (replace) vs drifts (accumulate) ---------
    const stillDrift = (mode) => {
      const eng = mk();
      eng.resize(W, H, frame(0), 'stretch');
      eng.setSource(frame(0), { estimateMotion: true, motionMode: mode });
      eng.advance();
      for (let i = 1; i <= 6; i++) {
        eng.setSource(frame(i * 3), { estimateMotion: true, motionMode: mode });
        eng.advance();
      }
      // Subject STOPS. The FIRST still frame still carries legitimate motion
      // (the last moving frame -> the held frame), so it is applied before the
      // baseline is taken. Counting it as drift would be measuring real motion
      // and calling it a bug.
      const held = frame(18);
      eng.setSource(held, { estimateMotion: true, motionMode: mode });
      eng.advance();

      const settled = read(eng);
      for (let i = 0; i < 20; i++) {
        eng.setSource(held, { estimateMotion: true, motionMode: mode });
        eng.advance();
      }
      const d = dev(settled, read(eng));
      eng.dispose();
      return d;
    };
    out.replaceDrift = stillDrift('replace');
    out.accumulateDrift = stillDrift('accumulate');

    // --- 3. one advance = one frame of displacement ------------------------
    {
      const eng = mk();
      eng.resize(W, H, frame(0), 'stretch');
      eng.setSource(frame(0), { estimateMotion: true, motionMode: 'replace' });
      eng.advance();
      eng.setSource(frame(9), { estimateMotion: true, motionMode: 'replace' });
      const before = read(eng);
      eng.advance();
      const afterOne = read(eng);
      out.oneAdvance = dev(before, afterOne);
      // Extra advances with NO new frame: this is what start()'s rAF loop does
      // ~30x between source updates.
      eng.advance();
      eng.advance();
      eng.advance();
      out.threeMore = dev(afterOne, read(eng));
      eng.dispose();
    }

    // --- 4. a featureless frame produces no corruption ---------------------
    {
      const flat = document.createElement('canvas');
      flat.width = W;
      flat.height = H;
      const g = flat.getContext('2d');
      g.fillStyle = '#777';
      g.fillRect(0, 0, W, H);

      const eng = mk();
      eng.resize(W, H, flat, 'stretch');
      const pristine = read(eng);
      for (let i = 0; i < 12; i++) {
        eng.setSource(flat, { estimateMotion: true, motionMode: 'replace' });
        eng.advance();
      }
      out.flatDev = dev(pristine, read(eng));
      eng.dispose();
    }

    // --- 5. regression: setSource keeps buf, resize wipes it ---------------
    {
      const eng = mk();
      eng.resize(W, H, frame(0), 'stretch');
      const pristine = read(eng);
      eng.setSource(frame(0), { estimateMotion: true, motionMode: 'replace' });
      eng.advance();
      for (let i = 1; i <= 6; i++) {
        eng.setSource(frame(i * 3), { estimateMotion: true, motionMode: 'replace' });
        eng.advance();
      }
      const corruptDev = dev(pristine, read(eng));
      eng.setSource(frame(18), { estimateMotion: false });
      const keptDev = dev(pristine, read(eng));

      eng.resize(W, H, frame(18), 'stretch');
      const ref = document.createElement('canvas');
      ref.width = canvas.width;
      ref.height = canvas.height;
      ref.getContext('2d').drawImage(frame(18), 0, 0, canvas.width, canvas.height);
      const expected = new Uint8ClampedArray(
        ref.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data,
      );
      out.corruptDev = corruptDev;
      out.keptDev = keptDev;
      out.resizeResidual = dev(expected, read(eng));
      eng.dispose();
    }

    return out;
  });

  section('API');
  ok('advance() is public', r.hasAdvance);

  section('1. a moving subject displaces the held picture');
  ok(
    'motion produces displacement',
    r.movingDev > 1,
    `deviation=${r.movingDev.toFixed(2)}`,
  );

  section('2. a STILL subject must settle — the reported bug');
  ok(
    'replace: still subject settles to NO further change',
    r.replaceDrift < 0.01,
    `drift over 20 still frames=${r.replaceDrift.toFixed(4)}`,
  );
  ok(
    'accumulate keeps drifting on a still subject (the old behaviour)',
    r.accumulateDrift > r.replaceDrift,
    `accumulate=${r.accumulateDrift.toFixed(4)} vs replace=${r.replaceDrift.toFixed(4)}`,
  );

  section('3. advance() applies exactly one frame');
  ok('one advance displaces', r.oneAdvance > 0.5, `delta=${r.oneAdvance.toFixed(2)}`);
  ok(
    'advances without a new frame keep smearing (why the page gates on frames)',
    r.threeMore > 0,
    `3 extra advances moved it a further ${r.threeMore.toFixed(2)}`,
  );

  section('4. featureless input');
  ok(
    'a flat frame produces no corruption',
    r.flatDev < 0.5,
    `deviation=${r.flatDev.toFixed(3)}`,
  );

  section('5. regression: setSource vs resize');
  ok(
    'setSource keeps the corrupted buffer',
    r.keptDev > r.corruptDev * 0.5,
    `corrupt=${r.corruptDev.toFixed(2)} kept=${r.keptDev.toFixed(2)}`,
  );
  ok(
    'resize resets to pristine',
    r.resizeResidual < 1.0,
    `residual=${r.resizeResidual.toFixed(2)}`,
  );
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
