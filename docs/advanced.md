# Advanced control

Start with `intensity`, `trigger`, and `disabled`. Use these APIs when you need to
control the underlying effect more precisely.

## Override engine settings

Both React components accept `options`. Overrides are applied after the
content-specific intensity settings. Removing an override restores its default.
`disabled` and intensity `0` still turn the effect off.

```tsx
<Corrupt intensity={0.6} options={{ blockSize: 12, healRate: 0.12 }}>
  <h1>Chunkier text</h1>
</Corrupt>
```

| Option            | Meaning                                                            |
| ----------------- | ------------------------------------------------------------------ |
| `blockSize`       | Size of motion blocks in internal pixels. Larger is chunkier.      |
| `resolutionScale` | Buffer size relative to CSS size. Lower is faster and blockier.    |
| `decay`           | Motion retained each frame. Lower values settle faster.            |
| `healRate`        | Fraction blended back to the original each frame. `0` never heals. |
| `channelShift`    | Colour separation along moving edges.                              |
| `maxVector`       | Maximum displacement per block.                                    |
| `influenceRadius` | Pointer influence radius in internal pixels.                       |
| `force`           | Pointer movement strength.                                         |
| `floodThreshold`  | Motion threshold for blocks to flatten in colour.                  |
| `edgeFade`        | Transparency fade at the buffer boundary. `0` disables it.         |
| `travelFade`      | Fade displaced blocks by travel distance. `0` disables it.         |
| `alpha`           | Preserve transparency. Always enabled for DOM content.             |

React components rebuild their buffers when `blockSize` or `resolutionScale`
changes. This clears existing distortion. `CorruptImage` recreates its canvas if
`alpha` changes. The bare engine reads `alpha` only at construction.

## DOM capture

`Corrupt` additionally accepts:

| Prop           | Default | Meaning                                                     |
| -------------- | ------- | ----------------------------------------------------------- |
| `bleed`        | `0`     | Extra CSS pixels the effect can paint outside the content.  |
| `rasterScale`  | `1`     | DOM capture resolution multiplier.                          |
| `burstOnClick` | `true`  | Allow click bursts in hover mode. Also available on images. |
| `onError`      | —       | Capture failure callback; original content stays visible.   |

Add `data-corrupt-ignore` to a descendant to omit it from the captured image.
A same-origin nested canvas is captured as a still image. Embedded videos and
iframes are not captured as live content.

## Custom motion

The `CorruptHandle` also provides methods for custom motion:

```ts
effect.current?.drift(1, 0, 0.5); // direction and strength
effect.current?.explode(0.8); // outward from the centre
effect.current?.burst(120, 30, 0.6); // x, y, strength
effect.current?.shear(24, 40, 0.8, 1); // y, band height, strength, direction
effect.current?.isActive();
```

Coordinates and band sizes are CSS pixels relative to the content box. Strength
is normally `0–1`. Use `trigger="manual"` for external orchestration. Manual mode
ignores pointer input; drive methods prepare the raster before applying motion.

## Use the engine without React

The `/core` entry point contains no React imports:

```ts
import { CorruptionEngine } from 'react-corruption/core';

const engine = new CorruptionEngine(canvas, { blockSize: 12 });
engine.resize(cssWidth, cssHeight, loadedImage, 'cover');
engine.start();
engine.drift(1, 0, 0.5);
// On teardown:
engine.dispose();
```

Supported sources are images, canvases, videos, and ImageBitmaps. Wait for a source
to have real dimensions before seeding it. Fit is `'cover'` or `'stretch'`.

For live video, update the source without clearing accumulated distortion and
advance once per sampled video frame:

```ts
engine.resize(cssWidth, cssHeight, video, 'cover');
// Inside your video-frame loop:
engine.setSource(video, { estimateMotion: true, motionMode: 'replace' });
engine.advance();
```

Use `start()` for continuously animating a static source, or `advance()` for a
frame-driven source. `setSource` also accepts `fit` and `motionStrength`.
`motionMode: 'accumulate'` keeps adding estimated motion instead of replacing it.

`DEFAULT_OPTIONS`, `CorruptionOptions`, `CorruptionSource`, `SetSourceOptions`,
`rasterizeElement`, and `RasterizeResult` are available from `/core`. These exports are also available from the package root. The engine's `DEFAULT_OPTIONS` describe the bare engine,
not the content-specific React defaults.
