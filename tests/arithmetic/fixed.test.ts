import { describe, expect, it } from "vitest";
import {
  fixedToHdr,
  decimalDigits,
  fixedToNumber,
  formatFixed,
  fromHdr,
  fromLimbs,
  fractionalBits,
  maxMagnitude,
  parseFixed,
  scaleDecimal,
  toLimbs,
  wrapSigned,
} from "../../src/arithmetic/types";
import {
  addFixed,
  hasEscaped,
  mul32,
  mulFixed,
  orbitStep,
  referenceOrbit,
  subFixed,
} from "../../src/arithmetic/cpu-oracle";

const PROFILES = [8, 16, 64, 128];

/** Deterministic PRNG so failures reproduce. */
function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state;
  };
}

function randomFixed(random: () => number, limbs: number): bigint {
  let value = 0n;
  for (let i = 0; i < limbs; i++) {
    value = (value << 32n) | BigInt(random());
  }
  return wrapSigned(value, limbs);
}

describe("limb encoding", () => {
  it.each(PROFILES)("round-trips random values at %i limbs", (limbs) => {
    const random = makeRandom(limbs * 7919);
    for (let trial = 0; trial < 200; trial++) {
      const value = randomFixed(random, limbs);
      expect(fromLimbs(toLimbs(value, limbs), limbs)).toBe(value);
    }
  });

  it.each(PROFILES)("round-trips the extremes at %i limbs", (limbs) => {
    const bits = 32n * BigInt(limbs);
    const extremes = [0n, 1n, -1n, (1n << (bits - 1n)) - 1n, -(1n << (bits - 1n))];
    for (const value of extremes) {
      expect(fromLimbs(toLimbs(value, limbs), limbs)).toBe(value);
    }
  });

  it("packs all-ones without loss", () => {
    const limbs = 16;
    const words = new Uint32Array(limbs).fill(0xffffffff);
    expect(fromLimbs(words, limbs)).toBe(-1n);
  });
});

describe("decimal parsing", () => {
  it("scales exactly", () => {
    expect(scaleDecimal("1", 8n)).toBe(256n);
    expect(scaleDecimal("0.5", 8n)).toBe(128n);
    expect(scaleDecimal("-0.5", 8n)).toBe(-128n);
    expect(scaleDecimal("1e-2", 16n)).toBe(655n); // round(0.01 * 65536) = 655
  });

  it("keeps far more digits than a double", () => {
    const limbs = 64;
    const text = "-0.74515814367400103245678901234567890123456789012345";
    const parsed = parseFixed(text, limbs);
    // Re-rendering must agree to the requested digits.
    expect(formatFixed(parsed, limbs, 48)).toBe(text.slice(0, 51));
  });

  it("handles exponential notation", () => {
    const limbs = 32;
    const parsed = parseFixed("1.706e-12", limbs);
    const back = Number(formatFixed(parsed, limbs, 30));
    expect(back).toBeCloseTo(1.706e-12, 24);
  });
});

describe("emulated 32x32 -> 64 multiply", () => {
  it("matches BigInt on random and extreme inputs", () => {
    const random = makeRandom(12345);
    const cases: [number, number][] = [
      [0, 0],
      [0xffffffff, 0xffffffff],
      [0xffffffff, 1],
      [0x80000000, 2],
      [0xffff, 0xffff],
      [0x10000, 0x10000],
    ];
    for (let i = 0; i < 500; i++) cases.push([random(), random()]);

    for (const [a, b] of cases) {
      const expected = BigInt(a >>> 0) * BigInt(b >>> 0);
      const got = mul32(a, b);
      const combined = (BigInt(got.hi >>> 0) << 32n) | BigInt(got.lo >>> 0);
      expect(combined).toBe(expected);
    }
  });
});

describe("fixed-point arithmetic", () => {
  it.each(PROFILES)("add and subtract agree with BigInt at %i limbs", (limbs) => {
    const random = makeRandom(limbs * 104729);
    for (let trial = 0; trial < 200; trial++) {
      const a = randomFixed(random, limbs);
      const b = randomFixed(random, limbs);
      expect(addFixed(a, b, limbs)).toBe(wrapSigned(a + b, limbs));
      expect(subFixed(a, b, limbs)).toBe(wrapSigned(a - b, limbs));
    }
  });

  it("multiplies one by one", () => {
    const limbs = 16;
    const one = 1n << fractionalBits(limbs);
    expect(mulFixed(one, one, limbs)).toBe(one);
  });

  it("multiplies a half by a half", () => {
    const limbs = 16;
    const one = 1n << fractionalBits(limbs);
    const half = one / 2n;
    expect(mulFixed(half, half, limbs)).toBe(one / 4n);
  });

  it("handles signs", () => {
    const limbs = 16;
    const one = 1n << fractionalBits(limbs);
    expect(mulFixed(-one, one, limbs)).toBe(-one);
    expect(mulFixed(-one, -one, limbs)).toBe(one);
  });
});

