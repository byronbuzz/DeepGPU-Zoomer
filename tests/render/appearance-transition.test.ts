import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { DEFAULT_COLORS } from "../../src/logic/colorSettings";
import {
  appearanceUpgradeCompatible,
  Method,
  type AppearanceFrameIdentity,
  type RenderRequest,
} from "../../src/render/webgpu-renderer";
import shader from "../../src/render/perturbation.wgsl?raw";

const request: RenderRequest = {
  centerX: new Decimal("-0.75"), centerY: new Decimal("0.1"), unitsPerPixel: new Decimal("1e-30"),
  width: 192, height: 128, maxIterations: 4096, colors: { ...DEFAULT_COLORS, stops: [...DEFAULT_COLORS.stops] },
  family: "mandelbrot", juliaX: new Decimal("-0.8"), juliaY: new Decimal("0.156"), useApprox: true,
};
const frame: AppearanceFrameIdentity = {
  centerX: request.centerX, centerY: request.centerY, unitsPerPixel: request.unitsPerPixel,
  width: request.width, height: request.height, maxIterations: request.maxIterations,
  colors: { ...request.colors, effect: 0 }, useApprox: true, method: Method.Hdr, grid: 1,
};

describe("completed appearance upgrades", () => {
  it("holds only an exact numerical/view identity while appearance data changes", () => {
    const phaseWeave = { ...request, colors: { ...request.colors, effect: 5 } };
    expect(appearanceUpgradeCompatible(frame, phaseWeave, Method.Hdr, 1)).toBe(true);
    expect(appearanceUpgradeCompatible(frame, { ...phaseWeave, centerX: request.centerX.plus("1e-10") }, Method.Hdr, 1)).toBe(false);
    expect(appearanceUpgradeCompatible(frame, { ...phaseWeave, width: 193 }, Method.Hdr, 1)).toBe(false);
    expect(appearanceUpgradeCompatible(frame, { ...phaseWeave, maxIterations: 4097 }, Method.Hdr, 1)).toBe(false);
    expect(appearanceUpgradeCompatible(frame, { ...phaseWeave, useApprox: false }, Method.Hdr, 1)).toBe(false);
    expect(appearanceUpgradeCompatible(frame, phaseWeave, Method.Plain, 1)).toBe(false);
    expect(appearanceUpgradeCompatible(frame, phaseWeave, Method.Hdr, 2)).toBe(false);
    expect(appearanceUpgradeCompatible({ ...frame, proxy: true }, phaseWeave, Method.Hdr, 1)).toBe(false);
  });

  it("requires the exact Julia constant", () => {
    const juliaRequest = { ...request, family: "julia" as const };
    const juliaFrame = { ...frame, family: "julia" as const, juliaX: request.juliaX, juliaY: request.juliaY };
    expect(appearanceUpgradeCompatible(juliaFrame, juliaRequest, Method.Hdr, 1)).toBe(true);
    expect(appearanceUpgradeCompatible(juliaFrame, { ...juliaRequest, juliaX: new Decimal("-0.7") }, Method.Hdr, 1)).toBe(false);
  });

  it("uses the distance field escape flag when reconstructing iteration scalars", () => {
    expect(shader).toContain("let escaped = field[at].y > 0.0;");
    expect(shader).toContain("select(-1.0, endpoint.z, escaped)");
    expect(shader).not.toMatch(/distanceToIterationField[\s\S]*endpoint\.z\s*[>=]/);
  });
});
