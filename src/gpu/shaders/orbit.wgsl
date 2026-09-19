// Arbitrary-precision quadratic reference orbit, resident on the GPU.
//
// The whole recurrence runs inside a SINGLE workgroup. That is not a
// limitation: z_{n+1} = z_n^2 + c is strictly serial, so the only parallelism
// available is *within* each big-number operation. Staying in one workgroup
// lets us use barriers instead of the grid-wide sync WebGPU lacks, and lets one
// dispatch advance many iterations with no CPU round trip.
//
// Concatenated after orbit-bindings.wgsl and bigfixed.wgsl.

var<workgroup> escaped: u32;
// Mandelbrot keeps its pair samples; Julia transports four mantissa words.
override SAMPLE_WORDS: u32 = 12u;

fn addSeedInto(dst: u32, offset: u32) {
    var carry: u32 = 0u;
    for (var i: u32 = 0u; i < LIMBS; i = i + 1u) {
        let a = scratch[dst + i];
        let b = seed[offset + i];
        let s = a + b;
        let c0 = select(0u, 1u, s < a);
        let t = s + carry;
        let c1 = select(0u, 1u, t < s);
        scratch[dst + i] = t;
        carry = c0 + c1;
    }
}

// Subtract the exact initial Julia point before sample reduction.
fn subtractOrigin(dst: u32, offset: u32) {
    var borrow = 0u;
    for (var i = 0u; i < LIMBS; i += 1u) {
        let a = scratch[dst+i]; let b = seed[offset+i];
        let t = a-b; let out = t-borrow;
        borrow = select(0u,1u,a < b) + select(0u,1u,t < borrow);
        scratch[dst+i] = out;
    }
}
/// Converts a fixed-point slot into the HDR triple the renderer consumes: two
/// f32 mantissas plus a binary exponent, so magnitudes far below f32's normal
/// range survive the trip through storage. Restores the slot before returning.
fn emitSample(base: u32, out: u32) {
    let negative = isNegative(base);
    if (negative) { negate(base); }

    var top: i32 = -1;
    for (var i: i32 = i32(LIMBS) - 1; i >= 0; i = i - 1) {
        if (scratch[base + u32(i)] != 0u) { top = i; break; }
    }

    if (top < 0) {
        for (var j = 0u; j < SAMPLE_WORDS / 4u; j++) { samples[out + j] = 0.0; }
        return;
    }

    if (SAMPLE_WORDS == 20u) {
        let msb = top * 32 + i32(firstLeadingBit(scratch[base + u32(top)]));
        let sign = select(1.0, -1.0, negative);
        for (var j = 0u; j < 4u; j++) {
            // Exact adjacent 24-bit chunks, without a binary64 intermediate.
            let start = msb - i32(24u * (j + 1u)) + 1;
            var chunk = 0u;
            if (start < 0) {
                if (start > -24) { chunk = scratch[base] << u32(-start); }
            } else {
                let word = u32(start) / 32u;
                let shift = u32(start) % 32u;
                chunk = scratch[base + word] >> shift;
                if (shift != 0u && word + 1u < LIMBS) {
                    chunk |= scratch[base + word + 1u] << (32u - shift);
                }
            }
            samples[out + j] = sign * ldexp(f32(chunk & 0xffffffu), 1 - i32(24u * (j + 1u)));
        }
        samples[out + 4u] = f32(msb - i32(32u * (LIMBS - 1u)));
        if (negative) { negate(base); }
        return;
    }

    let hiWord = scratch[base + u32(top)];
    var w1: u32 = 0u;
    var w2: u32 = 0u;
    if (top >= 1) { w1 = scratch[base + u32(top) - 1u]; }
    if (top >= 2) { w2 = scratch[base + u32(top) - 2u]; }

    // firstLeadingBit gives the index of the most significant set bit.
    let msbIndex = firstLeadingBit(hiWord);       // 0..31
    let shift = 31u - msbIndex;                   // left shift to normalise

    var high: u32 = hiWord << shift;
    var low: u32 = w1 << shift;
    if (shift != 0u) {
        high = high | (w1 >> (32u - shift));
        low = low | (w2 >> (32u - shift));
    }

    // `high` holds 32 bits starting at the msb; `low` the next 32. An f32 only
    // carries 24 mantissa bits, so f32(high) alone would silently drop bits
    // 24..31 and leave a gap before `low` picks up at bit 32. Split so the two
    // mantissas abut: the top 24 bits go in `hi` exactly (the shift by 8 is a
    // power of two), and everything below joins `low` in `lo`.
    let msbPosition = i32(u32(top) * 32u + msbIndex);
    let exponent = msbPosition - i32(32u * (LIMBS - 1u)) - 31;
    let sign = select(1.0, -1.0, negative);

    let mantissaHi = f32(high >> 8u) * 256.0;
    let mantissaLo = f32(high & 0xffu) + f32(low) * exp2(-32.0);

    samples[out + 0u] = sign * mantissaHi;
    samples[out + 1u] = sign * mantissaLo;
    samples[out + 2u] = f32(exponent);

    if (negative) { negate(base); }
}

