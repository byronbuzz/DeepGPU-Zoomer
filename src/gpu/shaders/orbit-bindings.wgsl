// Bindings for the reference-orbit kernel.
//
// WGSL has no forward declarations, so this must be concatenated *before*
// bigfixed.wgsl — the arithmetic library reads and writes `scratch`.

struct Params {
    iterations: u32,      // iterations to advance in this dispatch
    _unusedStartIndex: u32,  // superseded: the shader resumes from status[0]
    maxSamples: u32,      // capacity of the sample buffer
    _pad: u32,
};

@group(0) @binding(0) var<storage, read_write> state: array<u32>;    // x, then y
@group(0) @binding(1) var<storage, read> seed: array<u32>;           // cx, cy, initial x, initial y
@group(0) @binding(2) var<storage, read_write> scratch: array<u32>;
@group(0) @binding(3) var<storage, read_write> samples: array<f32>;  // 12 words: absolute and origin-relative (hi,lo,exp)*2
@group(0) @binding(4) var<storage, read_write> status: array<u32>;
@group(0) @binding(5) var<uniform> params: Params;
