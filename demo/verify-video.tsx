import { StrictMode, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CorruptVideo, type CorruptVideoHandle } from 'react-corruption';
import 'react-corruption/styles.css';

function Fixture() {
  const [source, setSource] = useState<HTMLVideoElement | null>(null);
  const [paused, setPaused] = useState(false);
  const [original, setOriginal] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [mounted, setMounted] = useState(true);
  const [generation, setGeneration] = useState(0);
  const [ready, setReady] = useState(0);
  const [errors, setErrors] = useState(0);
  const [rate, setRate] = useState(8);
  const effect = useRef<CorruptVideoHandle>(null);
  return (
    <>
      <video
        key={generation}
        ref={setSource}
        src="/motion-sample.webm"
        autoPlay
        muted
        playsInline
        loop
        hidden
        onLoadedData={(e) => {
          void e.currentTarget.play();
        }}
      />
      <button onClick={() => setPaused(!paused)}>Freeze</button>
      <button onClick={() => setOriginal(!original)}>Compare</button>
      <button onClick={() => setDisabled(!disabled)}>Disable</button>
      <button onClick={() => effect.current?.corrupt()}>Corrupt</button>
      <button onClick={() => effect.current?.reset()}>Reset</button>
      <button onClick={() => setMounted(!mounted)}>Mount</button>
      <button onClick={() => setGeneration(generation + 1)}>Replace</button>
      <input
        aria-label="Rate"
        type="number"
        value={rate}
        onChange={(e) => setRate(Number(e.target.value))}
      />
      <p id="status">
        Ready {ready}; errors {errors}
      </p>
      {mounted && (
        <CorruptVideo
          ref={effect}
          source={source}
          paused={paused}
          showOriginal={original}
          disabled={disabled}
          sampleRate={rate}
          options={{ healRate: 0.08 }}
          onReady={() => setReady((n) => n + 1)}
          onError={() => setErrors((n) => n + 1)}
          style={{ width: 480, height: 270 }}
        />
      )}
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
