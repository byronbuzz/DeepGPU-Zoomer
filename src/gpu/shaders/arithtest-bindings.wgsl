// Bindings for the arithmetic self-test kernels. Concatenated before
// bigfixed.wgsl, which reads and writes `scratch`.

struct TestParams {
    op: u32,      // 0 = multiply, 1 = add, 2 = subtract
    cases: u32,   // how many operand pairs to process
    _p0: u32,
    _p1: u32,
};

// Packed operand pairs: a[LIMBS], b[LIMBS], repeated.
@group(0) @binding(0) var<storage, read> operands: array<u32>;
@group(0) @binding(1) var<storage, read_write> results: array<u32>;
@group(0) @binding(2) var<storage, read_write> scratch: array<u32>;
@group(0) @binding(3) var<uniform> tp: TestParams;
