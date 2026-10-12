/**
 * Pixel corruption engine — framework-independent, no dependencies.
 *
 * Each step displaces blocks from the previous rendered image, then blends
 * the original source back in at `healRate`. Pointer gestures or motion
 * estimated from source images drive the displacement field. The result is
 * accumulated pixel smearing, with optional colour separation and fading.
 */

export interface CorruptionOptions {
  /** Macroblock edge in internal pixels. Bigger = chunkier tearing. */
  blockSize: number;
  /** Internal buffer scale vs. CSS size. <1 is faster and coarser. */
  resolutionScale: number;
  /** Per-frame motion-vector decay (0–1). Lower = motion dies sooner. */
  decay: number;
  /** Per-frame blend back toward the pristine source (0–1). 0 = never heals. */
  healRate: number;
  /** Chroma displacement in px per unit of vector magnitude. */
  channelShift: number;
  /**
   * Fade a displaced block's alpha in proportion to how far it has travelled.
   *
   * Without this, a block pushed to the displacement clamp keeps full opacity,
   * so the smear simply STOPS at `maxVector` from the ink — a straight, hard
   * front that reads as a container edge. It is worst on the axis where the
   * content nearly fills the buffer (a wide title: left and right), because
   * there the front lands outside the `edgeFade` band and never gets faded.
   *
   * 0 disables. 1 means a block at full clamp fades to nothing.
   */
  travelFade: number;

  /** Vector magnitude clamp, in internal px per frame. */
  maxVector: number;
  /** Radius (internal px) over which a pointer sample spreads. */
  influenceRadius: number;
  /** Pointer velocity multiplier. */
  force: number;
  /** Above this magnitude a block flattens to its average colour. */
  floodThreshold: number;
  /**
   * Fade the buffer's own alpha to zero across this many internal pixels at
   * every edge, so the canvas boundary dissolves instead of cutting.
   *
   * Without it there is no way to hide where the buffer ends: a smear that
   * reaches the edge is sliced off at full opacity and reads as a hard
   * rectangle — the "box" around the words. Widening the bleed does not fix
   * that, because the corruption simply expands to fill whatever buffer it is
   * given; the edge just moves further out. Feathering removes the edge as a
   * visible feature instead of trying to outrun it.
   *
   * 0 disables it (a hard edge, correct for photos that should fill frame).
   */
  edgeFade: number;
  /**
   * Preserve transparency. Required when corrupting DOM elements, whose
   * backgrounds are usually transparent — without it every uncovered pixel
   * composites to black and the element renders as a solid slab.
   * Read once at construction: the canvas context cannot change alpha mode
   * after creation, so changing this via setOptions has no effect.
   */
  alpha: boolean;
}

export const DEFAULT_OPTIONS: CorruptionOptions = {
  blockSize: 8,
  resolutionScale: 0.5,
  decay: 0.94,
  healRate: 0.012,
  channelShift: 1.7,
  maxVector: 14,
  influenceRadius: 130,
  force: 0.42,
  floodThreshold: 7.5,
  // Off by default: a photo corrupting inside its own frame wants a hard edge.
  // Transparent DOM sources (text) are the case that needs feathering.
  edgeFade: 0,
  travelFade: 0,
  alpha: false,
};

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Smallest sensible influence radius: a couple of macroblocks across. */
const blockFloor = (blockSize: number) => blockSize * 2;

/** Anything drawable that also reports its own intrinsic size. */
export type CorruptionSource =
  HTMLImageElement | HTMLCanvasElement | HTMLVideoElement | ImageBitmap;

function intrinsicSize(src: CorruptionSource): [number, number] {
  // Video reports its frame size separately from its layout size, and a
  // not-yet-loaded stream reports 0 — the caller must wait for metadata.
  if ('videoWidth' in src) return [src.videoWidth, src.videoHeight];
  if ('naturalWidth' in src) return [src.naturalWidth, src.naturalHeight];
  return [src.width, src.height];
}

/** Options for {@link CorruptionEngine.setSource}. */
export interface SetSourceOptions {
  /** How the raster is fitted into the buffer. Defaults to the last fit used. */
  fit?: 'cover' | 'stretch';
  /** Estimate motion between source images and use it to drive displacement. */
  estimateMotion?: boolean;
  /** Multiplier on estimated vectors. 1 = as measured. */
  motionStrength?: number;
  /**
   * 'replace' uses the latest measured movement plus injected gestures.
   * 'accumulate' adds measurements to the existing, decaying motion field.
   */
  motionMode?: 'replace' | 'accumulate';
}

export class CorruptionEngine {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private opts: CorruptionOptions;

  /** Internal buffer dimensions. */
  private w = 0;
  private h = 0;
  /** Motion-vector field dimensions, in blocks. */
  private cols = 0;
  private rows = 0;

  /** Original source pixels, used as the recovery target. */
  private source: Uint8ClampedArray | null = null;
  /**
   * The previous pristine raster. Kept only while motion estimation is on, so
   * block matching has an earlier frame to search against.
   */
  private prevSource: Uint8ClampedArray | null = null;
  /**
   * Vectors injected from OUTSIDE motion estimation (drift/burst/shear/
   * explode), kept separate so a `replace`-mode estimate cannot clobber them.
   *
   * Measured motion describes one frame and must overwrite the previous
   * frame's measurement. A user gesture is not a measurement — it is an added
   * force that should persist and decay on its own. Without this split, any
   * gesture is erased by the very next frame's estimate, which made `explode`
   * on a live stream do visibly nothing.
   */
  private injected: Float32Array | null = null;
  /** Last fit mode used, so `setSource` can default to it. */
  private fit: 'cover' | 'stretch' = 'cover';
  /** Current accumulated frame (read side of the loop). */
  private buf: Uint8ClampedArray | null = null;
  /** Scratch frame (write side). Swapped with `buf` each tick. */
  private next: Uint8ClampedArray | null = null;
  private image: ImageData | null = null;

  /** Motion-vector field, two floats (x, y) per block. */
  private field: Float32Array | null = null;
  /**
   * Per-block alpha multiplier from `travelFade`, written during `step` and
   * applied to the PAINTED pixels only — never to the reference frame.
   * See `applyTravelFade`.
   */
  private travel: Float32Array | null = null;

  /**
   * Per-block mean alpha of the pristine raster, 0..1, one entry per block.
   *
   * Lets a global impulse push only where there is actually ink. Without it a
   * whole-grid effect displaces the empty blocks too — and since the corner
   * blocks are furthest from centre they get the largest push, so corruption
   * fills the entire rectangle and reveals the container as a hard-edged slab.
   */
  private ink: Float32Array | null = null;

  private rafId = 0;
  private running = false;
  private needsFrame = false;
  private disposed = false;

  private pointer = { x: 0, y: 0, px: 0, py: 0, active: false, primed: false };

