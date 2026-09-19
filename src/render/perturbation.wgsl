// Per-pixel perturbation rendering against a GPU-generated reference orbit.
//
// The reference samples X_n are O(1) and fit in f32 directly. The per-pixel
// delta does not: at a zoom of 1e-60 it starts around 1e-60 and grows to O(1)
// before escaping, a dynamic range no f32 can hold. So the delta is carried as
// an explicit mantissa/exponent pair ("Hdr" below) and renormalised every
// iteration. That, not the orbit, is what sets the depth limit of the old
// WebGL path -- its f32 deltas simply underflow to zero.

struct Uniforms {
    resolution: vec2<f32>,
    // Complex units per pixel, as mantissa * 2^exponent.
    scaleMantissa: f32,
    scaleExponent: i32,
    // View centre relative to the reference point, same encoding.
    offsetMantissa: vec2<f32>,
    offsetExponent: i32,
    maxIterations: u32,
    refLength: u32,
    palette: u32,
    colorCycle: f32,
    colorOffset: f32,
    mapping: u32,
    mirror: u32,
    smoothShading: u32,
    interior: vec3<f32>,
    stopCount: u32,
    // Linear approximation: levels of precomputed skips. laLevels == 0 disables.
    laLevels: u32,
    laBaseStep: u32,
    // Distance-estimation colouring.
    mode: u32,              // 0 iteration bands, 1 distance estimation
    colorDensity: f32,
    colorPhase: f32,
    slopeDepth: f32,
    rowLimit: u32,
    lightDir: vec3<f32>,    // normalised, z is elevation out of the screen
    ambientLight: f32,
    diffuseStrength: f32,
    specularStrength: f32,
    slopeLighting: u32,
    supersample: u32,
    invGamma: f32,
    /// 0 direct compensated, 1 compensated perturbation, 2 permits BLA.
    method: u32,
    /// View centre as plain f32, used only by the direct method.
    centre: vec2<f32>,
    /// First screen row this dispatch covers, for tiled rendering.
    rowOffset: u32,
    reuseField: u32,
    columnOffset: u32,
    columnLimit: u32,
    offsetLow: vec2<f32>,
    scaleLow: f32,
    family: u32,
    constant: vec2<f32>,
    constantLow: vec2<f32>,
    centreLow: vec2<f32>,
    sampleStep: u32,
    previewStep: u32,
    wideScale: vec4<f32>,
    wideOffsetX: vec4<f32>,
    wideOffsetY: vec4<f32>,
    wideCentreX: vec4<f32>,
    wideCentreY: vec4<f32>,
    juliaConstantX: vec4<f32>,
    juliaConstantY: vec4<f32>,
};

@group(0) @binding(0) var<storage, read> orbit: array<f32>;   // four mantissa words + exponent per component
@group(0) @binding(1) var<uniform> u: Uniforms;
@group(0) @binding(2) var output: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<storage, read> stops: array<vec4<f32>>;
/** Ax, Ay, Ae, Bx, By, Be, radiusLog2, pad — per skip entry. */
@group(0) @binding(4) var<storage, read> la: array<f32>;
/** levelOffsets then levelCounts, laLevels each. */
@group(0) @binding(5) var<storage, read> laIndex: array<u32>;
/**
 * [0] iterations skipped, [1] LA steps taken, [2] rebases, [3] plain steps,
 * [4] samples that used the whole iteration budget, [5] samples total.
 *
 * [4] and [5] are what tells the caller whether the budget was the binding
 * constraint. A sample that hit the cap either is interior or simply ran out
 * of iterations, and only raising the cap distinguishes them.
 */
@group(0) @binding(6) var<storage, read_write> stats: array<atomic<u32>>;
/**
 * One entry per sub-sample, holding everything the colouring needs and
 * nothing about how it should look:
 *
 *   iteration mode  x = iteration count, negative when the point never
 *                       escaped; y = |z|^2 at bail-out, for smooth shading
 *   distance mode   x = height field; y = 1 when the point escaped
 *
 * Filling this is the expensive half. Changing a palette, a light angle or a
 * gamma only re-reads it.
 */
