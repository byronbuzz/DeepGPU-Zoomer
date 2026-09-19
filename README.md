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

One renderer-owned queue serves motion and rest at the exact requested pixel
spacing. It recursively splits pending rectangles at their midpoint. Zoom-in
prioritises the pointer; outward zoom and pan prioritise exposed or poorly
resolved coverage. Sparse actual target samples compete with dense work by
visible density deficit and calculation cost. Adequate existing coverage
suppresses sparse work; there is no mandatory whole-view preview stage.
Sparse samples fill hard-edged display blocks only: the scalar slots between
them remain unknown until calculated. The compositor prefers finer available
source coverage, with exact current-view pixels authoritative at completion.
Priorities follow the live camera between GPU batches, with regular oldest-work
turns so other visible gaps finish. This adapts XaoS's documented dynamic
resolution priority principles without its line-reallocation engine.

Camera changes retarget the same calculation process after bounded useful work.
Releasing the mouse changes demand, without cancelling compatible pending work,
changing the grid resolution or starting a separate quality stage. Matching
complex coordinates retain their scalar samples through the existing GPU remap;
off-grid retained imagery is presentation-only. Once the camera is unchanged,
the same queue finishes every exact target pixel. Palette changes reuse scalars.

Before retargeting a partial image, the hard-edge composite is retained as a
display proxy, including its validity and sample density. One original completed source
also remains available for broader coverage, including highly magnified coarse
fallback where partial detail has holes. Proxies never populate numerical
storage or establish exact completion. Priority uses a conservative known
rectangle and its spacing, not a proxy's whole extent; smaller disjoint determined
patches can therefore receive redundant priority. Proxies use an anchored presentation lattice: fractional pans do not repeatedly
round already retained pixels into a different phase. They remain approximate
display samples until the exact numerical queue covers the current view.
Retained proxies use half-float colour/density storage so broad valid samples
do not disappear through byte-alpha rounding. This doubles proxy texture bytes;
the scalar field and normal output textures retain their existing formats.

Measured expensive 64K-sample batches stalled presentation, so the queue starts
at 16K samples and grows cheap batches using measured cost. Changes of numerical
method, precision or iteration budget reset that estimate. Rectangle
splitting can make an individual dispatch smaller. This trades some numerical
throughput for responsiveness; eight milliseconds is a sizing target, not a
GPU latency guarantee. Input state never selects a different batch policy.
The Julia preview can run between main-stream batches.
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

Current checks include 76 CPU tests, 20 GPU arithmetic/orbit checks, atomic
publication across GPU fences, exact copied sample identity, nearest
magnification/minification, palette reuse, Julia preview/promotion/return,
rapid family changes, responsive layout and 1440p motion/refinement. Streaming
checks read actual GPU presentation pixels before field completion, including
unknown-sample fallback, incompatible Julia constants and partial-field reuse.
Continuous-stream checks cover same-promise release, exact partial reuse, full-field
convergence after a pan, sparse anchors versus display-filled unknown slots,
and camera/palette demand arriving during final readback.
Proxy checks compare 40 fractional pans with original-source reprojection and
verify that unmappable history stays transparent, 1024x broad sources survive
repeated retention, and coarser incoming samples preserve finer available pixels.
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
