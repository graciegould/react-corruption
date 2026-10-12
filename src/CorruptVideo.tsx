import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { CorruptionEngine, DEFAULT_OPTIONS } from './engine';
import {
  normalizeIntensity,
  useReducedMotion,
  type CorruptControls,
} from './reactOptions';

export interface CorruptVideoHandle {
  /** Add a burst to the current video. Ignored while paused or disabled. */
  corrupt: () => void;
  /** Restore the most recently sampled source frame. */
  reset: () => void;
}

export interface CorruptVideoProps extends Omit<CorruptControls, 'trigger'> {
  /** A video element owned by your app. It may play a clip or a MediaStream. */
  source: HTMLVideoElement | null;
  /** Source frames processed per second, from 1 to 60. Default 8. */
  sampleRate?: number;
  /** Hold both the effect and comparison frame. Does not pause the source video. */
  paused?: boolean;
  /** Display the original frame while preserving accumulated corruption. */
  showOriginal?: boolean;
  /** Allow pointer smearing and click bursts. Default true. */
  interactive?: boolean;
  /** Fit the source into the canvas. Default cover. */
  fit?: 'cover' | 'stretch';
  /** Refresh the initial source while camera exposure settles. Default 0 ms. */
  warmupMs?: number;
  className?: string;
  style?: CSSProperties;
  label?: string;
  onReady?: () => void;
  /** A failed effect falls back to the original video frames. */
  onError?: (error: Error) => void;
}