@group(0) @binding(7) var<storage, read_write> field: array<vec2<f32>>;

const TAU: f32 = 6.283185307179586;
const ESCAPE_R: f32 = 16.0;
const ESCAPE_R2: f32 = 256.0;
// Specialize the set and direct path to remove unused recurrence branches.
override JULIA: bool = false;
// Separate direct specialization keeps the cheap path free of wide live values.
override DIRECT: bool = false;
// Keep approximation coefficients and operations out of unaccelerated kernels.
override APPROX: bool = false;

// ------------------------------------------------------- mantissa/exponent pair

// Compensated complex mantissas retain both words emitted by the reference.
struct Hdr { m: vec2<f32>, lo: vec2<f32>, e: i32 };
fn hdr(m: vec2<f32>, e: i32) -> Hdr { return Hdr(m, vec2<f32>(0.0), e); }
fn hdrZero() -> Hdr { return hdr(vec2<f32>(0.0), 0); }
fn hdrNorm(a: Hdr) -> Hdr {
    let mx = max(abs(a.m.x), abs(a.m.y));
    if (mx == 0.0) { return hdrZero(); }
    let shift = i32(floor(log2(mx)));
    let first = (-shift) / 2;
    let second = -shift - first;
    return Hdr(ldexp(ldexp(a.m, vec2<i32>(first)), vec2<i32>(second)),
        ldexp(ldexp(a.lo, vec2<i32>(first)), vec2<i32>(second)), a.e + shift);
}
fn hdrAdd(a: Hdr, b: Hdr) -> Hdr {
    if (all(a.m == vec2<f32>(0.0))) { return b; }
    if (all(b.m == vec2<f32>(0.0))) { return a; }
    let e = max(a.e, b.e);
    if (a.e - b.e > 100) { return a; }
    if (b.e - a.e > 100) { return b; }
    let ah = ldexp(a.m, vec2<i32>(a.e-e)); let al = ldexp(a.lo, vec2<i32>(a.e-e));
    let bh = ldexp(b.m, vec2<i32>(b.e-e)); let bl = ldexp(b.lo, vec2<i32>(b.e-e));
    let x = dsAdd(vec2<f32>(ah.x,al.x),vec2<f32>(bh.x,bl.x));
    let y = dsAdd(vec2<f32>(ah.y,al.y),vec2<f32>(bh.y,bl.y));
    return hdrNorm(Hdr(vec2<f32>(x.x,y.x),vec2<f32>(x.y,y.y),e));
}
fn hdrNeg(a: Hdr) -> Hdr { return Hdr(-a.m,-a.lo,a.e); }
fn hdrMul(a: Hdr, b: Hdr) -> Hdr {
    let v = complexMultiply(vec4<f32>(a.m.x,a.lo.x,a.m.y,a.lo.y),vec4<f32>(b.m.x,b.lo.x,b.m.y,b.lo.y));
    return hdrNorm(Hdr(v.xz,v.yw,a.e+b.e));
}
fn hdrMulPlain(a: Hdr, b: vec2<f32>) -> Hdr { return hdrMul(a,hdrNorm(hdr(b,0))); }
fn hdrLess(a: Hdr, b: Hdr) -> bool { return hdrLog2(a) < hdrLog2(b); }
fn hdrValue(a: Hdr) -> vec2<f32> {
    if (a.e < -120 || a.e > 120) { return vec2<f32>(0.0); }
    return ldexp(a.m+a.lo,vec2<i32>(a.e));
}

// -------------------------------------------------------------------- colour

fn cosPalette(t: f32, a: vec3<f32>, b: vec3<f32>, c: vec3<f32>, d: vec3<f32>) -> vec3<f32> {
    return a + b * cos(TAU * (c * t + d));
}

