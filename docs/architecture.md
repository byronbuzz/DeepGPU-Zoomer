# DeepGPU Zoomer — Architecture reference

[Project overview](../README.md) · [User guide](user-guide.md) · [Attribution](../NOTICE.md)

This reference describes the active application: a decimal camera and browser interface, a BigInt reference worker, WebGPU numerical and presentation pipelines, and an independent tiled export path.

## Application boundaries

| Layer | Responsibility | Main source |
| --- | --- | --- |
| Application | Events, camera revisions, generations, render demand, Julia preview and saved preferences | [main.ts](../src/main.ts) |
| Coordinates | Decimal view state, serialized coordinates, rotation and fixed-point preparation | [state.ts](../src/state.ts), [coordinate.ts](../src/coordinate.ts), [rotation.ts](../src/rotation.ts) |
| Reference | Fixed-point recurrence, packing, cancellation and extension | [reference-worker.ts](../src/render/reference-worker.ts), [reference-orbit.ts](../src/render/reference-orbit.ts), [reference-step.ts](../src/render/reference-step.ts) |
| Transfer | Chunk assembly, bounded uploads and reference decoding | [reference-worker-client.ts](../src/render/reference-worker-client.ts), [reference-preparation.ts](../src/render/reference-preparation.ts) |
| Renderer | Methods, resource ownership, pending work, reuse and coherent publication | [webgpu-renderer.ts](../src/render/webgpu-renderer.ts) |
| GPU arithmetic | Compensated two-component and four-component operations | [compensated.wgsl](../src/arithmetic/compensated.wgsl), [quad.wgsl](../src/arithmetic/quad.wgsl), [wide.wgsl](../src/render/wide.wgsl) |
| Approximation | BLA coefficient hierarchy and local radii | [bla.ts](../src/render/bla.ts), [perturbation.wgsl](../src/render/perturbation.wgsl) |
| Work scheduling | Pending regions, coverage, adaptive sizing and publication stripes | [regions.ts](../src/render/regions.ts), [motion-sizing.ts](../src/render/motion-sizing.ts), [ordinary-stripes.ts](../src/render/ordinary-stripes.ts) |
| Device | Feature/limit discovery, allocation checks, compilation and timing | [device.ts](../src/gpu/device.ts), [timing.ts](../src/gpu/timing.ts) |
| Appearance | Colour schema, palettes, picker and panel preferences | [colorSettings.ts](../src/logic/colorSettings.ts), [palette-editor.ts](../src/palette-editor.ts), [colour-picker.ts](../src/colour-picker.ts), [panels.ts](../src/panels.ts) |
| Persistence | Saved-view validation, defaults, location backups and initial locations | [state.ts](../src/state.ts), [defaults.ts](../src/defaults.ts), [locations.ts](../src/locations.ts), [default-locations.json](../src/default-locations.json) |
| Export | Snapshot, tiling, device readback and streaming PNG encoding | [export/](../src/export/) |

The frontend is TypeScript with native HTML/CSS controls. Vite 5.4.21 bundles modules, worker entry points and imported WGSL strings. decimal.js 10.6.0 is the direct runtime package dependency. Native browser APIs provide workers, GPU access, local storage, clipboard access, image download and compression.

## Camera and render demand

The camera keeps centre and span as Decimal values. Rotation uses an angle and basis applied to screen offsets. Coordinates are serialized as decimal strings, avoiding a conversion of the full deep coordinate through JavaScript Number.

A render request includes the camera, family, Julia constant, iteration cap, appearance requirements, dimensions and scheduling policy. Camera revision and application generation distinguish current demand from work that has become stale. Numerical identity and presentation metadata determine whether previously calculated values remain compatible.

The view's span is its vertical extent. Magnification is measured against the Home span of 2.8. Coordinate validation constrains centres and Julia constants to ±16, positive spans to at most 8, and the supported decimal exponent envelope. The camera chooses working decimal precision from depth with additional guard digits.

## Automatic numerical method

The renderer chooses Direct above **10⁻¹⁴·⁷⁵ units per pixel** and Wide perturbation at smaller scales. The latter uses the internal `Hdr` method label. This boundary is pixel scale, not a single magnification independent of viewport size.

