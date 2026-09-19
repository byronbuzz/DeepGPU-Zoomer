# Third-party code

GPU-Zoomer-3 is licensed under GPL-3.0-or-later; see LICENSE.

The stable sample reuse design follows the coordinate-preserving sample
movement and selective calculation inspected in
[XaoSjs](https://github.com/xaos-project/XaoSjs/blob/c82013cbf428948d01f5345d82471632a1cb6ac4/js/xaos.js)
(GPL-3.0-or-later) and
[XaoS](https://github.com/xaos-project/XaoS/blob/51fd5e2ba052246c6ef44c556e906aac9c822378/src/engine/zoom.cpp)
(GPL-2.0-or-later). This implementation uses a regular nested sample grid
and GPU field copying; it does not include their full line-reallocation engine.

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

The four-component operations in src/arithmetic/quad.wgsl adapt QD 2.3.24's
renorm, default sloppy_add and accurate_mul algorithms from
[BL-highprecision/QD](https://github.com/BL-highprecision/QD), revision
b1c8ddfd2d4a0f0901a88491524df728a26cbe8e. The adaptation uses f32 components,
splitter 4097, and normalized exponent-carrying operands. See licenses/QD-LICENSE
(BSD-3-Clause) and licenses/QD-COPYING for the original notices.
