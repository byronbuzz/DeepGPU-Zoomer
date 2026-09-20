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
- Main, Colouring and Advanced controls share one movable, resizable tabbed
  panel. Drag the spare strip above its connected tabs, or focus that strip and use arrow keys. The tab row
  supports Left/Right/Home/End. Reset panel layout restores its initial size
  and position. Layout and background opacity are device-local; the footer uses
  that opacity. Palette and lighting editors are inline disclosure sections.
- Resize Julia from its bottom-right corner. The previous complete image stays
  visible until a coherent replacement is ready. Selection updates coalesce;
  images finish even during continuous dragging. Displayed c labels the
  displayed image; M always promotes the latest selection with main precision
  and iteration limit. The preview follows its displayed size and device pixel
  ratio, subject to GPU capacity, and uses its own
  1,000-iteration limit, independent of the main viewport's limit.
- The iteration slider is logarithmic from 32 to 1,000,000. Fixed mode is the
  backward-compatible default. Dynamic mode adds 50 iterations per completed
  zoom decade from Home, rounds upward to 32 and clamps at 1,000,000. The UI
  shows base and effective limits; the effective limit is latched between
  admitted jobs so in-flight work keeps one stable identity. This is a bounded
  variable-detail policy, not an equal-quality speed claim. Depth uses `10^50.37×` notation without
  converting the full magnification to a JavaScript number.
- Palette stops are dragged directly and adjusted with Left/Right. Clicking a
  stop opens a nonmodal anchored RGB picker; valid hex or swatch edits recolour
  immediately. New palette edits are seamless repeating gradients and retain
  2–8 stops, stop-bound randomisation locks, reversal, even spacing and
  undo/redo. Older non-repeating saved colours still load. Ten compact presets
  are visibly labelled as adaptations of documented Matplotlib colormaps.
- Colour mappings retain the original five IDs for smooth escape, classic
  bands, XaoS binary/colour decomposition and biomorphs. Ten additional
  formulas use escape scalars or honestly labelled final endpoint coordinates.
  Endpoint-dependent mappings acquire their missing channels once; scalar-only
  formula changes reuse the field. Colour spacing uses an exponential slider;
  distance lighting explicitly opts into derivative computation. Capped samples
  default to black, with twelve optional low-cost final-orbit patterns. Five
  are labelled XaoS endpoint adaptations; the remaining patterns are original.
  Capped is not proven interior.
- Places includes whole-set, Seahorse Valley, period-1215 and structured
  Mandelbrot/Julia 1e50 views. Moving away clears the preset label.
- Built-in Places and browser-local saved locations share one grouped selector
  with distinct IDs. Save locations, return Home, fully reset preferences while
  retaining saved locations, or copy a share link.
  Coordinates, span, c, iteration limit and appearance round-trip without
  trimming digits. Old links use default appearance.

Every page load starts at shallow Home (`10^0`, 1,000 iterations). It retains
saved locations, palette/appearance and panel preferences, but never restores a
remembered deep camera or iteration budget automatically. A URL hash is parsed
and staged without starting its calculation; Main shows **Open linked
location** to apply that exact payload. Copy exact link does not rewrite the
current address bar, so a base-URL reload remains Home.

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
weights pointer detail alongside exposed or poorly resolved coverage. Spatial
service persists across compatible retargets. Intermediate 8/4/2 sample strides
compete locally with exact work; there is no whole-viewport stage barrier.
Sparse actual target samples compete with dense work by
visible density deficit and calculation cost. Adequate existing coverage
suppresses sparse work; there is no mandatory whole-view preview stage.
Sparse samples fill hard-edged display blocks only: the scalar slots between
them remain unknown until calculated. The compositor prefers finer available
source coverage, with exact current-view pixels authoritative at completion.
Priorities follow the live camera and current-target progress between GPU batches,
with deterministic broad service so other visible gaps finish. Shading chooses
the finest available aligned anchor. This adapts XaoS's documented dynamic
resolution priority principles without its line-reallocation engine.

Camera changes retarget the same calculation process after bounded useful work.
Releasing the mouse changes demand, without cancelling compatible pending work,
changing the grid resolution or starting a separate quality stage. Matching
complex coordinates retain their scalar samples through the existing GPU remap;
off-grid retained imagery is presentation-only. Once the camera is unchanged,
the same queue finishes every exact target pixel. Palette changes reuse scalars.

The footer's refinement percentage is conservative exact-tier progress for the
current target: only completed dense target samples and proven exact reuse are
credited. Sparse preview samples and overlapping presentation coverage are not
summed. It can decrease or reset as camera demand changes and reaches 100% only
after the current field and any optional final pass have drained.

