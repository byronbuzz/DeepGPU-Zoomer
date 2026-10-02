// Ordinary scalar Mandelbrot variants fix only these appearance-independent
// calculation choices. Existing variants retain the uniform-controlled path.
override ORDINARY: bool = false;
fn sampleMode() -> u32 {
    if (ORDINARY) { return 0u; }
    return u.mode;
}
fn sampleGrid() -> u32 {
    if (ORDINARY) { return 1u; }
    return max(u.supersample, 1u);
}
fn sampleCappedPattern() -> u32 {
    if (ORDINARY) { return 0u; }
    return u.cappedPattern;
}
fn sampleRetainEndpoints() -> bool {
    if (ORDINARY) { return false; }
    return u.retainEndpoints != 0u;
}

// Shared QD-derived transport and recurrence for sensitive perturbation orbits.
// Coordinates, reference samples and rebased deltas retain all four words.
struct Wide { x: vec4<f32>, y: vec4<f32>, e: i32 };

// Each immutable raw reference sample is normalised once by
// decodeReferenceOrbit. Pixel recurrences only load these decoded bits.
// One Wide per Mandelbrot sample; Julia retains adjacent absolute/relative
// Wides. Each Wide has the same 48-byte layout as either half of the old pair.
@group(0) @binding(9) var<storage, read_write> decodedOrbit: array<Wide>;
@group(0) @binding(10) var<storage, read_write> decodeMismatches: atomic<u32>;

fn wideNorm(a: Wide) -> Wide {
    let magnitude = max(abs(a.x.x), abs(a.y.x));
    if (magnitude == 0.0) { return Wide(vec4<f32>(0.0), vec4<f32>(0.0), 0); }
    let shift = frexp(magnitude).exp;
    let first = -shift / 2;
    return Wide(ldexp(ldexp(a.x, vec4<i32>(first)), vec4<i32>(-shift - first)),
                ldexp(ldexp(a.y, vec4<i32>(first)), vec4<i32>(-shift - first)), a.e + shift);
}

fn wideAdd(a: Wide, b: Wide) -> Wide {
    if (all(a.x == vec4<f32>(0.0)) && all(a.y == vec4<f32>(0.0))) { return b; }
    if (all(b.x == vec4<f32>(0.0)) && all(b.y == vec4<f32>(0.0))) { return a; }
    if (a.e - b.e > 120) { return a; }
    if (b.e - a.e > 120) { return b; }
    let e = max(a.e, b.e);
    return wideNorm(Wide(
        qAdd(ldexp(a.x, vec4<i32>(a.e - e)), ldexp(b.x, vec4<i32>(b.e - e))),
        qAdd(ldexp(a.y, vec4<i32>(a.e - e)), ldexp(b.y, vec4<i32>(b.e - e))), e));
}

fn wideMul(a: Wide, b: Wide) -> Wide {
    return wideNorm(Wide(qAdd(qMul(a.x, b.x), -qMul(a.y, b.y)),
                         qAdd(qMul(a.x, b.y), qMul(a.y, b.x)), a.e + b.e));
}

fn wideLog(a: Wide) -> f32 {
    if (a.x.x == 0.0 && a.y.x == 0.0) { return -1e30; }
    return f32(a.e) + 0.5 * log2(max(a.x.x * a.x.x + a.y.x * a.y.x, 1e-38));
}

fn wideValue(a: Wide) -> vec2<f32> {
    if (a.e < -120) { return vec2<f32>(0.0); }
    return ldexp(vec2<f32>(a.x.x, a.y.x), vec2<i32>(a.e));
}

fn wideReal(value: f32) -> Wide {
    return Wide(vec4<f32>(value, 0.0, 0.0, 0.0), vec4<f32>(0.0), 0);
}

fn wideRealPart(value: Wide) -> Wide {
    return Wide(value.x, vec4<f32>(0.0), value.e);
}

fn wideImagPart(value: Wide) -> Wide {
    return Wide(value.y, vec4<f32>(0.0), value.e);
}

fn wideNegate(value: Wide) -> Wide {
    return Wide(-value.x, -value.y, value.e);
}

// A positive QD result is accepted only when its leading word dominates the
// retained tail and the result is comfortably outside a fixed uncertainty
// band. Points near either analytic boundary keep the ordinary recurrence.
fn decisivelyPositive(value: Wide) -> bool {
    let normalized = wideNorm(value);
    let tail = abs(normalized.x.y) + abs(normalized.x.z) + abs(normalized.x.w);
    let lower = normalized.x.x - tail;
    return lower > 0.0 && f32(normalized.e) + log2(lower) > -20.0;
}