- Direct Mandelbrot uses compensated two-component arithmetic.
- Direct Julia uses Wide arithmetic for its coordinates and recurrence.
- The deep route calculates a high-precision reference orbit and evaluates nearby pixel displacements using exponent-carrying Wide arithmetic.

Wide stores four `f32` components per real component and an explicit exponent. This extends mantissa accuracy and exponent range, but the per-pixel representation does not have the same precision as the BigInt reference. The QD-inspired operations are adapted to `f32`, so they must not be described as the original double-component QD precision.

## Reference worker lifecycle

The production reference is calculated by a persistent CPU Web Worker. Its fixed-point `BigInt` recurrence uses one of **8, 16, 32, 64, 128 or 256 limbs**, each 32 bits. Selection accounts for pixel depth, mantissa needs and guard precision.

The recurrence produces packed samples in chunks of at most **65,536 iterations**. A retained terminal state contains the actual BigInt orbit state. When a compatible capped reference needs more iterations, the worker extends that state rather than reconstructing it from lower-precision packed samples or calculating the prefix again.

Reference identity contains family, centre, Julia constant and limb profile. Iteration demand is excluded from identity so an extension remains the same trajectory. Main-thread copying and GPU uploads use bounded pieces of at most **4 MiB**. The GPU decodes the packed samples into its recurrence format.

Mandelbrot and Julia use different packed layouts. Decoded GPU reference storage requires **48 bytes per sample for Mandelbrot** and **96 for Julia**. The application accepts caps up to 10,000,000 iterations, but checks the requested allocation against device capacity and fails explicitly if it cannot fit.

## Perturbation, rebasing and linear BLA

For the quadratic recurrence, perturbation evolves the difference between a pixel and the reference. Mandelbrot injects a pixel-dependent parameter delta; Julia injects its pixel offset at initialization and uses a shared parameter thereafter. Julia reference-relative encoding retains differences from the initial reference point to reduce cancellation.

Rebasing re-expresses an orbit relative to a more suitable reference position. It is part of the recurrence, alongside escape handling and reference-index management.

Active acceleration uses **linear BLA**, built cooperatively on the main thread. Adjacent affine steps compose into multi-iteration entries carrying complex coefficients and a local validity radius. The shader selects an admissible skip or executes the full Wide recurrence. Affine skip application uses two-component mantissas, which is distinct from the four-component ordinary recurrence.

| Request | BLA policy |
| --- | --- |
| Eligible main Mandelbrot | Enabled for iteration and distance modes; local tolerance 2⁻¹⁴ by default, adjustable through 2⁻²⁴ |
| Eligible main Julia | Iteration mode with fixed local tolerance 2⁻⁴⁰ |
| Julia preview | Approximation disabled |

The hierarchy omits unusable single-step storage and uses alignment-aware skip lookup. When a multi-step entry is unavailable or its radius does not admit the current delta, recurrence continues without that skip.

The radius criterion is local. It is not a bound on accumulated image error, and accelerated completion does not imply exact equality with an unaccelerated calculation. Reaching the selected iteration cap is also distinct from proving mathematical interior membership.

## Fields, channels and reuse

A numerical field stores scalar results separately from image colour. Scalar storage uses **8 bytes per subsample**. Endpoint-dependent formulas require a further **16 bytes per subsample**. Distance mode propagates derivatives needed for its distance estimate and lighting.

Palette edits and compatible scalar formulas recolour retained fields. Missing endpoint or derivative information requires additional numerical work. Stop locks are palette-editor metadata and do not alter the numerical field.

Three kinds of reuse serve different purposes:

1. **Numerical reuse:** copy compatible previously calculated samples when the old and new sample grids describe the same coordinates. [sample-grid.ts](../src/render/sample-grid.ts) and [reuse.wgsl](../src/render/reuse.wgsl) own this path. Exact remapping is restricted to unrotated grids.
2. **Presentation reuse:** reproject retained imagery to the current camera while new values arrive. [reprojection.ts](../src/render/reprojection.ts) owns the transform. Rotated views can use this display history without claiming fresh numerical samples.
3. **Iteration-cap reuse:** retain already escaped samples across compatible cap changes, with remaining demand handled according to its provenance. [cap-reuse.ts](../src/render/cap-reuse.ts) owns the admission rules.

