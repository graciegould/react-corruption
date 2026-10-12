import { useSyncExternalStore } from 'react';
import { DEFAULT_OPTIONS, type CorruptionOptions } from './engine';

export type CorruptTrigger = 'hover' | 'click' | 'manual';

export interface CorruptControls {
  /** Effect strength, 0–1. Default 0.5; 0 shows the original content. */
  intensity?: number;
  /** Hover follows the pointer, click plays a burst, manual uses a ref. */
  trigger?: CorruptTrigger;
  /** Show the original content and stop the effect. */
  disabled?: boolean;
  /** Advanced overrides, applied after the intensity settings. */
  options?: Partial<CorruptionOptions>;
}

export function normalizeIntensity(value = 0.5) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
}

/** Keep the engine defaults stable for direct engine consumers. */
export function resolveOptions(
  kind: 'dom' | 'image',
  intensity: number,
  options?: Partial<CorruptionOptions>,
): CorruptionOptions {
  const amount = normalizeIntensity(intensity);
  const overrides = Object.fromEntries(
    Object.entries(options ?? {}).filter(([, value]) => value !== undefined),
  );
  return {
    ...DEFAULT_OPTIONS,
    alpha: true,
    force: 0.84 * amount,
    maxVector: kind === 'dom' ? 10 * amount : 28 * amount,
    channelShift: 3.4 * amount,
    decay: 0.9 + 0.08 * amount,
    healRate: kind === 'dom' ? 0.24 - 0.16 * amount : 0.022 - 0.02 * amount,
    ...(kind === 'dom' ? { floodThreshold: 13 } : {}),
    ...overrides,
    ...(kind === 'dom' ? { alpha: true } : {}),
  };
}

const query = '(prefers-reduced-motion: reduce)';
const getReducedMotion = () => window.matchMedia(query).matches;
const getServerReducedMotion = () => true;
const subscribe = (notify: () => void) => {
  const media = window.matchMedia(query);
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
};

export function useReducedMotion() {
  return useSyncExternalStore(subscribe, getReducedMotion, getServerReducedMotion);
}