// Proven Mandelbrot interiors. This intentionally uses the existing Wide/QD
// coordinate representation; the leading f32 value is only a cheap rejection.
fn analyticMandelbrotInterior(c: Wide) -> bool {
    let approximate = wideValue(c);
    if (approximate.x < -1.3 || approximate.x > 0.3 || abs(approximate.y) > 0.7) {
        return false;
    }

    let x = wideRealPart(c);
    let y = wideImagPart(c);
    let y2 = wideMul(y, y);

    let bulbX = wideAdd(x, wideReal(1.0));
    let bulbDistance = wideAdd(wideMul(bulbX, bulbX), y2);
    if (decisivelyPositive(wideAdd(wideReal(0.0625), wideNegate(bulbDistance)))) {
        return true;
    }

    let cardioidX = wideAdd(x, wideReal(-0.25));
    let q = wideAdd(wideMul(cardioidX, cardioidX), y2);
    let left = wideMul(q, wideAdd(q, cardioidX));
    let right = wideMul(y2, wideReal(0.25));
    return decisivelyPositive(wideAdd(right, wideNegate(left)));
}

fn decodeRawReference(index: u32) -> Wide {
    let base = index * 10u;
    let ex = i32(rawOrbit[base + 4u]);
    let ey = i32(rawOrbit[base + 9u]);
    // The producer emits adjacent unsigned chunks; renormalize them into the
    // non-overlapping nearest-word expansion expected by QD arithmetic.
    let x = qRenorm(vec4<f32>(rawOrbit[base], rawOrbit[base + 1u], rawOrbit[base + 2u], rawOrbit[base + 3u]), 0.0);
    let y = qRenorm(vec4<f32>(rawOrbit[base + 5u], rawOrbit[base + 6u], rawOrbit[base + 7u], rawOrbit[base + 8u]), 0.0);
    let e = max(select(ex, -100000, x.x == 0.0), select(ey, -100000, y.x == 0.0));
    if (e == -100000) { return Wide(vec4<f32>(0.0), vec4<f32>(0.0), 0); }
    return wideNorm(Wide(
        select(ldexp(x, vec4<i32>(max(-126, ex - e))), vec4<f32>(0.0), ex - e < -126),
        select(ldexp(y, vec4<i32>(max(-126, ey - e))), vec4<f32>(0.0), ey - e < -126), e));
}

fn wideReference(index: u32, relative: bool) -> Wide {
    let component = index * select(1u, 2u, JULIA) + select(0u, 1u, JULIA && relative);
    return decodedOrbit[component];
}

@compute @workgroup_size(64)
fn decodeReferenceOrbit(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
    let index = gid.x + gid.y * groups.x * 64u;
    if (index >= arrayLength(&decodedOrbit)) { return; }
    decodedOrbit[index] = decodeRawReference(index);
}

fn sameWideBits(a: Wide, b: Wide) -> bool {
    return all(bitcast<vec4<u32>>(a.x) == bitcast<vec4<u32>>(b.x)) &&
        all(bitcast<vec4<u32>>(a.y) == bitcast<vec4<u32>>(b.y)) && a.e == b.e;
}

// Development validation compares stored entries with the incumbent decoder
// on the GPU, avoiding a second arithmetic implementation on the CPU.
@compute @workgroup_size(64)
fn verifyDecodedReferenceOrbit(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
    let index = gid.x + gid.y * groups.x * 64u;
    if (index >= arrayLength(&decodedOrbit)) { return; }
    let decoded = decodedOrbit[index];
    if (!sameWideBits(decoded, decodeRawReference(index))) {
        atomicAdd(&decodeMismatches, 1u);
    }
}

fn wideFromHdr(a: Hdr) -> Wide {
    return Wide(vec4<f32>(a.m.x, a.lo.x, 0.0, 0.0),
                vec4<f32>(a.m.y, a.lo.y, 0.0, 0.0), a.e);
}

