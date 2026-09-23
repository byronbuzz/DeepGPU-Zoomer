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

- Hold left/right mouse to zoom in/out, steering with the pointer. The default
  zoom speed is 0.8x. Shift-drag
  or middle-drag pans; the wheel zooms. On the focused canvas, +/− zoom,
  arrow keys pan, and Esc stops motion.
- Refresh recalculates the exact current view and starts a new Time taken
  interval while keeping the prior image visible. Stop halts refinement and
  freezes that interval without changing the view; compatible appearance
  edits still recolour retained data. Navigation or numerical-setting changes
  resume calculation. Esc remains motion-only.
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
- The iteration slider is logarithmic from 1 to 1,000,000 and always sets a
  fixed limit. Old links that specify dynamic mode retain their explicit
  iteration limit but no longer enable depth-based increases. Depth uses
  `10^50.37×` notation without converting the full magnification to a
  JavaScript number.
- Palette stops are dragged directly and adjusted with Left/Right. Clicking a
  stop opens a nonmodal anchored RGB picker; valid hex or swatch edits recolour
  immediately. New palette edits are seamless repeating gradients and retain
  2–8 stops, stop-bound randomisation locks, reversal, even spacing and
  undo/redo. Older non-repeating saved colours still load. Ten compact presets
  use adapted colours from documented Matplotlib colormaps.
- Colour mappings retain the original five IDs for smooth escape, classic
  bands, XaoS binary/colour decomposition and biomorphs. Ten additional
  formulas use escape scalars or honestly labelled final endpoint coordinates.
  Endpoint-dependent mappings acquire their missing channels once; scalar-only
  formula changes reuse the field. Colour spacing uses an exponential slider;
  whole-image Hue rotation recolours palette, effects and capped samples without
  changing the numerical field, and old links default to zero rotation;
  distance lighting explicitly opts into derivative computation. Capped samples
  default to black, with twelve optional low-cost final-orbit patterns. Five
  adapt XaoS endpoint ideas; the remaining patterns are original.
  Capped is not proven interior.
- Places includes whole-set, Seahorse Valley, period-1215 and structured
  Mandelbrot/Julia 1e50 views. Moving away clears the preset label.
- Built-in Places and browser-local saved locations share one editable location
  chooser/name with distinct IDs. Selection is explicit; saving the current
  view with a matching name updates that location, while a different-location
  name collision asks for confirmation. Return Home, fully reset preferences
  while retaining saved locations, or copy a share link.
  Coordinates, span, c, iteration limit and appearance round-trip without
  trimming digits. Old links use default appearance.

Every page load starts at shallow Home (`10^0`, 5,000 iterations). It retains
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

One renderer-owned queue serves motion and rest at the requested pixel
spacing. It recursively splits pending rectangles at their midpoint. Zoom-in
weights pointer detail alongside exposed or poorly resolved coverage. Spatial
service persists across compatible retargets. Intermediate 8/4/2 sample strides
compete locally with dense work; there is no whole-viewport stage barrier.
Sparse actual target samples compete with dense work by
visible density deficit and calculation cost. Adequate existing coverage
suppresses sparse work; there is no mandatory whole-view preview stage.
Sparse samples fill hard-edged display blocks only: the scalar slots between
them remain unknown until calculated. The compositor prefers finer available
source coverage, with resolved current-view pixels authoritative at completion.
Priorities follow the live camera and current-target progress between GPU batches,
with deterministic broad service so other visible gaps finish. Shading chooses
the finest available aligned anchor. This adapts XaoS's documented dynamic
resolution priority principles without its line-reallocation engine.

Camera changes retarget the same calculation process after bounded useful work.
Releasing the mouse changes demand, without cancelling compatible pending work,
changing the grid resolution or starting a separate quality stage. Matching
complex coordinates retain their scalar samples through the existing GPU remap;
off-grid retained imagery is presentation-only. Once the camera is unchanged,
the same queue resolves every target pixel. Palette changes reuse scalars.

The footer's refinement percentage is conservative dense-tier progress for the
current target: only resolved dense target samples and compatible retained
samples are credited. Sparse preview samples and overlapping presentation
coverage are not summed. It can decrease or reset as camera demand changes and
reaches 100% only after the current sampling target and any optional final pass
have drained. It is not a mathematical accuracy certificate.

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
storage or establish target completion. Priority uses a bounded conservative
collection of known rectangles and their spacing. Overlaps count only their
finest density; discarded older hints may cause redundant priority, never false
scalar validity. Proxies use an anchored presentation lattice: fractional pans do not repeatedly
round already retained pixels into a different phase. They remain approximate
display samples until the exact numerical queue covers the current view.
Retained proxies use half-float internal colour/density storage so broad valid
samples do not disappear through byte-alpha rounding. The extra precision is
for sub-byte sample-density metadata, not HDR display. Canvas presentation,
completed images and PNG exports remain ordinary opaque 8-bit RGB.