Numerical extent planning and bounded overscan retain useful coverage around the viewport. Pending and completed coverage remain distinct; transformed display pixels do not become completed numerical coverage merely because they look plausible.

## Progressive work and scheduling

Rectangular pending regions receive sparse-to-dense refinement. Scheduling balances pointer regions, distributed regions and older work so pointer attention does not replace whole-view completion.

The user selects one of three navigation throughput policies:

| Preset | Work scale | Target residency |
| --- | --- | --- |
| Smooth | 1× | 64 ms |
| Balanced | 2× | 128 ms |
| Detailed | 4× | 32 ms |

These are internal workload settings, not measured latency promises. The main application uses the selection while interacting, and Detailed while stationary. Pointer priority selects relative service weights of 1, 2 or 4 against the other service classes; Off corresponds to equal weighting. The factory setting is 2× pointer priority, with Smooth navigation and pointer refinement disabled.

Measured GPU cost and completion feedback adapt eligible work sizes. Established inward work can publish aligned stripes. Ordinary Mandelbrot kernels use a **16×4** workgroup specialization where applicable. GPU timing is used when supported.

Analytic cardioid and bulb checks avoid eligible Mandelbrot interior work. Exact numerical-cycle detection can terminate eligible no-skip paths. Shader pipelines are cached or created lazily to avoid repeated setup costs.

## Bounded continuation

Eligible expensive cold work retains recurrence state across bounded GPU submissions. Each portion limits loop operations and then yields; its operation limit is not a wall-clock guarantee. Eligible ordinary Mandelbrot BLA work, including rotated views, can switch to ordinary dispatch after measured feedback, including above one million iterations. Other paths retain their existing admission policy. Long GPU submissions can delay fresh detail and cancellation.

Continuation state has its own ownership and compatibility rules. Cross-view carry is narrower than ordinary image reuse: eligible ordinary, unrotated Mandelbrot work can transfer compatible continuation state. [continuation.ts](../src/render/continuation.ts) and [pending-continuation.ts](../src/render/pending-continuation.ts) define its execution and ownership model.

## Publication and quality

A published image carries the camera, dimensions, fractal family and appearance metadata for the samples it represents. Publication updates those together before yielding. Presentation can then transform the correct completed image while subsequent work proceeds.

The optional **2× oversampling** stage calculates twice the width and height while stationary, then resolves four spatial samples into each displayed pixel. [quality.ts](../src/render/quality.ts) and [quality-resolve.wgsl](../src/render/quality-resolve.wgsl) implement this stage. Device capacity is checked at the requested size.

Pointer refinement is independent: it concentrates additional detail near the pointer during navigation. Full-view stationary oversampling is not implied by enabling it.

## Appearance and interface

Iteration colouring is the factory mode. Distance colouring adds a derivative-based distance field and screen-space surface relief, with ambient, diffuse and specular lighting. Highlight colour, light direction and elevation are appearance settings.

Palette and light rotation are optional and independently enabled. [colour-rotation.ts](../src/colour-rotation.ts) maps the shared speed control to a light period of 1–60 seconds, defaulting to 10 seconds. A full palette cycle takes four light periods: 40 seconds at the factory speed. Reverse applies to both. These changes use retained appearance data when compatible; changing the required numerical channels still follows the field-admission rules above. Manual offset or light-angle editing suspends that channel's automatic rotation for the gesture.

The shared colour picker provides saturation/brightness, hue and validated hex input for palette stops, highlights and panel accent. Image picking reads the renderer's last presented screen texture, including reprojection and partial refinement, rather than recalculating the fractal. A mapped GPU readback supplies the selected pixel and a 15×15 neighbourhood for the magnified loupe. Edge pixels are repeated at image boundaries; the centre marker identifies the selected pixel. Picking intercepts navigation gestures and can be cancelled with Escape.