  /**
   * Consecutive frames in which no block has had a live motion vector.
   * Drives `quiet`: the host can show the pristine DOM instead of the canvas
   * while nothing is moving, which matters because the canvas is a
   * `resolutionScale` buffer upscaled with `image-rendering: pixelated` —
   * crisp text goes blocky the moment it is replaced by its own raster.
   */
  private quietFrames = 0;
  private quiet = false;
  private quietListener: ((quiet: boolean) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, options: Partial<CorruptionOptions> = {}) {
    const useAlpha = options.alpha ?? DEFAULT_OPTIONS.alpha;
    const ctx = canvas.getContext('2d', { alpha: useAlpha, willReadFrequently: true });
    if (!ctx) throw new Error('CorruptionEngine: 2D context unavailable');
    this.canvas = canvas;
    this.ctx = ctx;
    this.opts = { ...DEFAULT_OPTIONS, ...options };
    this.ctx.imageSmoothingEnabled = false;
  }

  /**
   * Update tunables at runtime. `alpha` is deliberately ignored here: the
   * canvas context's alpha mode is fixed at getContext() time and cannot be
   * changed afterwards, so honouring it would desync `opts.alpha` from the
   * context's real behaviour and make transparent sources composite to black.
   * Alpha is a construction-time decision only.
   */
  setOptions(options: Partial<CorruptionOptions>) {
    const { alpha: _ignored, ...rest } = options;
    const changed = Object.entries(rest).some(
      ([key, value]) => this.opts[key as keyof CorruptionOptions] !== value,
    );
    this.opts = { ...this.opts, ...rest };
    if (changed && !this.quiet) this.wake();
  }

  /**
   * Subscribe to the engine going quiet / waking up. Fires on the frame the
   * state flips, not every frame.
   *
   * "Quiet" means two things, both required: no block has a live motion
   * vector, AND the accumulated frame has healed back to the pristine source
   * closely enough that swapping it for the DOM is invisible. The second is
   * derived from `healRate` rather than guessed: residual error after n idle
   * frames is (1 - healRate)^n, so quiet is declared once that drops under
   * one 8-bit step. At healRate 0.22 that is 23 frames; at the default 0.012
   * it is ~460 (about 8 s); at 0 the buffer never heals and the engine is
   * never quiet — the canvas is the only truthful picture.
   */
  onQuietChange(listener: ((quiet: boolean) => void) | null) {
    this.quietListener = listener;
    listener?.(this.quiet);
  }

  isQuiet() {
    return this.quiet;
  }

  private quietThresholdFrames(): number {
    const { healRate } = this.opts;
    if (healRate <= 0) return Infinity;
    if (healRate >= 1) return 1;
    return Math.ceil(Math.log(1 / 255) / Math.log(1 - healRate));
  }

  private setQuiet(quiet: boolean) {
    if (quiet === this.quiet) return;
    this.quiet = quiet;
    this.quietListener?.(quiet);
  }

  /**
   * Size the internal buffers to the element and draw `source` fitted.
   * Safe to call on resize; the accumulated frame resets to pristine.
   *
   * `fit` matters because the two use cases differ. A photo should COVER the
   * frame (crop overflow, never letterbox). A rasterized DOM element is
   * already the exact size of its own box, so it must map 1:1 — cover-fitting
   * it would crop the text off its own edges.
   */
  resize(
    cssWidth: number,
    cssHeight: number,
    source: CorruptionSource | null,
    fit: 'cover' | 'stretch' = 'cover',
  ) {
    const { resolutionScale, blockSize } = this.opts;
    const w = Math.max(1, Math.floor(cssWidth * resolutionScale));
    const h = Math.max(1, Math.floor(cssHeight * resolutionScale));

    this.w = w;
    this.h = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx.imageSmoothingEnabled = false;

    this.cols = Math.ceil(w / blockSize);
    this.rows = Math.ceil(h / blockSize);
    this.field = new Float32Array(this.cols * this.rows * 2);
    this.injected = new Float32Array(this.cols * this.rows * 2);
    this.travel = new Float32Array(this.cols * this.rows).fill(1);

    this.fit = fit;

    if (!source) return;

    const snapshot = this.rasterize(source, fit);
    if (!snapshot) return;

    this.source = new Uint8ClampedArray(snapshot.data);
    this.buf = new Uint8ClampedArray(snapshot.data);
    this.next = new Uint8ClampedArray(snapshot.data.length);
    this.image = snapshot;

    this.buildInkMask();

    // PAINT THE SEED FRAME IMMEDIATELY.
    //
    // Without this the buffers hold a real picture but the canvas itself is
    // still blank, so the host shows BLACK until the first `step()`/`advance()`
    // lands. Under `start()` that is one rAF and invisible, but a frame-driven
    // host sampling at 6-12fps leaves the canvas black for up to ~170ms, and a
    // paused or frozen host leaves it black indefinitely. Measured on the
    // webcam page: meanLuma 0.0 at 120ms, 81.6 once frames arrived.
    //
    // Painting here makes `resize` self-consistent: after it returns, what is
    // on the canvas matches what is in the buffer.
    this.ctx.putImageData(snapshot, 0, 0);
    this.prevSource = null;
    this.needsFrame = false;
    this.quietFrames = this.quietThresholdFrames();
    this.setQuiet(true);
  }

  /**
   * Draw a source into the canvas and read it back, honouring `fit` and the
   * alpha mode. Shared by `resize` (which then adopts it as the reference
   * frame) and `setSource` (which deliberately does NOT).
   *
   * Returns null when the source has no intrinsic size yet — a video before
   * `loadedmetadata`, or an image before `decode`.
   */
  private rasterize(
    source: CorruptionSource,
    fit: 'cover' | 'stretch',
  ): ImageData | null {
    const w = this.w;
    const h = this.h;
    if (w < 1 || h < 1) return null;

    const [sw, sh] = intrinsicSize(source);
    if (sw < 1 || sh < 1) return null;

    if (this.opts.alpha) {
      this.ctx.clearRect(0, 0, w, h);
    } else {
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, w, h);
    }

    if (fit === 'stretch') {
      this.ctx.drawImage(source, 0, 0, w, h);
    } else {
      const scale = Math.max(w / sw, h / sh);
      const dw = sw * scale;
      const dh = sh * scale;
      this.ctx.drawImage(source, (w - dw) / 2, (h - dh) / 2, dw, dh);
    }

