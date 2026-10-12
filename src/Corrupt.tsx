import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from 'react';
import { CorruptionEngine } from './engine';
import { rasterizeElement } from './rasterizeElement';
import {
  normalizeIntensity,
  resolveOptions,
  useReducedMotion,
  type CorruptControls,
} from './reactOptions';

export interface CorruptHandle {
  /** Play a burst. Captures the content first if it is not ready yet. */
  corrupt: () => void;
  /** Restore the original content immediately. */
  reset: () => void;
  /** Advanced: push the whole content in a direction. Strength is 0–1. */
  drift: (dirX: number, dirY: number, strength?: number) => void;
  /** Advanced: tear outward from the centre. */
  explode: (strength?: number) => void;
  /** Advanced: burst at a point in CSS pixels relative to the content. */
  burst: (x: number, y: number, strength?: number) => void;
  /** Advanced: shear a horizontal band, in CSS pixels. */
  shear: (y: number, band: number, strength?: number, dir?: 1 | -1) => void;
  /** Whether the content has been captured and is ready for effects. */
  isActive: () => boolean;
}

export interface CorruptProps extends CorruptControls {
  ref?: Ref<CorruptHandle>;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Advanced: DOM capture resolution. Default 1. */
  rasterScale?: number;
  /** Advanced: pixels the effect can extend beyond the content. Default 0. */
  bleed?: number;
  /** Also burst on click in hover mode. Default true; ignored in manual mode. */
  burstOnClick?: boolean;
  /** Capture errors leave the original content visible. */
  onError?: (error: Error) => void;
}

