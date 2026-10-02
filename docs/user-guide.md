# DeepGPU Zoomer — User guide

[Project overview](../README.md) · [Architecture](architecture.md) · [Attribution](../NOTICE.md)

## First exploration

Run the application using the [setup instructions](../README.md#get-started). Choose **Seahorse Valley** from Location, or hold the left mouse button over a part of the Mandelbrot set you would like to explore. Zoom follows the pointer. Release the button to let the image finish refining.

The footer shows refinement progress, elapsed calculation time, magnification and the effective iteration limit. Magnification is expressed as a power of ten, so it remains readable even at extremely small scales. A completed image means the requested calculation has finished; it does not prove every capped point is mathematically inside the set.

## Navigation

| Action | Mouse | Keyboard |
| --- | --- | --- |
| Zoom in | Hold left button or wheel inward | Hold `+` or `=` |
| Zoom out | Hold right button or wheel outward | Hold `−` |
| Pan | Shift-drag or middle-drag | Arrow keys |
| Rotate | Ctrl + left-drag | Ctrl + Left/Right |
| Stop movement | Release the held controls | Esc |
| Julia preview | Select its controls after opening | J |
| Open Julia / return to Mandelbrot | Open Julia in the preview | M |
| Show or hide panels | Menu button | Tab |
| Fullscreen | — | F11; Esc/F11 to leave |

Focus the canvas for its navigation keys. Editing a text or numeric field does not steer the camera. The Rotation slider provides a second way to rotate around the view centre.

**Stop** in Main pauses calculation and retains the current image. Navigation resumes it. Esc stops movement while allowing stationary refinement to continue. Compatible colour edits can still recolour retained data while calculation is stopped.

## Main

### Fractal family and Julia preview

Choose Mandelbrot or Julia in the Fractal family dropdown. In Mandelbrot, press **J** to show Julia preview. Left-click or drag on the Mandelbrot image to choose the Julia constant; this replaces left-button zoom while the preview is open.

The preview follows the main iteration limit. Its ordinary iteration colouring omits distance lighting. The last completed preview remains visible while another is prepared. **M** promotes the latest selected constant, even if its preview is still being prepared. Press M from Julia to return to the preserved Mandelbrot view.

Move and resize the preview panel to suit your layout. It retains a 16:9 image shape and a minimum width where the viewport permits.

### Iteration limit, base and Dynamic

Iteration limit and Base iterations accept **1–10,000,000**. The slider uses a logarithmic scale. Editing either sets a new base and depth anchor; it does not automatically turn Dynamic off.

With **Dynamic** enabled, the requested depth target is:

```text
base iterations + depth gain × change in log10 magnification
```

The depth change is measured from the current anchor. The default gain is 3,000 iterations per decade: one decade is a tenfold zoom. Actual increases and decreases are bounded and coordinated with navigation and reference preparation. Remaining stationary does not continuously raise the limit. Turn Dynamic off when you want a fixed iteration budget.

A higher limit gives difficult orbits more time to escape. It also increases work and can increase reference memory. The maximum accepted value is not a promise that every device can render every view at that limit.

### Home and Full Reset

**Home** restores the whole-view position and span for the current family and resets iterations to 1,000. It retains the current family, Julia constant, rotation and appearance.

**Full Reset** returns to factory Mandelbrot Home, clears saved defaults and remembered layout/view settings, closes auxiliary panels and removes a linked view from the address. Saved locations remain available.

### Locations and exact links

Location is both a searchable chooser and a name field. Click to browse, or type to filter the built-in and saved locations. Arrow keys select a result; Enter opens it.

To save your view, enter a name and select **Save location**. A saved view contains the family, exact decimal centre and span, Julia constant, rotation, iteration limit and appearance. Saving the selected saved name updates that entry. Reusing another saved name asks before replacement.

**Copy exact link** places those same view fields in a URL fragment. It does not change the current address bar. The recipient starts at Home and chooses **Open linked location** to begin rendering the shared view. Speed, Dynamic preference, navigation tuning and panel layout are local preferences and are not carried in that link.

Saved locations belong to this browser profile and origin. A different hostname or port has separate browser storage. Copy exact links for views you want to keep outside that storage.

### Save defaults

Save defaults captures appearance, zoom speed, base iterations, Dynamic preference, tuning and panel settings. Panel settings include positions, sizes, opacity, accent colour, active tab, open sections, visibility and status-line preference.

It deliberately excludes the camera position, fractal family, Julia constant and saved-location collection. Each page load begins at Mandelbrot Home using your saved preferences and iteration base. Without saved defaults, ordinary remembered appearance and local preferences may still apply; Full Reset returns to factory settings.

## Colouring

### Palette editor

Expand **Edit Palette** to select one of 18 presets or edit a custom palette.

| Operation | How |
| --- | --- |
| Add a stop | Click an empty position on the palette strip |
| Move a stop | Drag it, or focus it and use Left/Right |
| Edit a colour | Click a stop, or use Enter/Space; adjust hue, saturation, brightness or hex |
| Delete a stop | Use Delete in the picker, or the Delete key on a focused stop |
| Preserve a stop during Randomise | Select it and enable Lock stop |
| Reverse the palette | Reverse stops |
| Equalise stop positions | Space evenly |
| Revisit edits | Undo / Redo |

Palettes contain **2–8 stops**. New palette editing uses a repeating gradient so the end wraps into the beginning. Lock stop protects that stop's colour and position during Randomise; manual editing, deletion and reversal remain available. Randomise may change the number and positions of unlocked stops.

### Formulas, effects and capped points

The interface provides **25 colour formulas**, **20 effects plus None**, and **12 capped-point patterns plus Solid black**.

Formulas include smooth escape, classic bands, decomposition, biomorphs, final-endpoint mappings and scalar patterns. Effects change the colour or apparent relief. Colour spacing spans **8–65,536**; Palette offset moves through the gradient, and Hue rotation rotates the final image colours.

Palette and many scalar changes can reuse calculated values. An endpoint-dependent formula may need additional orbit data, and distance lighting needs derivatives. A colour change can therefore require calculation even when the camera is stationary.

A capped point is one that has not escaped by the selected limit. Its optional pattern uses available final-orbit information, not a proof of set membership.

### Lighting

Distance lighting is an explicit option with additional computation cost. Its controls are Relief strength, Light direction, Light elevation, Ambient and Highlights. The image is still a two-dimensional fractal; relief is a shading effect.

## Advanced

### Throughput

Throughput has three settings: **Smooth**, **Balanced** and **Detailed**. They change the amount and scheduling of work during movement. Smooth is the factory default.

Once movement stops, the main view automatically uses **Detailed** scheduling until it finishes refining. Choosing Smooth for navigation therefore does not prevent stationary detail. These settings are workload policies, not fixed frame-rate or latency guarantees.

### Pointer controls

Pointer priority offers **Off, 2×, 4×, 8× and 16×**. It weights work near the pointer relative to distributed and older pending work. Off means equal service weighting; it does not stop rendering. The factory setting is 2×.

**2× Pointer refinement** increases local detail around the pointer during interaction. It is independent of priority and is off by default.

### Oversampling

**2× oversampling** computes a stationary image at twice the width and height, giving four spatial samples per displayed pixel, then resolves it for display. It is off by default. It increases calculation and memory requirements; a view that exceeds device capacity reports an error instead of silently lowering the requested quality.

### BLA precision and Dynamic gain

**BLA precision** applies to Mandelbrot acceleration. The display runs from **2¹⁴ to 2²⁴**, corresponding to a local approximation tolerance of **2⁻¹⁴ to 2⁻²⁴**. Increasing the displayed exponent is stricter and may require more recurrence work. It does not increase decimal coordinate precision or reference-orbit precision. Julia uses its own fixed policy.

**Dynamic gain** ranges from 0 to 30,000 iterations per tenfold zoom, with a default of 3,000. It affects Dynamic iteration adjustment rather than spatial resolution.

### Panels and sliders

Drag panel backgrounds to reposition them. The main controls resize from the left, right and bottom edges. The title badge, Julia preview and PNG export panel have their own positions. Editable controls remain interactive inside the panels.

Panel accent colour also styles the borders of dropdowns and entry fields; regular buttons use it on hover. Opacity adjusts panel backgrounds. **hide status line with menu** controls whether the footer disappears with the panels.

Use the mouse wheel over a slider to adjust it. Ctrl-click resets supported application sliders to their factory values. Standard keyboard slider controls remain available.

## PNG export

Open **Save PNG** from Main. Choose Current viewport, Current display, 2× display, 3× display or 4× display; entering width and height selects Custom.

Display presets require supported display detection and may request permission. If unavailable or declined, use Custom. With 2× oversampling enabled, the first export opening uses twice the viewport width and height; a matching completed quality image may be reused.

The export snapshots the view when Save PNG is pressed. You may continue navigating without changing that image. Export preserves centre, rotation and vertical span. A different output aspect ratio changes the horizontal field, rather than stretching the fractal.

Use **Cancel export** or close the export panel to cancel. Large images are generated in tiles. Limits are 80 million total pixels and 32,768 pixels per dimension, plus device and memory checks. Lower dimensions if the requested size cannot fit.

## Factory settings at a glance

| Setting | Value |
| --- | --- |
| Family and centre | Mandelbrot, −0.6 + 0i |
| Vertical span / rotation | 2.8 / 0° |
| Iteration base / Dynamic | 1,000 / On |
| Zoom speed | 1× |
| Throughput / stationary refinement | Smooth / Detailed |
| Pointer priority / 2× Pointer refinement | 2× / Off |
| 2× oversampling / Distance lighting | Off / Off |
| BLA precision / Dynamic gain | 2¹⁴ / 3,000 |
| Colour formula / Effect / Capped points | Smooth escape / None / Solid black |
| Colour spacing / Palette offset / Hue rotation | 64 / 0 / 0° |
| Palette | Custom blue, cyan, white and orange Ultra-style gradient |

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| WebGPU unavailable | Use a browser/device combination that exposes WebGPU, with hardware acceleration and an HTTPS or localhost origin. See [WebGPU browser support](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API#browser_compatibility). |
| Navigation or refinement is slow | Iteration count, resolution, scene complexity, lighting and oversampling all affect work. Start with Smooth throughput, a lower iteration limit and oversampling off. |
| Image stays stopped | Navigate to resume after pressing Stop. |
| Colour changes start more calculation | The chosen formula or lighting may require channels absent from the retained field. |
| PNG display preset is unavailable | Use Custom dimensions, or allow display detection where the browser supports it. |
| GPU or export capacity error | Reduce output dimensions, oversampling or the iteration budget, as appropriate to the reported error. |
| A link opens Home | Choose Open linked location; applying the payload is deliberately explicit. |
| Saved locations appear missing | Confirm the same browser profile, hostname and port. Local storage is separate for each origin. |

The application computes and exports locally. Its code does not upload locations, send analytics or use a rendering service. Loading the application and its worker assets still uses the serving origin.
