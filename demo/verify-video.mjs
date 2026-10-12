import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const base = process.env.DEMO_URL ?? 'http://localhost:5180/';
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? (existsSync(systemChrome) ? systemChrome : undefined),
});
let count = 0;
const check = (name, value) => {
  assert.ok(value, name);
  console.log(`ok ${++count} - ${name}`);
};
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.__paints = 0;
    const put = CanvasRenderingContext2D.prototype.putImageData;
    CanvasRenderingContext2D.prototype.putImageData = function (...args) {
      window.__paints++;
      return put.apply(this, args);
    };
  });
  await page.goto(new URL('verify-video.html', base).href);
  const ready = () => page.locator('.corrupt-video[data-ready="true"]').waitFor();
  const paints = () => page.evaluate(() => window.__paints);
  const hash = (selector = '.corrupt-video__canvas') =>
    page.locator(selector).evaluate((canvas) => {
      const bytes = canvas
        .getContext('2d')
        .getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 0;
      for (let i = 0; i < bytes.length; i += 4)
        hash = (hash * 31 + bytes[i] * 3 + bytes[i + 1] * 7 + bytes[i + 2]) % 2147483647;
      return hash;
    });
  const click = (name) => page.getByRole('button', { name, exact: true }).click();
  await ready();
  check('StrictMode renders a real first video frame', (await hash()) > 0);
  const first = await hash();
  await page.waitForTimeout(600);
  check('source motion updates the effect', first !== (await hash()));
  await click('Freeze');
  const frozen = await hash();
  const frozenOriginal = await hash('.corrupt-video__original');
  const beforeFreeze = await paints();
  await page.waitForTimeout(500);
  check(
    'freeze holds the effect and stops pixel processing',
    frozen === (await hash()) && beforeFreeze === (await paints()),
  );
  check(
    'freeze holds the matching original frame',
    frozenOriginal === (await hash('.corrupt-video__original')),
  );
  await click('Compare');
  check(
    'comparison displays the original',
    (await page.locator('.corrupt-video').getAttribute('data-original')) === 'true',
  );
  await click('Compare');
  check('comparison preserves accumulated effect', frozen === (await hash()));
  await click('Reset');
  check('reset restores the held source immediately', frozen !== (await hash()));
  await click('Freeze');
  await click('Disable');
  await page.waitForTimeout(100);
  const beforeDisabled = await paints();
  await page.waitForTimeout(500);
  check('disabled avoids engine pixel processing', beforeDisabled === (await paints()));
  check(
    'disabled shows the original',
    (await page.locator('.corrupt-video').getAttribute('data-original')) === 'true',
  );
  await click('Disable');
  await page.waitForTimeout(350);
  check('reenabling resumes video processing', (await paints()) > beforeDisabled);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(100);
  const beforeReduced = await paints();
  await page.waitForTimeout(400);
  check(
    'reduced motion shows original without processing the effect',
    beforeReduced === (await paints()) &&
      (await page.locator('.corrupt-video').getAttribute('data-original')) === 'true',
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => document.querySelector('video').pause());
  await page.waitForTimeout(100);
  const beforePause = await paints();
  await page.waitForTimeout(400);
  check('a paused source stops processing', beforePause === (await paints()));
  await page.evaluate(() => document.querySelector('video').play());
  await page.waitForTimeout(300);
  check('playing the source resumes processing', (await paints()) > beforePause);
  await page.getByLabel('Rate').fill('1');
  await page.waitForTimeout(200);
  const beforeRate = await paints();
  await page.waitForTimeout(1100);
  check('sample rate limits source processing', (await paints()) - beforeRate <= 4);
  await click('Replace');
  await ready();
  check(
    'source replacement prepares fresh frames',
    (await page.locator('#status').innerText()).includes('Ready 2'),
  );
  await click('Mount');
  const beforeUnmount = await paints();
  await page.waitForTimeout(400);
  check('unmount cancels processing', beforeUnmount === (await paints()));
  await click('Mount');
  await ready();
  check('remount prepares a usable source', (await hash()) > 0);
  check(
    'no runtime or effect errors',
    errors.length === 0 &&
      (await page.locator('#status').innerText()).includes('errors 0'),
  );
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Video', exact: true }).click();
  await ready();
  check(
    'playground exposes the video example and its code',
    (await page.locator('pre').innerText()).includes('CorruptVideo'),
  );
  console.log(`\n${count} video checks passed.`);
} finally {
  await browser.close();
}
