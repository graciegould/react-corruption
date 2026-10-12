import { useEffect, useRef, useState } from 'react';
import { CorruptVideo, type CorruptVideoHandle } from 'react-corruption';

type Mode = 'flowers' | 'webcam';

/** A pre-rendered clip of three flowers each spinning in place, in demo/public. */
const FLOWERS_SRC = '/flowers.mp4';

export function VideoExample() {
  const [source, setSource] = useState<HTMLVideoElement | null>(null);
  const [mode, setMode] = useState<Mode>('flowers');
  const [paused, setPaused] = useState(false);
  const [original, setOriginal] = useState(false);
  const [intensity, setIntensity] = useState(0.5);
  const [rate, setRate] = useState(8);
  const [blockSize, setBlockSize] = useState(8);
  const [healRate, setHealRate] = useState(0.25);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [copied, setCopied] = useState(false);
  const effect = useRef<CorruptVideoHandle>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Stop the camera when leaving webcam mode or unmounting. The library never
  // touches the stream — the app owns camera lifecycle.
  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };
  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, []);

  // Default source: the pre-rendered spinning-flowers clip. Point the <video>
  // at the file and loop it; CorruptVideo samples it like any other source.
  useEffect(() => {
    if (mode !== 'flowers' || !source) return;
    source.srcObject = null;
    source.src = FLOWERS_SRC;
    source.loop = true;
    source.load();
    void source.play().catch(() => setError('Press Play to start the flowers.'));
  }, [mode, source]);

  const useFlowers = () => {
    stopCamera();
    setMode('flowers');
    setError('');
    // The effect above (keyed on mode) points the video at the flowers clip.
  };

  const enableCamera = async () => {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      streamRef.current = stream;
      if (source) {
        source.srcObject = stream;
        source.removeAttribute('src');
        await source.play();
      }
      setMode('webcam');
    } catch {
      setError('Camera access was blocked. Allow it in your browser, then retry.');
    }
  };

  const webcamCode = `import { useEffect, useRef, useState } from 'react';
import { CorruptVideo } from 'react-corruption';
import 'react-corruption/styles.css';

export function WebcamEffect() {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Your app owns the camera. Request it, feed the stream to a <video>,
  // then hand that video to CorruptVideo. Stop the tracks on cleanup.
  useEffect(() => {
    let cancelled = false;
    navigator.mediaDevices.getUserMedia({ video: true }).then((stream) => {
      if (cancelled) return stream.getTracks().forEach((t) => t.stop());
      streamRef.current = stream;
      if (video) { video.srcObject = stream; void video.play(); }
    });
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [video]);

  return (
    <>
      <video ref={setVideo} autoPlay muted playsInline hidden />
      <CorruptVideo source={video} intensity={${intensity}} sampleRate={${rate}}
        warmupMs={1000} options={{ blockSize: ${blockSize}, healRate: ${healRate} }}
        style={{ width: '100%', aspectRatio: '16 / 9' }} />
    </>
  );
}`;
  const flowersCode = `import { useState } from 'react';
import { CorruptVideo } from 'react-corruption';
import 'react-corruption/styles.css';

// Any playing <video> works as a source — here, a looping clip.
export function FlowersEffect() {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  return (
    <>
      <video ref={setVideo} src="/flowers.mp4" autoPlay loop muted playsInline hidden
        onLoadedData={(e) => { void e.currentTarget.play(); }} />
      <CorruptVideo source={video} intensity={${intensity}} sampleRate={${rate}}
        options={{ blockSize: ${blockSize}, healRate: ${healRate} }}
        style={{ width: '100%', aspectRatio: '8 / 3' }} />
    </>
  );
}`;
  const code = mode === 'webcam' ? webcamCode : flowersCode;

  return (
    <>
      <div className="demo__row" role="group" aria-label="Source">
        <button type="button" aria-pressed={mode === 'flowers'} onClick={useFlowers}>
          Spinning flowers
        </button>
        <button type="button" aria-pressed={mode === 'webcam'} onClick={enableCamera}>
          Use my webcam
        </button>
      </div>

      {mode === 'flowers' && (
        <p className="demo__hint">
          A looping clip of three flowers, each spinning in place. Any playing
          &lt;video&gt; works as a source.
        </p>
      )}

      <video
        ref={setSource}
        autoPlay
        loop
        muted
        playsInline
        hidden
        onError={() => setError('The video stream could not start.')}
      />
      <div
        className="demo__video-stage"
        style={{ aspectRatio: mode === 'webcam' ? '16 / 9' : '8 / 3' }}
      >
        <CorruptVideo
          ref={effect}
          source={source}
          intensity={intensity}
          sampleRate={rate}
          options={{ blockSize, healRate }}
          paused={paused}
          showOriginal={original}
          warmupMs={mode === 'webcam' ? 1000 : 0}
          onReady={() => setReady(true)}
          onError={(cause) => setError(cause.message)}
          label={mode === 'webcam' ? 'Your camera' : 'Spinning flowers'}
        />
        <span className="demo__video-label">
          {original ? 'Original' : 'Corruption'}
          {paused ? ' · frozen' : ''}
          {mode === 'webcam' ? ' · webcam' : ' · flowers'}
        </span>
      </div>
      <div className="demo__row">
        <button
          type="button"
          aria-pressed={paused}
          disabled={!ready}
          onClick={() => setPaused(!paused)}
        >
          {paused ? 'Resume' : 'Freeze'}
        </button>
        <button
          type="button"
          aria-pressed={original}
          disabled={!ready}
          onClick={() => setOriginal(!original)}
        >
          {original ? 'Show effect' : 'Show original'}
        </button>
        <button
          type="button"
          disabled={!ready || paused}
          onClick={() => effect.current?.corrupt()}
        >
          Corrupt
        </button>
        <button type="button" disabled={!ready} onClick={() => effect.current?.reset()}>
          Reset
        </button>
      </div>
      <section className="demo__panel" aria-label="Video controls">
        <label>
          Intensity <output>{intensity}</output>
          <code>intensity</code>
          <input
            aria-label="Intensity"
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={intensity}
            onChange={(e) => setIntensity(Number(e.target.value))}
          />
        </label>
        <label>
          Frames sampled <output>{rate}</output>
          <code>sampleRate</code>
          <input
            aria-label="Frames sampled per second"
            type="range"
            min="1"
            max="30"
            step="1"
            value={rate}
            onChange={(e) =>
              setRate(Math.max(1, Math.min(30, Number(e.target.value) || 1)))
            }
          />
        </label>
        <label>
          Pixel size <output>{blockSize}</output>
          <code>blockSize</code>
          <input
            aria-label="Pixel size"
            type="range"
            min="2"
            max="32"
            step="1"
            value={blockSize}
            onChange={(e) => setBlockSize(Number(e.target.value))}
          />
        </label>
        <label>
          Healing speed <output>{healRate}</output>
          <code>healRate</code>
          <input
            aria-label="Healing speed"
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={healRate}
            onChange={(e) => setHealRate(Number(e.target.value))}
          />
        </label>
      </section>
      {error && (
        <p role="alert">{error} The original is shown when the effect is unavailable.</p>
      )}
      <section className="demo__code" aria-label="Example code">
        <div className="demo__code-head">
          <h2>{mode === 'webcam' ? 'Wire up a webcam' : 'Use it in your app'}</h2>
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(code);
                setCopied(true);
              } catch {
                setError('Select the example code to copy it.');
              }
            }}
          >
            Copy code
          </button>
        </div>
        <p className="demo__note">
          {mode === 'webcam'
            ? 'Request the camera, feed the stream to a <video>, then hand that video to CorruptVideo. Your app owns the permission prompt and stops the tracks on cleanup — the library never touches the stream. warmupMs lets exposure settle before the first frame is sampled.'
            : 'Point a <video> at a clip, hand it to CorruptVideo, and its motion drives the effect. Any playing video works the same way. Switch to the webcam above to see the camera wiring.'}
        </p>
        <pre>
          <code>{code}</code>
        </pre>
        <p className="demo__note" role="status">
          {copied ? 'Copied' : ''}
        </p>
      </section>
    </>
  );
}