fn ultraFractal(t: f32) -> vec3<f32> {
    var p = array<f32, 6>(0.0, 0.16, 0.42, 0.6425, 0.8575, 1.0);
    var c = array<vec3<f32>, 6>(
        vec3<f32>(0.000, 0.027, 0.392),
        vec3<f32>(0.125, 0.420, 0.796),
        vec3<f32>(0.929, 1.000, 1.000),
        vec3<f32>(1.000, 0.667, 0.000),
        vec3<f32>(0.000, 0.008, 0.000),
        vec3<f32>(0.000, 0.027, 0.392)
    );
    var col = c[0];
    for (var i = 0; i < 5; i = i + 1) {
        col = mix(col, c[i + 1], smoothstep(p[i], p[i + 1], t));
    }
    return col;
}

fn customPalette(t: f32) -> vec3<f32> {
    let count = max(u.stopCount, 1u);
    if (count == 1u) { return stops[0].rgb; }
    let scaled = t * f32(count);
    let index = u32(floor(scaled)) % count;
    let next = (index + 1u) % count;
    return mix(stops[index].rgb, stops[next].rgb, fract(scaled));
}

fn palette(tIn: f32) -> vec3<f32> {
    let t = clamp(tIn, 0.0, 1.0);
    if (u.palette == 1u) { return ultraFractal(t); }
    if (u.palette == 2u) {
        return cosPalette(t, vec3<f32>(0.50, 0.30, 0.20), vec3<f32>(0.50, 0.35, 0.25),
                             vec3<f32>(1.0), vec3<f32>(0.00, 0.10, 0.20));
    }
    if (u.palette == 3u) {
        return cosPalette(t, vec3<f32>(0.45, 0.50, 0.60), vec3<f32>(0.35, 0.40, 0.40),
                             vec3<f32>(1.0, 1.0, 0.9), vec3<f32>(0.60, 0.70, 0.85));
    }
    if (u.palette == 4u) { return vec3<f32>(0.5 - 0.5 * cos(TAU * t)); }
    if (u.palette == 5u) { return customPalette(t); }
    return cosPalette(t, vec3<f32>(0.5), vec3<f32>(0.5), vec3<f32>(1.0),
                         vec3<f32>(0.00, 0.33, 0.67));
}

fn wrapCoordinate(t: f32) -> f32 {
    if (u.mirror == 1u) {
        let m = t - 2.0 * floor(t / 2.0);
        if (m > 1.0) { return 2.0 - m; }
        return m;
    }
    return fract(t);
}

// ------------------------------------------------- linear approximation steps

const LA_NEVER: f32 = -1e29;
/**
 * Safety margin, in log2, between a pixel's delta and a step's stated radius.
 *
 * At the radius itself the truncation error is only as small as the tolerance,
 * and marginal steps visibly shift escape counts. The margin is a pure win at
 * depth — deltas there sit tens of orders below any radius — and simply stops
 * shallow views taking the borderline steps they gain nothing from.
 */
const LA_MARGIN_LOG2: f32 = 24.0;

/**
 * A precomputed skip: the range's map truncated to second order,
 * `w_out = A*w + B*d + C*w^2 + D*w*d + E*d^2`, plus the entry radius it holds
 * for. The second-order terms are what let the radius be roughly the square
 * root of the first-order one instead of proportional to it.
 */
struct Skip {
    a: Hdr,
    b: Hdr,
    c: Hdr,
    d: Hdr,
    e: Hdr,
    radiusLog2: f32,
};

const SKIP_FLOATS: u32 = 32u;

fn loadCoefficient(base: u32, slot: u32) -> Hdr {
    let at = base + slot * 5u;
    return Hdr(vec2<f32>(la[at],la[at+2u]),vec2<f32>(la[at+1u],la[at+3u]),i32(la[at+4u]));
}

fn loadSkip(entry: u32) -> Skip {
    let base = entry * SKIP_FLOATS;
    return Skip(
        loadCoefficient(base, 0u),
        loadCoefficient(base, 1u),
        loadCoefficient(base, 2u),
        loadCoefficient(base, 3u),
        loadCoefficient(base, 4u),
        la[base + 25u]
    );
}