/** Wrap content to distort it on interaction. */
export const Corrupt = forwardRef<CorruptHandle, CorruptProps>(function Corrupt(
  {
    children,
    options,
    intensity = 0.5,
    disabled = false,
    trigger = 'hover',
    className,
    style,
    rasterScale = 1,
    bleed = 0,
    burstOnClick = true,
    onError,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<CorruptionEngine | null>(null);
  const rasterRef = useRef<HTMLCanvasElement | null>(null);
  const activeRef = useRef(false);
  const visibleRef = useRef(true);
  const captureId = useRef(0);
  const pending = useRef<Promise<boolean> | null>(null);
  const [corrupting, setCorrupting] = useState(false);
  const [quiet, setQuiet] = useState(true);
  const [canvasStyle, setCanvasStyle] = useState<CSSProperties>({});
  const reduced = useReducedMotion();
  const blocked = disabled || reduced || normalizeIntensity(intensity) === 0;
  const latest = useRef({
    settings: resolveOptions('dom', intensity, options),
    blocked,
    onError,
  });
  latest.current = {
    settings: resolveOptions('dom', intensity, options),
    blocked,
    onError,
  };

  const syncPlayback = useCallback(() => {
    if (
      activeRef.current &&
      !latest.current.blocked &&
      visibleRef.current &&
      !document.hidden
    ) {
      engineRef.current?.start();
    } else {
      engineRef.current?.stop();
    }
  }, []);

  const deactivate = useCallback(() => {
    captureId.current += 1;
    pending.current = null;
    activeRef.current = false;
    engineRef.current?.stop();
    engineRef.current?.reset();
    engineRef.current?.pointerLeave();
    setCorrupting(false);
    setQuiet(true);
  }, []);

  const captureAndFit = useCallback((): Promise<boolean> => {
    if (pending.current) return pending.current;
    const content = contentRef.current;
    const canvas = canvasRef.current;
    if (!content || !canvas || latest.current.blocked) return Promise.resolve(false);
    const rect = content.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return Promise.resolve(false);
    const id = captureId.current;
    const work = (async () => {
      try {
        if (document.fonts?.ready) await document.fonts.ready;
        if (id !== captureId.current) return false;
        const { canvas: captured } = await rasterizeElement(content, rasterScale);
        if (id !== captureId.current || latest.current.blocked) return false;
        let raster = captured;
        if (bleed > 0) {
          const pad = Math.round(bleed * rasterScale);
          const padded = document.createElement('canvas');
          padded.width = captured.width + pad * 2;
          padded.height = captured.height + pad * 2;
          const ctx = padded.getContext('2d');
          if (!ctx) throw new Error('Corrupt: 2D context unavailable');
          ctx.drawImage(captured, pad, pad);
          raster = padded;
        }
        const host = hostRef.current!;
        const hostRect = host.getBoundingClientRect();
        const contentRect = content.getBoundingClientRect();
        setCanvasStyle({
          left: contentRect.left - hostRect.left - host.clientLeft - bleed,
          top: contentRect.top - hostRect.top - host.clientTop - bleed,
          width: rect.width + bleed * 2,
          height: rect.height + bleed * 2,
        });
        rasterRef.current = raster;
        if (!engineRef.current) {
          engineRef.current = new CorruptionEngine(canvas, latest.current.settings);
          engineRef.current.onQuietChange(setQuiet);
        }
        engineRef.current.setOptions(latest.current.settings);
        engineRef.current.resize(
          rect.width + bleed * 2,
          rect.height + bleed * 2,
          raster,
          'stretch',
        );
        engineRef.current.reset();
        return true;
      } catch (error) {
        if (id !== captureId.current) return false;
        deactivate();
        const err = error instanceof Error ? error : new Error(String(error));
        latest.current.onError?.(err);
        return false;
      }
    })();
    pending.current = work;
    void work.finally(() => {
      if (pending.current === work) pending.current = null;
    });
    return work;
  }, [bleed, rasterScale, deactivate]);

  const activate = useCallback(async () => {
    if (latest.current.blocked) return false;
    if (activeRef.current && !pending.current && engineRef.current) return true;
    activeRef.current = true;
    const ok = await captureAndFit();
    if (!ok || !activeRef.current || latest.current.blocked) return false;
    setCorrupting(true);
    syncPlayback();
    return true;
  }, [captureAndFit, syncPlayback]);

  const run = useCallback(
    (effect: (engine: CorruptionEngine) => void) => {
      const id = captureId.current;
      void activate().then((ready) => {
        if (
          !ready ||
          id !== captureId.current ||
          !activeRef.current ||
          latest.current.blocked ||
          !engineRef.current
        )
          return;
        effect(engineRef.current);
        syncPlayback();
      });
    },
    [activate, syncPlayback],
  );

  useImperativeHandle(
    ref,
    () => ({
      corrupt: () => run((engine) => engine.explode(0.8)),
      reset: deactivate,
      drift: (x, y, strength) => run((engine) => engine.drift(x, y, strength)),
      explode: (strength) => run((engine) => engine.explode(strength)),
      burst: (x, y, strength) =>
        run((engine) => {
          const rect = contentRef.current!.getBoundingClientRect();
          engine.burst(
            x + bleed,
            y + bleed,
            rect.width + bleed * 2,
            rect.height + bleed * 2,
            strength,
          );
        }),
      shear: (y, band, strength, dir) =>
        run((engine) => {
          const rect = contentRef.current!.getBoundingClientRect();
          engine.shear(y + bleed, band, rect.height + bleed * 2, strength, dir);
        }),
      isActive: () => activeRef.current && !pending.current && !!engineRef.current,
    }),
    [run, deactivate, bleed],
  );

  const previousSettings = useRef(latest.current.settings);
  useEffect(() => {
    const settings = latest.current.settings;
    const previous = previousSettings.current;
    previousSettings.current = settings;
    const engine = engineRef.current;
    if (!engine) return;
    engine.setOptions(settings);
    if (
      previous.blockSize !== settings.blockSize ||
      previous.resolutionScale !== settings.resolutionScale
    ) {
      const rect = contentRef.current?.getBoundingClientRect();
      if (rect && rasterRef.current)
        engine.resize(
          rect.width + bleed * 2,
          rect.height + bleed * 2,
          rasterRef.current,
          'stretch',
        );
    }
  }, [options, intensity, bleed]);

  useEffect(() => {
    if (!blocked && trigger === 'manual') void activate();
    return deactivate;
  }, [trigger, blocked, activate, deactivate]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let frame = 0;
    const resize = new ResizeObserver(() => {
      if (!activeRef.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => void captureAndFit());
    });
    resize.observe(host);
    const intersection = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        visibleRef.current = entry.isIntersecting;
        syncPlayback();
      },
      { threshold: 0.01 },
    );
    intersection.observe(host);
    document.addEventListener('visibilitychange', syncPlayback);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      intersection.disconnect();
      document.removeEventListener('visibilitychange', syncPlayback);
    };
  }, [captureAndFit, syncPlayback]);

  useEffect(() => {
    if (activeRef.current) void captureAndFit();
  }, [children, captureAndFit]);

  useEffect(
    () => () => {
      captureId.current += 1;
      pending.current = null;
      activeRef.current = false;
      engineRef.current?.dispose();
      engineRef.current = null;
    },
    [],
  );

  return (
    <div
      ref={hostRef}
      className={[
        'corrupt',
        corrupting && !blocked ? 'is-corrupting' : '',
        quiet ? 'is-quiet' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ ...style, '--corrupt-bleed': `${bleed}px` } as CSSProperties}
      onPointerEnter={() => {
        if (trigger === 'hover') void activate();
      }}
      onPointerLeave={() => {
        if (trigger === 'hover') deactivate();
      }}
      onPointerMove={(event) => {
        if (trigger !== 'hover' || blocked) return;
        if (!activeRef.current) {
          void activate();
          return;
        }
        const rect = contentRef.current!.getBoundingClientRect();
        engineRef.current?.pointerMove(
          event.clientX - rect.left + bleed,
          event.clientY - rect.top + bleed,
          rect.width + bleed * 2,
          rect.height + bleed * 2,
        );
      }}
      onClick={(event) => {
        if (trigger === 'manual' || (trigger === 'hover' && !burstOnClick)) return;
        const rect = contentRef.current!.getBoundingClientRect();
        const x = event.detail === 0 ? rect.width / 2 : event.clientX - rect.left;
        const y = event.detail === 0 ? rect.height / 2 : event.clientY - rect.top;
        run((engine) =>
          engine.burst(
            x + bleed,
            y + bleed,
            rect.width + bleed * 2,
            rect.height + bleed * 2,
          ),
        );
      }}
    >
      <div ref={contentRef} className="corrupt__content">
        {children}
      </div>
      <canvas
        ref={canvasRef}
        className="corrupt__canvas"
        style={canvasStyle}
        data-corrupt-ignore=""
        aria-hidden="true"
      />
    </div>
  );
});
