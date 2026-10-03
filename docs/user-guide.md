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
| Show or hide panels | Menu button | Tab while focused on the fractal |
| Fullscreen | — | F11; Esc/F11 to leave |

Focus the canvas for its navigation keys. Editing a text or numeric field does not steer the camera. The Rotation slider provides a second way to rotate around the view centre.

**Stop** in Main pauses calculation and retains the current image. Navigation resumes it. Esc stops movement while allowing stationary refinement to continue. Compatible colour edits can still recolour retained data while calculation is stopped.

## Main

### Fractal family and Julia preview

Choose Mandelbrot or Julia in the Fractal family dropdown. In Mandelbrot, press **J** to show Julia preview. Left-click or drag on the Mandelbrot image to choose the Julia constant; this replaces left-button zoom while the preview is open.

The preview follows the main iteration limit. Its ordinary iteration colouring omits distance lighting. The last completed preview remains visible while another is prepared. **J** and **M** also work while a checkbox has focus, including either colour rotation checkbox. **M** promotes the latest selected constant, even if its preview is still being prepared. Press M from Julia to return to the preserved Mandelbrot view.

Move and resize the preview panel to suit your layout. It retains a 16:9 image shape and a minimum width where the viewport permits.

### Iteration limit, base and Dynamic

Iteration limit and Base iterations accept **1–10,000,000**. The slider uses a logarithmic scale. Editing either sets a new base and depth anchor; it does not automatically turn Dynamic off.

With **Dynamic** enabled, the requested depth target is:

```text
base iterations + depth gain × change in log10 magnification
```

The depth change is measured from the current anchor. The default gain is 5,000 iterations per decade: one decade is a tenfold zoom. Actual increases and decreases are bounded and coordinated with navigation and reference preparation. Remaining stationary does not continuously raise the limit. Turn Dynamic off when you want a fixed iteration budget.

A higher limit gives difficult orbits more time to escape. It also increases work and can increase reference memory. The maximum accepted value is not a promise that every device can render every view at that limit.

### Home and Full Reset

**Home** restores the whole-view position and span for the current family and resets iterations to 1,000. It retains the current family, Julia constant, rotation and appearance.

**Full Reset**, at the bottom of Advanced beside Reset tuning, returns to factory Mandelbrot Home, clears saved defaults and remembered layout/view settings, closes auxiliary panels and removes a linked view from the address. Saved locations remain available.

### Locations and exact links

Location is both a searchable chooser and a name field. Click to browse, or type to filter the built-in and saved locations. Use the dropdown arrow to browse. Arrow keys select a result; Enter opens it. Escape or clicking outside closes the list. Saving works with the list open.

To save your view, enter a name and select **Save location**. A saved view contains the family, exact decimal centre and span, Julia constant, camera rotation, iteration limit, appearance, colour rotation checkbox states, Reverse direction and Rotation speed. Saving the selected saved name updates that entry. Reusing another saved name asks before replacement. Editing the name clears the selection. Select a saved location and choose **Delete location** to remove it after confirmation; the current camera view stays in place. Default locations are added to the saved collection once and can also be deleted; deleted entries stay deleted after reloading.

**Back**, beside Save PNG, restores the exact view before a location jump, Home, opening a linked location or changing family. It preserves the camera, family, rotation, iteration limit, appearance and colour rotation settings. Repeated Back steps through up to 32 previous jumps in this session; reload and Full Reset clear that history.

**Copy Link** places those same view fields in a URL fragment. It does not change the current address bar. Paste the link into the browser address bar and press Enter to open the shared view immediately. This works on a fresh page or in the running explorer, without a reload or a second confirmation. After opening, the fragment is removed from the address bar so the same link can be pasted again; use Copy Link to share the current view. Zoom speed, Dynamic preference, navigation tuning and panel layout are local preferences and are not carried in that link.

Saved locations belong to this browser profile and origin. A different hostname or port has separate browser storage. Copy links for views you want to keep outside that storage.

### Save defaults

**Save defaults**, below Backup/Restore locations in Advanced, captures appearance, colour rotation settings, zoom speed, base iterations, Dynamic preference, tuning and panel settings. Panel settings include positions, sizes, opacity, accent colour, active tab, open sections, visibility and status-line preference.

It deliberately excludes the camera position, fractal family, Julia constant and saved-location collection. Each page load begins at Mandelbrot Home using your saved preferences and iteration base. Without saved defaults, ordinary remembered appearance and local preferences may still apply; Full Reset returns to factory settings.

## Colouring

### Palette editor

Expand **Edit Palette** to select one of 18 presets or edit a custom palette.

| Operation | How |
| --- | --- |
| Add a stop | Click an empty position on the palette strip |
| Move a stop | Drag it, or focus it and use Left/Right |
| Edit a colour | Click a stop, or use Enter/Space; choose saturation and brightness in the 2D swatch, adjust hue, or enter hex |
| Sample the image | Use the eyedropper in any colour picker, then click the image; Escape cancels |
| Delete a stop | Use Delete in the picker, or the Delete key on a focused stop |
| Preserve a stop during Randomise | Select it and enable Lock stop |
| Reverse the palette | Reverse stops |
| Equalise stop positions | Space evenly |
| Revisit edits | Undo / Redo |

Palettes contain **2–8 stops**. New palette editing uses a repeating gradient so the end wraps into the beginning. Lock stop protects that stop's colour and position during Randomise; manual editing, deletion and reversal remain available. Randomise may change the number and positions of unlocked stops.

