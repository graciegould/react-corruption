import { useRef, useState, type ReactNode } from 'react';
import {
  Corrupt,
  CorruptImage,
  type CorruptHandle,
  type CorruptImageHandle,
  type CorruptionOptions,
  type CorruptTrigger,
} from 'react-corruption';
import 'react-corruption/styles.css';

import { VideoExample } from './VideoExample';

const advanced = [
  ['channelShift', 'Colour separation', 0, 6, 0.1],
  ['maxVector', 'Maximum displacement', 1, 40, 1],
  ['influenceRadius', 'Pointer radius', 1, 400, 1],
  ['floodThreshold', 'Colour flattening threshold', 1, 30, 0.5],
] as const;

type SectionProps = {
  id: string;
  title: string;
  blurb?: string;
  /** 'content' uses <Corrupt>, 'image' uses <CorruptImage>. */
  kind?: 'content' | 'image';
  defaultTrigger?: CorruptTrigger;
  /** Build the preview given the live controls and a ref to attach for manual mode. */
  render: (args: {
    controls: {
      intensity: number;
      trigger: CorruptTrigger;
      disabled: boolean;
      options: Partial<CorruptionOptions>;
    };
    contentRef: React.Ref<CorruptHandle>;
    imageRef: React.Ref<CorruptImageHandle>;
  }) => ReactNode;
  /** Build the code snippet string from the live controls. */
  code: (args: {
    intensity: number;
    trigger: CorruptTrigger;
    disabled: boolean;
    options: Partial<CorruptionOptions>;
  }) => string;
};

/** A self-contained mini-playground: preview + full controls + live code. */
function DemoSection({
  id,
  title,
  blurb,
  kind = 'content',
  defaultTrigger = 'hover',
  render,
  code,
}: SectionProps) {
  const [intensity, setIntensity] = useState(0.5);
  const [trigger, setTrigger] = useState<CorruptTrigger>(defaultTrigger);
  const [disabled, setDisabled] = useState(false);
  const [options, setOptions] = useState<Partial<CorruptionOptions>>({});
  const [copyStatus, setCopyStatus] = useState('');
  const contentRef = useRef<CorruptHandle>(null);
  const imageRef = useRef<CorruptImageHandle>(null);

  const controls = { intensity, trigger, disabled, options };
  const snippet = code(controls);
  const effect = () => (kind === 'image' ? imageRef.current : contentRef.current);

  return (
    <section className="section" id={id} aria-labelledby={`${id}-h`}>
      <div className="section__head">
        <h2 id={`${id}-h`} className="section__title">
          {title}
        </h2>
        {blurb && <p className="section__blurb">{blurb}</p>}
      </div>

      <div className="section__grid">
        <div className="section__preview" data-demo={id}>
          {render({ controls, contentRef, imageRef })}
          {trigger === 'manual' && (
            <div className="section__manual">
              <button
                type="button"
                disabled={disabled || intensity === 0}
                onClick={() => effect()?.corrupt()}
              >
                Corrupt
              </button>
              <button type="button" onClick={() => effect()?.reset()}>
                Reset
              </button>
            </div>
          )}
          <p className="section__hint">
            {disabled || intensity === 0
              ? 'Effect off — original content stays visible.'
              : trigger === 'hover'
                ? 'Hover or tap the preview. Click for a burst.'
                : trigger === 'click'
                  ? 'Click or tap the preview for a burst.'
                  : 'Use Corrupt to play, Reset to restore.'}
          </p>
        </div>

        <div className="section__controls">
          <div className="control">
            <label>
              <span>
                Intensity <output>{intensity}</output>
              </span>
              <input
                aria-label={`Intensity for ${title}`}
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={intensity}
                onChange={(e) => setIntensity(Number(e.target.value))}
              />
            </label>
          </div>
          <div className="control">
            <label>
              <span>
                Pixel size <output>{options.blockSize ?? 8}</output>
                <code>blockSize</code>
              </span>
              <input
                aria-label={`Pixel size for ${title}`}
                type="range"
                min="2"
                max="32"
                step="1"
                value={options.blockSize ?? 8}
                onChange={(e) =>
                  setOptions((cur) => ({ ...cur, blockSize: Number(e.target.value) }))
                }
              />
            </label>
          </div>
          <div className="control">
            <label>
              <span>
                Healing speed <output>{options.healRate ?? 0.25}</output>
                <code>healRate</code>
              </span>
              <input
                aria-label={`Healing speed for ${title}`}
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={options.healRate ?? 0.25}
                onChange={(e) =>
                  setOptions((cur) => ({ ...cur, healRate: Number(e.target.value) }))
                }
              />
            </label>
          </div>
          <div className="control control--row">
            <label>
              <span>Trigger</span>
              <select
                aria-label={`Trigger for ${title}`}
                value={trigger}
                onChange={(e) => setTrigger(e.target.value as CorruptTrigger)}
              >
                <option value="hover">Hover</option>
                <option value="click">Click</option>
                <option value="manual">Manual</option>
              </select>
            </label>
            <label className="control__check">
              <input
                type="checkbox"
                checked={disabled}
                onChange={(e) => setDisabled(e.target.checked)}
              />
              <span>Disabled</span>
            </label>
          </div>

          <details className="control__advanced">
            <summary>Advanced options</summary>
            <div className="control__advanced-grid">
              {advanced.map(([key, label, min, max, step]) => (
                <label key={key}>
                  <span>{label}</span>
                  <code>{key}</code>
                  <input
                    type="number"
                    aria-label={`${label} for ${title}`}
                    placeholder="Auto"
                    min={min}
                    max={max}
                    step={step}
                    value={options[key] ?? ''}
                    onChange={(e) => {
                      const raw = e.target.value;
                      setOptions((cur) => {
                        const next = { ...cur };
                        if (!raw) delete next[key];
                        else next[key] = Math.max(min, Math.min(max, Number(raw)));
                        return next;
                      });
                    }}
                  />
                </label>
              ))}
            </div>
            <button type="button" onClick={() => setOptions({})}>
              Clear overrides
            </button>
          </details>
        </div>
      </div>

      <div className="section__code">
        <div className="section__code-head">
          <span className="section__code-label">Code</span>
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(snippet);
                setCopyStatus('Copied');
                window.setTimeout(() => setCopyStatus(''), 1500);
              } catch {
                setCopyStatus('Select the code to copy.');
              }
            }}
          >
            {copyStatus || 'Copy'}
          </button>
        </div>
        <pre>
          <code>{snippet}</code>
        </pre>
      </div>
    </section>
  );
}

