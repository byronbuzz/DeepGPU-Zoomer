# GPU-Zoomer-3

A browser-only Mandelbrot and quadratic Julia explorer. WebGPU computes
multiprecision reference orbits and compensated, exponent-carrying pixel
deltas. The camera follows elapsed time; completed fields are reprojected
while fresh calculations lag, and stationary views refine spatially.
Palette changes reuse the numeric field.

## Run locally

Node.js and npm are development tools only; visitors install nothing.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5183 in current stable Edge or Chrome with hardware
WebGPU enabled. No unsafe browser flags, native helper or cloud compute is
used. `npm run build` checks TypeScript and builds `dist`; `npm run preview`
serves the production build locally. This repository does not deploy it.

## Explore

- Hold the left/right mouse button to zoom in/out and steer with the pointer.
  Shift-drag or middle-drag pans; the wheel zooms. On the focused canvas,
  +/− zoom, arrow keys pan, J opens Julia at the pointer, and Esc stops motion.
- Choose either set, edit Julia's constant, or return to the Mandelbrot view
  from which Julia was opened. Controls collapse to leave the canvas clear.
- Places includes the whole set, Seahorse Valley, the difficult period-1215
  minibrot, and structured Mandelbrot and Julia views at 1e50 magnification.
- Save locations in this browser, use Back/Forward, or copy a share link.
  Coordinates, span, Julia constant and iteration limit round-trip without
  trimming their decimal digits. Serialization occurs at user checkpoints,
  not on each animation frame. Palette/speed are presentation preferences.
- The footer distinguishes presentation cadence, spatial refinement and the
  age of the last computed field. A capped point is unresolved at the chosen
  iteration limit; it is not a proof of membership.

The initial target is useful structure at 1e50 in both sets, not a ceiling.
Precision grows through the supported GPU profiles (up to 256 u32 limbs);
views beyond those profiles are rejected. The initial target environment is
Windows 11, stable Edge/Chrome, Radeon RX 9070 XT, 2560×1440 at 60 Hz.
There is no autopilot, nucleus locking or recording.

## Verification and current limits

```sh
npm test
npm run build
npm run test:browser
```

The browser suite requires the development server and installed stable Edge.
It uses an isolated headless profile with the browser sandbox enabled and
checks that the adapter is physical AMD hardware. Set `GPU_ZOOMER_URL` to
override the server, and `GPU_ZOOMER_TEST_DIR` to choose an external evidence
directory. The default is
`F:/Coding/Temp/GPU-Zoomer-3-qualification/app-verification`; no test artifacts
or browser profiles belong in this repository.

Observed on Edge 153.0.4234.32 / RX 9070 XT:

- 58 CPU tests and 20 GPU arithmetic/orbit checks passed, including wide
  Julia absolute/relative transport and compensated cancellation/products.
- At 720×480, all 49 sampled escape counts agreed with independently
  structured direct 512/768-bit evaluation for Mandelbrot home, Seahorse
  Valley, the original difficult 6e-42 span, and the 1e50 minibrot. Julia home
  and initially escaped Julia points also agreed.
- The original structured Julia 1e50 fixture now agrees at **all 49 sampled
  pixels**, including (51,240) = 2543 and (51,377) = 2002, against unchanged
  direct 512/768-bit evaluators. The accepted baseline b0376cb gave 2479/2000.
  Diagnosis isolated reduced absolute-reference precision and accumulated
  perturbation rounding: directly iterating the exact encoded starting
  deltas still gave 2543/2002. Julia now uses QD-derived four-f32 mantissas
  across inputs, GPU reference transport, iteration and rebasing. This closes
  the demonstrated regression; it does not certify every pixel or zoom.
- Exact share reload, palette-only recolouring, Julia selection/return,
  rapid set changes, narrow layout, and short wheel/hold-release refinement
  passed. A five-second 1440p zoom/reversal run measured 59.95 Hz rAF
  presentation cadence, 16.8 ms p95 interval and six fresh fields, followed
  by stationary refinement. This is headless browser scheduling evidence,
  not a physical display latency measurement or a guaranteed frame rate.
- Wider Julia arithmetic has a measured cost. Three warm-reference repeats
  at the original 720×480 deep fixture gave median field times of 121.3 ms
  for b0376cb and 748.9 ms for the repair (about 6.2×). At 180×120 the medians
  were 23.6/180.4 ms. These measure completed numerical fields, separately
  from presentation cadence. Set-specialized compute pipelines retain the
  existing Mandelbrot arithmetic and acceleration.

The tests are sampled practical checks, not universal per-pixel certification.
The compensated arithmetic is verified through actual GPU fields; WGSL
reassociation rules do not justify blanket error-free-transform claims.
Julia uses fixed high-precision c, initial reference Z0 at the view centre,
and high-precision Zm−Z0 samples reduced to 96-bit chunks for rebasing.
Four-component arithmetic is a practical precision choice, not a WGSL
error-free guarantee. Mandelbrot retains BLA with
the remaining-iteration and reference-drift bounds; Julia BLA is disabled.
GPU loss is reported and currently requires a page reload.

## Licensing

GPL-3.0-or-later. See LICENSE and NOTICE.md for adopted code and attribution.
