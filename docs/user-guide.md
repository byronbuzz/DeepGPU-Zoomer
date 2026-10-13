# DeepGPU Zoomer — User guide

[Project overview](../README.md) · [Gallery](https://byronbuzz.github.io/DeepGPU-Zoomer/gallery/) · [Architecture](architecture.md) · [Attribution](../NOTICE.md)

## First exploration

Open [the hosted application](https://byronbuzz.github.io/DeepGPU-Zoomer/) or run it using the [setup instructions](../README.md#get-started). Choose **Julia Jewels 10^0x** from Location, or hold the left mouse button over a part of the Mandelbrot set you would like to explore. Zoom follows the pointer. Release the button to let the image finish refining.

The footer shows refinement progress, elapsed calculation time, magnification and the effective iteration limit. Magnification is expressed as a power of ten, so it remains readable even at extremely small scales. A completed image means the requested calculation has finished; it does not prove every capped point is mathematically inside the set.

**View the gallery** at the bottom of Advanced opens eight captured views in a separate tab. Select an image to view its full-resolution PNG; **Open the explorer** returns to the application.

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

**Full Reset**, in Advanced beside Save Defaults, returns to factory Mandelbrot Home, clears saved defaults and remembered layout/view settings, closes auxiliary panels and removes a linked view from the address. Saved locations remain available.

### Locations and exact links

Location is both a searchable chooser and a name field. Click to browse, or type to filter saved locations, including the 15 editable defaults. Use the dropdown arrow to browse. Arrow keys select a result; Enter opens it. Escape or clicking outside closes the list. Saving works with the list open.

To save your view, enter a name and select **Save location**. A saved view contains the family, exact decimal centre and span, Julia constant, camera rotation, iteration limit, appearance, colour rotation checkbox states, Reverse and Rotation speed. Saving the selected saved name updates that entry. Reusing another saved name asks before replacement. Editing the name clears the selection. Select a saved location and choose **Delete location** to remove it after confirmation; the current camera view stays in place. Default locations are added to the saved collection once and can also be deleted; deleted entries stay deleted after reloading.

**Back**, beside Home and Stop, returns through up to 1,000 previous stationary camera locations in this session. Zooming, panning and camera rotation each record their departure point once per gesture or wheel burst. About 250 ms without camera navigation makes the current view a new stationary point, even if refinement or colour animation continues. Location jumps, Home, links, PNG loads and family changes also participate. Back during movement returns to the last stationary point; repeated Back steps further into history without recording its own return trips.

Back restores exact coordinates, span, camera angle, family, Julia constant and the effective iteration limit. Your current colouring, colour rotation flags/speed and tuning stay in effect. Dynamic iterations re-anchor at the restored depth and cap. Colour edits and calculation progress add no entries. History stores settings only, with no images, numerical fields or reference orbits; reload and Full Reset clear it.

**Copy Link** places those same view fields in a URL fragment. It does not change the current address bar. Paste the link into the browser address bar and press Enter to open the shared view immediately. This works on a fresh page or in the running explorer, without a reload or a second confirmation. After opening, the fragment is removed from the address bar so the same link can be pasted again; use Copy Link to share the current view. Zoom speed, Dynamic preference, navigation tuning and panel layout are local preferences and are not carried in that link.

**Paste Link**, after Copy Link, opens a valid DeepGPU link or scene text from the clipboard. When clipboard access is already granted, returning to the app checks the contents and greys out the button if no valid scene is present. Until the contents can be read, the button stays available and may request permission on click. Ctrl+V while focused on the fractal also works without granting clipboard-read permission; pasting into an input remains ordinary text editing. Invalid contents and a clipboard read that finishes after navigation leave the current view unchanged. URLs are decoded locally rather than opened or fetched.

Saved locations belong to this browser profile and origin. A different hostname or port has separate browser storage. Copy links for views you want to keep outside that storage.

**Advanced → Backup locations** downloads a JSON collection containing the saved names and complete views. **Restore locations** validates a selected backup before merging it. Exact duplicates are skipped; a different view with an existing name receives a numbered suffix so both remain available. Restoring never replaces an existing entry. Keep the backup before changing hostname, port or browser profile, and restore it in the destination.

### Save defaults

**Save Defaults**, beside Full Reset in Advanced, captures appearance, colour rotation settings, zoom speed, base iterations, Dynamic preference, tuning and panel settings. Panel settings include positions, sizes, opacity, accent colour, active tab, open sections, visibility and status-line preference.

It deliberately excludes the camera position, fractal family, Julia constant and saved-location collection. Each page load begins at Mandelbrot Home using your saved preferences and iteration base. Without saved defaults, ordinary remembered appearance and local preferences may still apply; Full Reset returns to factory settings.

## Colouring

### Palette editor

Expand **Edit Palette** to select one of 18 presets or edit a custom palette.

| Operation | How |
| --- | --- |
| Add a stop | Click an empty position on the palette strip |
| Move a stop | Drag it, or focus it and use Left/Right |
| Edit a colour | Click a stop, or use Enter/Space; choose saturation and brightness in the 2D swatch, adjust hue, or enter hex |
| Sample the image | Use the eyedropper in any colour picker, move over the image to inspect the magnifying loupe, then click to select its centre pixel; Escape cancels |
| Delete a stop | Use Delete in the picker, or the Delete key on a focused stop |
| Preserve a stop during Randomise | Select it and enable Lock stop |
| Reverse the palette | Reverse |
| Equalise stop positions | Space evenly |
| Revisit edits | Undo / Redo |

Palettes contain **2–10 stops**. New palette editing uses a repeating gradient so the end wraps into the beginning. Lock stop protects that stop's colour and position during Randomise; manual editing, deletion and reversal remain available. Randomise generates 6–10 stops, leaving at least 5% of the strip between neighbours, including the wraparound seam. Neighbouring colours differ by at least 10% of the full RGB distance. It chooses one black stop 50% of the time, two 25%, and none 25%; two black stops are never neighbours, including across the seam. Locked stops take precedence where their existing colours or positions make these constraints impossible.

A black stop means every RGB channel is below 17: #101010 qualifies, while #111111 and #00ffff do not. Each preset has at least one such stop. When a preset previously lacked one, a black stop was appended for palettes with fewer than eight stops, or inserted at a randomly chosen, saved position for longer palettes. Reloading keeps those preset positions stable. Existing saved views retain their stored colours.

### Formulas, effects and capped points

The interface provides **25 colour formulas**, **20 effects plus None**, and **12 capped-point patterns plus Solid black**.

Formulas include smooth escape, classic bands, decomposition, biomorphs, final-endpoint mappings and scalar patterns. Effects change the colour or apparent relief. Colour spacing spans **8–65,536**; Palette Offset moves through the gradient, and Hue Offset shifts the final image colours. Enable **rotate** beside Palette Offset or Light Direction to animate that value. Each can run independently; dragging its slider pauses that rotation until release.

Palette and many scalar changes can reuse calculated values. An endpoint-dependent formula may need additional orbit data, and distance lighting needs derivatives. A colour change can therefore require calculation even when the camera is stationary.

A capped point is one that has not escaped by the selected limit. Its optional pattern uses available final-orbit information, not a proof of set membership.

### Lighting

Distance lighting is an explicit option with additional computation cost. Its controls are Relief strength, Light direction, Light elevation, Ambient and Highlights. **Highlight colour**, beneath Highlights, sets the tint of the specular highlights; white is the default. Its picker includes a 2D swatch, hue, hex and image eyedropper. The colour is saved with appearance, including locations and links. The image is still a two-dimensional fractal; relief is a shading effect.

## Advanced

**Rotation speed** sets the time for one full light-direction turn, from **30 seconds at the left to 0.1 seconds at the right**, with a factory default of **10 seconds**. Palette Offset rotates four times slower: a full palette cycle takes **120 seconds to 0.4 seconds** (40 seconds at the default setting). **Reverse**, beside the speed label, reverses both rotations. The numeric speed remains available to assistive technology. Save Defaults remembers the speed and checkbox settings; Full Reset restores 10 seconds, normal direction and both rotations off.

### Throughput

Throughput has three settings: **Smooth**, **Balanced** and **Detailed**. They change the amount and scheduling of work during movement. Smooth is the factory default.

Once movement stops, the main view automatically uses **Detailed** scheduling until it finishes refining. Choosing Smooth for navigation therefore does not prevent stationary detail. These settings are workload policies, not fixed frame-rate or latency guarantees.

### Pointer controls

Pointer priority offers **Off, 2× and 4×**. It weights work near the pointer relative to distributed and older pending work. Off means 1×, or equal service weighting; it does not stop rendering. The factory setting is **2×**.

**2× Pointer refinement** increases local detail around the pointer during interaction. It is independent of priority and is off by default.

### Oversampling

**2× oversampling** computes a stationary image at twice the width and height, giving four spatial samples per displayed pixel, then resolves it for display. It is off by default. It increases calculation and memory requirements; a view that exceeds device capacity reports an error instead of silently lowering the requested quality.

### BLA precision and Dynamic gain

**BLA precision** applies to Mandelbrot acceleration. The display runs from **2¹⁴ to 2²⁴**, corresponding to a local approximation tolerance of **2⁻¹⁴ to 2⁻²⁴**. Increasing the displayed exponent is stricter and may require more recurrence work. It does not increase decimal coordinate precision or reference-orbit precision. Julia uses its own fixed policy.

**Dynamic gain** ranges from 0 to 30,000 iterations per tenfold zoom, with a default of 5,000. It affects Dynamic iteration adjustment rather than spatial resolution.

### Panels and sliders

Drag panel backgrounds or the tab headers to reposition them; dragging uses the normal mouse pointer. Clicking a tab still selects it. The main controls resize in width from the left and right edges. Each tab’s height follows its content and stops eight pixels above the viewport bottom, scrolling inside the panel when needed. The Controls accordion at the bottom of Main contains the interaction guide. The title badge, Julia preview and PNG export panel have their own positions. Use the input, checkbox or button itself to activate a control; ordinary labels do not activate it. Accordions toggle only from their summary text. Resize edges show a double-arrow cursor without a highlighted side strip.

Panel accent colour also styles the borders of dropdowns and entry fields; focusing these thickens the existing border without adding a second outline. The title and footer use the same border style as the menu button. Regular buttons use the accent on hover. Hover, pressed and active-button backgrounds and the selected tab are fully opaque. The menu icon remains white, including on hover. Opacity adjusts panel backgrounds and the menu button. Control backgrounds use 1.2 times that opacity, capped at 100%. **menu hides title and status line** hides both the title and footer with the menu when checked; both stay visible when unchecked.

Opening PNG export or Julia preview while the other is open places the new panel beneath it if it fits, otherwise it is centred in the viewport.

Use the mouse wheel over a slider to adjust it. Ctrl-click resets supported application sliders to their factory values. Standard keyboard slider controls remain available.

## PNG export

Open **Save PNG** from Main. Choose Current viewport, Display estimate, 2× display estimate, 3× display estimate or 4× display estimate; entering width and height selects Custom.

Display estimates use browser-reported screen dimensions and pixel ratio without permission prompts. Browser zoom can affect the estimate; use Custom for exact dimensions. With 2× oversampling enabled, the first export opening uses twice the viewport width and height; a matching completed quality image may be reused.

The export snapshots the view when Save PNG is pressed. You may continue navigating without changing that image. Export preserves centre, rotation and vertical span. A different output aspect ratio changes the horizontal field, rather than stretching the fractal.

Use **Cancel export** or close the export panel to cancel. Large images are generated in tiles. Limits are 80 million total pixels and 32,768 pixels per dimension, plus device and memory checks. Lower dimensions if the requested size cannot fit.

New exports embed the exact location, iteration limit, appearance, both palette/light rotation flags and rotation speed from the same Save action as the rendered image. Choose **Main → Load PNG**, or drop the original PNG onto the explorer, to restore the view and show the original image immediately. The image scales to viewport height: wider images crop at the sides; narrower images leave side margins. When both saved rotation flags are off, the image stays displayed without numerical calculation until navigation or an image-setting change needs rendering. If either rotation is on, the original image stays visible while the numerical field is prepared; live animation then starts automatically at the restored speed and direction. Deep locations may take time to prepare. Stop cancels preparation while retaining the original image. Panel settings and stop locks leave it displayed. PNGs contain final colours rather than escape/distance data, so changing colouring needs a numerical render; compatible recolouring of ordinary completed numerical fields still reuses their data. Loading preserves saved locations and adds the preceding view to **Back**, beside Home and Stop. Pending loading is cancelled if the view changes before the image is ready.

Older PNGs have no embedded location, and editing or re-encoding an image can remove its metadata. Loading accepts files up to 512 MB with the same 80-million-pixel and 32,768-pixel-per-side limits as export. Metadata is read in bounded slices, then the image is decoded before the current view changes. Navigation starts rendering for the full current viewport, including any previously missing side margins.

## Factory settings at a glance

| Setting | Value |
| --- | --- |
| Family and centre | Mandelbrot, −0.6 + 0i |
| Vertical span / rotation | 2.8 / 0° |
| Iteration base / Dynamic | 1,000 / On |
| Zoom speed | 1× |
| Panel opacity | 70% |
| Panel accent / Menu hides title and status line | #e5a14e / Off |
| Light rotation / Palette rotation / Reverse | Off / Off / Off |
| Rotation speed / Palette cycle at that speed | 10 seconds / 40 seconds |
| Default locations | 15 editable, deletable saved views |
| Throughput / stationary refinement | Smooth / Detailed |
| Pointer priority / 2× Pointer refinement | 2× / Off |
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
| PNG display estimate is unsuitable | Use Custom dimensions for an exact size; display estimation does not require a permission grant. |
| GPU or export capacity error | Reduce output dimensions, oversampling or the iteration budget, as appropriate to the reported error. |
| A link does not open | Use the complete URL produced by Copy Link, including its fragment. Invalid links leave the current view unchanged. |
| Saved locations appear missing | Confirm the same browser profile, hostname and port. Local storage is separate for each origin. |

The application computes and exports locally, with no automatic upload of saved locations or PNGs and no remote rendering service. The GitHub Pages site loads a Google Analytics visit tag; its configuration omits queries and fragments from reported page and referrer URLs. The tag is disabled on other origins, including localhost. Loading the application and its worker assets still uses the serving origin.

Before moving to a new candidate, port or version, use **Advanced → Backup locations** and keep the downloaded JSON file. Use **Restore locations** in the new version and verify the names and count before retiring the old version. Restoring merges locations without overwriting name conflicts. The checked-in collection contains 15 views: the 12 original defaults and three additional deep views, **Inferno 10^800**, **Inferno 10^900** and **Eon 10^1000**. A fresh browser origin receives all 15. An origin that already received the original defaults gets only the three additions once, preserving existing entries and leaving deleted original defaults deleted. After each group has been added, deleting one of its entries does not recreate it on reload.