/** Shared code-snippet builder for <Corrupt>/<CorruptImage> sections. */
function buildCode(
  component: 'Corrupt' | 'CorruptImage',
  children: string,
  {
    intensity,
    trigger,
    disabled,
    options,
  }: {
    intensity: number;
    trigger: CorruptTrigger;
    disabled: boolean;
    options: Partial<CorruptionOptions>;
  },
) {
  const handle = component === 'CorruptImage' ? 'CorruptImageHandle' : 'CorruptHandle';
  const props = [
    trigger === 'manual' ? 'ref={effect}' : '',
    intensity !== 0.5 ? `intensity={${intensity}}` : '',
    trigger !== 'hover' ? `trigger="${trigger}"` : '',
    disabled ? 'disabled' : '',
    Object.keys(options).length ? `options={${JSON.stringify(options)}}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const tag = `${component}${props ? ` ${props}` : ''}`;
  const body =
    component === 'CorruptImage'
      ? `<${tag} ${children} />`
      : `<${tag}>\n      ${children}\n    </${component}>`;
  return `${trigger === 'manual' ? "import { useRef } from 'react';\n" : ''}import { ${component}${
    trigger === 'manual' ? `, type ${handle}` : ''
  } } from 'react-corruption';\nimport 'react-corruption/styles.css';\n\nexport function Example() {\n${
    trigger === 'manual' ? `  const effect = useRef<${handle}>(null);\n` : ''
  }  return (\n    ${body}\n  );\n}`;
}

type Controls = {
  intensity: number;
  trigger: CorruptTrigger;
  disabled: boolean;
  options: Partial<CorruptionOptions>;
};

function FormPreview({
  controls,
  contentRef,
}: {
  controls: Controls;
  contentRef: React.Ref<CorruptHandle>;
}) {
  const [name, setName] = useState('');
  const [submitted, setSubmitted] = useState('');
  return (
    <>
      <Corrupt ref={contentRef} {...controls}>
        <form
          className="demo-form"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(name ? `Submitted: ${name}` : 'Submitted (empty)');
          }}
        >
          <h3>Still a real form.</h3>
          <label className="demo-form__field">
            Your name
            <input
              type="text"
              value={name}
              placeholder="Type here…"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="demo-form__row">
            <button type="submit">Submit</button>
            <button
              type="button"
              onClick={() => {
                setName('');
                setSubmitted('');
              }}
            >
              Clear
            </button>
          </div>
        </form>
      </Corrupt>
      <p className="demo-form__status" aria-live="polite">
        {submitted || 'The controls stay live under the effect.'}
      </p>
    </>
  );
}

export function App() {
  return (
    <main className="page">
      <header className="hero">
        <h1 className="hero__title">react-corruption</h1>
        <p className="hero__sub">
          Interactive pixel corruption for React. Wrap any content, hover, and watch it
          distort — move away and it restores. Each section below is a live playground.
        </p>
      </header>

      <DemoSection
        id="text"
        title="Text"
        render={({ controls, contentRef }) => (
          <Corrupt ref={contentRef} {...controls}>
            <p className="demo-headline">Make some noise.</p>
          </Corrupt>
        )}
        code={(c) => buildCode('Corrupt', '<h1>Make some noise.</h1>', c)}
      />

      <DemoSection
        id="article"
        title="Article"
        render={({ controls, contentRef }) => (
          <Corrupt ref={contentRef} {...controls}>
            <article className="wiki">
              <h1>Pixel corruption</h1>
              <p className="wiki__sub">From the free glitch encyclopedia</p>
              <p>
                Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod
                tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim
                veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea
                commodo consequat.
              </p>
              <h2>Etymology</h2>
              <p>
                Duis aute irure dolor in reprehenderit in voluptate velit esse cillum
                dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non
                proident, sunt in culpa qui officia deserunt mollit anim id est laborum.
              </p>
              <h2>Technique</h2>
              <p>
                Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium
                doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo
                inventore veritatis et quasi architecto beatae vitae dicta sunt.
              </p>
            </article>
          </Corrupt>
        )}
        code={(c) =>
          buildCode(
            'Corrupt',
            '<article>\n        <h1>Pixel corruption</h1>\n        <p>Lorem ipsum dolor sit amet…</p>\n      </article>',
            c,
          )
        }
      />

      <DemoSection
        id="scrapbook"
        title="Images"
        kind="image"
        render={({ controls, imageRef }) => (
          <div className="scrapbook">
            <CorruptImage
              ref={imageRef}
              className="scrapbook__item scrapbook__item--a"
              src="/dandelion.png"
              alt="Dandelion"
              {...controls}
            />
            <CorruptImage
              className="scrapbook__item scrapbook__item--b"
              src="/sunflower.png"
              alt="Sunflower"
              {...controls}
            />
            <CorruptImage
              className="scrapbook__item scrapbook__item--c"
              src="/pink-zinnia.png"
              alt="Pink zinnia"
              {...controls}
            />
          </div>
        )}
        code={(c) => buildCode('CorruptImage', 'src="/sunflower.png" alt="Sunflower"', c)}
      />

      <DemoSection
        id="form"
        title="Form"
        blurb="A working input and buttons stay interactive under the effect."
        defaultTrigger="click"
        render={({ controls, contentRef }) => (
          <FormPreview controls={controls} contentRef={contentRef} />
        )}
        code={(c) =>
          buildCode(
            'Corrupt',
            '<form>\n        <input type="text" placeholder="Type here…" />\n        <button type="submit">Submit</button>\n      </form>',
            c,
          )
        }
      />

      <section className="section" id="webcam" aria-labelledby="webcam-h">
        <div className="section__head">
          <h2 id="webcam-h" className="section__title">
            Webcam
          </h2>
          <p className="section__blurb">
            Motion-driven corruption on a live camera stream. Your app owns the camera.
          </p>
        </div>
        <VideoExample />
      </section>

      <footer className="footer">
        <p>react-corruption — MIT © Gracie Gould</p>
      </footer>
    </main>
  );
}