Measured expensive batches stalled presentation, so the numerical submission
floor scales down from roughly 16K samples with the iteration cap; measured cost
can grow batches toward an eight-millisecond target. Sparse preview density begins
near 16K anchors. Changes of numerical method, precision or iteration budget reset
that estimate. Rectangle splitting can make an individual dispatch smaller. This
trades some numerical throughput for responsiveness; eight milliseconds is a
sizing target, not a GPU latency guarantee. Input state does not select a different
batch policy.
The Julia preview can run between main-stream batches.
The initial Home view prepares only its direct calculation, shading, sample
reuse and presentation pipelines; other calculation variants and completed-image
antialiasing compile asynchronously on first demand. The small retained-image
pipelines remain ready for synchronous Stop/Refresh capture. At deep Mandelbrot
scales, every eligible sampling density uses
one standard linear BLA table to skip reference ranges within its existing
radius policy. Ordinary Wide recurrence is the local fallback when a skip is
inapplicable, and changing density does not force recomputation of an already
calculated sample. Deep main-view Julia iteration colouring uses a separate
-40-bound BLA table; its preview, derivative-distance and per-iteration
diagnostic modes, and direct Mandelbrot, do not use BLA. Expanded Mandelbrot
views rebuild the table's conservative offset bound while retaining the orbit.
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
reference transport, recurrence and rebasing. When BLA is enabled, completed
dense Mandelbrot or eligible Julia fields and PNG export use the same linear
approximation policy as navigation samples. Completion means the current
sampling target is fully resolved under that selected policy, not that it
matches the no-skip recurrence or an independent oracle. Julia preview,
derivative-distance and per-iteration diagnostic modes fall back to no skips;
direct Mandelbrot retains its cheaper compensated-pair path. Neither WGSL nor these tests establish
universal error-free arithmetic.
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
check actual device capacity; BLA preparation yields cooperatively and high-cap
batches shrink. Cancellation still waits for an already submitted GPU batch.
GPU loss requires a reload. There is no built-in recording or public deploy.

## Accepted follow-up, 23 September 2026

The first status/fixed-controls release is `f1247acc`, based on `f3885de`. The
isolated 5184 focus experiment (`5f9b5c1`) was rejected and is retained only as
history. This release changes scheduler turn allocation to four pointer, two
distributed and two oldest turns
per eight; its numerical policies, missing-resolution scoring, batching and
submission path remain the stable ones. The footer shows stationary refinement
time and stays visible when the control panel is hidden. Colour spacing reaches
16,384; iteration limits are fixed from 1 to 1,000,000, with Home at 5,000.

Same-view appearance upgrades that need missing endpoint data now keep the
previous completed, antialiased image visible and publish the new appearance
only when its field is complete. Their footer remains at `Refined · 100% ·
Preparing colour data` with the completed time frozen. Disabling Distance
Lighting converts its complete retained endpoint field back to the normal field
without another orbit recurrence. Palette-only edits and re-enabling an already
prepared effect still recolour without recurrence. The controls toggle is an
accessible hamburger; it and the footer remain visible while controls are hidden.

Julia BLA is now enabled for eligible main-view iteration colouring. The same
practical acceptance standard applies to both fractal families: repeated
bounded wall benefit and preservation of major structure and useful detail,
not exact raw iteration equality. The historical
default-bound Julia probe missed 6 of 49 independently checked points. At the
tighter -40 bound, four fresh 960×640 spiral renders gave a 23.6% mean wall
gain (including preparation), with 1.012% changed pixels and the visible
spiral intact. No escape/capped classification changes were observed in this
tested view, which had no capped samples; other views, GPUs and
endpoint-dependent appearances remain unqualified. Patches and raw evidence are in
`F:\Coding\Temp\GPU-Zoomer-3-julia-practical-20260923\RESULT.md` and the
earlier `F:\Coding\Temp\GPU-Zoomer-3-julia-bla-20260923\RESULT.md`.
Use the Codex in-app browser for testing; do not launch an external or headless
browser. Candidate builds must write outside the directory served on 5183: a
source revision or unchanged listener does not establish the served bundle.

Julia BLA is accepted for the current scope; broader numerical qualification is
not a prerequisite for the practical-fidelity target (preserved major structure
and useful detail) in either Julia or Mandelbrot. Park continuous UI-control
latency work on the backlog: prioritising existing-data appearance ahead of
preview, trying temporarily smaller batches, and investigating redundant
reproject/copy submissions. The bounded colour-response measurement is in
`F:\Coding\Temp\GPU-Zoomer-3-colour-response-20260923\RESULT.md`; it does not
establish a change to adopt. Never reinstate the rejected zoom-out numerical-field
cache or the 5184 scheduler architecture. Retain accepted numerical and BLA gains.

