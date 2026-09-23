# gpxto3mf

GPX → AMS multicolor 3MF terrain topo with a raised route line.

## Dev

```bash
npm install
npm run dev
```

Open the URL Vite prints. Upload a `.gpx`, optionally import a palette (see `public/sample-palette.json`), then **Download 3MF**.

Sample files: `public/sample.gpx`, `public/sample-palette.json`.

## Build / deploy

```bash
npm run build   # → dist/
```

Netlify: `netlify.toml` publishes `dist/` and serves `netlify/functions/tile-proxy.ts` at `/api/dem/*` and `/api/imagery/*` (Terrarium DEM + Esri World Imagery). Local Vite uses the same paths via a middleware proxy in `vite.config.ts`.

## Smoke test

With `npm run dev` running:

```bash
node scripts/e2e-smoke.mjs
```
