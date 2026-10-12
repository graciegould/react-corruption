/** Browser contracts against the built package, plus the consumer playground. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const base = process.env.DEMO_URL ?? 'http://localhost:5180/';
const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? (existsSync(systemChrome) ? systemChrome : undefined),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
let count = 0;
const check = (name, condition) => {
  assert.ok(condition, name);
  console.log(`ok ${++count} - ${name}`);
};
const hash = (selector) =>
  page.locator(selector).evaluate((canvas) => {
    const data = canvas
      .getContext('2d')
      .getImageData(0, 0, canvas.width, canvas.height).data;
    let value = 0;
    let transparent = 0;
    for (let i = 0; i < data.length; i += 4) {
      value =
        (value * 31 + data[i] + data[i + 1] * 3 + data[i + 2] * 7 + data[i + 3] * 11) %
        2147483647;
      if (data[i + 3] === 0) transparent++;
    }
    return { value, transparent, width: canvas.width, height: canvas.height };
  });
const click = (name) => page.getByRole('button', { name, exact: true }).click();
const moveAcross = async (selector) => {
  const box = await page.locator(selector).boundingBox();
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.waitForTimeout(120);
  for (let i = 1; i <= 15; i++) {
    await page.mouse.move(
      box.x + 10 + ((box.width - 20) * i) / 15,
      box.y + box.height / 2,
    );
    await page.waitForTimeout(16);
  }
};
const waitForImage = () =>
  page.waitForFunction(() =>
    document.querySelector('#image .corrupt-image')?.classList.contains('is-ready'),
  );

try {
  await page.goto(base, { waitUntil: 'networkidle' });
  check(
    'playground starts with text and advanced controls collapsed',
    (await page
      .getByRole('button', { name: 'Text', exact: true })
      .getAttribute('aria-pressed')) === 'true' &&
      !(await page.locator('details').getAttribute('open')),
  );
  await moveAcross('.demo__stage .corrupt');
  check(
    'zero-config text produces real pixels',
    (await hash('.corrupt canvas')).transparent <
      (await hash('.corrupt canvas')).width * (await hash('.corrupt canvas')).height,
  );
  await page.getByLabel('Trigger', { exact: true }).selectOption('manual');
  await page.waitForTimeout(150);
  await click('Corrupt');
  await page.waitForTimeout(80);
  check(
    'generated code includes the manual handle',
    (await page.locator('pre').innerText()).includes('effect.current?.corrupt()'),
  );
  await click('Image');
  await page.waitForFunction(() =>
    document.querySelector('.corrupt-image')?.classList.contains('is-ready'),
  );
  const imageBox = await page.locator('.corrupt-image').boundingBox();
  check(
    'image sizes itself to its source aspect ratio',
    Math.abs(imageBox.width / imageBox.height - 393 / 291) < 0.03,
  );
  await click('Card');
  await click('Still a real button');
  check(
    'card button remains interactive',
    await page.getByText('Button clicks: 1').isVisible(),
  );
  await page.locator('summary').click();
  await page.getByRole('spinbutton', { name: 'Maximum displacement' }).fill('3');
  check(
    'code reflects advanced overrides',
    (await page.locator('pre').innerText()).includes('"maxVector":3'),
  );
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await click('Copy code');
  check(
    'copy button copies the current example',
    (await page.evaluate(() => window.navigator.clipboard.readText())) ===
      (await page.locator('pre').innerText()),
  );
  await click('Clear overrides');
  check(
    'clearing overrides removes them from the example',
    !(await page.locator('pre').innerText()).includes('options='),
  );
  mkdirSync('/tmp/corruption-demo', { recursive: true });
  await page.screenshot({
    path: '/tmp/corruption-demo/playground-desktop.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  check(
    'playground fits a mobile viewport',
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  );
  await page.screenshot({
    path: '/tmp/corruption-demo/playground-mobile.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 1000 });

  await page.addInitScript(() => {
    window.__idlePaints = 0;
    const put = CanvasRenderingContext2D.prototype.putImageData;
    CanvasRenderingContext2D.prototype.putImageData = function (...args) {
      window.__idlePaints++;
      return put.apply(this, args);
    };
  });
  await page.goto(new URL('verify.html', base).href, { waitUntil: 'networkidle' });
  await waitForImage();
  await page.waitForTimeout(200);
  const idlePaints = await page.evaluate(() => window.__idlePaints);
  await page.waitForTimeout(400);
  check(
    'idle images and manual content do not process pixels',
    idlePaints === (await page.evaluate(() => window.__idlePaints)),
  );
  const domCanvas = '#content canvas';
  const imageCanvas = '#image canvas';
  const pristine = await hash(domCanvas);
  check(
    'StrictMode captures real DOM pixels',
    pristine.transparent < pristine.width * pristine.height,
  );
  check(
    'overlay aligns with content inside padded wrappers',
    await page.locator('#content').evaluate((host) => {
      const content = host.querySelector('.corrupt__content').getBoundingClientRect();
      const canvas = host.querySelector('canvas').getBoundingClientRect();
      return ['x', 'y', 'width', 'height'].every(
        (key) => Math.abs(content[key] - canvas[key]) < 1,
      );
    }),
  );
  const transparent = await hash(imageCanvas);
  check(
    'images preserve transparent pixels by default',
    transparent.transparent > 5000 &&
      transparent.transparent < transparent.width * transparent.height,
  );
  await moveAcross('#content .corrupt');
  await page.locator('#content h1').click();
  check(
    'manual content ignores pointer movement and clicks',
    (await hash(domCanvas)).value === pristine.value,
  );
  await moveAcross('#image .corrupt-image');
  await page.locator('#image img').click();
  check(
    'manual images ignore pointer movement and clicks',
    (await hash(imageCanvas)).value === transparent.value,
  );
  await click('Corrupt content');
  await page.waitForTimeout(80);
  check(
    'corrupt changes rendered DOM pixels',
    (await hash(domCanvas)).value !== pristine.value,
  );
  await click('Reset');
  check(
    'reset immediately shows original DOM',
    await page
      .locator('#content .corrupt__content')
      .evaluate((el) => getComputedStyle(el).opacity === '1'),
  );
  await click('Corrupt then reset');
  await page.waitForTimeout(150);
  check(
    'reset cancels a pending capture or burst',
    await page
      .locator('#content .corrupt__content')
      .evaluate((el) => getComputedStyle(el).opacity === '1'),
  );
  await click('Corrupt image');
  await page.waitForTimeout(80);
  check(
    'image corrupt changes pixels',
    (await hash(imageCanvas)).value !== transparent.value,
  );
  await page.getByLabel('Disabled', { exact: true }).check();
  check(
    'disabled restores both originals immediately',
    (await page
      .locator('#content .corrupt__content')
      .evaluate((el) => getComputedStyle(el).opacity === '1')) &&
      (await page
        .locator('#image img')
        .evaluate((el) => getComputedStyle(el).opacity === '1')),
  );
  await click('Corrupt content');
  await click('Corrupt image');
  await page.waitForTimeout(100);
  check(
    'disabled prevents manual effects',
    await page
      .locator('#content .corrupt__content')
      .evaluate((el) => getComputedStyle(el).opacity === '1'),
  );
  await page.getByLabel('Disabled', { exact: true }).uncheck();
  await waitForImage();
  await page.getByLabel('Intensity', { exact: true }).fill('0');
  await click('Corrupt content');
  check(
    'zero intensity disables the effect',
    await page
      .locator('#content .corrupt__content')
      .evaluate((el) => getComputedStyle(el).opacity === '1'),
  );
  await page.getByLabel('Intensity', { exact: true }).fill('0.5');
  await waitForImage();
  await page.getByLabel('Trigger', { exact: true }).selectOption('click');
  const beforeClick = await hash(domCanvas);
  await moveAcross('#content .corrupt');
  check(
    'click trigger ignores pointer motion',
    (await hash(domCanvas)).value === beforeClick.value,
  );
  await page.locator('#content h1').click();
  await page.waitForTimeout(80);
  check(
    'click trigger plays a burst',
    (await hash(domCanvas)).value !== beforeClick.value,
  );
  await click('Real button');
  check(
    'DOM button still receives clicks while corrupting',
    (await page.locator('#results').innerText()).includes('Clicks: 1'),
  );
  await page.getByLabel('Trigger', { exact: true }).selectOption('hover');
  await moveAcross('#content .corrupt');
  check(
    'hover trigger activates',
    await page
      .locator('#content .corrupt')
      .evaluate((el) => el.classList.contains('is-corrupting')),
  );
  await page.mouse.move(0, 0);
  check(
    'pointer leave restores the original',
    await page
      .locator('#content .corrupt__content')
      .evaluate((el) => getComputedStyle(el).opacity === '1'),
  );
  await page.getByLabel('Trigger', { exact: true }).selectOption('manual');
  await page.getByLabel('Block size', { exact: true }).fill('16');
  await click('Corrupt content');
  await click('Corrupt image');
  await page.waitForTimeout(100);
  check(
    'grid options can change while mounted',
    (await hash(domCanvas)).width > 0 && (await hash(imageCanvas)).width > 0,
  );
  await click('Reset');
  await page.getByLabel('Intensity', { exact: true }).fill('1');
  await click('Corrupt content');
  await page.waitForFunction(
    () => !document.querySelector('#content .corrupt')?.classList.contains('is-quiet'),
  );
  await page.waitForFunction(
    () => document.querySelector('#content .corrupt')?.classList.contains('is-quiet'),
    null,
    { timeout: 12000 },
  );
  check(
    'maximum intensity still settles back to readable content',
    await page
      .locator('#content .corrupt__content')
      .evaluate((el) => getComputedStyle(el).opacity === '1'),
  );
  const settledPaints = await page.evaluate(() => window.__idlePaints);
  await page.waitForTimeout(300);
  check(
    'settled effects stop pixel writes',
    settledPaints === (await page.evaluate(() => window.__idlePaints)),
  );
  await page.getByLabel('Intensity', { exact: true }).fill('0.5');
  await click('Replace image');
  await waitForImage();
  check(
    'changing src displays fresh pixels',
    (await hash(imageCanvas)).value !== transparent.value,
  );
  await click('Toggle alpha');
  await waitForImage();
  check(
    'alpha changes recreate the image context',
    (await hash(imageCanvas)).transparent === 0,
  );
  await click('Toggle alpha');
  await waitForImage();
  check(
    'transparency can be restored at runtime',
    (await hash(imageCanvas)).transparent > 0,
  );
  await click('Corrupt content');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(100);
  check(
    'live reduced-motion changes restore original content',
    (await page
      .locator('#content .corrupt__content')
      .evaluate((el) => getComputedStyle(el).opacity === '1')) &&
      (await page
        .locator('#image img')
        .evaluate((el) => getComputedStyle(el).opacity === '1')),
  );
  await click('Corrupt content');
  check(
    'reduced motion ignores manual requests',
    await page
      .locator('#content .corrupt__content')
      .evaluate((el) => getComputedStyle(el).opacity === '1'),
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await waitForImage();
  await click('Drift');
  await page.waitForTimeout(80);
  check(
    'advanced ref methods work',
    await page
      .locator('#content .corrupt')
      .evaluate((el) => el.classList.contains('is-corrupting')),
  );
  await click('Change content');
  await page.waitForTimeout(100);
  check(
    'updated content remains available',
    (await page.getByRole('heading', { name: 'Changed content' }).count()) === 1,
  );
  await page.route('**/unavailable.png', (route) => route.abort());
  await click('Fail image');
  await page.waitForFunction(() =>
    /errors: [1-9]/.test(document.querySelector('#results').textContent),
  );
  check(
    'failed effect exposes onError and leaves the original img visible',
    await page
      .locator('#image img')
      .evaluate((el) => getComputedStyle(el).opacity === '1'),
  );
  await click('Restore image');
  await waitForImage();
  check(
    'a valid src recovers after a failure',
    (await hash(imageCanvas)).transparent > 0,
  );
  await click('Toggle mount');
  await click('Toggle mount');
  await waitForImage();
  check(
    'unmount and remount recover cleanly',
    (await page.locator('#content canvas').count()) === 1,
  );
  check('no browser runtime errors', errors.length === 0);
  await page.screenshot({ path: '/tmp/corruption-demo/fixtures.png', fullPage: true });
  console.log(`\n${count} browser checks passed.`);
} finally {
  await browser.close();
}
