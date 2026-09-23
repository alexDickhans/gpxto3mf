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

## Check a 3MF

```bash
npm run validate-3mf
node scripts/validate-3mf.mjs path/to/model.3mf
```

`npm run validate-3mf` builds a mesh from `public/sample.gpx` and the default palette, then checks the 3MF. The checker (`scripts/validate-3mf.mjs`) reads the OPC package and runs mesh tests — index bounds, degenerate and duplicate faces, winding, boundary / non-manifold edges, and watertight components — in parallel across Node worker threads. `--self-test` repeats those checks on a single thread and compares the defect counts, including a few hundred thousand triangles so the wall-clock speedup is printed. If Python `lib3mf` is installed, file checks also ask lib3mf whether the package reads and the mesh is manifold and oriented.

## Smoke test

With `npm run dev` running:

```bash
node scripts/e2e-smoke.mjs
```