Further candidates require evidence before adoption: workgroup, subgroup,
register, temporary-storage and submission efficiencies; redundant spatial
dispatch, boundary/solid filling and adaptive subdivision; a retained-image
row/column experiment; shared series-prefix jumps beyond BLA including their
preparation cost (no separate change is justified without measured residual
prefix work beyond current BLA); independent CPU/GPU preparation or pixel overlap, perhaps
WASM f64/SIMD rather than idle-core parallelism; periodicity beyond Direct,
reference choice beyond the domain-bound fix, and arithmetic cheaper than the
accepted two-word BLA jump. Park tolerance loosening, logarithm/comparator
rewrites, the three-step alignment bridge, wholesale arithmetic replacement,
and another broad profiler campaign. No fixed 10–15% presentation reserve has
been established.

Main begins with Zoom speed and Iteration limit, then retains the Refresh/Stop
action row. J/M and the preview panel's own controls
retain Julia open/return behaviour; Main has no separate preview button or
constant form. Home changes only position and scale for the active family to
the displayed 10^0 view; Full Reset restores defaults. The footer retains a
numeric Time taken during held navigation, starting at release; wheel timing
still starts at the last actual wheel change. The controls panel defaults to
286 CSS pixels wide and resizes from its left, right and bottom edges.
The Iteration limit has no helper line; each tab's content begins with 8px of
internal top padding below the unchanged tabs. Ordinary preparation shows only
numeric Time taken; colour-data preparation keeps its established label. Do not
add status-line words, fields or phases without explicit approval.
Stop also cancels optional preview and colour-data
preparation. An appearance edit that needs missing data holds the previous
valid image until Refresh, navigation or a numerical-setting change.

Later, investigate preparing missing effect data after visual 100% only if
inexpensive: retain 100% and frozen time with a separate Preparing colour data
status, let Stop halt it, and prioritize navigation.

The editable location chooser/name, Advanced ordering and labels, and removal
of Reset panel layout are complete. Fullscreen uses the browser's native F11;
the application fullscreen button was removed.
The lazy-log optimisation comparison was not adopted.

Approved later UI work: retain Colour spacing and Palette offset at the top of
Colouring, followed by Hue rotation, Palette, Edit Palette, the formula/effect/
capped selectors and Lighting. Hue rotation affects the whole output
including capped/effect colours without mutating palette points; presets reset
rotation, individual palette edits preserve it. More formula/effect ideas need
their exact approved list recovered first. Exclude solarised, duotone, halftone
dots, crosshatch, histogram colouring and unapproved gcollombet features.
Remove the specified “final”, “adapted”, and “XaoS adapted” label fragments and
the capped-samples explanation. Replace Hide controls with a hamburger and
use helpful hover-only tooltips. Keep status and the hamburger visible with
controls hidden and do not change Julia preview visibility. A hard-right
palette point and light-distance control were cancelled.

Main-view rotation has a −180° to +180° slider, no numerical angle field,
Ctrl+circular drag or held Ctrl+Left/Right, Shift pan, a centre pivot and zero
reset. Locations and exact links retain angle; old records default to zero.
Home preserves angle; Full Reset clears it. Rotation is navigation and the
Julia preview remains unrotated. Retained images reproject during rotation;
rotated numerical grids conservatively decline exact sample remapping.
Later antialiasing should be sharper, post-image only, after
completion, with no extra fractal calculation. PNG should export only the
fractal, with Current viewport, Monitor size and 2× Monitor size as true render
sizes, retaining view, rotation, palette and AA. Palette-offset animation was
discussed but not accepted as a requirement.

The supplied extreme minibrot fixture has no confirmed mode or Julia constant.
Do not treat it as a Julia BLA benchmark without clarification, change its
signs, or start an unbounded extreme render by default. The supplied strings
are preserved exactly:

```text
real: 0.747702709800511938677751194679951319751517984123356800029955785208167644444157656204818392389452328656750204117267778516081822213518192597153358754704375802032457281379095368784237552018288630140584008517944711273258989195162368
imaginary: 0.0726794346032732975587095198367621143952225859816777610262290490332383495948353245238954438160097885662712500585131971636074018247078694504465727984279787749804571891146232401034066596968505351404825154179221317994167287582546606
Vertical Span: 7.43268908108426967144683224931870442656439030102003759253629056509268800548072466732357585049928883110527821380512455933576726465936251829303857402392150455973853776948664012767390892121313198148693756459499152306639282336394391e-143
```

## Licensing

GPL-3.0-or-later. See LICENSE and NOTICE.md for adopted code and attribution.
