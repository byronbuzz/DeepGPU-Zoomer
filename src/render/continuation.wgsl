// Mode 0, grid 1 only. Loop arithmetic below matches iterateWide verbatim.
// Wide is 48 bytes/alignment 16; this state is 304 bytes/alignment 16.
struct WideContinuation {
    delta: Wide, z: Wide, injection: Wide, checkpointZ: Wide, checkpointDelta: Wide,
    n: u32, referenceIndex: u32, skipped: u32, skips: u32, rebases: u32,
    checkpointReference: u32, checkpointPower: u32, checkpointLength: u32, haveCheckpoint: u32, reserved: u32,
    zValue: vec2<f32>, z2: f32, reserved2: u32,
};
struct ContinuationRegion {
    operations: u32, resume: u32, columns: u32, reserved: u32,
    pendingBits: array<atomic<u32>, 128>,
    states: array<WideContinuation>,
};
@group(1) @binding(0) var<storage, read_write> continuation: ContinuationRegion;
// Another density obligation may have finished this exact sample while its
// checkpoint was parked. Retire this logical visit once, preserving the work
// already performed without overwriting the determined field.
fn retireContinuedSample(stateIndex: u32) {
    let saved = continuation.states[stateIndex];
    var skipped = 0u;
    var skips = 0u;
    var rebases = 0u;
    var plain = saved.n;
    if (!DIRECT) {
        skipped = saved.skipped;
        skips = saved.skips;
        rebases = saved.rebases;
        plain = saved.n - saved.skipped;
    }
    let beforeSkipped = atomicAdd(&stats[0], skipped);
    let beforeSkips = atomicAdd(&stats[1], skips);
    let beforeRebases = atomicAdd(&stats[2], rebases);
    let beforePlain = atomicAdd(&stats[3], plain);
    if (beforeSkipped > 0xffffffffu - skipped) { atomicAdd(&stats[8], 1u); }
    if (beforeSkips > 0xffffffffu - skips) { atomicAdd(&stats[9], 1u); }
    if (beforeRebases > 0xffffffffu - rebases) { atomicAdd(&stats[10], 1u); }
    if (beforePlain > 0xffffffffu - plain) { atomicAdd(&stats[11], 1u); }
    atomicAnd(&continuation.pendingBits[stateIndex / 32u], ~(1u << (stateIndex % 32u)));
    atomicAdd(&stats[6], 1u);
}

