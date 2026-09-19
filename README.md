# GPU-Zoomer-3

A browser-only Mandelbrot and quadratic Julia explorer. WebGPU computes
multiprecision reference orbits and compensated, exponent-carrying pixel deltas.
Coordinates and saved views retain their decimal precision.

## Run locally

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5183 in stable Edge or Chrome with hardware WebGPU.
Node.js/npm are development tools; visitors install nothing. No native helper,
unsafe browser flags or cloud compute is required. `npm run build` checks
TypeScript and builds `dist`; `npm run preview` serves that build locally.

## Explore

- Hold left/right mouse to zoom in/out, steering with the pointer. Shift-drag
  or middle-drag pans; the wheel zooms. On the focused canvas, +/− zoom,
  arrow keys pan, and Esc stops motion.
- J toggles a small Julia preview. While it is open, left-click/drag selects
  the exact Mandelbrot point as c without zooming the main view. M opens the
  selected Julia; M again restores the preserved Mandelbrot view.
- The preview has independent resources and latest-selection cancellation.
  Its 240×160 image uses up to 512 iterations; promotion uses the main view's
  unchanged iteration limit and full numerical renderer.
- Places includes whole-set, Seahorse Valley, period-1215 and structured
  Mandelbrot/Julia 1e50 views. Moving away clears the preset label.
- Save browser-local locations, use Back/Forward, or copy a share link.
  Coordinates, span, c and iteration limit round-trip without trimming digits.

## Display and calculation

Completed pixels and their camera, dimensions, family and colour metadata
publish together before any asynchronous yield. Presentation samples the
stored image with nearest filtering: enlarged determined pixels have hard
boundaries. Smooth escape-time colouring remains available; there is no
spatial blend or temporal crossfade in presentation.

During motion, a rolling grid retains fixed complex sample coordinates.
Panning copies matching samples and calculates exposed positions. Zooming
changes the grid spacing by powers of two and retains exact matches on the
nested grids. A small overscan margin preserves coverage. This follows the
coordinate-preserving reuse principle inspected in XaoS/XaoSjs; attribution
is in NOTICE.md. It is not a full XaoS port or an image atlas.
One additional completed image retains broader coverage. Presentation chooses
the finer valid source at each pixel, so a smaller new field cannot erase
already calculated surrounding pixels. Both sources retain their own geometry
and palette identity; neither is resampled into the numerical field.

Calculation resolution follows measured field cost, rather than dropping to
quarter resolution on every input. Existing finer samples remain useful
until further detail or coverage is needed. Once motion stops, the renderer
calculates the exact regular full-resolution camera field. Palette changes
reuse scalar numerical data. Stable grid reuse currently applies to the
single-sample escape-colour mode; the other numerical modes retain their
ordinary calculation path.

The GPU queue receives bounded numerical bands. Orbit pipelines compile
asynchronously. Expanded views rebuild the BLA table's conservative offset
bound while retaining the reference orbit. Statistics distinguish reference work, pipeline wait,
BLA-table preparation, completed-field wall time and copied/computed samples.
Those wall times include waits and are not GPU timestamp measurements.

## Verification and limits

```sh
npm test
npm run build
npm run test:browser
```

The browser suite needs the development server and installed stable Edge.
It uses an isolated sandboxed profile and checks for physical AMD hardware.
Set `GPU_ZOOMER_URL` and `GPU_ZOOMER_TEST_DIR` to override the server and
external evidence directory. No browser profiles or recordings belong here.

Current checks include 64 CPU tests, 20 GPU arithmetic/orbit checks, atomic
publication across GPU fences, exact copied sample identity, nearest
magnification/minification, palette reuse, Julia preview/promotion/return,
rapid family changes, responsive layout and 1440p motion/refinement.
Seven numerical views compare 49 raw escape counts each with independently
structured 512/768-bit direct evaluation, including the difficult 6e-42
view and both original 1e50 fixtures.

These are sampled checks, not universal per-pixel certification. Mandelbrot
uses compensated perturbation and bounded BLA; Julia uses QD-derived
four-f32 mantissas with BLA disabled. Neither WGSL nor these tests establish
universal error-free arithmetic. Precision grows through profiles up to
256 u32 limbs; views beyond that range are rejected.

A roughly 60 Hz presentation callback rate does not imply 60 newly calculated
or correctly delivered display frames. Expensive views magnify known samples
while refinement runs; newly exposed areas use the nearest available edge
until coverage arrives. New detail may change pixels abruptly, with no blur
to hide it. Deep Julia remains substantially more expensive than Mandelbrot.
GPU loss requires a reload. There is no built-in recording or public deploy.

## Licensing

GPL-3.0-or-later. See LICENSE and NOTICE.md for adopted code and attribution.