    return this.ctx.getImageData(0, 0, w, h);
  }

  /**
   * Update the recovery target without clearing accumulated distortion.
   * Optionally estimate motion from the source images. Use this for changing
   * images or video; `resize` instead clears the accumulated image.
   * Returns false if the engine or source is not ready.
   */
  setSource(source: CorruptionSource, options: SetSourceOptions = {}): boolean {
    if (this.disposed || !this.source || !this.buf || !this.image) return false;

    const {
      fit = this.fit,
      estimateMotion = false,
      motionStrength = 1,
      motionMode = 'replace',
    } = options;

    // Keep the outgoing reference for block matching before it is overwritten.
    const previous = estimateMotion ? this.prevSource : null;
    if (estimateMotion && !previous) {
      this.prevSource = new Uint8ClampedArray(this.source);
    }

    const snapshot = this.rasterize(source, fit);
    if (!snapshot) {
      // Nothing was read back, but the canvas has been cleared by `rasterize`.
      // Repaint the live buffer so the frame is not dropped to blank.
      this.image.data.set(this.buf);
      this.applyTravelFade(this.image.data);
      this.applyEdgeFade(this.image.data);
      this.ctx.putImageData(this.image, 0, 0);
      return false;
    }

    if (estimateMotion && previous) {
      this.estimateMotion(previous, snapshot.data, motionStrength, motionMode);
    }

    // Carry the outgoing source forward as the next match reference.
    if (estimateMotion) {
      if (!this.prevSource || this.prevSource.length !== this.source.length) {
        this.prevSource = new Uint8ClampedArray(this.source);
      } else {
        this.prevSource.set(this.source);
      }
    }

    this.source.set(snapshot.data);
    this.buildInkMask();

    // `rasterize` painted the pristine frame onto the visible canvas. Put the
    // corrupted buffer back so a `setSource` outside the rAF loop does not
    // flash the clean image for one frame.
    this.image.data.set(this.buf);
    this.applyTravelFade(this.image.data);
    this.applyEdgeFade(this.image.data);
    this.ctx.putImageData(this.image, 0, 0);

    this.wake();
    return true;
  }

  /**
   * Block-matching motion estimation between two rasters, accumulated into the
   * vector field.
   *
   * For each macroblock, search a small neighbourhood of the PREVIOUS frame for
   * the offset whose luma best matches the CURRENT frame, and store that
   * displacement. This is a diamond/step search rather than exhaustive: start
   * coarse, halve the step, refine. Exhaustive search over every block at
   * 30fps is far too slow in JS, and the coarse-to-fine result is visually
   * indistinguishable here.
   *
   * Only blocks with real detail get a vector. A flat region (a white wall)
   * has no reliable match — every offset scores about the same — so matching
   * it produces confident-looking noise. Those blocks are left to decay.
   */
  private estimateMotion(
    prev: Uint8ClampedArray,
    curr: Uint8ClampedArray,
    strength: number,
    mode: 'replace' | 'accumulate' = 'replace',
  ) {
    const field = this.field;
    if (!field || strength <= 0) return;

    const replace = mode === 'replace';

    const { blockSize, maxVector } = this.opts;
    const w = this.w;
    const h = this.h;

    // Sample every other pixel when scoring — a quarter of the work, and the
    // ranking between candidate offsets barely changes.
    const STEP = 2;
    // Search radius, in px. Beyond the clamp there is no point looking.
    const radius = Math.max(blockSize, Math.min(maxVector * 1.5, 24));
    // Minimum luma variance for a block to be considered matchable.
    const DETAIL_FLOOR = 34;

    const luma = (data: Uint8ClampedArray, p: number) =>
      data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114;

    for (let by = 0; by < this.rows; by++) {
      const y0 = by * blockSize;
      const y1 = Math.min(y0 + blockSize, h);

      for (let bx = 0; bx < this.cols; bx++) {
        const x0 = bx * blockSize;
        const x1 = Math.min(x0 + blockSize, w);

        // Reject flat blocks: compute min/max luma of the current block.
        let lo = 255;
        let hi = 0;
        for (let y = y0; y < y1; y += STEP) {
          let p = (y * w + x0) * 4;
          for (let x = x0; x < x1; x += STEP, p += 4 * STEP) {
            const l = luma(curr, p);
            if (l < lo) lo = l;
            if (l > hi) hi = l;
          }
        }
        if (hi - lo < DETAIL_FLOOR) {
          // A flat block has no trustworthy match. Under `replace` it must be
          // reset, not skipped: leaving a stale vector here is what makes a
          // still subject keep smearing after it has stopped moving. It falls
          // back to any injected force rather than to zero, so a gesture over
          // a featureless region still registers.
          if (replace) {
            const fz = (by * this.cols + bx) * 2;
            const inj = this.injected;
            field[fz] = inj ? inj[fz] : 0;
            field[fz + 1] = inj ? inj[fz + 1] : 0;
          }
          continue;
        }

        // Score a candidate offset by sum of absolute luma difference.
        const score = (ox: number, oy: number) => {
          let sad = 0;
          let n = 0;
          for (let y = y0; y < y1; y += STEP) {
            const sy = y + oy;
            if (sy < 0 || sy >= h) return Infinity;
            for (let x = x0; x < x1; x += STEP) {
              const sx = x + ox;
              if (sx < 0 || sx >= w) return Infinity;
              sad += Math.abs(
                luma(curr, (y * w + x) * 4) - luma(prev, (sy * w + sx) * 4),
              );
              n++;
            }
          }
          return n > 0 ? sad / n : Infinity;
        };

        // Coarse-to-fine: halve the step each pass, keeping the best offset.
        let bestX = 0;
        let bestY = 0;
        let best = score(0, 0);
        for (let s = Math.max(1, Math.round(radius / 2)); s >= 1; s = Math.floor(s / 2)) {
          let improved = true;
          while (improved) {
            improved = false;
            // Four cardinal neighbours plus diagonals at the current step.
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const cx = bestX + dx * s;
                const cy = bestY + dy * s;
                if (Math.abs(cx) > radius || Math.abs(cy) > radius) continue;
                const sc = score(cx, cy);
                if (sc < best) {
                  best = sc;
                  bestX = cx;
                  bestY = cy;
                  improved = true;
                }
              }
            }
          }
          if (s === 1) break;
        }

        // The block moved FROM (x+bestX) TO x, so the content's travel is the
        // negation of the matched offset. `step` samples at (x - v), so the
        // vector that reproduces this motion is the matched offset itself.
        const fi = (by * this.cols + bx) * 2;
        const capX = Math.min(maxVector, Math.max(2, w * 0.18));
        const capY = Math.min(maxVector, Math.max(2, h * 0.18));

        if (replace) {
          // A best match of (0,0) is a real measurement — the block did not
          // move — so it writes zero rather than being skipped. Injected force
          // is added on top: measurement replaces measurement, gestures stay.
          const inj = this.injected;
          const ix = inj ? inj[fi] : 0;
          const iy = inj ? inj[fi + 1] : 0;
          field[fi] = clamp(bestX * strength + ix, -capX, capX);
          field[fi + 1] = clamp(bestY * strength + iy, -capY, capY);
        } else {
          if (bestX === 0 && bestY === 0) continue;
          field[fi] = clamp(field[fi] + bestX * strength, -capX, capX);
          field[fi + 1] = clamp(field[fi + 1] + bestY * strength, -capY, capY);
        }
      }
    }
  }

  /**
   * Mean alpha per block, from the pristine raster. Computed once when the
   * source is captured rather than per frame — the raster does not change
   * between captures, and this runs over every pixel.
   */
  private buildInkMask() {
    const { blockSize } = this.opts;
    const src = this.source;
    if (!src) return;

    const mask = new Float32Array(this.cols * this.rows);

    for (let by = 0; by < this.rows; by++) {
      for (let bx = 0; bx < this.cols; bx++) {
        const x0 = bx * blockSize;
        const y0 = by * blockSize;
        const x1 = Math.min(x0 + blockSize, this.w);
        const y1 = Math.min(y0 + blockSize, this.h);

        let sum = 0;
        let count = 0;

        for (let y = y0; y < y1; y++) {
          let i = (y * this.w + x0) * 4 + 3;
          for (let x = x0; x < x1; x++) {
            sum += src[i]!;
            i += 4;
            count++;
          }
        }

        mask[by * this.cols + bx] = count ? sum / count / 255 : 0;
      }
    }

    this.ink = mask;
  }

  /** Feed a pointer position in CSS pixels relative to the canvas. */
  pointerMove(cssX: number, cssY: number, cssWidth: number, cssHeight: number) {
    if (!this.w || !this.h) return;
    const x = (cssX / cssWidth) * this.w;
    const y = (cssY / cssHeight) * this.h;

    if (!this.pointer.primed) {
      // First sample has no previous position, so it would read as a huge
      // jump from the origin. Seed both and wait for the next move.
      this.pointer.px = x;
      this.pointer.py = y;
      this.pointer.primed = true;
    }
    this.pointer.x = x;
    this.pointer.y = y;
    this.pointer.active = true;
    this.wake();
  }

  pointerLeave() {
    this.pointer.active = false;
    this.pointer.primed = false;
  }

  /** Inject a radial burst around a point. */
  burst(cssX: number, cssY: number, cssWidth: number, cssHeight: number, strength = 1) {
    const field = this.field;
    if (!field || !this.w) return;
    const { blockSize, maxVector, floodThreshold } = this.opts;
    // Same per-axis cap as the pointer path: an absolute pixel budget would
    // blow a short element clean off its own canvas.
    const capX = Math.min(maxVector, Math.max(2, this.w * 0.18));
    const capY = Math.min(maxVector, Math.max(2, this.h * 0.18));
    const cx = (cssX / cssWidth) * this.w;
    const cy = (cssY / cssHeight) * this.h;
    // A burst is deliberately wider than a drag, but still bounded by the
    // element — otherwise one click floods a small card end to end.
    const radius = this.effectiveRadius(1.6);
    const r2 = radius * radius;

    for (let by = 0; by < this.rows; by++) {
      for (let bx = 0; bx < this.cols; bx++) {
        const px = bx * blockSize + blockSize / 2;
        const py = by * blockSize + blockSize / 2;
        const dx = px - cx;
        const dy = py - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const d = Math.sqrt(d2) || 1;
        // Squared falloff, not linear. With a linear ramp the magnitude stays
        // above `floodThreshold` across most of the radius, so the whole disc
        // flattens to one colour. Squaring keeps the peak at the click point
        // and drops off fast, so only a small core floods and the ring around
        // it tears — which is the part that actually reads as pixel corruption.
        const falloff = (1 - d / radius) ** 2;
        // Bound the peak against `floodThreshold` rather than letting it run
        // to the full `maxVector`. Flooded pixels are re-displaced every frame
        // by the feedback loop, so a block that floods on impact keeps pushing
        // its flat colour outward and the whole element eventually fills in.
        // Keeping the peak just over the threshold floods a small core and
        // leaves the rest tearing.
        const peak = Math.min(maxVector, floodThreshold * 1.3);
        const mag = peak * falloff * strength;
        const i = (by * this.cols + bx) * 2;
        field[i] = clamp(field[i] + (dx / d) * mag, -capX, capX);
        field[i + 1] = clamp(field[i + 1] + (dy / d) * mag, -capY, capY);
      }
    }
    this.wake();
  }

  /**
   * Shear a horizontal band of the image sideways — a torn scanline.
   *
   * `burst` is a disc and `drift` is global; neither can address ONE line of
   * text. This confines the push to block rows within `cssBand` of `cssY`,
   * with a smooth vertical falloff so the band has no hard top/bottom seam,
   * and alternates direction every block row so the band reads as interleaved
   * scanlines slipping against each other rather than one slab sliding over.
   * Horizontal only: a row of type has lots of travel sideways and none
   * vertically before it collides with its neighbours.
   *
   * @param cssY     band centre, CSS px relative to the element.
   * @param cssBand  band height, CSS px.
   * @param strength 0..1 of the per-axis cap.
   * @param dir      -1 | 1, the direction of the even rows (odd rows oppose).
   */
  shear(cssY: number, cssBand: number, cssHeight: number, strength = 1, dir = 1) {
    const field = this.field;
    const ink = this.ink;
    if (!field || !this.w) return;
    const { blockSize, maxVector, floodThreshold } = this.opts;
    // SET the band's x-vector to a target rather than adding to it. Shear is
    // called every frame while a line is in its envelope; accumulating pushed
    // the magnitude past `floodThreshold` within a few frames and the band
    // collapsed to a flat slab running to the viewport edge — measured as the
    // boxed-in look returning by a different road. A target the heal pulls
    // against stays bounded for any number of frames.
    //
    // The field is a per-frame VELOCITY, not an offset: a row held at
    // `maxVector` moves `maxVector` px every frame and leaves the canvas in
    // a dozen frames (measured: the lines scattered to the viewport edges and
    // flooded into a slab at 26/frame). The visible slip is the integral over
    // the frames a line spends in its envelope, so the per-frame target is
    // small — a few px — and the duration does the accumulating.
    const capX = Math.min(
      maxVector * 0.16,
      floodThreshold * 0.1,
      Math.max(1, this.w * 0.18),
    );
    const scale = this.h / cssHeight;
    const cy = cssY * scale;
    const half = Math.max(blockSize, (cssBand * scale) / 2);

    for (let by = 0; by < this.rows; by++) {
      const py = by * blockSize + blockSize / 2;
      const t = 1 - Math.abs(py - cy) / half;
      if (t <= 0) continue;
      // Smoothstep so the band's edges feather instead of stepping.
      const fall = t * t * (3 - 2 * t);
      const sign = by % 2 === 0 ? dir : -dir;
      const target = sign * capX * fall * strength;
      for (let bx = 0; bx < this.cols; bx++) {
        const bi = by * this.cols + bx;
        // Same ink gate as `explode`: blocks with no ink in their 3x3
        // neighbourhood are left alone. Shearing empty rows smears the
        // background colour (transparent -> but alpha-weighted) sideways and
        // was what drew the slab out past the glyphs to the canvas edge.
        if (ink && !this.hasInkNear(bx, by)) continue;
        const i = bi * 2;
        // Approach the target rather than snapping, so the band settles in
        // over a few frames instead of popping.
        field[i] += (target - field[i]) * 0.5;
      }
    }
    this.wake();
  }

  /** Max block-ink in the 3x3 neighbourhood is non-trivial. */
  private hasInkNear(bx: number, by: number) {
    const ink = this.ink;
    if (!ink) return true;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = by + dy;
      if (ny < 0 || ny >= this.rows) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = bx + dx;
        if (nx < 0 || nx >= this.cols) continue;
        if (ink[ny * this.cols + nx]! > 0.02) return true;
      }
    }
    return false;
  }

  /**
   * Push the whole field in one direction — a uniform drift rather than a
   * radial event.
   *
   * `pointerMove` and `burst` are both *local*: they decay with distance from
   * a point, which is right for a cursor or a click but wrong for "the whole
   * title smears upward". This adds the same vector to every block, so the
   * image tears along one axis across its full width.
   *
   * @param dirX -1..1 horizontal bias.
   * @param dirY -1..1 vertical bias. Negative is up (canvas y grows downward).
   * @param strength 0..1 of the safe per-frame budget.
   */
  drift(dirX: number, dirY: number, strength = 1) {
    const field = this.field;
    if (!field || !this.w || strength <= 0) return;

    const { maxVector, floodThreshold } = this.opts;

    // Same per-axis budget as the pointer path: an absolute pixel cap shreds a
    // short element, since a few px of displacement is a large fraction of a
    // single line of text.
    const capX = Math.min(maxVector, Math.max(2, this.w * 0.18));
    const capY = Math.min(maxVector, Math.max(2, this.h * 0.18));

    // Hold the per-frame push below `floodThreshold`. A uniform field has no
    // falloff to protect it, so driving every block past the flood point turns
    // the entire element into flat colour within a few frames instead of
    // tearing it. Bursts can exceed this because their peak is a single point.
    const budget = Math.min(maxVector, floodThreshold * 0.85) * strength;

    // Normalise so a diagonal is not √2 stronger than a cardinal direction.
    const len = Math.hypot(dirX, dirY) || 1;
    const ax = (dirX / len) * budget;
    const ay = (dirY / len) * budget;

    for (let i = 0; i < field.length; i += 2) {
      field[i] = clamp(field[i] + ax, -capX, capX);
      field[i + 1] = clamp(field[i + 1] + ay, -capY, capY);
    }
    this.wake();
  }

  /**
   * Multiply alpha down to zero across the outer `edgeFade` pixels, so the
   * buffer boundary is invisible rather than a cut line.
   *
   * Operates on the OUTGOING pixels only — see the call site for why this must
   * not touch the reference frame.
   */
  /**
   * Thin each block's alpha by how far it has travelled, so the leading edge of
   * a smear dissolves instead of terminating in a hard front.
   *
   * Like `applyEdgeFade`, this runs on the OUTGOING pixels after the buffer
   * swap. Folding it into the reference frame would re-multiply the same alpha
   * every frame and permanently erode the image.
   *
   * The multiplier is sampled bilinearly between block centres rather than
   * applied per block: a flat per-block value makes the block grid itself
   * visible as a staircase, which trades one hard edge for many.
   */
  private applyTravelFade(data: Uint8ClampedArray) {
    const travel = this.travel;
    if (!travel || this.opts.travelFade <= 0) return;

    const { w, h, cols, rows } = this;
    const bs = this.opts.blockSize;
    const half = bs / 2;

    for (let y = 0; y < h; y++) {
      // Position in block space, measured between block CENTRES.
      const gy = (y - half) / bs;
      const by0 = Math.max(0, Math.min(rows - 1, Math.floor(gy)));
      const by1 = Math.max(0, Math.min(rows - 1, by0 + 1));
      const fy = Math.max(0, Math.min(1, gy - by0));
      const row0 = by0 * cols;
      const row1 = by1 * cols;

      let p = y * w * 4 + 3;
      for (let x = 0; x < w; x++, p += 4) {
        if (data[p] === 0) continue;

        const gx = (x - half) / bs;
        const bx0 = Math.max(0, Math.min(cols - 1, Math.floor(gx)));
        const bx1 = Math.max(0, Math.min(cols - 1, bx0 + 1));
        const fx = Math.max(0, Math.min(1, gx - bx0));

        const t00 = travel[row0 + bx0]!;
        const t10 = travel[row0 + bx1]!;
        const t01 = travel[row1 + bx0]!;
        const t11 = travel[row1 + bx1]!;

        const top = t00 + (t10 - t00) * fx;
        const bottom = t01 + (t11 - t01) * fx;
        const t = top + (bottom - top) * fy;

        if (t < 1) data[p] = data[p]! * t;
      }
    }
  }

  private applyEdgeFade(data: Uint8ClampedArray) {
    const fade = this.opts.edgeFade;
    if (fade <= 0) return;

    const { w, h } = this;
    // Cannot fade further than half the buffer from each side, or the two
    // ramps would overlap and dim the centre of the image.
    const fx = Math.min(fade, Math.floor(w / 2));
    const fy = Math.min(fade, Math.floor(h / 2));
    if (fx < 1 && fy < 1) return;

    for (let y = 0; y < h; y++) {
      // Distance to the nearest horizontal edge, normalised across the ramp.
      const ty = fy < 1 ? 1 : Math.min(1, Math.min(y, h - 1 - y) / fy);
      let p = y * w * 4 + 3;
      for (let x = 0; x < w; x++, p += 4) {
        const tx = fx < 1 ? 1 : Math.min(1, Math.min(x, w - 1 - x) / fx);
        const t = tx < ty ? tx : ty;
        if (t >= 1) continue;
        // Smoothstep rather than linear: a straight ramp still leaves a
        // perceptible line where the gradient starts, because the eye is
        // sensitive to the discontinuity in the first derivative.
        data[p] = data[p] * (t * t * (3 - 2 * t));
      }
    }
  }

  /**
   * Push every block *away from the element's centre* — the image tears
   * outward in all directions at once.
   *
   * `drift` moves the whole field along one axis, so the title slides as a
   * slab. `burst` radiates outward but decays with distance from a point, so
   * it only ever affects a disc. This is the third case: radial like a burst,
   * global like a drift. Blocks near the centre barely move and blocks at the
   * edges move most, which reads as the word pulling itself apart rather than
   * sliding or being punched.
   *
   * @param strength 0..1 of the safe per-frame budget.
   */
  explode(strength = 1) {
    const field = this.field;
    if (!field || !this.w || strength <= 0) return;

    const ink = this.ink;

    const { maxVector, blockSize } = this.opts;

    const capX = Math.min(maxVector, Math.max(2, this.w * 0.18));
    const capY = Math.min(maxVector, Math.max(2, this.h * 0.18));

    // Budget off `maxVector` alone, NOT `floodThreshold`.
    //
    // `drift` derives its budget from `floodThreshold`, which couples the two:
    // raising the flood ceiling to stop blocks collapsing to flat colour also
    // raises the push, so the fix cancels itself and the smear never heals
    // (measured: 25.7k residual ink against 15.9k at rest). Sizing the push
    // from the displacement clamp instead lets `floodThreshold` do its one job
    // — deciding when a block is corrupt enough to flood — independently.
    const budget = maxVector * strength;

    const cx = this.w / 2;
    const cy = this.h / 2;
    // Normalise distance against the half-diagonal so the corner blocks reach
    // exactly 1.0 and nothing is scaled past the budget.
    const maxDist = Math.hypot(cx, cy) || 1;

    for (let by = 0; by < this.rows; by++) {
      for (let bx = 0; bx < this.cols; bx++) {
        const px = bx * blockSize + blockSize / 2;
        const py = by * blockSize + blockSize / 2;
        let dx = px - cx;
        let dy = py - cy;
        const d = Math.hypot(dx, dy);

        // The exact centre block has no outward direction. Leave it be rather
        // than dividing by zero and flinging it somewhere arbitrary.
        if (d < 1e-3) continue;

        dx /= d;
        dy /= d;

        // Ramp with distance: the centre holds, the edges fly. A uniform
        // magnitude here would just inflate the whole word evenly, which reads
        // as a scale-up rather than a tear.
        let mag = budget * (d / maxDist);

        // Scale by how much ink this block and its neighbours hold.
        //
        // This is the fix for the visible container edge. Pushing every block
        // regardless of content means the empty corners — the furthest from
        // centre, so the hardest pushed — smear into flat slabs that trace the
        // canvas rectangle exactly. Gating on ink keeps displacement on the
        // letterforms, so the corruption has the shape of the word.
        //
        // The neighbourhood max (a 1-block dilation) rather than this block's
        // own alpha: a glyph must be able to tear OUTWARD into the empty space
        // beside it. Gating on the block's own ink alone would wall the effect
        // in at the glyph boundary and read as clipping.
        if (ink) {
          let near = 0;

          for (let oy = -1; oy <= 1 && near < 1; oy++) {
            const ny = by + oy;
            if (ny < 0 || ny >= this.rows) continue;
            for (let ox = -1; ox <= 1; ox++) {
              const nx = bx + ox;
              if (nx < 0 || nx >= this.cols) continue;
              const a = ink[ny * this.cols + nx]!;
              if (a > near) near = a;
            }
          }

          // Empty neighbourhood: leave the field completely alone. Not a
          // small push — zero. Any residual push here is what draws the box.
          if (near <= 0.004) continue;

          // Soft-knee so the outline of the ink mask does not itself become a
          // visible hard edge.
          mag *= Math.min(1, near * 1.6);
        }

        const i = (by * this.cols + bx) * 2;
        field[i] = clamp(field[i] + dx * mag, -capX, capX);
        field[i + 1] = clamp(field[i + 1] + dy * mag, -capY, capY);
      }
    }
    this.wake();
  }

  /** Restore the original source and clear the motion field. */
  reset() {
    if (this.source && this.buf) this.buf.set(this.source);
    this.field?.fill(0);
    this.injected?.fill(0);
    // The buffer IS the source now; no need to wait out the heal window.
    this.quietFrames = this.quietThresholdFrames();
    this.needsFrame = false;
    this.setQuiet(true);
    this.renderStatic();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  /**
   * Apply one displacement step using the current motion field.
   * Use `setSource(video, { estimateMotion: true })` followed by `advance()`
   * for each sampled video frame. Use `start()` for a continuous animation.
   * Does nothing while `start()` is running, preventing duplicate steps.
   */
  advance() {
    if (this.disposed || this.running) return;
    this.step();
  }

  /**
   * Run a gesture and record whatever it added to the field as INJECTED force,
   * so a subsequent `replace`-mode motion estimate preserves it.
   *
   * The gesture methods (`drift`, `burst`, `shear`, `explode`) write straight
   * into `field`, which is correct for `start()`-driven use. Under a live
   * stream the next estimate overwrites the field by design, which erased
   * gestures entirely. Rather than thread a flag through all four, the delta
   * they produce is captured here and re-applied on top of each estimate.
   */
  private captureInjected(run: () => void) {
    const field = this.field;
    if (!field) {
      run();
      return;
    }
    if (!this.injected || this.injected.length !== field.length) {
      this.injected = new Float32Array(field.length);
    }
    const before = new Float32Array(field);
    run();
    const inj = this.injected;
    for (let i = 0; i < field.length; i++) inj[i] += field[i] - before[i];
  }

  /** `drift`, but surviving `replace`-mode motion estimation. */
  driftInjected(dirX: number, dirY: number, strength = 1) {
    this.captureInjected(() => this.drift(dirX, dirY, strength));
  }

  /** `burst`, but surviving `replace`-mode motion estimation. */
  burstInjected(
    cssX: number,
    cssY: number,
    cssWidth: number,
    cssHeight: number,
    strength = 1,
  ) {
    this.captureInjected(() => this.burst(cssX, cssY, cssWidth, cssHeight, strength));
  }

  /** `explode`, but surviving `replace`-mode motion estimation. */
  explodeInjected(strength = 1) {
    this.captureInjected(() => this.explode(strength));
  }

  /** `shear`, but surviving `replace`-mode motion estimation. */
  shearInjected(cssY: number, cssBand: number, cssHeight: number, strength = 1, dir = 1) {
    this.captureInjected(() => this.shear(cssY, cssBand, cssHeight, strength, dir));
  }

  private wake() {
    if (this.disposed) return;
    this.needsFrame = true;
    this.quietFrames = 0;
    this.setQuiet(false);
    this.scheduleFrame();
  }

  private scheduleFrame() {
    if (!this.running || this.disposed || !this.needsFrame || this.rafId) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      if (!this.running) return;
      this.step();
      this.scheduleFrame();
    });
  }

  /** Enable animation. Settled sources sleep until the next input or source update. */
  start() {
    if (this.disposed) return;
    this.running = true;
    this.scheduleFrame();
  }

  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  dispose() {
    this.stop();
    this.disposed = true;
    this.source = this.buf = this.next = this.prevSource = null;
    this.injected = null;
    this.image = null;
    this.field = null;
    this.travel = null;
    this.ink = null;
  }

  /** Paint the pristine source once, with no displacement applied. */
  renderStatic() {
    if (!this.image || !this.source) return;
    this.image.data.set(this.source);
    this.ctx.putImageData(this.image, 0, 0);
  }

  /**
   * Effective influence radius in internal px.
   *
   * `influenceRadius` is an absolute value tuned for full-size images. On a
   * small element it exceeds the buffer entirely — a 130px radius over a
   * 230x119 card reaches every block at once, so a single gesture flattens
   * the whole thing to one colour instead of tearing part of it. Cap the
   * radius against the element's own diagonal so the damage stays local and
   * the effect reads the same at any size.
   */
  private effectiveRadius(spread = 1) {
    const raw = this.opts.influenceRadius * this.opts.resolutionScale * spread;
    const diag = Math.hypot(this.w, this.h);
    // The ceiling is applied AFTER any spread multiplier — otherwise a burst
    // scales straight back past the cap it was meant to respect.
    return Math.max(blockFloor(this.opts.blockSize), Math.min(raw, diag * 0.34));
  }

  private injectPointer() {
    const field = this.field;
    if (!field || !this.pointer.active || !this.pointer.primed) return;

    const { blockSize, maxVector, force } = this.opts;

    // `maxVector` is an absolute pixel cap, which is fine on a large image but
    // destroys a short element: a 38px-tall buffer displaced by 14px loses
    // over a third of its height off-canvas every frame, and a line of text
    // quickly smears into nothing. Cap displacement at a fraction of each
    // axis so the effect scales with the element instead of erasing it.
    const capX = Math.min(maxVector, Math.max(2, this.w * 0.18));
    const capY = Math.min(maxVector, Math.max(2, this.h * 0.18));

    const vx = (this.pointer.x - this.pointer.px) * force;
    const vy = (this.pointer.y - this.pointer.py) * force;
    this.pointer.px = this.pointer.x;
    this.pointer.py = this.pointer.y;

    if (Math.abs(vx) < 0.01 && Math.abs(vy) < 0.01) return;

    const r = this.effectiveRadius();
    const r2 = r * r;
    const cx = this.pointer.x;
    const cy = this.pointer.y;

    // Only walk blocks inside the influence box, not the whole field.
    const bx0 = clamp(Math.floor((cx - r) / blockSize), 0, this.cols - 1);
    const bx1 = clamp(Math.ceil((cx + r) / blockSize), 0, this.cols - 1);
    const by0 = clamp(Math.floor((cy - r) / blockSize), 0, this.rows - 1);
    const by1 = clamp(Math.ceil((cy + r) / blockSize), 0, this.rows - 1);

    for (let by = by0; by <= by1; by++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        const px = bx * blockSize + blockSize / 2;
        const py = by * blockSize + blockSize / 2;
        const dx = px - cx;
        const dy = py - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const falloff = 1 - Math.sqrt(d2) / r;
        const w = falloff * falloff;
        const i = (by * this.cols + bx) * 2;
        field[i] = clamp(field[i] + vx * w, -capX, capX);
        field[i + 1] = clamp(field[i + 1] + vy * w, -capY, capY);
      }
    }
  }

  private step() {
    const { buf, next, source, field, image, travel } = this;
    if (!buf || !next || !source || !field || !image) return;

    this.injectPointer();

    const {
      blockSize,
      decay,
      healRate,
      channelShift,
      floodThreshold,
      maxVector,
      travelFade,
    } = this.opts;
    const w = this.w;
    const h = this.h;

    // Normalise travel against the clamp: a block at full `maxVector` scores 1.
    const travelRef = Math.max(1, maxVector);

    // Injected force decays on the same curve as the field itself, so a
    // gesture fades out instead of persisting forever as a standing push.
    const inj = this.injected;
    if (inj) {
      for (let i = 0; i < inj.length; i++) {
        const v = inj[i] * decay;
        inj[i] = Math.abs(v) < 0.01 ? 0 : v;
      }
    }

    let anyMotion = false;

    for (let by = 0; by < this.rows; by++) {
      const y0 = by * blockSize;
      const y1 = Math.min(y0 + blockSize, h);

      for (let bx = 0; bx < this.cols; bx++) {
        const x0 = bx * blockSize;
        const x1 = Math.min(x0 + blockSize, w);

        const bi = by * this.cols + bx;
        const fi = bi * 2;
        const vx = field[fi];
        const vy = field[fi + 1];
        const mag = Math.hypot(vx, vy);

        // Idle blocks: straight copy, then heal toward the pristine source.
        // This is the cheap path and most blocks take it.
        if (mag < 0.05) {
          for (let y = y0; y < y1; y++) {
            let p = (y * w + x0) * 4;
            for (let x = x0; x < x1; x++, p += 4) {
              if (healRate > 0) {
                next[p] = buf[p] + (source[p] - buf[p]) * healRate;
                next[p + 1] = buf[p + 1] + (source[p + 1] - buf[p + 1]) * healRate;
                next[p + 2] = buf[p + 2] + (source[p + 2] - buf[p + 2]) * healRate;
                next[p + 3] = buf[p + 3] + (source[p + 3] - buf[p + 3]) * healRate;
              } else {
                next[p] = buf[p];
                next[p + 1] = buf[p + 1];
                next[p + 2] = buf[p + 2];
                next[p + 3] = buf[p + 3];
              }
            }
          }
          field[fi] = vx * decay;
          field[fi + 1] = vy * decay;
          if (travel) travel[bi] = 1;
          continue;
        }

        anyMotion = true;

        const dx = Math.round(vx);
        const dy = Math.round(vy);
        // Chroma lags luma under stress — this is the magenta/green fringe.
        const cs = Math.round(clamp(mag * channelShift * 0.1, 0, 6));

        // Alpha multiplier for this block, based on how far it has travelled.
        // A block sitting at the clamp is the SMEAR FRONT: without this it
        // keeps full opacity and terminates in a hard straight line, which is
        // exactly what reads as a container edge on the axis where the content
        // nearly fills the buffer. Fading with travel dissolves that front
        // wherever it happens to land, independent of buffer geometry.
        //
        // RECORDED, not applied here: multiplying it into `next` would fold the
        // fade into the reference frame and re-multiply it every frame, so
        // sustained motion would eat the image away permanently (measured: rest
        // ink 16,192 px healing to only 9,569 px after one fast pass). It is
        // applied to the outgoing pixels after the buffer swap instead — the
        // same discipline `applyEdgeFade` already follows.
        const tf =
          travelFade > 0 ? Math.max(0, 1 - travelFade * Math.min(1, mag / travelRef)) : 1;
        if (travel) travel[bi] = tf;

        // Past the flood threshold the block collapses to a single averaged
        // colour, the way a macroblock decoded from DC coefficients alone
        // goes flat. This is what produces the solid poster-like fields.
        if (mag > floodThreshold) {
          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;
          let n = 0;
          // Separate counter for colour-bearing samples — see the loop below.
          let cn = 0;
          for (let y = y0; y < y1; y += 2) {
            const sy = clamp(y - dy, 0, h - 1);
            for (let x = x0; x < x1; x += 2) {
              const sx = clamp(x - dx, 0, w - 1);
              const p = (sy * w + sx) * 4;
              const pa = buf[p + 3];
              // Alpha is averaged over EVERY sample (so the block keeps the
              // right coverage), but colour is averaged only over pixels that
              // actually have colour. Transparent pixels store RGB = 0,0,0 in
              // non-premultiplied canvas data, so including them would drag
              // every flooded block toward black.
              a += pa;
              n++;
              if (pa > 8) {
                r += buf[p];
                g += buf[p + 1];
                b += buf[p + 2];
                cn++;
              }
            }
          }
          if (n > 0) {
            // Colour divides by the opaque-sample count, alpha by the total.
            // If the block was entirely transparent there is no colour to
            // average, so leave RGB at 0 — alpha is 0 too, so it stays clear.
            if (cn > 0) {
              r /= cn;
              g /= cn;
              b /= cn;
            }
            a /= n;

            // CHROMA LAG, BOUNDED BY THE SOURCE.
            //
            // The previous version read `(r - g)` out of `buf` and wrote the
            // amplified result straight back, so `buf` fed its own output in
            // next frame. That is geometric, not additive: a 50% per-frame
            // amplification of the R/B deviation from green saturates in ~5-15
            // frames no matter what the camera sent. Measured: pure grey 128
            // converged to (250,128,5) — maximal orange from a neutral input —
            // and removing the additive `spread` entirely did NOT fix it,
            // because the ratio term alone is sufficient. A fixed `+spread` on
            // red and `-spread*0.7` on blue also made the drift
            // direction-locked (warm), so every block travelled the same way.
            //
            // Three properties this version holds instead:
            //
            //  1. The reference is the PRISTINE source, not `buf`. The lag is
            //     recomputed from the camera's own chroma each frame, so it
            //     cannot compound through the feedback buffer.
            //  2. LUMA IS PRESERVED. Collapse changes hue, never brightness,
            //     so a flooded region stops reading as a dark muddy slab.
            //  3. Deviation is CLAMPED to a fraction of the source chroma, so
            //     a block can lag but never invent colour the camera did not
            //     see. A grey source stays grey because its chroma is zero and
            //     zero times anything is zero.
            const si =
              (clamp(y0 + ((y1 - y0) >> 1), 0, h - 1) * w +
                clamp(x0 + ((x1 - x0) >> 1), 0, w - 1)) *
              4;
            const sr = source[si];
            const sg = source[si + 1];
            const sb = source[si + 2];

            // Luma of the block as sampled from the (corrupted) buffer. This
            // is what the displacement legitimately produced, so it is kept.
            const luma = 0.299 * r + 0.587 * g + 0.114 * b;

            // The source's own chroma, as offsets from its luma. Zero for a
            // grey pixel — which is exactly why grey now stays grey.
            const sluma = 0.299 * sr + 0.587 * sg + 0.114 * sb;
            const cr = sr - sluma;
            const cg = sg - sluma;
            const cb = sb - sluma;

            // Chroma lag strength: 0 at the flood threshold, rising with
            // magnitude but capped, so it is a visible artifact and not a
            // runaway. `cs` is the existing per-block channel-shift estimate.
            const lag = clamp(cs / 6, 0, 1) * 0.85;

            // Rotate the source chroma rather than scaling one channel, so the
            // hue shifts (the characteristic magenta/green fringe) instead of
            // always heating up. Sign comes from the block's vertical motion,
            // so neighbouring blocks moving differently lag differently.
            const dir = vy >= 0 ? 1 : -1;
            let dr = dir * lag * (cg - cb);
            let dg = dir * lag * (cb - cr);
            let db = dir * lag * (cr - cg);

            // The rotation must be LUMA-NEUTRAL or it compounds. A raw channel
            // rotation has a non-zero luma projection
            // (-0.473·cr + 0.185·cg + 0.288·cb), and because `luma` is re-read
            // from `buf` every frame that projection accumulates: measured skin
            // tone fell 174 -> 27 and dark navy rose 32 -> 236 over 240 frames.
            // Subtracting the rotation's own luma makes it a pure hue shift, so
            // brightness is carried solely by the displacement.
            const dLuma = 0.299 * dr + 0.587 * dg + 0.114 * db;
            dr -= dLuma;
            dg -= dLuma;
            db -= dLuma;

            // GAMUT FIT, so the clamp never has to fire.
            //
            // `clamp` is not luma-neutral: clipping a channel at 0 or 255
            // silently adds luma back. On a dark saturated block the chroma
            // pushes a channel below zero, the clamp lifts it, and because
            // `luma` is re-read from `buf` the lift compounds — measured dark
            // navy rising 32 -> 236 even with a luma-neutral rotation. So
            // instead of clipping the result, scale the whole chroma vector by
            // the largest factor that keeps every channel inside [0,255].
            // Hue and luma are both preserved; only saturation gives way,
            // which is the correct trade for a dark or already-vivid block.
            let tr = cr + dr;
            let tg = cg + dg;
            let tb = cb + db;
            let fit = 1;
            for (const c of [tr, tg, tb]) {
              if (c > 0 && luma + c > 255) fit = Math.min(fit, (255 - luma) / c);
              else if (c < 0 && luma + c < 0) fit = Math.min(fit, luma / -c);
            }
            if (fit < 1) {
              if (fit < 0) fit = 0;
              tr *= fit;
              tg *= fit;
              tb *= fit;
            }

            const rr = clamp(luma + tr, 0, 255);
            const gg2 = clamp(luma + tg, 0, 255);
            const bb = clamp(luma + tb, 0, 255);
            for (let y = y0; y < y1; y++) {
              let p = (y * w + x0) * 4;
              for (let x = x0; x < x1; x++, p += 4) {
                next[p] = rr;
                next[p + 1] = gg2;
                next[p + 2] = bb;
                next[p + 3] = a;
              }
            }
          }
          field[fi] = vx * decay;
          field[fi + 1] = vy * decay;
          continue;
        }

        // Normal displaced copy, sampling the PREVIOUS frame. Because `buf`
        // is already wrong from prior frames, the error compounds — which is
        // the entire effect.
        for (let y = y0; y < y1; y++) {
          const sy = clamp(y - dy, 0, h - 1);
          const rowSrc = sy * w;
          let p = (y * w + x0) * 4;
          for (let x = x0; x < x1; x++, p += 4) {
            const sx = clamp(x - dx, 0, w - 1);
            const gp = (rowSrc + sx) * 4;
            const rp = (rowSrc + clamp(sx - cs, 0, w - 1)) * 4;
            const bp = (rowSrc + clamp(sx + cs, 0, w - 1)) * 4;
            // Canvas stores NON-premultiplied RGBA, so a fully transparent
            // pixel keeps RGB = 0,0,0. The chroma taps are offset from the
            // alpha tap, so on a transparent background (text, rounded
            // corners) a tap easily lands on a transparent pixel while alpha
            // comes from an opaque one — writing pure black into the smear.
            // Fall back to the centre tap whenever a chroma tap is
            // transparent, so trails carry the element's own colour.
            next[p] = buf[rp + 3] > 8 ? buf[rp] : buf[gp];
            next[p + 1] = buf[gp + 1];
            next[p + 2] = buf[bp + 3] > 8 ? buf[bp + 2] : buf[gp + 2];
            // Alpha follows the luma (green) tap so transparent regions stay
            // transparent as they smear, instead of turning into black slabs.
            // The travel-based thinning of the smear front is applied after the
            // swap, so it never compounds into the reference frame.
            next[p + 3] = buf[gp + 3];
          }
        }

        field[fi] = vx * decay;
        field[fi + 1] = vy * decay;
      }
    }

    // Swap read/write buffers: this frame becomes the next frame's reference.
    this.buf = next;
    this.next = buf;

    image.data.set(this.buf);
    // Feather AFTER the swap, so the mask is applied to what gets PAINTED but
    // never written back into the reference frame. Folding it into `buf` would
    // compound every frame — the fade would eat inward until the whole image
    // dissolved, because each pass would re-multiply alpha that was already
    // reduced.
    this.applyTravelFade(image.data);
    this.applyEdgeFade(image.data);
    this.ctx.putImageData(image, 0, 0);

    // Quiet bookkeeping. Wakes on the SAME frame motion appears, so the host
    // can switch to the canvas before the first displaced frame is seen;
    // sleeps only after the heal window has fully elapsed.
    if (anyMotion) {
      this.quietFrames = 0;
      this.setQuiet(false);
    } else {
      const threshold = this.quietThresholdFrames();
      if (this.quietFrames < threshold) this.quietFrames++;
      if (this.quietFrames >= threshold) this.setQuiet(true);
      if (this.quiet || this.opts.healRate <= 0) this.needsFrame = false;
    }
  }
}