/// Float approximation of a fixed-point slot, from its top two limbs.
///
/// The top limb is read as signed and the next as unsigned, which reconstructs
/// the two's-complement value directly: -0.1 is stored as top limb 0xffffffff
/// (= -1) plus a fraction of 0.9, and -1 + 0.9 is the value. Reading the top
/// limb alone would report -1 and wildly overstate the magnitude.
fn approxValue(base: u32) -> f32 {
    let hi = f32(i32(scratch[base + LIMBS - 1u]));
    var lo: f32 = 0.0;
    if (LIMBS >= 2u) { lo = f32(scratch[base + LIMBS - 2u]) * exp2(-32.0); }
    return hi + lo;
}

/// |z|^2 > 256, matching ESCAPE_R2 in perturbation.wgsl.
///
/// The two bailouts have to agree. When this one was tighter the reference
/// stopped while the renderer was still iterating, and every pixel had to
/// rebase to cover the gap -- 691,200 rebases on a frame that needed none.
/// Accurate to ~24 bits, far more than a bailout test needs.
fn escapedNow() -> bool {
    let x = approxValue(slot(S_X));
    let y = approxValue(slot(S_Y));
    return x * x + y * y > 256.0;
}

var<workgroup> resumeAt: u32;

@compute @workgroup_size(256)
fn advanceOrbit(@builtin(local_invocation_id) local: vec3<u32>) {
    let tid = local.x;

    // Resume from the shared status rather than from params, so many dispatches
    // can be encoded into a single submission. queue.writeBuffer is applied
    // before any commands in the submission, so a per-dispatch uniform could
    // not vary within one encoder — self-sequencing sidesteps that entirely and
    // turns hundreds of CPU round trips into a handful.
    if (tid == 0u) {
        escaped = status[1];
        resumeAt = status[0] - 1u;   // index of the last sample written
    }
    // Uniform load: the early exit below is control flow guarding barriers.
    if (workgroupUniformLoad(&escaped) == 1u) { return; }
    let startIndex = workgroupUniformLoad(&resumeAt);

    for (var i: u32 = tid; i < LIMBS; i = i + WG) {
        scratch[slot(S_X) + i] = state[i];
        scratch[slot(S_Y) + i] = state[LIMBS + i];
    }
    sync();

    for (var iter: u32 = 0u; iter < params.iterations && startIndex + iter + 1u < params.maxSamples; iter = iter + 1u) {
        // The barriers below require provably uniform control flow, so the
        // early exit has to read `escaped` through workgroupUniformLoad --
        // a plain load of a workgroup variable is not uniform to the compiler.
        if (workgroupUniformLoad(&escaped) == 1u) { break; }

        mulFixed(tid, S_X, S_X, S_XX);
        mulFixed(tid, S_Y, S_Y, S_YY);
        mulFixed(tid, S_X, S_Y, S_XY);

        if (tid == 0u) {
            // x' = x*x - y*y + cx
            subInto(slot(S_XX), slot(S_YY));
            addSeedInto(slot(S_XX), 0u);

            // y' = 2*x*y + cy
            addInto(slot(S_XY), slot(S_XY));
            addSeedInto(slot(S_XY), LIMBS);

            for (var i: u32 = 0u; i < LIMBS; i = i + 1u) {
                scratch[slot(S_X) + i] = scratch[slot(S_XX) + i];
                scratch[slot(S_Y) + i] = scratch[slot(S_XY) + i];
            }

            let index = startIndex + iter + 1u;
            if (index < params.maxSamples) {
                let componentWords = SAMPLE_WORDS / 4u;
                emitSample(slot(S_X), index * SAMPLE_WORDS);
                emitSample(slot(S_Y), index * SAMPLE_WORDS + componentWords);
                for (var j = 0u; j < LIMBS; j += 1u) {
                    scratch[slot(S_XX)+j] = scratch[slot(S_X)+j];
                    scratch[slot(S_YY)+j] = scratch[slot(S_Y)+j];
                }
                subtractOrigin(slot(S_XX),2u*LIMBS);
                subtractOrigin(slot(S_YY),3u*LIMBS);
                emitSample(slot(S_XX), index * SAMPLE_WORDS + 2u * componentWords);
                emitSample(slot(S_YY), index * SAMPLE_WORDS + 3u * componentWords);
                status[0] = index + 1u;
            }

            if (escapedNow()) {
                escaped = 1u;
                status[1] = 1u;
                status[2] = index;
            }
        }
        sync();
    }

    for (var i: u32 = tid; i < LIMBS; i = i + WG) {
        state[i] = scratch[slot(S_X) + i];
        state[LIMBS + i] = scratch[slot(S_Y) + i];
    }
}