fn iterateWide(pixel: vec2<f32>, wantDerivative: bool) -> Sample {
    let fromCentre = pixel - 0.5 * u.domainResolution;
    var pixelDelta = wideMul(Wide(u.wideScale, vec4<f32>(0.0), u.scaleExponent),
        Wide(vec4<f32>(fromCentre.x, 0.0, 0.0, 0.0), vec4<f32>(fromCentre.y, 0.0, 0.0, 0.0), 0));
    if (u.rotationCos.x != 1.0 || u.rotationSin.x != 0.0) {
        pixelDelta = wideMul(pixelDelta, Wide(u.rotationCos,u.rotationSin,0));
    }
    let direct = JULIA && u.method == 0u;
    let injection = wideAdd(pixelDelta, wideNorm(Wide(u.wideOffsetX, u.wideOffsetY, u.offsetExponent)));
    var parameterDelta = injection;
    if (JULIA) { parameterDelta = Wide(vec4<f32>(0.0), vec4<f32>(0.0), 0); }
    var delta = injection;
    if (!JULIA) { delta = Wide(vec4<f32>(0.0), vec4<f32>(0.0), 0); }
    var z = wideAdd(wideNorm(Wide(u.wideCentreX, u.wideCentreY, 0)), pixelDelta);
    if (!JULIA && sampleMode() == 0u && sampleCappedPattern() == 0u &&
        analyticMandelbrotInterior(z)) {
        // The caller already represents a determined capped sample as (-1,0).
        // n=0 records that no recurrence iterations were executed.
        return emptySample();
    }
    var reference = Wide(vec4<f32>(0.0), vec4<f32>(0.0), 0);
    if (!direct) {
        reference = wideReference(0u, false);
        z = wideAdd(reference, delta);
    }
    let c = wideNorm(Wide(u.juliaConstantX, u.juliaConstantY, 0));
    var derivative = HDR_ONE;
    if (!JULIA) { derivative = hdrZero(); }
    var n = 0u;
    var referenceIndex = 0u;
    var rebases = 0u;
    var skipped = 0u;
    var skips = 0u;
    var zValue = wideValue(z);
    var z2 = dot(zValue, zValue);
    var escaped = z2 > ESCAPE_R2;
    // The ordinary no-skip path can terminate on an exact repeated numerical
    // state. Check sparsely; approximation depends on the remaining budget.
    let detectPeriodic = !APPROX && sampleMode() == 0u &&
        sampleCappedPattern() == 0u && !wantDerivative;
    var checkpointZ = z;
    var checkpointDelta = delta;
    var checkpointReference = referenceIndex;
    var checkpointPower = 1u;
    var checkpointLength = 0u;
    var haveCheckpoint = false;
    var termination = SAMPLE_LIMIT;

    while (n < u.maxIterations && !escaped) {
        var span = 0u;
        if (APPROX && (!JULIA || sampleMode() == 0u) && !direct && referenceIndex > 0u &&
            ((referenceIndex - 1u) % u.laBaseStep) == 0u &&
            referenceIndex + u.laBaseStep < u.refLength &&
            n + u.laBaseStep <= u.maxIterations) {
            span = takeSkip(referenceIndex, &delta, &derivative, wantDerivative, parameterDelta, u.maxIterations - n);
        }
        if (span > 0u) {
            referenceIndex += span;
            n += span;
            skipped += span;
            skips += 1u;
            reference = wideReference(referenceIndex, false);
            z = wideAdd(reference, delta);
        } else {
            if (wantDerivative) {
                // Colouring retains its existing pair derivative; the orbit
                // and escape decision remain wide across every operation.
                let pair = Hdr(vec2<f32>(z.x.x, z.y.x), vec2<f32>(z.x.y, z.y.y), z.e + 1);
                derivative = hdrMul(derivative, pair);
                if (!JULIA) { derivative = hdrAdd(derivative, HDR_ONE); }
            }
            if (direct) {
                z = wideAdd(wideMul(z, z), c);
            } else {
                var twiceReference = reference;
                twiceReference.e += 1;
                // Factored quadratic difference, shared with the Julia path.
                delta = wideMul(delta, wideAdd(twiceReference, delta));
                if (!JULIA) { delta = wideAdd(delta, injection); }
                referenceIndex += 1u;
                reference = wideReference(referenceIndex, false);
                z = wideAdd(reference, delta);
            }
            n += 1u;
        }
        zValue = wideValue(z);
        z2 = dot(zValue, zValue);
        escaped = z2 > ESCAPE_R2;
        if (!direct && !escaped) {
            // Julia rebases relative to its nonzero initial point. Mandelbrot
            // starts at zero, so its absolute and relative samples coincide.
            var rebased = z;
            if (JULIA) { rebased = wideAdd(wideReference(referenceIndex, true), delta); }
            if (wideLog(rebased) < wideLog(delta) || referenceIndex >= u.refLength - 1u) {
                delta = rebased;
                referenceIndex = 0u;
                reference = wideReference(0u, false);
                rebases += 1u;
            }
        }
        if (detectPeriodic && !escaped && (n & 63u) == 0u) {
            if (haveCheckpoint && referenceIndex == checkpointReference &&
                sameWideBits(delta, checkpointDelta) && sameWideBits(z, checkpointZ)) {
                termination = SAMPLE_NUMERICAL_PERIODIC; break;
            }
            checkpointLength += 1u;
            // Brent checkpoints on the sparse sample stream also catch exact
            // cycles whose period does not divide the 64-iteration stride.
            if (!haveCheckpoint || checkpointLength >= checkpointPower) {
                checkpointZ = z;
                checkpointDelta = delta;
                checkpointReference = referenceIndex;
                haveCheckpoint = true;
                checkpointLength = 0u;
                checkpointPower = min(checkpointPower * 2u, 262144u);
            }
        }
    }
    return Sample(escaped, n, zValue, z2, hdrLog2(derivative), skipped, skips, rebases,
                  wideLog(delta), referenceIndex, select(termination, SAMPLE_ESCAPE, escaped));
}