/// Applies the truncated polynomial.
fn applySkip(skip: Skip, w: Wide, d: Wide) -> Wide {
    var out = wideAdd(wideMul(wideFromHdr(skip.a), w), wideMul(wideFromHdr(skip.b), d));
    out = wideAdd(out, wideMul(wideFromHdr(skip.c), wideMul(w, w)));
    out = wideAdd(out, wideMul(wideFromHdr(skip.d), wideMul(w, d)));
    out = wideAdd(out, wideMul(wideFromHdr(skip.e), wideMul(d, d)));
    return out;
}

/// log2 of |v|, for comparing against a step's validity radius.
fn hdrLog2(v: Hdr) -> f32 {
    let m = dot(v.m, v.m);
    if (m == 0.0) { return -1e30; }
    return f32(v.e) + 0.5 * log2(m);
}

/**
 * Largest valid skip starting at iteration n, or 0 if none applies.
 *
 * Steps are aligned: a level-L step covers laBaseStep << L iterations and only
 * starts at multiples of that. Bigger levels are tried first, so a pixel with a
 * tiny delta jumps thousands of iterations at once.
 */
fn takeSkip(
    at: u32,
    dz: ptr<function, Wide>,
    deriv: ptr<function, Hdr>,
    withDerivative: bool,
    delta0: Wide,
    remaining: u32
) -> u32 {
    if (u.laLevels == 0u) { return 0u; }
    let dzLog2 = wideLog(*dz);

    // A level-L step starts only at multiples of laBaseStep << L, so the
    // highest level that can possibly align here is fixed by the trailing zeros
    // of at / laBaseStep. Walking down from the top level every time wasted most
    // of its work on steps that were never aligned to begin with.
    let unit = at / u.laBaseStep;
    var level: i32 = i32(u.laLevels) - 1;
    if (unit != 0u) {
        level = min(level, i32(countTrailingZeros(unit)));
    }

    loop {
        if (level < 0) { break; }
        let count = laIndex[u.laLevels + u32(level)];
        let index = unit >> u32(level);

        if (index < count && (u.laBaseStep << u32(level)) <= remaining) {
            let skip = loadSkip(laIndex[u32(level)] + index);
            // Safety margin: the delta must sit well below the radius, not just
            // inside it. Right at the boundary the linear map is only as good
            // as the tolerance, and marginal steps visibly shift escape counts.
            // Deep views sit tens of orders below the radius, so they lose
            // nothing; shallow views simply stop taking the marginal steps.
            if (skip.radiusLog2 > LA_NEVER && dzLog2 + LA_MARGIN_LOG2 <= skip.radiusLog2) {
                *dz = applySkip(skip, *dz, delta0);
                // The orbit derivative obeys the same linear recurrence with
                // d = 1, so the very same A and B advance it over the range.
                if (withDerivative) {
                    *deriv = hdrAdd(hdrMul(skip.a, *deriv), skip.b);
                }
                return u.laBaseStep << u32(level);
            }
        }
        level = level - 1;
    }
    return 0u;
}

// ------------------------------------------------------------------ iteration

/**
 * Result of iterating one point.
 *
 * `logDeriv` is log2 of |dz/dc| for the *full* orbit, carried in log space
 * because the derivative reaches astronomical magnitudes at depth — it is the
 * denominator of the distance estimate, so only its logarithm is ever needed.
 */
struct Sample {
    escaped: bool,
    n: u32,
    z: vec2<f32>,
    z2: f32,
    logDeriv: f32,
    skipped: u32,
    skips: u32,
    rebases: u32,
    /// log2 |delta| when the loop ended, for diagnostics.
    dzLog2: f32,
    /// Final reference index, for diagnostics.
    refIter: u32,
};

const HDR_ONE = Hdr(vec2<f32>(1.0, 0.0), vec2<f32>(0.0), 0);

// --------------------------------------------------- distance-estimation field

