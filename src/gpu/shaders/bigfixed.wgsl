// Fixed-point big-number arithmetic over a shared `scratch` storage buffer.
//
// A value is a two's-complement integer over LIMBS u32 words, little-endian,
// scaled by 2^-(32 * (LIMBS - 1)). Every sample of a Mandelbrot reference orbit
// satisfies |z| < 4 or the orbit has escaped, so no exponent field is needed.
//
// All routines are collective: every invocation in the workgroup must call them
// in the same order. `scratch` lives in the storage address space, so every
// synchronisation point needs storageBarrier() as well as workgroupBarrier() --
// workgroupBarrier() alone only orders the workgroup address space.

override LIMBS: u32 = 64u;

const WG: u32 = 256u;

// Scratch slots, each LIMBS words wide.
const S_X: u32 = 0u;    // z.x
const S_Y: u32 = 1u;    // z.y
const S_XX: u32 = 2u;   // x*x
const S_YY: u32 = 3u;   // y*y
const S_XY: u32 = 4u;   // x*y
const S_MA: u32 = 5u;   // multiplier operand A (magnitude)
const S_MB: u32 = 6u;   // multiplier operand B (magnitude)
const S_SLOTS: u32 = 7u;

var<workgroup> signFlip: u32;

fn slot(s: u32) -> u32 { return s * LIMBS; }

/// Column accumulators live past the slots: 2*LIMBS columns of 3 words each.
fn col(k: u32) -> u32 { return S_SLOTS * LIMBS + k * 3u; }

/// Total scratch words a given precision needs.
fn scratchSize() -> u32 { return S_SLOTS * LIMBS + 2u * LIMBS * 3u; }

fn sync() {
    storageBarrier();
    workgroupBarrier();
}

// ---------------------------------------------------------------- emulated u64

struct U64 { lo: u32, hi: u32 };

// 32x32 -> 64 via 16-bit partial products. No floating point: WGSL u32
// arithmetic is exact modulo 2^32, which is all this needs.
fn mul32(a: u32, b: u32) -> U64 {
    let a0 = a & 0xffffu;
    let a1 = a >> 16u;
    let b0 = b & 0xffffu;
    let b1 = b >> 16u;

    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let p11 = a1 * b1;

    // mid = p01 + p10 may carry out of 32 bits. That carry is worth 2^48,
    // i.e. 2^16 in the high word.
    let mid = p01 + p10;
    let midCarry = select(0u, 0x10000u, mid < p01);

    let lo = p00 + (mid << 16u);
    let loCarry = select(0u, 1u, lo < p00);

    return U64(lo, p11 + (mid >> 16u) + midCarry + loCarry);
}

fn addU64(a: U64, b: U64) -> U64 {
    let lo = a.lo + b.lo;
    let carry = select(0u, 1u, lo < a.lo);
    return U64(lo, a.hi + b.hi + carry);
}

// ------------------------------------------------------------ limb primitives

fn isNegative(base: u32) -> bool {
    return (scratch[base + LIMBS - 1u] & 0x80000000u) != 0u;
}

/// Two's-complement negate in place. Serial: thread 0 only.
fn negate(base: u32) {
    var carry: u32 = 1u;
    for (var i: u32 = 0u; i < LIMBS; i = i + 1u) {
        let inverted = ~scratch[base + i];
        let sum = inverted + carry;
        carry = select(0u, 1u, sum < inverted);
        scratch[base + i] = sum;
    }
}

/// Collective copy between slots. (`from`/`to` are reserved words in WGSL.)
fn copySlot(tid: u32, src: u32, dst: u32) {
    for (var i: u32 = tid; i < LIMBS; i = i + WG) {
        scratch[slot(dst) + i] = scratch[slot(src) + i];
    }
}

// --------------------------------------------------------------- multiplication

