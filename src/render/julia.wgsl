// Julia's sensitive long orbits need more than the Mandelbrot pair mantissa.
// Four QD components and one exponent cover coordinates, reference transport,
// perturbation and rebasing. There is no precision retry or pixel repair.
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

fn juliaReference(index: u32, relative: bool) -> Wide {
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

fn iterateJulia(pixel: vec2<f32>, wantDerivative: bool) -> Sample {
    let fromCentre = pixel - 0.5 * u.resolution;
    let pixelDelta = wideMul(Wide(u.juliaScale, vec4<f32>(0.0), u.scaleExponent),
        Wide(vec4<f32>(fromCentre.x, 0.0, 0.0, 0.0), vec4<f32>(fromCentre.y, 0.0, 0.0, 0.0), 0));
    let direct = u.method == 0u;
    var delta = wideAdd(pixelDelta, wideNorm(Wide(u.juliaOffsetX, u.juliaOffsetY, u.offsetExponent)));
    var z = wideAdd(wideNorm(Wide(u.juliaCentreX, u.juliaCentreY, 0)), pixelDelta);
    if (!direct) { z = wideAdd(juliaReference(0u, false), delta); }
    let c = wideNorm(Wide(u.juliaConstantX, u.juliaConstantY, 0));
    var derivative = HDR_ONE;
    var n = 0u;
    var referenceIndex = 0u;
    var rebases = 0u;
    var zValue = wideValue(z);
    var z2 = dot(zValue, zValue);
    var escaped = z2 > ESCAPE_R2;

    while (n < u.maxIterations && !escaped) {
        if (wantDerivative) {
            // The derivative is used only for colouring, retaining its existing
            // pair representation; the orbit and escape decision stay wide.
            let pair = Hdr(vec2<f32>(z.x.x, z.y.x), vec2<f32>(z.x.y, z.y.y), z.e + 1);
            derivative = hdrMul(derivative, pair);
        }
        if (direct) {
            z = wideAdd(wideMul(z, z), c);
        } else {
            var twiceReference = juliaReference(referenceIndex, false);
            twiceReference.e += 1;
            // Factored quadratic difference: delta * (2*Z + delta).
            delta = wideMul(delta, wideAdd(twiceReference, delta));
            referenceIndex += 1u;
            z = wideAdd(juliaReference(referenceIndex, false), delta);
        }
        n += 1u;
        zValue = wideValue(z);
        z2 = dot(zValue, zValue);
        escaped = z2 > ESCAPE_R2;
        if (!direct && !escaped) {
            let rebased = wideAdd(juliaReference(referenceIndex, true), delta);
            if (wideLog(rebased) < wideLog(delta) || referenceIndex >= u.refLength - 1u) {
                delta = rebased;
                referenceIndex = 0u;
                rebases += 1u;
            }
        }
    }
    return Sample(escaped, n, zValue, z2, hdrLog2(derivative), 0u, 0u, rebases,
                  wideLog(delta), referenceIndex);
}