const bounded = (value: number, fallback: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

/** Render a playing video with motion-driven corruption. Camera access stays in your app. */
export const CorruptVideo = forwardRef<CorruptVideoHandle, CorruptVideoProps>(
  function CorruptVideo(
    {
      source,
      intensity = 0.5,
      disabled = false,
      options,
      sampleRate = 8,
      paused = false,
      showOriginal = false,
      interactive = true,
      fit = 'cover',
      warmupMs = 0,
      className,
      style,
      label = 'Video with pixel corruption',
      onReady,
      onError,
    },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const originalRef = useRef<HTMLCanvasElement>(null);
    const controlRef = useRef<{
      sync: () => void;
      reset: () => void;
      corrupt: () => void;
      pointer: (x: number, y: number) => void;
      burst: (x: number, y: number) => void;
      leave: () => void;
    } | null>(null);
    const [readySource, setReadySource] = useState<HTMLVideoElement | null>(null);
    const [failedSource, setFailedSource] = useState<HTMLVideoElement | null>(null);
    const reduced = useReducedMotion();
    const amount = normalizeIntensity(intensity);
    const blocked = disabled || reduced || amount === 0;
    const ready = source !== null && readySource === source;
    const original =
      blocked || showOriginal || (source !== null && failedSource === source);
    const current = {
      blocked,
      paused,
      interactive,
      fit,
      onReady,
      onError,
      sampleRate: bounded(sampleRate, 8, 1, 60),
      warmupMs: bounded(warmupMs, 0, 0, 5000),
      settings: {
        ...DEFAULT_OPTIONS,
        blockSize: 5,
        resolutionScale: 0.85,
        decay: 0.95,
        healRate: 0.4 - amount * 0.3,
        channelShift: 2.2 * amount,
        maxVector: 32 * amount,
        floodThreshold: 8.5,
        ...options,
        alpha: false,
      },
      motionStrength: amount * 2,
    };
    const state = useRef(current);
    state.current = current;

    useImperativeHandle(
      ref,
      () => ({
        corrupt: () => controlRef.current?.corrupt(),
        reset: () => controlRef.current?.reset(),
      }),
      [],
    );

    useEffect(() => {
      const host = hostRef.current;
      const canvas = canvasRef.current;
      const originalCanvas = originalRef.current;
      setReadySource(null);
      setFailedSource(null);
      if (!source || !host || !canvas || !originalCanvas) return;
      const originalContext = originalCanvas.getContext('2d');
      if (!originalContext) {
        state.current.onError?.(new Error('CorruptVideo: 2D context unavailable'));
        return;
      }
      let engine: CorruptionEngine | null = null;
      let failed = false;
      let disposed = false;
      let visible = true;
      let notified = false;
      let frame: number | null = null;
      let videoFrame = false;
      let lastTime = -1;
      let lastSample = -Infinity;
      let seededAt = -1;
      let lastSeed = -Infinity;
      let dimensions = '';
      let previousBlocked = state.current.blocked;
      let lastGrid = '';
      const fail = (error: unknown) => {
        if (failed || disposed) return;
        failed = true;
        engine?.dispose();
        engine = null;
        setFailedSource(source);
        state.current.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      };
      const cancel = () => {
        if (frame === null) return;
        if (videoFrame) source.cancelVideoFrameCallback(frame);
        else cancelAnimationFrame(frame);
        frame = null;
      };
      const drawOriginal = () => {
        const width = originalCanvas.width;
        const height = originalCanvas.height;
        const scale = Math.max(width / source.videoWidth, height / source.videoHeight);
        const w = state.current.fit === 'cover' ? source.videoWidth * scale : width;
        const h = state.current.fit === 'cover' ? source.videoHeight * scale : height;
        originalContext.clearRect(0, 0, width, height);
        originalContext.drawImage(source, (width - w) / 2, (height - h) / 2, w, h);
      };
      const render = (force = false) => {
        if (
          disposed ||
          !visible ||
          document.hidden ||
          source.readyState < 2 ||
          source.seeking
        )
          return;
        const s = state.current;
        if (s.paused && notified && !force) return;
        const rect = host.getBoundingClientRect();
        if (
          rect.width < 1 ||
          rect.height < 1 ||
          !source.videoWidth ||
          !source.videoHeight
        )
          return;
        const now = performance.now();
        const size = `${rect.width}:${rect.height}:${source.videoWidth}:${source.videoHeight}:${s.fit}`;
        const grid = `${s.settings.blockSize}:${s.settings.resolutionScale}`;
        const resize = size !== dimensions || grid !== lastGrid;
        const rewind = source.currentTime < lastTime;
        const warming = seededAt >= 0 && now - seededAt < s.warmupMs;
        const reseed = warming && now - lastSeed >= 250;
        if (
          !force &&
          !resize &&
          !reseed &&
          !rewind &&
          (source.currentTime === lastTime || now - lastSample < 1000 / s.sampleRate)
        )
          return;
        if (size !== dimensions) {
          originalCanvas.width = Math.max(1, Math.round(rect.width));
          originalCanvas.height = Math.max(1, Math.round(rect.height));
        }
        drawOriginal();
        try {
          if (!s.blocked && !failed) {
            if (!engine) engine = new CorruptionEngine(canvas, s.settings);
            engine.setOptions(s.settings);
            if (resize || seededAt < 0 || previousBlocked || rewind || reseed) {
              engine.resize(rect.width, rect.height, source, s.fit);
              if (seededAt < 0) seededAt = now;
              lastSeed = now;
            } else {
              engine.setSource(source, {
                fit: s.fit,
                estimateMotion: true,
                motionStrength: s.motionStrength,
                motionMode: 'replace',
              });
              engine.advance();
            }
          }
        } catch (error) {
          fail(error);
        }
        previousBlocked = s.blocked;
        dimensions = size;
        lastGrid = grid;
        lastSample = now;
        lastTime = source.currentTime;
        if (!notified) {
          notified = true;
          setReadySource(source);
          state.current.onReady?.();
        }
      };
      const schedule = () => {
        if (
          disposed ||
          frame !== null ||
          !visible ||
          document.hidden ||
          state.current.paused ||
          source.paused ||
          source.ended
        )
          return;
        const tick = () => {
          frame = null;
          try {
            render();
          } catch (error) {
            fail(error);
          }
          schedule();
        };
        videoFrame = typeof source.requestVideoFrameCallback === 'function';
        frame = videoFrame
          ? source.requestVideoFrameCallback(tick)
          : requestAnimationFrame(tick);
      };
      const sync = () => {
        cancel();
        try {
          render(!notified);
        } catch (error) {
          fail(error);
        }
        schedule();
      };
      const motion = (fn: (effect: CorruptionEngine) => void) => {
        if (!engine || failed || state.current.blocked || state.current.paused) return;
        fn(engine);
      };
      controlRef.current = {
        sync,
        reset: () => engine?.reset(),
        corrupt: () => motion((e) => e.explodeInjected(0.8)),
        pointer: (x, y) =>
          motion((e) => {
            const rect = host.getBoundingClientRect();
            e.pointerMove(x, y, rect.width, rect.height);
          }),
        burst: (x, y) =>
          motion((e) => {
            const rect = host.getBoundingClientRect();
            e.burstInjected(x, y, rect.width, rect.height);
          }),
        leave: () => engine?.pointerLeave(),
      };
      const resizeObserver = new ResizeObserver(() => {
        try {
          render(true);
        } catch (error) {
          fail(error);
        }
      });
      resizeObserver.observe(host);
      const intersection = new IntersectionObserver(([entry]) => {
        visible = entry?.isIntersecting ?? false;
        sync();
      });
      intersection.observe(host);
      const events = [
        'loadeddata',
        'playing',
        'pause',
        'seeked',
        'resize',
        'ended',
      ] as const;
      for (const event of events) source.addEventListener(event, sync);
      document.addEventListener('visibilitychange', sync);
      sync();
      return () => {
        disposed = true;
        cancel();
        resizeObserver.disconnect();
        intersection.disconnect();
        for (const event of events) source.removeEventListener(event, sync);
        document.removeEventListener('visibilitychange', sync);
        engine?.dispose();
        controlRef.current = null;
      };
    }, [source]);

    useEffect(() => {
      controlRef.current?.sync();
    }, [paused, blocked, options, sampleRate, intensity, fit]);
    const position = useCallback(
      (event: { currentTarget: HTMLDivElement; clientX: number; clientY: number }) => {
        const rect = event.currentTarget.getBoundingClientRect();
        return [event.clientX - rect.left, event.clientY - rect.top] as const;
      },
      [],
    );
    return (
      <div
        ref={hostRef}
        className={['corrupt-video', className].filter(Boolean).join(' ')}
        style={style}
        role="img"
        aria-label={label}
        data-ready={ready}
        data-original={original}
        onPointerMove={(event) => {
          if (interactive && !original) controlRef.current?.pointer(...position(event));
        }}
        onPointerLeave={() => controlRef.current?.leave()}
        onPointerDown={(event) => {
          if (interactive && !original) controlRef.current?.burst(...position(event));
        }}
      >
        <canvas
          ref={canvasRef}
          className="corrupt-video__canvas"
          data-ready={ready}
          aria-hidden="true"
        />
        <canvas
          ref={originalRef}
          className="corrupt-video__original"
          aria-hidden="true"
        />
      </div>
    );
  },
);
