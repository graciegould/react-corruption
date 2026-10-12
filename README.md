# react-corruption

<p align="center">
  <img src="https://raw.githubusercontent.com/graciegould/react-corruption/main/assets/corrupt-sunflower.png" alt="A sunflower breaking apart into glitched, channel-split pixels" width="360" />
</p>

Interactive pixel corruption for React. Wrap some content, move your pointer over it,
and watch it distort. Move away to restore the original.

## Get started

```bash
npm install react-corruption
# or: pnpm add react-corruption
# or: yarn add react-corruption
```

```tsx
import { Corrupt } from 'react-corruption';
import 'react-corruption/styles.css';

export function Heading() {
  return (
    <Corrupt>
      <h1>Make some noise.</h1>
    </Corrupt>
  );
}
```

Import the stylesheet once in your app. No other setup or configuration is needed.
React 18 and later are supported. In an app with React Server Components, use these
components inside a client component (`'use client'`).

## Choose the strength and trigger

Both components accept the same everyday controls:

| Prop        | Default   | What it does                                        |
| ----------- | --------- | --------------------------------------------------- |
| `intensity` | `0.5`     | Strength from `0` to `1`. `0` turns the effect off. |
| `trigger`   | `'hover'` | `'hover'`, `'click'`, or `'manual'`.                |
| `disabled`  | `false`   | Stops the effect and shows the original content.    |

```tsx
<Corrupt intensity={0.7} trigger="click">
  <h1>Click or tap to distort</h1>
</Corrupt>
```

Hover mode follows pointer movement and also bursts on click or tap. Click mode
plays a burst and lets the content recover; moving the pointer does nothing.
Manual mode responds only to its ref. Keyboard activation of a button inside a
click-triggered wrapper also triggers the effect; the wrapper does not add a tab stop.
Focused keyboard controls remain visible.

The wrapper uses settings suited to text and UI. Higher intensity increases
movement and colour separation and slows recovery. Values outside `0–1` are clamped.

## Use an image

```tsx
import { CorruptImage } from 'react-corruption';
import 'react-corruption/styles.css';

<CorruptImage src="/flower.png" alt="A flower" intensity={0.6} />;
```

Images preserve transparency by default and use their natural aspect ratio. Set a
container's width and height to create a frame; the image covers that frame.
Optional `width` and `height` props reserve space while loading. The original image
stays visible while the effect loads, when the effect is off, or if the effect fails.

Use a same-origin image or an image server with CORS enabled. A remote image may be
displayable as an ordinary image but unavailable for pixel effects without CORS.

## Use a video or camera stream

`CorruptVideo` samples a playing video and uses its motion to drive the effect.
Your app owns the video element, playback, and any camera permission request.

```tsx
import { useState } from 'react';
import { CorruptVideo } from 'react-corruption';
import 'react-corruption/styles.css';

export function VideoEffect() {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  return (
    <>
      <video
        ref={setVideo}
        src="/clip.webm"
        autoPlay
        loop
        muted
        playsInline
        hidden
        onLoadedData={(event) => {
          void event.currentTarget.play();
        }}
      />
      <CorruptVideo
        source={video}
        intensity={0.5}
        sampleRate={8}
        style={{ width: '100%', height: 'auto', aspectRatio: '16 / 9' }}
      />
    </>
  );
}
```

Handle rejected `play()` promises in your app and offer a Play button if autoplay is blocked.
For a webcam, pass a playing video whose `srcObject` is your camera stream.
Stop the stream's tracks when your app finishes using it. The component does not
request camera access, change playback, or stop a source owned by your app.

- `sampleRate`: processed source frames per second, 1–60 (default 8).
- `paused`: freeze the effect and its matching original frame.
- `showOriginal`: compare the original without clearing the effect.
- `interactive`: pointer smearing and click bursts (default `true`).
- `fit`: `'cover'` (default) or `'stretch'`.
- `warmupMs`: refresh the initial image as exposure settles; use `1000` for a camera.
- `onReady` and `onError`: source readiness and effect failure callbacks.

`intensity`, `disabled`, `options`, `className`, and `style` work here too.
A `CorruptVideoHandle` ref provides `corrupt()` and `reset()`. There is no `trigger`
prop: video motion drives the effect. Zero intensity, `disabled`, or reduced motion
shows the original video. `paused` also freezes that original. A failed effect falls
back to original frames; the app remains responsible for media loading errors.
Use a same-origin video or a CORS-enabled source with `crossOrigin="anonymous"`.
Effects pause offscreen, in hidden tabs, and when the source stops playing.

## Trigger it from your code

```tsx
import { useRef } from 'react';
import { Corrupt, type CorruptHandle } from 'react-corruption';
import 'react-corruption/styles.css';

export function Example() {
  const effect = useRef<CorruptHandle>(null);

  return (
    <>
      <Corrupt ref={effect} trigger="manual">
        <h1>Make some noise.</h1>
      </Corrupt>
      <button onClick={() => effect.current?.corrupt()}>Corrupt</button>
      <button onClick={() => effect.current?.reset()}>Reset</button>
    </>
  );
}
```

`corrupt()` prepares the content if needed and plays a burst. `reset()` immediately
restores it. `CorruptImage` supports the same two methods through
`CorruptImageHandle`. Both methods respect `disabled`, zero intensity, and reduced
motion preferences.

## Styling and fallback

Both components accept `className` and `style`. Style the children to control the
appearance of captured content. `Corrupt` adds a wrapper that fits its content;
use `style={{ display: 'block', width: '100%' }}` when it should fill a row.

```tsx
<Corrupt onError={(error) => console.warn(error)}>
  <article>My content</article>
</Corrupt>
```

Reduced motion preferences disable animation automatically, including changes made
while the page is open. Settled static effects sleep until the next interaction. Effects pause offscreen and in hidden tabs. Content remains
in the DOM; the decorative overlay does not intercept clicks.

DOM capture works best with text and simple UI. It is a snapshot, not a continuous
recording: animated content, pseudo-elements, embedded video, iframes, and external
fonts/backgrounds may not reproduce faithfully. Put standalone images through
`CorruptImage`. Use the engine for video. The effect runs on the main thread, so
keep large animated surfaces to a minimum.

## Need more control?

- [Advanced options and methods](docs/advanced.md): engine overrides, bleed,
  capture resolution, and custom motion.
- [How it works](docs/how-it-works.md): pixel feedback and DOM capture.

## Playground and development

```bash
pnpm install
pnpm demo         # build and start the playground server at localhost:5180
pnpm dev          # rebuild the package as source files change
pnpm demo:dev     # serve an existing build
```

Scroll through the Text, Article, Images, Form, and Webcam sections, adjust each
section's controls, and copy the resulting React code. The playground consumes the
built package, including its stylesheet.

```bash
pnpm verify      # types, lint, and formatting
pnpm build
pnpm test:browser # with the playground server running
pnpm test:engine  # source updates and video motion regression checks
pnpm test:video   # video lifecycle, comparison, and playground checks
pnpm test:package # packed ESM/CommonJS types and server rendering
```

Browser checks use Playwright's Chromium, or the browser specified by `CHROME_PATH`.
On macOS they also look for the standard Google Chrome installation. The fixtures
exercise the built package, interactions, advanced controls, fallback,
transparency, and changes to reduced motion preferences.

## Licence

MIT © Gracie Gould
