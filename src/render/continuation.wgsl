// Mode 0, grid 1 only. Loop arithmetic below matches iterateWide verbatim.
// Wide is 48 bytes/alignment 16; this state is 192 bytes/alignment 16.
struct WideContinuation {
    delta: Wide, z: Wide, injection: Wide,
    n: u32, referenceIndex: u32, skipped: u32, skips: u32, rebases: u32,
    zValue: vec2<f32>, z2: f32, reserved: u32,
};
struct ContinuationRegion {
    operations: u32, resume: u32, columns: u32, reserved: u32,
    pendingBits: array<atomic<u32>, 128>,
    states: array<WideContinuation>,
};
@group(1) @binding(0) var<storage, read_write> continuation: ContinuationRegion;
fn iterateWideContinued(pixel: vec2<f32>, stateIndex: u32) -> Sample {
    let wantDerivative = false;
    let fromCentre = pixel - 0.5 * u.resolution;
    var pixelDelta = wideMul(Wide(u.wideScale, vec4<f32>(0.0), u.scaleExponent),
        Wide(vec4<f32>(fromCentre.x, 0.0, 0.0, 0.0), vec4<f32>(fromCentre.y, 0.0, 0.0, 0.0), 0));
    if (u.rotationCos.x != 1.0 || u.rotationSin.x != 0.0) {
        pixelDelta = wideMul(pixelDelta, Wide(u.rotationCos,u.rotationSin,0));
    }
    let direct = JULIA && u.method == 0u;
    var injection = wideAdd(pixelDelta, wideNorm(Wide(u.wideOffsetX, u.wideOffsetY, u.offsetExponent)));
    var parameterDelta = injection;
    if (JULIA) { parameterDelta = Wide(vec4<f32>(0.0), vec4<f32>(0.0), 0); }
    var delta = injection;
    if (!JULIA) { delta = Wide(vec4<f32>(0.0), vec4<f32>(0.0), 0); }
    var z = wideAdd(wideNorm(Wide(u.wideCentreX, u.wideCentreY, 0)), pixelDelta);
    if (continuation.resume == 0u && !JULIA && u.mode == 0u && u.retainEndpoints == 0u && u.cappedPattern == 0u &&
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

    if (continuation.resume != 0u) {
        let saved = continuation.states[stateIndex];
        delta = saved.delta; z = saved.z; injection = saved.injection;
        if (!JULIA) { parameterDelta = injection; }
        n = saved.n; referenceIndex = saved.referenceIndex;
        skipped = saved.skipped; skips = saved.skips; rebases = saved.rebases;
        zValue = saved.zValue; z2 = saved.z2; escaped = false;
        reference = wideReference(referenceIndex, false);
    }
    var executed = 0u;
    while (n < u.maxIterations && !escaped) {
        var span = 0u;
        if (APPROX && (!JULIA || u.mode == 0u) && !direct && referenceIndex > 0u &&
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
        executed += 1u;
        if (executed >= continuation.operations && n < u.maxIterations && !escaped) {
            continuation.states[stateIndex] = WideContinuation(delta, z, injection,
                n, referenceIndex, skipped, skips, rebases, zValue, z2, 0u);
            atomicOr(&continuation.pendingBits[stateIndex / 32u], 1u << (stateIndex % 32u));
            atomicAdd(&stats[7], 1u);
            // Negative z2 means unresolved. compute must not publish a field or counters.
            return Sample(false, n, zValue, -1.0, 0.0, skipped, skips, rebases, 0.0, referenceIndex);
        }
    }
    return Sample(escaped, n, zValue, z2, hdrLog2(derivative), skipped, skips, rebases,
                  wideLog(delta), referenceIndex);
}
