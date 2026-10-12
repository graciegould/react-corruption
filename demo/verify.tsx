import { StrictMode, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Corrupt,
  CorruptImage,
  type CorruptHandle,
  type CorruptImageHandle,
  type CorruptTrigger,
} from 'react-corruption';
import 'react-corruption/styles.css';

const source = document.createElement('canvas');
source.width = 240;
source.height = 160;
const ctx = source.getContext('2d')!;
ctx.fillStyle = '#df6378';
ctx.fillRect(48, 32, 144, 96);
ctx.fillStyle = '#483fb3';
ctx.fillRect(80, 48, 64, 64);
const image = source.toDataURL();
ctx.fillStyle = '#ffe069';
ctx.fillRect(48, 32, 144, 96);
const replacement = source.toDataURL();

function Fixture() {
  const dom = useRef<CorruptHandle>(null);
  const img = useRef<CorruptImageHandle>(null);
  const [disabled, setDisabled] = useState(false);
  const [intensity, setIntensity] = useState(0.5);
  const [trigger, setTrigger] = useState<CorruptTrigger>('manual');
  const [blockSize, setBlockSize] = useState(8);
  const [src, setSrc] = useState(image);
  const [alpha, setAlpha] = useState<boolean | undefined>(undefined);
  const [clicks, setClicks] = useState(0);
  const [errors, setErrors] = useState(0);
  const [mounted, setMounted] = useState(true);
  const [content, setContent] = useState('Original content');
  const common = { disabled, intensity, trigger, options: { blockSize, alpha } };
  return (
    <main style={{ fontFamily: 'system-ui', padding: 20 }}>
      <div id="controls" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <label>
          Disabled
          <input
            type="checkbox"
            checked={disabled}
            onChange={(e) => setDisabled(e.target.checked)}
          />
        </label>
        <label>
          Intensity
          <input
            type="number"
            value={intensity}
            onChange={(e) => setIntensity(Number(e.target.value))}
          />
        </label>
        <label>
          Block size
          <input
            type="number"
            value={blockSize}
            onChange={(e) => setBlockSize(Number(e.target.value))}
          />
        </label>
        <label>
          Trigger
          <select
            aria-label="Trigger"
            value={trigger}
            onChange={(e) => setTrigger(e.target.value as CorruptTrigger)}
          >
            <option>hover</option>
            <option>click</option>
            <option>manual</option>
          </select>
        </label>
        <button onClick={() => dom.current?.corrupt()}>Corrupt content</button>
        <button onClick={() => img.current?.corrupt()}>Corrupt image</button>
        <button
          onClick={() => {
            dom.current?.reset();
            img.current?.reset();
          }}
        >
          Reset
        </button>
        <button
          onClick={() => {
            dom.current?.corrupt();
            dom.current?.reset();
            img.current?.corrupt();
            img.current?.reset();
          }}
        >
          Corrupt then reset
        </button>
        <button onClick={() => setSrc(replacement)}>Replace image</button>
        <button onClick={() => setSrc('/unavailable.png')}>Fail image</button>
        <button onClick={() => setSrc(image)}>Restore image</button>
        <button onClick={() => setAlpha((value) => !(value ?? true))}>
          Toggle alpha
        </button>
        <button onClick={() => setMounted((value) => !value)}>Toggle mount</button>
        <button onClick={() => setContent('Changed content')}>Change content</button>
        <button onClick={() => dom.current?.drift(1, 0, 0.6)}>Drift</button>
      </div>
      <p id="results">
        Clicks: {clicks}; errors: {errors}
      </p>
      {mounted && (
        <div style={{ display: 'flex', gap: 32, alignItems: 'center', marginTop: 30 }}>
          <section id="content">
            <Corrupt
              ref={dom}
              {...common}
              style={{ padding: 12, border: '3px solid #ddd' }}
            >
              <article style={{ padding: 24, width: 360, background: '#f4c5d5' }}>
                <h1>{content}</h1>
                <p>Readable text, even after distortion.</p>
                <button onClick={() => setClicks((value) => value + 1)}>
                  Real button
                </button>
              </article>
            </Corrupt>
          </section>
          <section id="image" style={{ width: 240 }}>
            <CorruptImage
              ref={img}
              src={src}
              alt="Transparent blocks"
              {...common}
              onError={() => setErrors((value) => value + 1)}
            />
          </section>
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
