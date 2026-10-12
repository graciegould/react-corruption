/**
 * Rasterize a live DOM subtree into a canvas the pixel corruption engine can read.
 *
 * Canvas has no API for "draw this element." The only native path is:
 *   clone the subtree -> inline every computed style -> wrap in an SVG
 *   <foreignObject> -> load that SVG as an image -> drawImage into a canvas.
 *
 * Two constraints drive the whole implementation:
 *
 * 1. THE SVG IS A SEALED DOCUMENT. It cannot reach back into the page for
 *    stylesheets, so a bare clone renders as unstyled markup. Every visual
 *    property has to be copied inline onto every node.
 *
 * 2. THE CANVAS MUST STAY UNTAINTED. `getImageData` throws on a tainted
 *    canvas, which would kill the effect outright. Any cross-origin external
 *    resource (image, webfont) taints it, so external images are inlined as
 *    data URLs and anything that fails to inline is dropped rather than
 *    allowed to poison the canvas.
 */

/**
 * Properties that carry visible appearance. Copying all ~340 computed
 * properties per node is correct but pathologically slow and balloons the
 * serialized SVG; this subset is what actually shows up in a raster.
 */
const PAINTED_PROPERTIES = [
  'background-color',
  'background-image',
  'background-position',
  'background-repeat',
  'background-size',
  'background-clip',
  'background-origin',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-style',
  'border-right-style',
  'border-bottom-style',
  'border-left-style',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-left-radius',
  'border-bottom-right-radius',
  'box-shadow',
  'box-sizing',
  'opacity',
  'overflow-x',
  'overflow-y',
  'color',
  'font-family',
  'font-size',
  'font-style',
  'font-variant',
  'font-weight',
  'letter-spacing',
  'line-height',
  'text-align',
  'text-decoration-line',
  'text-decoration-color',
  'text-indent',
  'text-shadow',
  'text-transform',
  'white-space',
  'word-break',
  'word-spacing',
  'vertical-align',
  'display',
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'z-index',
  'float',
  'clear',
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'flex-direction',
  'flex-wrap',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'justify-content',
  'align-items',
  'align-self',
  'align-content',
  'gap',
  'row-gap',
  'column-gap',
  'order',
  'grid-template-columns',
  'grid-template-rows',
  'grid-column',
  'grid-row',
  'grid-auto-flow',
  'grid-auto-columns',
  'grid-auto-rows',
  'transform',
  'transform-origin',
  'object-fit',
  'object-position',
  'list-style-type',
  'list-style-position',
  'fill',
  'stroke',
  'stroke-width',
  'visibility',
  'mix-blend-mode',
  'filter',
  'backdrop-filter',
] as const;

/** Escape a string for safe inclusion in an HTML attribute value. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Fetch an external image and convert it to a data URL.
 * Returns null on any failure — the caller drops the node rather than risk
 * tainting the canvas.
 */