### Formulas, effects and capped points

The interface provides **25 colour formulas**, **20 effects plus None**, and **12 capped-point patterns plus Solid black**.

Formulas include smooth escape, classic bands, decomposition, biomorphs, final-endpoint mappings and scalar patterns. Effects change the colour or apparent relief. Colour spacing spans **8–65,536**; Palette Offset moves through the gradient, and Hue Offset shifts the final image colours. Enable **rotate** beside Palette Offset or Light Direction to animate that value. Each can run independently; dragging its slider pauses that rotation until release.

Palette and many scalar changes can reuse calculated values. An endpoint-dependent formula may need additional orbit data, and distance lighting needs derivatives. A colour change can therefore require calculation even when the camera is stationary.

A capped point is one that has not escaped by the selected limit. Its optional pattern uses available final-orbit information, not a proof of set membership.

### Lighting

Distance lighting is an explicit option with additional computation cost. Its controls are Relief strength, Light direction, Light elevation, Ambient and Highlights. **Highlight colour**, beneath Highlights, sets the tint of the specular highlights; white is the default. Its picker includes a 2D swatch, hue, hex and image eyedropper. The colour is saved with appearance, including locations and links. The image is still a two-dimensional fractal; relief is a shading effect.

## Advanced

**Rotation speed** sets the time for one full light-direction turn, from **1 second to 1 minute**, with a factory default of **10 seconds**. The left end is slowest and the right end is fastest. Palette Offset rotates four times slower: a full palette cycle takes **4 seconds to 4 minutes** (40 seconds at the default setting). **Reverse direction**, beneath the slider, reverses both rotations. Save Defaults remembers the speed and checkbox settings; Full Reset restores 10 seconds, normal direction and both rotations off.

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

**Dynamic gain** ranges from 0 to 30,000 iterations per tenfold zoom, with a default of 5,000. It affects Dynamic iteration adjustment rather than spatial resolution.

### Panels and sliders

Drag panel backgrounds or the tab headers to reposition them; dragging uses the normal mouse pointer. Clicking a tab still selects it. The main controls resize in width from the left and right edges. Each tab’s height follows its content and stops eight pixels above the viewport bottom, scrolling inside the panel when needed. The Controls accordion at the bottom of Main contains the interaction guide. The title badge, Julia preview and PNG export panel have their own positions. Use the input, checkbox or button itself to activate a control; ordinary labels do not activate it. Accordions toggle only from their summary text. Resize edges show a double-arrow cursor without a highlighted side strip.

Panel accent colour also styles the borders of dropdowns and entry fields; focusing these thickens the existing border without adding a second outline. Regular buttons use the accent on hover. Opacity adjusts panel backgrounds and the menu button. Control backgrounds use 1.2 times that opacity, capped at 100%. **menu hides title and status line** hides both the title and footer with the menu when checked; both stay visible when unchecked.

Use the mouse wheel over a slider to adjust it. Ctrl-click resets supported application sliders to their factory values. Standard keyboard slider controls remain available.

## PNG export

Open **Save PNG** from Main. Choose Current viewport, Display estimate, 2× display estimate, 3× display estimate or 4× display estimate; entering width and height selects Custom.

Display estimates use browser-reported screen dimensions and pixel ratio without permission prompts. Browser zoom can affect the estimate; use Custom for exact dimensions. With 2× oversampling enabled, the first export opening uses twice the viewport width and height; a matching completed quality image may be reused.

The export snapshots the view when Save PNG is pressed. You may continue navigating without changing that image. Export preserves centre, rotation and vertical span. A different output aspect ratio changes the horizontal field, rather than stretching the fractal.

Use **Cancel export** or close the export panel to cancel. Large images are generated in tiles. Limits are 80 million total pixels and 32,768 pixels per dimension, plus device and memory checks. Lower dimensions if the requested size cannot fit.

## Factory settings at a glance

| Setting | Value |
| --- | --- |
| Family and centre | Mandelbrot, −0.6 + 0i |
| Vertical span / rotation | 2.8 / 0° |
| Iteration base / Dynamic | 1,000 / On |
| Zoom speed | 1× |
| Panel opacity | 60% |
| Throughput / stationary refinement | Smooth / Detailed |
| Pointer priority / 2× Pointer refinement | 4× / Off |
| 2× oversampling / Distance lighting | Off / Off |
| BLA precision / Dynamic gain | 2¹⁴ / 5,000 |
| Colour formula / Effect / Capped points | Smooth escape / None / Solid black |
| Colour spacing / Palette Offset / Hue Offset | 64 / 0 / 0° |
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
| A link does not open | Use the complete URL produced by Copy Link, including its fragment. Invalid links leave the current view unchanged. |
| Saved locations appear missing | Confirm the same browser profile, hostname and port. Local storage is separate for each origin. |

The application computes and exports locally. Its code does not upload locations, send analytics or use a rendering service. Loading the application and its worker assets still uses the serving origin.

When opening PNG export or Julia preview while the other is open, the new panel goes beneath it if it fits, otherwise it is centred in the viewport.

Before moving to a new candidate, port or version, use **Advanced → Backup locations** and keep the downloaded JSON file. Use **Restore locations** in the new version and verify the names before retiring the old version. Restoring merges locations without overwriting name conflicts. The 12 default locations come from the owner's 3 October 2026 backup and are added once, preserving existing saved entries.