// Direct uses the first three Wide slots for c, z and its Brent checkpoint.
fn iterateDirectContinued(pixel: vec2<f32>, stateIndex: u32) -> Sample {
    var offset = hdrMul(Hdr(vec2<f32>(u.scaleMantissa,0.0),vec2<f32>(u.scaleLow,0.0),u.scaleExponent),hdr(pixel-0.5*u.resolution,0));
    if (u.rotationCos.x != 1.0 || u.rotationSin.x != 0.0) {
        offset = hdrMul(offset, Hdr(vec2<f32>(u.rotationCos.x,u.rotationSin.x),vec2<f32>(u.rotationCos.y,u.rotationSin.y),0));
    }
    var c = hdrAdd(hdrNorm(Hdr(u.centre,u.centreLow,0)),offset);
    let detectCycle = u.mode == 0u && u.cappedPattern == 0u;
    if (continuation.resume == 0u && detectCycle && analyticMandelbrotInterior(wideFromHdr(c))) {
        return emptySample();
    }
    var z = hdrZero();
    var checkpoint = hdrZero();
    var n = 0u; var cyclePower = 0u; var cycleLength = 0u;
    var termination = SAMPLE_LIMIT;
    if (continuation.resume != 0u) {
        let saved = continuation.states[stateIndex];
        c = hdrFromWide(saved.delta); z = hdrFromWide(saved.z);
        checkpoint = hdrFromWide(saved.injection);
        n = saved.n; cyclePower = saved.referenceIndex; cycleLength = saved.skipped;
    }
    var z2 = dot(hdrValue(z),hdrValue(z));
    var escaped = z2 > ESCAPE_R2;
    var executed = 0u;
    while (n < u.maxIterations && !escaped) {
        z = hdrAdd(hdrMul(z,z),c); n += 1u;
        z2 = dot(hdrValue(z),hdrValue(z)); escaped = z2 > ESCAPE_R2;
        if (detectCycle && !escaped) {
            if (cyclePower == 0u) {
                if (n >= 64u) { checkpoint = z; cyclePower = 1u; }
            } else {
                cycleLength += 1u;
                if (sameHdrBits(z,checkpoint)) { termination = SAMPLE_NUMERICAL_PERIODIC; break; }
                if (cycleLength == cyclePower) {
                    checkpoint = z; cycleLength = 0u;
                    cyclePower = min(cyclePower << 1u,u.maxIterations);
                }
            }
        }
        executed += 1u;
        if (executed >= continuation.operations && n < u.maxIterations && !escaped) {
            let zeroWide = Wide(vec4<f32>(0.0),vec4<f32>(0.0),0);
            continuation.states[stateIndex] = WideContinuation(wideFromHdr(c),wideFromHdr(z),wideFromHdr(checkpoint),zeroWide,zeroWide,
                n,cyclePower,cycleLength,0u,0u,0u,0u,0u,0u,0u,hdrValue(z),z2,0u);
            atomicOr(&continuation.pendingBits[stateIndex / 32u],1u << (stateIndex % 32u));
            atomicAdd(&stats[7],1u);
            return Sample(false,n,hdrValue(z),-1.0,0.0,0u,0u,0u,0.0,0u,SAMPLE_PENDING);
        }
    }
    return Sample(escaped,n,hdrValue(z),z2,0.0,0u,0u,0u,hdrLog2(z),0u,
                  select(termination, SAMPLE_ESCAPE, escaped));
}
fn iterateWideContinued(pixel: vec2<f32>, stateIndex: u32) -> Sample {
    if (DIRECT) { return iterateDirectContinued(pixel,stateIndex); }
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
    if (continuation.resume == 0u && !JULIA && u.mode == 0u && u.cappedPattern == 0u &&
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
    let detectPeriodic = !APPROX && u.cappedPattern == 0u;
    var checkpointZ = z;
    var checkpointDelta = delta;
    var checkpointReference = referenceIndex;
    var checkpointPower = 1u;
    var checkpointLength = 0u;
    var haveCheckpoint = false;
    var termination = SAMPLE_LIMIT;

    if (continuation.resume != 0u) {
        let saved = continuation.states[stateIndex];
        delta = saved.delta; z = saved.z; injection = saved.injection;
        checkpointZ = saved.checkpointZ; checkpointDelta = saved.checkpointDelta;
        checkpointReference = saved.checkpointReference; checkpointPower = saved.checkpointPower;
        checkpointLength = saved.checkpointLength; haveCheckpoint = saved.haveCheckpoint != 0u;
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
        if (detectPeriodic && !escaped && (n & 63u) == 0u) {
            if (haveCheckpoint && referenceIndex == checkpointReference &&
                sameWideBits(delta, checkpointDelta) && sameWideBits(z, checkpointZ)) {
                termination = SAMPLE_NUMERICAL_PERIODIC; break;
            }
            checkpointLength += 1u;
            if (!haveCheckpoint || checkpointLength >= checkpointPower) {
                checkpointZ = z; checkpointDelta = delta; checkpointReference = referenceIndex;
                haveCheckpoint = true; checkpointLength = 0u;
                checkpointPower = min(checkpointPower * 2u, 262144u);
            }
        }
        executed += 1u;
        if (executed >= continuation.operations && n < u.maxIterations && !escaped) {
            continuation.states[stateIndex] = WideContinuation(delta, z, injection, checkpointZ, checkpointDelta,
                n, referenceIndex, skipped, skips, rebases,
                checkpointReference, checkpointPower, checkpointLength, select(0u,1u,haveCheckpoint), 0u,
                zValue, z2, 0u);
            atomicOr(&continuation.pendingBits[stateIndex / 32u], 1u << (stateIndex % 32u));
            atomicAdd(&stats[7], 1u);
            // Negative z2 means unresolved. compute must not publish a field or counters.
            return Sample(false, n, zValue, -1.0, 0.0, skipped, skips, rebases, 0.0, referenceIndex, SAMPLE_PENDING);
        }
    }
    return Sample(escaped, n, zValue, z2, hdrLog2(derivative), skipped, skips, rebases,
                  wideLog(delta), referenceIndex, select(termination, SAMPLE_ESCAPE, escaped));
}
