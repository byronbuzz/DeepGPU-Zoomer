// Shared QD-derived transport and recurrence for sensitive perturbation orbits.
// Coordinates, reference samples and rebased deltas retain all four words.
struct Wide { x: vec4<f32>, y: vec4<f32>, e: i32 };

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

fn wideReference(index: u32, relative: bool) -> Wide {
    let base = index * 20u + select(0u, 10u, relative);
    let ex = i32(orbit[base + 4u]);
    let ey = i32(orbit[base + 9u]);
    // The producer emits adjacent unsigned chunks; renormalize them into the
    // non-overlapping nearest-word expansion expected by QD arithmetic.
    let x = qRenorm(vec4<f32>(orbit[base], orbit[base + 1u], orbit[base + 2u], orbit[base + 3u]), 0.0);
    let y = qRenorm(vec4<f32>(orbit[base + 5u], orbit[base + 6u], orbit[base + 7u], orbit[base + 8u]), 0.0);
    let e = max(select(ex, -100000, x.x == 0.0), select(ey, -100000, y.x == 0.0));
    if (e == -100000) { return Wide(vec4<f32>(0.0), vec4<f32>(0.0), 0); }
    return wideNorm(Wide(
        select(ldexp(x, vec4<i32>(max(-126, ex - e))), vec4<f32>(0.0), ex - e < -126),
        select(ldexp(y, vec4<i32>(max(-126, ey - e))), vec4<f32>(0.0), ey - e < -126), e));
}

fn wideFromHdr(a: Hdr) -> Wide {
    return Wide(vec4<f32>(a.m.x, a.lo.x, 0.0, 0.0),
                vec4<f32>(a.m.y, a.lo.y, 0.0, 0.0), a.e);
}

fn iterateWide(pixel: vec2<f32>, wantDerivative: bool) -> Sample {
    let fromCentre = pixel - 0.5 * u.resolution;
    let pixelDelta = wideMul(Wide(u.wideScale, vec4<f32>(0.0), u.scaleExponent),
        Wide(vec4<f32>(fromCentre.x, 0.0, 0.0, 0.0), vec4<f32>(fromCentre.y, 0.0, 0.0, 0.0), 0));
    let direct = u.method == 0u;
    let injection = wideAdd(pixelDelta, wideNorm(Wide(u.wideOffsetX, u.wideOffsetY, u.offsetExponent)));
    var delta = injection;
    if (!JULIA) { delta = Wide(vec4<f32>(0.0), vec4<f32>(0.0), 0); }
    var z = wideAdd(wideNorm(Wide(u.wideCentreX, u.wideCentreY, 0)), pixelDelta);
    if (!direct) { z = wideAdd(wideReference(0u, false), delta); }
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

    while (n < u.maxIterations && !escaped) {
        var span = 0u;
        if (APPROX && !JULIA && !direct && (referenceIndex % u.laBaseStep) == 0u &&
            referenceIndex + u.laBaseStep < u.refLength &&
            n + u.laBaseStep <= u.maxIterations) {
            span = takeSkip(referenceIndex, &delta, &derivative, wantDerivative, injection, u.maxIterations - n);
        }
        if (span > 0u) {
            referenceIndex += span;
            n += span;
            skipped += span;
            skips += 1u;
            z = wideAdd(wideReference(referenceIndex, false), delta);
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
                var twiceReference = wideReference(referenceIndex, false);
                twiceReference.e += 1;
                // Factored quadratic difference, shared with the Julia path.
                delta = wideMul(delta, wideAdd(twiceReference, delta));
                if (!JULIA) { delta = wideAdd(delta, injection); }
                referenceIndex += 1u;
                z = wideAdd(wideReference(referenceIndex, false), delta);
            }
            n += 1u;
        }
        zValue = wideValue(z);
        z2 = dot(zValue, zValue);
        escaped = z2 > ESCAPE_R2;
        if (!direct && !escaped) {
            // Julia rebases relative to its nonzero initial point. Mandelbrot
            // starts at zero, so its absolute and relative samples coincide.
            let rebased = wideAdd(wideReference(referenceIndex, JULIA), delta);
            if (wideLog(rebased) < wideLog(delta) || referenceIndex >= u.refLength - 1u) {
                delta = rebased;
                referenceIndex = 0u;
                rebases += 1u;
            }
        }
    }
    return Sample(escaped, n, zValue, z2, hdrLog2(derivative), skipped, skips, rebases,
                  wideLog(delta), referenceIndex);
}