/// log2 of one pixel's width in the complex plane.
fn logPixelSize() -> f32 {
    return f32(u.scaleExponent) + log2(max(abs(u.scaleMantissa), 1e-30));
}

/**
 * Height field: how many octaves the distance to the set sits below one pixel.
 *
 * distance = 0.5 * |z| * ln|z| / |dz/dc|, normalised against the pixel size so
 * the banding stays the same visual scale at any zoom. Everything is done in
 * log2: the derivative alone can reach 10^700 at depth.
 */
fn heightOf(s: Sample) -> f32 {
    if (!s.escaped) { return 0.0; }
    let magnitude = max(sqrt(s.z2), 1.0000001);
    let logDistance =
        -1.0 + log2(magnitude) + log2(max(log(magnitude), 1e-30)) - s.logDeriv;
    return -(logDistance - logPixelSize());
}

fn cmul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

fn emptySample() -> Sample {
    return Sample(false, 0u, vec2<f32>(0.0), 0.0, 0.0, 0u, 0u, 0u, 0.0, 0u);
}

/// Direct z <- z^2 + c in plain f32.
///
/// Perturbation only pays when |delta| << |z|. Zoomed out that is false, the
/// rebase test fires almost every iteration, and we also pay for an
/// arbitrary-precision reference orbit the view cannot even resolve. Iterating
/// c directly is both simpler and much faster, and f32 has precision to spare
/// until the pixel spacing approaches its resolution near |c| ~ 1.
fn iterateDirect(c0: Hdr, wantDerivative: bool) -> Sample {
    var z = hdrZero(); var c = c0; var deriv = hdrZero();
    var n = 0u; var z2 = dot(hdrValue(z),hdrValue(z)); var escaped = z2 > ESCAPE_R2;
    while (n < u.maxIterations && !escaped) {
        if (wantDerivative) {
            deriv = hdrMul(deriv,hdrMulPlain(z,vec2<f32>(2.0,0.0)));
            deriv = hdrAdd(deriv,HDR_ONE);
        }
        z = hdrAdd(hdrMul(z,z),c); n += 1u;
        z2 = dot(hdrValue(z),hdrValue(z)); escaped = z2 > ESCAPE_R2;
    }
    return Sample(escaped,n,hdrValue(z),z2,hdrLog2(deriv),0u,0u,0u,hdrLog2(z),0u);
}
fn iterateAny(pixel: vec2<f32>, wantDerivative: bool) -> Sample {
    if (JULIA) { return iterateWide(pixel, wantDerivative); }
    if (DIRECT) {
        let offset = hdrMul(Hdr(vec2<f32>(u.scaleMantissa,0.0),vec2<f32>(u.scaleLow,0.0),u.scaleExponent),hdr(pixel-0.5*u.resolution,0));
        return iterateDirect(hdrAdd(hdrNorm(Hdr(u.centre,u.centreLow,0)),offset),wantDerivative);
    }
    return iterateWide(pixel,wantDerivative);
}

// --------------------------------------------------------------------- shading

fn iterationColour(n: f32, z2: f32) -> vec3<f32> {
    var mu = n;
    if (u.smoothShading == 1u) {
        mu = mu - log2(0.5 * log(z2) / log(ESCAPE_R));
    }
    var cycle = u.colorCycle;
    if (u.mapping == 1u) {
        mu = sqrt(max(mu, 0.0));
        cycle = u.colorCycle / 8.0;
    } else if (u.mapping == 2u) {
        mu = log2(max(mu, 1.0));
        cycle = u.colorCycle / 64.0;
    }
    return palette(wrapCoordinate(mu / max(cycle, 0.001) + u.colorOffset));
}

/// sRGB-ish decode, so palette stops are mixed and lit in linear light.
fn toLinear(c: vec3<f32>) -> vec3<f32> {
    return pow(max(c, vec3<f32>(0.0)), vec3<f32>(2.2));
}

