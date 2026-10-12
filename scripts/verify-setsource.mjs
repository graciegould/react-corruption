/**
 * verify-setsource.mjs — browser verification of `setSource` + motion estimation.
 *
 * The claim under test is narrow and mechanical: `setSource` must replace the
 * pristine heal target WITHOUT resetting the compounding buffer, where `resize`
 * resets it. That difference is the entire feature, so it is measured directly
 * rather than inferred from how the canvas looks.
 *
 * Run: CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *      node scripts/verify-setsource.mjs
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

  const imports = await page.evaluate(
    async () => typeof (await import('/core.js')).CorruptionEngine === 'function',
  );
  ok('core imports in the browser without React', imports);

  // ---- real test: drive the public loop with rAF ------------------------
  section('setSource preserves accumulated corruption, resize resets it');
  const main = await page.evaluate(async () => {
    const { CorruptionEngine } = await import('/core.js');

    const makeSrc = (shift) => {
      const c = document.createElement('canvas');
      c.width = 240;
      c.height = 200;
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, 240, 200);
      g.fillStyle = '#000';
      for (let y = 0; y < 200; y += 40) {
        for (let x = 0; x < 240; x += 40) {
          g.fillRect((x + shift) % 240, y, 22, 22);
        }
      }
      g.fillStyle = '#c00';
      g.fillRect(20 + shift, 90, 60, 20);
      return c;
    };

    const frames = (n) =>
      new Promise((res) => {
        let i = 0;
        const t = () => (++i >= n ? res() : requestAnimationFrame(t));
        requestAnimationFrame(t);
      });

    const canvas = document.getElementById('c');
    canvas.style.width = '400px';
    canvas.style.height = '300px';
    const ctx = canvas.getContext('2d');
    const grab = () =>
      Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
    const dev = (a, b) => {
      let s = 0;
      for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]);
      return s / (a.length / 4);
    };

    const srcA = makeSrc(0);
    const srcB = makeSrc(12);
    const o = {};

    // healRate 0 → no healing at all, so any deviation is pure accumulation.
    const eng = new CorruptionEngine(canvas, {
      healRate: 0,
      resolutionScale: 1,
      maxVector: 16,
      blockSize: 10,
    });
    eng.resize(400, 300, srcA, 'stretch');
    const pristine = grab();

    eng.start();
    eng.explode(1);
    await frames(14);
    const corrupted = grab();
    o.corruptionBuilt = dev(pristine, corrupted);

    // setSource: swap the heal target. buf must survive.
    eng.setSource(srcB, { fit: 'stretch' });
    const afterSetSource = grab();
    o.devAfterSetSource = dev(corrupted, afterSetSource);
    o.stillCorruptAfterSetSource = dev(pristine, afterSetSource);

    // Establish what a CLEAN frame of srcB actually looks like, so "did resize
    // reset" is measured against the right baseline. Comparing against
    // pristine-A would instead measure how much A and B differ as images.
    const ref = new CorruptionEngine(document.createElement('canvas'), {
      healRate: 0,
      resolutionScale: 1,
    });
    const refCanvas = ref['canvas'] ?? null;
    eng.stop();
    eng.resize(400, 300, srcB, 'stretch');
    const afterResize = grab();
    // Clean render of B from the same engine, for an exact baseline.
    eng.reset();
    eng.renderStatic();
    const pristineB = grab();
    o.resizeResidual = dev(pristineB, afterResize);
    o.setSourceResidual = dev(pristineB, afterSetSource);
    ref.dispose();
    void refCanvas;

    eng.stop();
    eng.dispose();
    return o;
  });

  ok(
    'corruption accumulates with healRate=0',
    main.corruptionBuilt > 5,
    `meanDev=${main.corruptionBuilt.toFixed(2)}`,
  );
  ok(
    'setSource leaves the corrupted buffer essentially untouched',
    main.devAfterSetSource < 1.0,
    `delta=${main.devAfterSetSource.toFixed(3)} (want ~0)`,
  );
  ok(
    'image is still corrupt after setSource (not reset)',
    main.stillCorruptAfterSetSource > 5,
    `meanDev=${main.stillCorruptAfterSetSource.toFixed(2)}`,
  );
  ok(
    'resize DOES reset to a clean frame of the new image',
    main.resizeResidual < 1.0,
    `residual vs pristine-B = ${main.resizeResidual.toFixed(3)} (want ~0)`,
  );
  ok(
    'setSource does NOT reset — the contrast that proves the feature',
    main.setSourceResidual > main.resizeResidual + 10,
    `setSource residual=${main.setSourceResidual.toFixed(2)} vs resize residual=${main.resizeResidual.toFixed(2)}`,
  );

  // ---- healing re-points at the NEW image -------------------------------
  section('healing converges toward the image given to setSource');
  const heal = await page.evaluate(async () => {
    const { CorruptionEngine } = await import('/core.js');
    const solid = (color) => {
      const c = document.createElement('canvas');
      c.width = 240;
      c.height = 200;
      const g = c.getContext('2d');
      g.fillStyle = color;
      g.fillRect(0, 0, 240, 200);
      g.fillStyle = '#000';
      for (let y = 0; y < 200; y += 40)
        for (let x = 0; x < 240; x += 40) g.fillRect(x, y, 20, 20);
      return c;
    };
    const frames = (n) =>
      new Promise((res) => {
        let i = 0;
        const t = () => (++i >= n ? res() : requestAnimationFrame(t));
        requestAnimationFrame(t);
      });

    const canvas = document.getElementById('c');
    const ctx = canvas.getContext('2d');
    const meanG = () => {
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let s = 0;
      for (let i = 1; i < d.length; i += 4) s += d[i];
      return s / (d.length / 4);
    };

    // Source A is red-ish (low green). Source B is green-ish (high green).
    const eng = new CorruptionEngine(canvas, { healRate: 0.25, resolutionScale: 1 });
    eng.resize(400, 300, solid('#cc2222'), 'stretch');
    eng.start();
    await frames(6);
    const gBefore = meanG();

    eng.setSource(solid('#22cc22'), { fit: 'stretch' });
    await frames(40);
    const gAfter = meanG();

    eng.stop();
    eng.dispose();
    return { gBefore, gAfter };
  });

  ok(
    'mean green rises as healing pulls toward the new source',
    heal.gAfter > heal.gBefore + 20,
    `green ${heal.gBefore.toFixed(1)} → ${heal.gAfter.toFixed(1)}`,
  );

  // ---- motion estimation produces vectors from real movement ------------
  section('estimateMotion derives vectors from frame-to-frame movement');
  const motion = await page.evaluate(async () => {
    const { CorruptionEngine } = await import('/core.js');
    const bars = (shift) => {
      const c = document.createElement('canvas');
      c.width = 240;
      c.height = 200;
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, 240, 200);
      g.fillStyle = '#000';
      for (let x = -40; x < 280; x += 40) g.fillRect(x + shift, 0, 20, 200);
      return c;
    };
    const frames = (n) =>
      new Promise((res) => {
        let i = 0;
        const t = () => (++i >= n ? res() : requestAnimationFrame(t));
        requestAnimationFrame(t);
      });

    const canvas = document.getElementById('c');
    const ctx = canvas.getContext('2d');
    const grab = () =>
      Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
    const dev = (a, b) => {
      let s = 0;
      for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]);
      return s / (a.length / 4);
    };

    // No pointer, no explode: ALL motion must come from estimation.
    const eng = new CorruptionEngine(canvas, {
      healRate: 0,
      resolutionScale: 1,
      blockSize: 10,
      maxVector: 18,
    });
    eng.resize(400, 300, bars(0), 'stretch');
    const pristine = grab();
    eng.start();

    // Walk the bars sideways, estimating motion each step.
    for (let i = 1; i <= 10; i++) {
      eng.setSource(bars(i * 3), {
        fit: 'stretch',
        estimateMotion: true,
        motionStrength: 1,
      });
      await frames(2);
    }
    const corrupted = grab();
    // Only one engine may paint this shared canvas at a time.
    eng.stop();

    // Control: identical frames, so estimation should find no motion.
    const eng2 = new CorruptionEngine(canvas, {
      healRate: 0,
      resolutionScale: 1,
      blockSize: 10,
      maxVector: 18,
    });
    eng2.resize(400, 300, bars(0), 'stretch');
    const p2 = grab();
    eng2.start();
    for (let i = 0; i < 10; i++) {
      eng2.setSource(bars(0), {
        fit: 'stretch',
        estimateMotion: true,
        motionStrength: 1,
      });
      await frames(2);
    }
    const still = grab();

    eng.stop();
    eng.dispose();
    eng2.stop();
    eng2.dispose();
    return { moved: dev(pristine, corrupted), unmoved: dev(p2, still) };
  });

  ok(
    'moving content corrupts with NO pointer input at all',
    motion.moved > 4,
    `meanDev=${motion.moved.toFixed(2)}`,
  );
  ok(
    'identical frames produce (almost) no corruption — no phantom vectors',
    motion.unmoved < Math.max(1.5, motion.moved / 4),
    `stillDev=${motion.unmoved.toFixed(2)} vs movedDev=${motion.moved.toFixed(2)}`,
  );

  // ---- robustness -------------------------------------------------------
  section('robustness');
  const robust = await page.evaluate(async () => {
    const { CorruptionEngine } = await import('/core.js');
    const canvas = document.getElementById('c');
    const o = {};

    const eng = new CorruptionEngine(canvas, { resolutionScale: 1 });
    const src = document.createElement('canvas');
    src.width = 100;
    src.height = 80;
    src.getContext('2d').fillRect(0, 0, 50, 40);

    // setSource before any resize must be a safe no-op, not a crash.
    o.beforeResize = eng.setSource(src);

    eng.resize(300, 200, src, 'stretch');
    o.afterResize = eng.setSource(src);

    // A zero-size source (a video with no metadata yet) must return false.
    const empty = document.createElement('canvas');
    empty.width = 0;
    empty.height = 0;
    o.zeroSize = eng.setSource(empty);

    // Still functional afterwards.
    o.recovers = eng.setSource(src);

    eng.dispose();
    o.afterDispose = eng.setSource(src);
    return o;
  });

  ok(
    'setSource before resize returns false (no crash)',
    robust.beforeResize === false,
    `=${robust.beforeResize}`,
  );
  ok(
    'setSource after resize returns true',
    robust.afterResize === true,
    `=${robust.afterResize}`,
  );
  ok('zero-size source returns false', robust.zeroSize === false, `=${robust.zeroSize}`);
  ok(
    'engine still works after a rejected source',
    robust.recovers === true,
    `=${robust.recovers}`,
  );
  ok(
    'setSource after dispose returns false',
    robust.afterDispose === false,
    `=${robust.afterDispose}`,
  );
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('SOME CHECKS FAILED');
  process.exitCode = 1;
}
