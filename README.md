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
- Drag the Julia panel's bottom-right corner to resize both dimensions. Its
  backing image follows the available space and device pixel ratio, with
  square complex-plane pixels and a stable vertical span. Selection and resize
  changes cancel obsolete preview work. The preview uses up to 512 iterations;
  promotion retains the main view's iteration limit and full numerical renderer.
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

Single-sample escape-colour rendering publishes completed GPU regions while
the rest of the field is still calculating. The incoming image has explicit
sample validity and fixed geometry; unknown samples cannot replace determined
history pixels. Each batch shades its own region, with one initial validity
pass and one completed-image copy, rather than repeating full-image shading
or copying for every update. Partial progress is not a completed field.

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

The GPU queue receives adaptively sized numerical regions, with visible areas
ahead of overscan and fully retained rectangles omitted from numerical dispatch.
The default batch floor is approximately 64K samples, aligned to workgroups:
measurements found smaller batches sacrificed substantial throughput for little
first-detail benefit. A batch is not guaranteed to fit one display frame.
Compatible interrupted fields retain their determined scalar samples.
Orbit pipelines compile
asynchronously. Expanded views rebuild the BLA table's conservative offset
bound while retaining the reference orbit. Statistics distinguish reference work, pipeline wait,
BLA-table preparation, completed-field wall time and copied/computed samples.
Those wall times include waits and are not GPU timestamp measurements. Optional
GPU profiling reports pass durations using a bounded asynchronous timestamp
readback pool when supported. It is off by default; these timings are neither
hardware cycles nor physical display latency.

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

Current checks include 68 CPU tests, 20 GPU arithmetic/orbit checks, atomic
publication across GPU fences, exact copied sample identity, nearest
magnification/minification, palette reuse, Julia preview/promotion/return,
rapid family changes, responsive layout and 1440p motion/refinement. Streaming
checks read actual GPU presentation pixels before field completion, including
unknown-sample fallback, incompatible Julia constants and partial-field reuse.
Native preview resizing is checked at normal and high DPI.
Seven original numerical views compare 49 raw escape counts each with independently
structured 512/768-bit direct evaluation, including the difficult 6e-42
view and both original 1e50 fixtures. An eighth regression preserves the
reported 10,000-iteration view near (-0.730641524956718, 0.161803892923925),
span 5.34548e-18, and checks 73 points including the failing pixels and their
immediate neighbours against the same independent oracles.

These are sampled checks, not universal per-pixel certification. Mandelbrot
and Julia perturbation share QD-derived four-f32 mantissas for coordinates,
reference transport, recurrence and rebasing. Julia keeps BLA disabled, and
direct Mandelbrot retains its cheaper compensated-pair path.
BLA reads all reference words into its existing double-precision table builder;
its bounded polynomial and pair coefficient transport remain approximations.
Neither WGSL nor these tests establish universal error-free arithmetic.
Precision grows through profiles up to
256 u32 limbs; views beyond that range are rejected.

At the reported view the preceding compensated-pair path disagreed at eight
of those 73 points, including a false escape. Wider transport and recurrence
repair those sampled counts without changing the iteration cap or oracle.
They cost more GPU time; this is a fidelity repair, not a throughput improvement.

A roughly 60 Hz presentation callback rate does not imply 60 newly calculated
or correctly delivered display frames. Expensive views magnify known samples
while refinement runs; newly exposed areas use the nearest available edge
until coverage arrives. New detail may change pixels abruptly, with no blur
to hide it. Deep fields can take seconds to refine at high resolution.
GPU loss requires a reload. There is no built-in recording or public deploy.

## Licensing

GPL-3.0-or-later. See LICENSE and NOTICE.md for adopted code and attribution.
