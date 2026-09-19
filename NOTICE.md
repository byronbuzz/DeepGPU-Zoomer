# Third-party code

GPU-Zoomer-3 is licensed under GPL-3.0-or-later; see LICENSE.

The arithmetic, GPU reference orbit, perturbation renderer, BLA, reprojection,
colour settings and associated original tests are adapted from
[Desarso/mandelbrot-webgpu](https://github.com/Desarso/mandelbrot-webgpu),
revision 6f03eb2adb2461e3481cbd0ae4403f376c53a455, GPL-3.0-or-later.
That project credits FractalShark (Matt Renzelmann and contributors, GPL-3.0)
for GPU reference-orbit architecture, perturbation, rebasing and acceleration.
Perturbation is due to K. I. Martin; rebasing and bilinear approximation to
Zhuoran, with explanations by Claude Heiland-Allen.

Julia reference-relative encoding and rebasing are adapted from
[Timmor77/FractalFlow](https://github.com/Timmor77/FractalFlow),
revision 42eea6e4a7a5909f687ca49156272cd9a41e2020,
Copyright Timofei Amosov, Apache-2.0. See licenses/FractalFlow-LICENSE
and licenses/FractalFlow-NOTICE.

Adaptations include Julia initialization and relative samples, compensated
mantissas, normalization, iteration-budget handling, camera/presentation,
exact saved state and independent numerical checks.

The compensated f32-pair helpers in src/arithmetic/compensated.wgsl reuse
the author's prior WebGPU-Zoomer implementation at revision
444431aaed32bd4227559931bde6c0e1e2869e8c, with the author's permission.
