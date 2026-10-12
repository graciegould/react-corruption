# Changelog

## 0.1.0 — 2026-10-12

First public release of react-corruption.

- `CorruptVideo` supports existing video elements, motion sampling, freeze, and original/effect comparison.
- Static effects stop processing pixels when settled and wake on interaction.
- CommonJS consumers resolve their matching TypeScript declarations.
- Packaging now builds and validates automatically before packing.

- `Corrupt` and `CorruptImage` apply interactive pixel corruption to content and
  images with `intensity`, `trigger`, and `disabled` controls.
- `corrupt()` and `reset()` provide simple manual playback. Advanced motion
  methods remain available on `CorruptHandle`.
- `CorruptionEngine` and DOM capture utilities are available through `/core`.
- Images preserve transparency and fall back to their original content.
- Effects respect reduced motion, pause offscreen, and preserve DOM interaction.
- The playground includes Text, Image, and Card examples with copyable React code.
