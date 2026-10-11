# Accessibility

DeepGPU Zoomer is an interactive, GPU-rendered fractal explorer. Accessibility is a project goal, but the application has **not** been certified against WCAG or independently audited. Some interactions and rendered fractal imagery may be difficult to use with assistive technology.

## Current capabilities and limitations

- Several navigation actions have keyboard shortcuts, documented in the [README](README.md). This does not establish full keyboard-only operability.
- The fractal image is primarily visual, and its structural detail may not have an equivalent text description.
- Colours, gradients, lighting and visual effects can vary substantially, so contrast is not guaranteed across user-selected palettes.
- Use requires a browser and device with WebGPU support. No fallback renderer is provided.

## Reporting barriers

Please [open an accessibility issue](https://github.com/byronbuzz/DeepGPU-Zoomer/issues/new) describing the affected control or workflow, your browser/OS and assistive technology (if any), what you expected and what prevented access. Do not include sensitive personal or medical information.

Accessibility improvements will be evaluated according to demonstrated barriers and their impact; this statement does not promise a particular compliance level or delivery date.
