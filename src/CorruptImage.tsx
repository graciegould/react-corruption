import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { CorruptionEngine } from './engine';
import {
  normalizeIntensity,
  resolveOptions,
  useReducedMotion,
  type CorruptControls,
} from './reactOptions';

export interface CorruptImageHandle {
  /** Play a burst, or queue one until the image has loaded. */
  corrupt: () => void;
  reset: () => void;
}

export interface CorruptImageProps extends CorruptControls {
  src: string;
  alt?: string;
  className?: string;
  style?: CSSProperties;
  /** Intrinsic dimensions reserve space while the image loads. */
  width?: number;
  height?: number;
  /** Also burst on click in hover mode. Default true; ignored in manual mode. */
  burstOnClick?: boolean;
  /** A failed effect leaves the original image visible. */
  onError?: (error: Error) => void;
}

/** An image with an optional distortion overlay. */
export const CorruptImage = forwardRef<CorruptImageHandle, CorruptImageProps>(
  function CorruptImage(
    {
      src,
      alt = '',
      options,
      intensity = 0.5,
      trigger = 'hover',
      disabled = false,
      className,
      style,
      width,
      height,
      burstOnClick = true,
      onError,
    },
    ref,
  ) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const wrapRef = useRef<HTMLDivElement>(null);
    const engineRef = useRef<CorruptionEngine | null>(null);
    const fitRef = useRef<(() => void) | null>(null);
    const visibleRef = useRef(true);
    const readyRef = useRef(false);
    const queuedRef = useRef<((engine: CorruptionEngine) => void) | null>(null);
    const [readySource, setReadySource] = useState<{
      src: string;
      alpha: boolean;
    } | null>(null);
    const [quiet, setQuiet] = useState(true);
    const reduced = useReducedMotion();
    const blocked = disabled || reduced || normalizeIntensity(intensity) === 0;
    const settings = resolveOptions('image', intensity, options);
    const alpha = settings.alpha;
    const ready = readySource?.src === src && readySource.alpha === alpha && !blocked;
    const latest = useRef({ settings, blocked, onError });
    latest.current = { settings, blocked, onError };

    const syncPlayback = useCallback(() => {
      const engine = engineRef.current;
      if (!engine) return;
      if (
        readyRef.current &&
        !latest.current.blocked &&
        visibleRef.current &&
        !document.hidden
      )
        engine.start();
      else engine.stop();
    }, []);

    const run = useCallback(
      (effect: (engine: CorruptionEngine) => void) => {
        if (latest.current.blocked) return;
        if (!readyRef.current || !engineRef.current) {
          queuedRef.current = effect;
          return;
        }
        effect(engineRef.current);
        syncPlayback();
      },
      [syncPlayback],
    );

    const reset = useCallback(() => {
      queuedRef.current = null;
      engineRef.current?.pointerLeave();
      engineRef.current?.reset();
      setQuiet(true);
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        corrupt: () => run((engine) => engine.explode(0.8)),
        reset,
      }),
      [run, reset],
    );

    const previousSettings = useRef(settings);
    useEffect(() => {
      const current = latest.current.settings;
      const previous = previousSettings.current;
      previousSettings.current = current;
      engineRef.current?.setOptions(current);
      if (
        previous.blockSize !== current.blockSize ||
        previous.resolutionScale !== current.resolutionScale
      )
        fitRef.current?.();
    }, [options, intensity]);

    useEffect(() => {
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      readyRef.current = false;
      setReadySource(null);
      setQuiet(true);
      if (!canvas || !wrap || blocked) return;
      let cancelled = false;
      let loaded = false;
      let engine: CorruptionEngine;
      const fail = (error: unknown) => {
        if (cancelled) return;
        loaded = false;
        readyRef.current = false;
        queuedRef.current = null;
        setReadySource(null);
        engine?.stop();
        latest.current.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      };
      try {
        engine = new CorruptionEngine(canvas, latest.current.settings);
      } catch (error) {
        fail(error);
        return;
      }
      engineRef.current = engine;
      engine.onQuietChange(setQuiet);
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      const fit = () => {
        if (!loaded || cancelled) return;
        const rect = wrap.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return;
        try {
          engine.resize(rect.width, rect.height, img);
          engine.reset();
          readyRef.current = true;
          setReadySource({ src, alpha });
          const queued = queuedRef.current;
          queuedRef.current = null;
          queued?.(engine);
          syncPlayback();
        } catch (error) {
          fail(error);
        }
      };
      fitRef.current = fit;
      img.onload = () => {
        if (cancelled) return;
        loaded = true;
        fit();
      };
      img.onerror = () =>
        fail(
          new Error(
            `CorruptImage: could not load an effect source. Check the image URL and CORS headers.`,
          ),
        );
      img.src = src;
      const resize = new ResizeObserver(fit);
      resize.observe(wrap);
      const intersection = new IntersectionObserver(
        ([entry]) => {
          if (!entry) return;
          visibleRef.current = entry.isIntersecting;
          syncPlayback();
        },
        { threshold: 0.01 },
      );
      intersection.observe(wrap);
      document.addEventListener('visibilitychange', syncPlayback);
      return () => {
        cancelled = true;
        readyRef.current = false;
        queuedRef.current = null;
        fitRef.current = null;
        resize.disconnect();
        intersection.disconnect();
        document.removeEventListener('visibilitychange', syncPlayback);
        engine.dispose();
        engineRef.current = null;
      };
    }, [src, blocked, alpha, syncPlayback]);

    useEffect(reset, [trigger, reset]);

    return (
      <div
        ref={wrapRef}
        className={[
          'corrupt-image',
          ready ? 'is-ready' : '',
          ready && !quiet && !blocked ? 'is-corrupting' : '',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
        style={style}
        onPointerMove={(event) => {
          if (trigger !== 'hover' || blocked || !readyRef.current) return;
          const rect = event.currentTarget.getBoundingClientRect();
          engineRef.current?.pointerMove(
            event.clientX - rect.left,
            event.clientY - rect.top,
            rect.width,
            rect.height,
          );
        }}
        onPointerLeave={() => {
          engineRef.current?.pointerLeave();
          if (trigger === 'hover') reset();
        }}
        onClick={(event) => {
          if (trigger === 'manual' || (trigger === 'hover' && !burstOnClick)) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const x = event.detail === 0 ? rect.width / 2 : event.clientX - rect.left;
          const y = event.detail === 0 ? rect.height / 2 : event.clientY - rect.top;
          run((engine) => engine.burst(x, y, rect.width, rect.height));
        }}
      >
        <img
          className="corrupt-image__image"
          src={src}
          alt={alt}
          width={width}
          height={height}
          draggable={false}
        />
        <canvas
          key={String(alpha)}
          ref={canvasRef}
          className="corrupt-image__canvas"
          aria-hidden="true"
        />
      </div>
    );
  },
);