Advanced offers optional completed-image antialiasing, off by default. It is a
single cached low-preset FXAA-style presentation pass over a completed fractal
image. Compatible sRGB texture views make its filtered reads and attachment
writes light-correct while retaining 8-bit storage. It does not rerun orbits, alter the numerical field or its coverage
alpha, filter the DOM HUD, recover missing subpixel detail, or claim to be the
universally cheapest antialiasing method. Toggling it off presents the retained
raw completion again. GPU profiling, when supported and enabled, reports this
pass separately from recurrence and shading. The adapted shader and licenses
are pinned in `NOTICE.md`.

Before retargeting a partial image, the hard-edge composite is retained as a
display proxy, including its validity and sample density. One original completed source
also remains available for broader coverage, including highly magnified coarse
fallback where partial detail has holes. Proxies never populate numerical
storage or establish exact completion. Priority uses a bounded conservative
collection of known rectangles and their spacing. Overlaps count only their
finest density; discarded older hints may cause redundant priority, never false
scalar validity. Proxies use an anchored presentation lattice: fractional pans do not repeatedly
round already retained pixels into a different phase. They remain approximate
display samples until the exact numerical queue covers the current view.
Retained proxies use half-float internal colour/density storage so broad valid
samples do not disappear through byte-alpha rounding. The extra precision is
for sub-byte sample-density metadata, not HDR display. Canvas presentation,
completed images and PNG exports remain ordinary opaque 8-bit RGB.

Measured expensive 64K-sample batches stalled presentation, so the queue starts
at 16K samples and grows cheap batches using measured cost. Changes of numerical
method, precision or iteration budget reset that estimate. Rectangle
splitting can make an individual dispatch smaller. This trades some numerical
throughput for responsiveness; eight milliseconds is a sizing target, not a
GPU latency guarantee. Input state never selects a different batch policy.
The Julia preview can run between main-stream batches.
Orbit pipelines compile
asynchronously. Ordinary product rendering does not build or use BLA skips.
Explicit development experiments can opt in; expanded experimental views rebuild
the table's conservative offset bound while retaining the reference orbit.
Statistics distinguish reference work, pipeline wait, optional table preparation,
completed-field wall time and copied/computed samples.
Wide perturbation carries the already decoded absolute reference sample across
iterations and reuses the current Mandelbrot value for its identical rebase
comparison; this changes neither the recurrence nor its magnitude test.
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

The browser smoke needs the development server and installed stable Edge.
It uses an isolated sandboxed profile and covers the current product surface.
Set `GPU_ZOOMER_URL` and `GPU_ZOOMER_TEST_DIR` to override the server and
external evidence directory. No browser profiles or recordings belong here.

The larger independent arithmetic/GPU campaign is preserved as an explicit
`npm run qualify:numerical` gate for numerical changes. Superseded UI campaigns
and manual pages are archived under `qualification/archive`, outside default
test and build discovery. Numerical qualification includes CPU regressions, 20 GPU arithmetic/orbit checks, atomic
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
The external suite includes native preview resizing at normal and high DPI;
the in-app suite checks size-matched preview backing sizes across aspect ratios.
Seven original numerical views compare 49 raw escape counts each with independently
structured 512/768-bit direct evaluation, including the difficult 6e-42
view and both original 1e50 fixtures. An eighth regression preserves the
reported 10,000-iteration view near (-0.730641524956718, 0.161803892923925),
span 5.34548e-18, and checks 73 points including the failing pixels and their
immediate neighbours against the same independent oracles.

These are sampled checks, not universal per-pixel certification. One original
fixed-cap pixel independently escapes at 19688 while the unaccelerated GPU path
reports 19679; this remains unresolved. Mandelbrot
and Julia perturbation share QD-derived four-f32 mantissas for coordinates,
reference transport, recurrence and rebasing. Julia keeps BLA disabled, and
direct Mandelbrot retains its cheaper compensated-pair path.
The older BLA path is disabled by default after demonstrated additional count
and endpoint errors. It remains available only through explicit development
opt-in for diagnostics; its bounded polynomial and pair coefficient transport
remain unqualified approximations.
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
The one-million cap is supported, not a speed promise. Work counters use paired
words so high-cap totals do not wrap at 32 bits. Reference/table allocations
check actual device capacity; optional experimental BLA preparation yields cooperatively and high-cap
batches shrink. Cancellation still waits for an already submitted GPU batch.
GPU loss requires a reload. There is no built-in recording or public deploy.

## Licensing

GPL-3.0-or-later. See LICENSE and NOTICE.md for adopted code and attribution.