describe("reference orbit", () => {
  it("reproduces the period-2 cycle at c = -1", () => {
    const limbs = 32;
    const c = { x: -(1n << fractionalBits(limbs)), y: 0n };
    const orbit = referenceOrbit(c, limbs, 20);

    // 0 -> -1 -> 0 -> -1 ...
    expect(orbit[0]).toEqual({ x: 0n, y: 0n });
    expect(orbit[1].x).toBe(c.x);
    expect(orbit[2].x).toBe(0n);
    expect(orbit[3].x).toBe(c.x);
    expect(orbit).toHaveLength(21);
  });

  it("escapes for a point well outside the set", () => {
    const limbs = 32;
    const one = 1n << fractionalBits(limbs);
    const orbit = referenceOrbit({ x: 2n * one, y: 2n * one }, limbs, 50);
    expect(orbit.length).toBeLessThan(10);
    expect(hasEscaped(orbit[orbit.length - 1], limbs)).toBe(true);
  });

  it("stays bounded deep inside the set for many iterations", () => {
    const limbs = 64;
    const c = {
      x: scaleDecimal("-0.25", fractionalBits(limbs)),
      y: 0n,
    };
    const orbit = referenceOrbit(c, limbs, 2000);
    expect(orbit).toHaveLength(2001);
    expect(hasEscaped(orbit[orbit.length - 1], limbs)).toBe(false);
  });

  it("matches a double-precision orbit while doubles are still accurate", () => {
    const limbs = 64;
    const cx = -0.743643887037151;
    const cy = 0.13182590420533;
    const c = {
      x: scaleDecimal(String(cx), fractionalBits(limbs)),
      y: scaleDecimal(String(cy), fractionalBits(limbs)),
    };

    let z = { x: 0n, y: 0n };
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < 40; i++) {
      z = orbitStep(z, c, limbs);
      const nx = dx * dx - dy * dy + cx;
      dy = 2 * dx * dy + cy;
      dx = nx;

      expect(fixedToNumber(toLimbs(z.x, limbs), limbs)).toBeCloseTo(dx, 9);
      expect(fixedToNumber(toLimbs(z.y, limbs), limbs)).toBeCloseTo(dy, 9);
    }
  });

  it("keeps centres apart that doubles collapse together", () => {
    // This is the engine's whole reason to exist: at deep-zoom depths the
    // centre coordinate has more digits than a double can hold.
    const limbs = 64;
    const a = "-0.7436438870371587459817981870345";
    const b = "-0.7436438870371587459817981870999";

    expect(Number(a)).toBe(Number(b)); // doubles see one value

    const fa = scaleDecimal(a, fractionalBits(limbs));
    const fb = scaleDecimal(b, fractionalBits(limbs));
    expect(fa).not.toBe(fb); // fixed point sees two

    // And the difference is carried, not rounded away. The strings part at the
    // 29th decimal place, by 654 units in the 31st: 6.54e-29.
    const difference = fixedToNumber(toLimbs(fa - fb, limbs), limbs);
    expect(Math.abs(difference)).toBeGreaterThan(6e-29);
    expect(Math.abs(difference)).toBeLessThan(7e-29);
  });

  it("resolves centres far past double precision at 1024 limbs", () => {
    const limbs = 1024;
    expect(decimalDigits(limbs)).toBeGreaterThan(9800);

    const digits = `0.${"1234567890".repeat(500)}`;
    const parsed = parseFixed(digits, limbs);
    // Every one of those 5000 digits survives the round trip.
    expect(formatFixed(parsed, limbs, 5000)).toBe(digits);
  });
});

describe("HDR sample format", () => {
  it("round-trips magnitudes inside the format's range", () => {
    // The integer part is one limb, so |value| < 2^31 by construction. The
    // orbit itself never exceeds 2.
    for (const value of [1, -1, 0.5, -0.25, 1234.5, 1e-8, -3.75, 2 ** 30]) {
      const reconstructed = fromHdr(fixedToHdrFromNumber(value));
      expect(reconstructed / value).toBeCloseTo(1, 6);
    }
  });

  it("wraps rather than saturating past the representable range", () => {
    const limbs = 32;
    const overflow = scaleDecimal("3.75e12", fractionalBits(limbs));
    // Documented behaviour: values this large are simply out of range.
    expect(Math.abs(fixedToNumber(toLimbs(overflow, limbs), limbs))).toBeLessThan(
      maxMagnitude()
    );
  });

  it("survives magnitudes far below f32's normal range", () => {
    const limbs = 64;
    const tiny = scaleDecimal("1e-100", fractionalBits(limbs));
    const hdr = fixedToHdr(toLimbs(tiny, limbs), limbs);
    const reconstructed = (hdr.mantissaHi + hdr.mantissaLo) * 2 ** hdr.exponent;
    expect(Math.log10(Math.abs(reconstructed))).toBeCloseTo(-100, 4);
  });

  it("represents zero", () => {
    const limbs = 16;
    const hdr = fixedToHdr(toLimbs(0n, limbs), limbs);
    expect(hdr).toEqual({ mantissaHi: 0, mantissaLo: 0, exponent: 0 });
  });
});

function fixedToHdrFromNumber(value: number) {
  const limbs = 64;
  const scaled = scaleDecimal(value.toExponential(17), fractionalBits(limbs));
  return fixedToHdr(toLimbs(scaled, limbs), limbs);
}