/**
 * Colour for one sample, with the pseudo-3D relief.
 *
 * The normal comes from the screen-space gradient of the height field, which
 * is a normal-map illusion rather than displaced geometry: nothing moves, the
 * shading just reads as a surface. The bands flow and fold while zooming
 * because the distance field itself changes, not because the palette scrolls.
 */
fn shade(hCentre: f32, hRight: f32, hUp: f32) -> vec3<f32> {
    let base = toLinear(palette(fract(hCentre * u.colorDensity + u.colorPhase)));
    if (u.slopeLighting == 0u) { return base; }

    let dx = hRight - hCentre;
    let dy = hUp - hCentre;
    let normal = normalize(vec3<f32>(-dx * u.slopeDepth, -dy * u.slopeDepth, 1.0));

    let diffuse = max(dot(normal, u.lightDir), 0.0);
    var lit = base * (u.ambientLight + u.diffuseStrength * diffuse);

    if (u.specularStrength > 0.0) {
        // Blinn-Phong against a viewer straight down the z axis.
        let halfway = normalize(u.lightDir + vec3<f32>(0.0, 0.0, 1.0));
        let specular = pow(max(dot(normal, halfway), 0.0), 32.0);
        lit = lit + vec3<f32>(u.specularStrength * specular);
    }
    return lit;
}

// --------------------------------------------------------------------- entry

/** Sub-samples across one screen row. */
fn sampleStride() -> u32 {
    return u32(u.resolution.x) * max(u.supersample, 1u);
}

fn fieldIndex(col: u32, rowIdx: u32) -> u32 {
    return rowIdx * sampleStride() + col;
}

/// Iterates every sub-sample and stores what the colouring will need.
@compute @workgroup_size(8, 8)
fn compute(@builtin(global_invocation_id) gid: vec3<u32>) {
    let size = vec2<u32>(u32(u.resolution.x), u32(u.resolution.y));
    let row = gid.y * max(u.sampleStep, 1u) + u.rowOffset;
    let col = gid.x * max(u.sampleStep, 1u) + u.columnOffset;
    if (col >= min(size.x, u.columnLimit) || row >= min(size.y, u.rowLimit)) { return; }
    // The remap pass retained this exact sample, including its escape value.
    // Reuse is enabled only for the single-sample iteration field.
    if (u.reuseField != 0u && field[fieldIndex(col, row)].y >= 0.0) {
        atomicAdd(&stats[6], 1u);
        return;
    }

    let distanceMode = u.mode == 1u;
    let grid = max(u.supersample, 1u);
    let step = 1.0 / f32(grid);

    var skipped: u32 = 0u;
    var skips: u32 = 0u;
    var rebases: u32 = 0u;
    var plain: u32 = 0u;
    var capped: u32 = 0u;
    var total: u32 = 0u;

    for (var sy: u32 = 0u; sy < grid; sy = sy + 1u) {
        for (var sx: u32 = 0u; sx < grid; sx = sx + 1u) {
            let jitter = vec2<f32>((f32(sx) + 0.5) * step, (f32(sy) + 0.5) * step);
            let pixel = vec2<f32>(f32(col), u.resolution.y - 1.0 - f32(row)) + jitter;

            let s = iterateAny(pixel, distanceMode);
            skipped = skipped + s.skipped;
            skips = skips + s.skips;
            rebases = rebases + s.rebases;
            plain = plain + (s.n - s.skipped);
            total = total + 1u;
            if (!s.escaped) { capped = capped + 1u; }

            // mode 2 is a diagnostic view: red = iterations used, green =
            // escaped, blue = log2 of the final delta, alpha = rebases. It
            // wants more than the field carries, so it writes straight out.
            if (u.mode == 2u) {
                textureStore(output, vec2<i32>(i32(col), i32(row)), vec4<f32>(
                    f32(s.n) / f32(max(u.maxIterations, 1u)),
                    select(0.0, 1.0, s.escaped),
                    clamp((s.dzLog2 + 300.0) / 344.0, 0.0, 1.0),
                    clamp(f32(s.rebases) / 255.0, 0.0, 1.0)
                ));
                return;
            }

            var entry = vec2<f32>(0.0);
            if (distanceMode) {
                entry = vec2<f32>(heightOf(s), select(0.0, 1.0, s.escaped));
            } else {
                entry = vec2<f32>(select(-1.0, f32(s.n), s.escaped), s.z2);
            }
            field[fieldIndex(col * grid + sx, row * grid + sy)] = entry;
        }
    }

    atomicAdd(&stats[0], skipped);
    atomicAdd(&stats[1], skips);
    atomicAdd(&stats[2], rebases);
    atomicAdd(&stats[3], plain);
    atomicAdd(&stats[4], capped);
    atomicAdd(&stats[5], total);
}