/// Column k accumulates every a[i]*b[j] with i + j == k, into 96 bits. Each
/// thread owns whole columns, so the partial products never race.
fn accumulateColumns(tid: u32) {
    let columns = 2u * LIMBS;
    let aBase = slot(S_MA);
    let bBase = slot(S_MB);

    for (var k: u32 = tid; k < columns; k = k + WG) {
        var sum0: u32 = 0u;
        var sum1: u32 = 0u;
        var sum2: u32 = 0u;

        let lo = select(0u, k - (LIMBS - 1u), k >= LIMBS);
        let hi = min(k, LIMBS - 1u);
        for (var i: u32 = lo; i <= hi; i = i + 1u) {
            let p = mul32(scratch[aBase + i], scratch[bBase + (k - i)]);

            let n0 = sum0 + p.lo;
            let c0 = select(0u, 1u, n0 < sum0);
            sum0 = n0;

            let n1 = sum1 + p.hi;
            let c1 = select(0u, 1u, n1 < sum1);
            let n1c = n1 + c0;
            let c2 = select(0u, 1u, n1c < n1);
            sum1 = n1c;

            sum2 = sum2 + c1 + c2;
        }

        scratch[col(k) + 0u] = sum0;
        scratch[col(k) + 1u] = sum1;
        scratch[col(k) + 2u] = sum2;
    }
}

/// Propagates carries across the columns and writes the fixed-point result:
/// the full product shifted right by 32*(LIMBS-1) bits, i.e. product limbs
/// [LIMBS-1 .. 2*LIMBS-2]. Serial, and obviously correct.
fn resolveColumns(dst: u32) {
    var carry0: u32 = 0u;
    var carry1: u32 = 0u;
    let columns = 2u * LIMBS;

    for (var k: u32 = 0u; k < columns; k = k + 1u) {
        let c0 = scratch[col(k) + 0u];
        let c1 = scratch[col(k) + 1u];
        let c2 = scratch[col(k) + 2u];

        let s0 = c0 + carry0;
        let k0 = select(0u, 1u, s0 < c0);

        let s1a = c1 + carry1;
        let k1 = select(0u, 1u, s1a < c1);
        let s1 = s1a + k0;
        let k2 = select(0u, 1u, s1 < s1a);

        if (k + 1u >= LIMBS && k < 2u * LIMBS - 1u) {
            scratch[dst + (k + 1u - LIMBS)] = s0;
        }
        carry0 = s1;
        carry1 = c2 + k1 + k2;
    }
}

/// dst = a * b in fixed point, honouring two's-complement signs. Operands are
/// copied first, so dst may alias a or b. Magnitudes are multiplied and the
/// sign reapplied, which truncates toward zero.
fn mulFixed(tid: u32, a: u32, b: u32, dst: u32) {
    copySlot(tid, a, S_MA);
    copySlot(tid, b, S_MB);
    sync();

    if (tid == 0u) {
        var flip: u32 = 0u;
        if (isNegative(slot(S_MA))) { negate(slot(S_MA)); flip = flip ^ 1u; }
        if (isNegative(slot(S_MB))) { negate(slot(S_MB)); flip = flip ^ 1u; }
        signFlip = flip;
    }
    sync();

    for (var k: u32 = tid; k < 2u * LIMBS; k = k + WG) {
        scratch[col(k) + 0u] = 0u;
        scratch[col(k) + 1u] = 0u;
        scratch[col(k) + 2u] = 0u;
    }
    sync();

    accumulateColumns(tid);
    sync();

    if (tid == 0u) {
        resolveColumns(slot(dst));
        if (signFlip == 1u) { negate(slot(dst)); }
    }
    sync();
}

// ------------------------------------------------------------------- add / sub

fn addInto(dst: u32, src: u32) {
    var carry: u32 = 0u;
    for (var i: u32 = 0u; i < LIMBS; i = i + 1u) {
        let a = scratch[dst + i];
        let b = scratch[src + i];
        let s = a + b;
        let c0 = select(0u, 1u, s < a);
        let t = s + carry;
        let c1 = select(0u, 1u, t < s);
        scratch[dst + i] = t;
        carry = c0 + c1;
    }
}

fn subInto(dst: u32, src: u32) {
    var borrow: u32 = 0u;
    for (var i: u32 = 0u; i < LIMBS; i = i + 1u) {
        let a = scratch[dst + i];
        let b = scratch[src + i];
        let d = a - b;
        let b0 = select(0u, 1u, a < b);
        let e = d - borrow;
        let b1 = select(0u, 1u, d < borrow);
        scratch[dst + i] = e;
        borrow = b0 + b1;
    }
}