[panels.ts](../src/panels.ts) owns draggable placement, the controls panel's edge resizing, Julia preview resizing, tabs and menu visibility. Positions remain within the viewport. When export and Julia preview are both open, the newly opened panel goes below the other if it fits, otherwise to the centre in front. Panel opacity defaults to 60%, with control backgrounds at 1.2 times panel opacity, capped at full opacity. The status/title can optionally hide with the menu. These interface settings do not change the numerical field or exported appearance.

## PNG export

An export snapshots camera, appearance and numerical settings. It has an independent renderer and cancellation signal, so live navigation does not replace the chosen image.

The planner preserves centre, rotation and vertical span. It splits the output into bounded padded tiles, assembles scanline strips, and feeds a streaming PNG encoder. Padding provides neighbouring data for appearance operations. A compatible completed oversampled image can take a direct readback path when its size fits that path's limits.

Output limits are **80,000,000 pixels** and **32,768 pixels per dimension**. A **768 MiB export allocation estimate** and actual device limits further restrict admissible work. The estimate is not the total browser process footprint: existing viewport/reference resources and browser internals are separate.

The encoder uses browser compression streams and enforces an encoded-output budget during construction. Display-based resolution estimates use screen CSS dimensions multiplied by the device pixel ratio without Window Management permission; browser zoom can affect the estimate. Custom dimensions do not depend on it.

## Persistence and privacy

The saved-view schema includes family, decimal centre and span, Julia constant, iteration limit, camera rotation, appearance and colour-motion settings (speed, palette/light enablement and reverse). Exact links encode the validated schema in the URL fragment. A valid fragment opens automatically on startup or a hash change, then is removed from the address bar so opening the same link again works. An invalid link leaves the current view intact. Local tuning and panel preferences are separate.

Saved defaults capture startup appearance, base iterations, Dynamic preference, navigation speed, colour-motion settings, tuning and panel settings, including selected tab, expanded sections and menu visibility. They exclude camera geometry, family, Julia constant and saved locations. Startup begins at Mandelbrot Home unless an exact link supplies a view. Without explicit saved defaults, the previous view can supply remembered appearance, while its camera is not restored. Reset restores factory settings and Home without deleting saved locations.

The initial collection is the owner's 12 locations in [default-locations.json](../src/default-locations.json). Each browser origin merges that collection into saved locations once, using a separate seeding marker. Existing locations are preserved, identical name/view entries are skipped, and conflicting names receive a numbered suffix. After successful seeding, deleting an initial location does not recreate it on reload. Browser-saved locations are distinct from this checked-in initial collection.

Location backups use a versioned `deepgpu-zoomer-locations` JSON envelope; restoration also accepts a legacy location array. Every incoming view is validated before merging. Restoration preserves destination entries and is safe to repeat. Unreadable stored location data disables saving and deletion rather than replacing it. Locations and settings remain origin-local; moving to another port or hosted site requires a backup and restore to transfer browser-saved entries.

Application state lives in browser local storage. Rendering and PNG encoding use local CPU/GPU resources, with no automatic upload of saved locations or PNGs and no remote rendering client. The GitHub Pages origin loads a Google Analytics visit tag through [analytics.js](../public/analytics.js); its configuration omits queries and fragments from reported page and referrer URLs. The tag is disabled on other origins, including localhost. Application and worker files are loaded from the serving origin.

## Static deployment

[The GitHub Pages workflow](../.github/workflows/pages.yml) installs the locked npm dependencies on Node.js 24, runs the TypeScript check and Vite production build, and publishes only `dist/` through the Pages artifact and deployment actions. The hosted build uses `/DeepGPU-Zoomer/` as its public base path; local builds use the root path. Deployment runs on pushes to `main` and supports manual dispatch. No application backend is deployed.

## Platform references

- [WebGPU](https://www.w3.org/TR/webgpu/) and [WGSL](https://www.w3.org/TR/WGSL/)
- [Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API) and [Compression Streams](https://developer.mozilla.org/en-US/docs/Web/API/Compression_Streams_API)
- [decimal.js](https://mikemcl.github.io/decimal.js/) and [Vite 5](https://v5.vite.dev/guide/)
- [Deep zoom methods](https://mathr.co.uk/web/deep-zoom.html)
- [Project references and acknowledgements](../README.md#references), including upstream repositories and arithmetic research