/// Turns the stored field into pixels. No iteration happens here.
@compute @workgroup_size(8, 8)
fn shadePass(@builtin(global_invocation_id) gid: vec3<u32>) {
    let size = vec2<u32>(u32(u.resolution.x), u32(u.resolution.y));
    let pixel = gid.xy + vec2<u32>(u.columnOffset, u.rowOffset);
    if (pixel.x >= min(size.x, u.columnLimit) || pixel.y >= min(size.y, u.rowLimit)) { return; }

    let distanceMode = u.mode == 1u;
    let grid = max(u.supersample, 1u);
    let stride = sampleStride();
    let lastCol = stride - 1u;
    let lastRow = size.y * grid - 1u;

    var accumulated = vec3<f32>(0.0);
    var density = 1.0;

    for (var sy: u32 = 0u; sy < grid; sy = sy + 1u) {
        for (var sx: u32 = 0u; sx < grid; sx = sx + 1u) {
            let col = pixel.x * grid + sx;
            let rowIdx = pixel.y * grid + sy;
            var entry = field[fieldIndex(col, rowIdx)];
            if (entry.y < 0.0 && grid == 1u && !distanceMode && u.previewStep > 1u) {
                // Fill colour only. The unknown scalar entry remains unknown.
                entry = field[fieldIndex(col / u.previewStep * u.previewStep,
                    rowIdx / u.previewStep * u.previewStep)];
                density = 1.0 / f32(u.previewStep);
            }
            // Unknown is distinct from a determined interior sample. Alpha is
            // coverage metadata, never a request to blend colours.
            if (entry.y < 0.0) {
                textureStore(output, vec2<i32>(pixel), vec4<f32>(0.0));
                return;
            }

            if (!distanceMode) {
                if (entry.x < 0.0) {
                    accumulated = accumulated + toLinear(u.interior);
                } else {
                    accumulated = accumulated + toLinear(iterationColour(entry.x, entry.y));
                }
                continue;
            }

            if (entry.y == 0.0) {
                accumulated = accumulated + toLinear(u.interior);
                continue;
            }

            // Gradient from the neighbouring sub-samples. They are 1/grid of a
            // pixel apart, so scale back up to keep slopeDepth meaning the same
            // thing whatever the sample count. Screen rows run downwards, so
            // the sample "above" is the previous row.
            var hRight = entry.x;
            var hUp = entry.x;
            if (u.slopeLighting == 1u) {
                let right = field[fieldIndex(min(col + 1u, lastCol), rowIdx)];
                let up = field[fieldIndex(col, max(rowIdx, 1u) - 1u)];
                if (right.y != 0.0) { hRight = right.x; }
                if (up.y != 0.0) { hUp = up.x; }
            }
            accumulated = accumulated + shade(
                entry.x,
                entry.x + (hRight - entry.x) * f32(grid),
                entry.x + (hUp - entry.x) * f32(grid)
            );
        }
    }

    let linearColour = accumulated / f32(grid * grid);
    // Encode out of linear light at the very end.
    let encoded = pow(max(linearColour, vec3<f32>(0.0)), vec3<f32>(u.invGamma));
    textureStore(output, vec2<i32>(pixel),
                 vec4<f32>(clamp(encoded, vec3<f32>(0.0), vec3<f32>(1.0)), density));
}
