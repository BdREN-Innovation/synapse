# Branding Overlay — BdREN Synapse

This file tracks every place the "LibreChat" upstream branding was changed to
"BdREN Synapse" (short: "Synapse"), so future upstream merges know exactly
where conflicts are likely and why each change exists. See
`repo-management-guide.md` (in the BdREN Synapse planning folder) for the full
update procedure.

Brand palette: **purple** `#9A278E` (identity, from the Synapse logo) +
**orange** `#F5871F` (interactive accent — buttons, links, focus, hover).

## New files (zero merge risk)

- `client/src/components/Auth/NetworkBackground.tsx` — animated network-graph
  canvas + watermark shown behind login/registration.
- `client/public/assets/synapse-icon.svg` — icon-only mark used as the login
  watermark and available for future use.
- `brand-source/` — original source PNGs (logo, favicon, model icon) kept for
  regenerating assets at other sizes later.

## Same-name asset replacements (zero merge risk)

All in `client/public/assets/`: `logo.svg`, `favicon-16x16.png`,
`favicon-32x32.png`, `apple-touch-icon-180x180.png`, `icon-192x192.png`,
`maskable-icon.png`. Plus `bdrenmodelicon.png` (new file, reserved for a
future `modelSpecs` entry — see `services-and-config-guide.md`).

## Upstream files touched (small, isolated edits)

| File | What changed |
|---|---|
| `client/index.html` | `<title>`, meta description, `theme-color` (→ purple) |
| `client/vite.config.ts` | PWA manifest `name`/`short_name`/`theme_color`/`background_color` |
| `client/tailwind.config.cjs` | `green` color scale hex values → orange ramp (this scale backs every direct `text-green-*`/`hover:text-green-700`-style utility class in the app, e.g. auth page links) |
| `client/src/style.css` | `--brand-purple`, `--surface-submit`, `--surface-submit-hover` hex values changed directly in the `:root`/`html`/`.dark` blocks (see note below on why this replaced a separate overlay file) |
| `client/src/components/Auth/AuthLayout.tsx` | mounts `<NetworkBackground />`; wrapped `Banner`/`DisplayError`/`Footer`/logo/`ThemeSelector`/`main` in `relative z-10` so they stack above the new background layer |
| `client/src/locales/en/translation.json` | `com_ui_latest_footer`, `com_agents_mcp_trust_subtext`, `com_ui_api_keys_description`, `com_a11y_logo_alt` (admin panel only — n/a here) |
| `client/src/components/Chat/Footer.tsx` | default-footer fallback text + link (only renders if `CUSTOM_FOOTER` env is unset) |
| `client/src/components/Agents/Marketplace.tsx` | browser tab title |
| `client/src/components/Nav/SettingsTabs/About/About.tsx` | diagnostics label |

## Left unchanged (intentional)

- All `package.json` `"name"` fields and `@librechat/*` / `librechat-data-provider`
  package scopes — internal identifiers, not user-visible.
- Non-English locale files (`client/src/locales/<lang>/translation.json`) — per
  `CLAUDE.md`, only English is hand-edited; others are automated externally.
- Code comments and `.spec`/`.test` files referencing "LibreChat".
- `startupConfig?.appTitle ?? 'LibreChat'`-style fallbacks (e.g. `Startup.tsx`,
  `AuthLayout.tsx` alt text) — these already resolve to "BdREN Synapse" at
  runtime via `APP_TITLE` in `.env`; the literal `'LibreChat'` is only a
  double-fallback default, never shown in practice.
- `AdminSettingsDialog.tsx` docs link — points at real LibreChat documentation,
  left as a genuinely useful reference.

## Why direct edits instead of an overlay CSS file

The original plan used a separate `bdren-theme.css` imported via one
`@import` line appended at the end of `style.css` (the classic "config
overlay" trick). Testing in the actual dev server showed Vite's CSS
dev-transform silently drops an `@import` that isn't the first rule in the
file (unlike a full production Rollup/postcss-import build, which would have
inlined it) — the override never took effect and the submit button stayed
green. Rather than ship something that only works in one build mode, the
three variables were edited directly in `style.css`'s existing `:root`/`html`/
`.dark` blocks (the same approach already used for the Tailwind `green`
scale, which was verified working). Slightly more upstream-file surface, but
correct in both dev and production.

## Login/registration network background

`NetworkBackground.tsx` is a self-contained canvas component (no new
dependencies) rendering ~28–56 drifting purple nodes/edges matching the logo's
motif. Nodes warm from purple to orange near the cursor and ripple outward on
click. Respects `prefers-reduced-motion` (renders one static frame), pauses on
tab-hidden, caps `devicePixelRatio` at 2, and is `aria-hidden` (purely
decorative, doesn't affect keyboard/screen-reader flow).