async function toDataUrl(url: string): Promise<string | null> {
  if (url.startsWith('data:')) return url;
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () =>
        resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/**
 * Walk source and clone in parallel, copying computed styles inline.
 * Collects <img> nodes for async inlining afterwards — style copying must be
 * synchronous so the DOM is read in a single consistent pass.
 */
function cloneWithStyles(
  source: Element,
  pendingImages: { node: HTMLImageElement; src: string }[],
): Element {
  const clone = source.cloneNode(false) as Element;

  if (source instanceof HTMLElement || source instanceof SVGElement) {
    const computed = window.getComputedStyle(source);
    const parts: string[] = [];
    for (const prop of PAINTED_PROPERTIES) {
      const value = computed.getPropertyValue(prop);
      if (!value) continue;
      // `none`/`normal`/`auto` are defaults; skipping them cuts the
      // serialized payload roughly in half with no visual change.
      if (value === 'none' || value === 'normal' || value === 'auto') continue;
      parts.push(`${prop}:${value}`);
    }
    if (parts.length) clone.setAttribute('style', parts.join(';'));
  }

  if (clone instanceof HTMLImageElement && source instanceof HTMLImageElement) {
    if (source.currentSrc || source.src) {
      pendingImages.push({ node: clone, src: source.currentSrc || source.src });
    }
  }

  // Canvases don't survive cloneNode — swap in a static snapshot of pixels.
  if (source instanceof HTMLCanvasElement) {
    try {
      const snapshot = document.createElement('img');
      snapshot.src = source.toDataURL();
      snapshot.setAttribute('style', clone.getAttribute('style') ?? '');
      return snapshot;
    } catch {
      // Tainted canvas — drop it rather than propagate the taint.
      return document.createElement('span');
    }
  }

  for (const child of Array.from(source.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      clone.appendChild(child.cloneNode(true));
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      // Skip invisible nodes and our own overlay canvases.
      const cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (el.hasAttribute('data-corrupt-ignore')) continue;
      clone.appendChild(cloneWithStyles(el, pendingImages));
    }
  }

  return clone;
}

export interface RasterizeResult {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

/**
 * Render `element` to an offscreen canvas at `scale` device pixels per CSS px.
 * Rejects if the raster fails — callers should fall back to the plain DOM.
 */
export async function rasterizeElement(
  element: HTMLElement,
  scale = 1,
): Promise<RasterizeResult> {
  const rect = element.getBoundingClientRect();
  const cssWidth = Math.max(1, Math.ceil(rect.width));
  const cssHeight = Math.max(1, Math.ceil(rect.height));

  const pendingImages: { node: HTMLImageElement; src: string }[] = [];

  // While the effect is running the host sets `opacity: 0` on this
  // subtree so only the canvas shows. The cloner reads COMPUTED styles, including
  // opacity, and skips hidden nodes — so a re-capture during an active corrupt (resize, font
  // load, an armed 'manual' host) would serialize an empty document and the
  // element would vanish entirely.
  //
  // Restore opacity and visibility for the duration of the clone. `cloneWithStyles` is
  // fully synchronous, and this inline style is set and reverted inside the
  // same task, so the browser never gets a chance to paint the unhidden state
  // — there is no flash.
  const priorVisibility = element.style.visibility;
  const priorOpacity = element.style.opacity;
  element.style.visibility = 'visible';
  element.style.opacity = '1';
  let clone: Element;
  try {
    clone = cloneWithStyles(element, pendingImages);
  } finally {
    // Restore exactly what was there, including "no inline style at all".
    if (priorVisibility) element.style.visibility = priorVisibility;
    else element.style.removeProperty('visibility');
    if (priorOpacity) element.style.opacity = priorOpacity;
    else element.style.removeProperty('opacity');
  }

  // Inline external images in parallel; drop any that can't be inlined.
  await Promise.all(
    pendingImages.map(async ({ node, src }) => {
      const dataUrl = await toDataUrl(src);
      if (dataUrl) node.setAttribute('src', dataUrl);
      else node.removeAttribute('src');
    }),
  );

  // The clone is positioned inside the foreignObject, so strip any offset it
  // inherited from its position on the real page.
  if (clone instanceof HTMLElement) {
    // The root's own computed `visibility` was inlined onto the clone by
    // cloneWithStyles. Inside the sealed SVG the clone IS the document root,
    // so force it visible — otherwise a capture taken while the host was
    // hidden renders a blank frame.
    clone.style.visibility = 'visible';
    clone.style.position = 'static';
    clone.style.top = '0';
    clone.style.left = '0';
    clone.style.margin = '0';
    clone.style.width = `${cssWidth}px`;
    clone.style.height = `${cssHeight}px`;
  }

  const markup = new XMLSerializer().serializeToString(clone);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${cssWidth}" height="${cssHeight}">` +
    `<foreignObject x="0" y="0" width="100%" height="100%">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${cssWidth}px;height:${cssHeight}px">` +
    markup +
    `</div></foreignObject></svg>`;

  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

  const img = new Image();
  img.decoding = 'sync';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () =>
      reject(
        new Error(
          'rasterizeElement: SVG failed to load (likely invalid serialized markup)',
        ),
      );
    img.src = url;
  });

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(cssWidth * scale));
  canvas.height = Math.max(1, Math.floor(cssHeight * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('rasterizeElement: 2D context unavailable');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  // Fail loudly here rather than deep inside the render loop: if the canvas
  // is tainted, getImageData throws and the effect silently dies.
  try {
    ctx.getImageData(0, 0, 1, 1);
  } catch {
    throw new Error('rasterizeElement: canvas tainted by a cross-origin resource');
  }

  return { canvas, width: cssWidth, height: cssHeight };
}

export { escapeAttribute };
