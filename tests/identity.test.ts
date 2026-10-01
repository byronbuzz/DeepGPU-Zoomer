import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import {
  WebGpuRenderer, Method, methodForScale, limbsForScale, linearBlaPolicy, type RenderRequest,
} from '../src/render/webgpu-renderer';
import { DEFAULT_COLORS } from '../src/logic/colorSettings';
import { DEFAULT_TUNING, EDITABLE_TUNING_KEYS, normalizeTuning } from '../src/tuning';

Decimal.set({ precision: 160 });
const high = '1.2e-25', low = '8e-26';
const request = (spacing = high, extra: Partial<RenderRequest> = {}): RenderRequest => ({
  centerX: new Decimal('-0.729882953111791166084675551358906868109922487455321459149773742447100765778310356112751441950271396473513109'),
  centerY: new Decimal('0.188350375638907101795252098428032927280862450411022560811418219236755906071344298179004183927833904508444051'),
  unitsPerPixel: new Decimal(spacing), width: 193, height: 129, maxIterations: 201629,
  family: 'mandelbrot', useApprox: true, colors: { ...DEFAULT_COLORS, formula: 1, effect: 0, capped: 0, supersample: 1, postAntialias: false },
  tuning: { ...DEFAULT_TUNING }, followView: true, workView: true, interacting: true, zoom: 1,
  ...extra,
});
const selected = (q: RenderRequest) => q.forceMethod ?? methodForScale(q.unitsPerPixel, q.tuning);
function renderer(): any {
  return Object.assign(Object.create(WebGpuRenderer.prototype), {
    ctx: { device: { limits: { maxStorageBufferBindingSize: 1e9, maxBufferSize: 1e9 } } },
    refLength: 13578, refLimbs: 8,
  });
}
function sampleKey(r: any, q: RenderRequest) {
  const method = selected(q), family = q.family ?? 'mandelbrot';
  return r.sampleIdentity(q, family, family === 'julia' ? `${q.juliaX},${q.juliaY}` : '', method, 1,
    limbsForScale(q.unitsPerPixel, family === 'julia' || method !== Method.Direct ? 96 : 48), 12);
}
function completed(q = request()): any {
  const r = renderer(), method = selected(q), frame = { ...q, method, grid: 1, proxy: false };
  Object.assign(r, { completedFrame: frame, fieldView: q, fieldComplete: true, currentImageValid: true,
    currentView: q, historyValid: true, fieldUniforms: new ArrayBuffer(256), fieldStats: {},
    target: {}, fieldBuffer: {}, endpointBuffer: {}, retainEndpoints: false, fieldKey: 'complete',
    fieldDescriptor: { family: q.family, constant: q.family === 'julia' ? `${q.juliaX},${q.juliaY}` : '',
      maxIterations: q.maxIterations, mode: q.colors.mode, grid: 1, method, useApprox: true,
      retainEndpoints: false, interiorEndpoints: false, linearBlaEpsilon:linearBlaPolicy(q,method) } });
  return r;
}

describe('automatic perturbation identity', () => {
  it('crosses the historical gate with one automatic method and unchanged real precision', () => {
    for (const value of [high, '1e-25', low]) {
      expect(methodForScale(new Decimal(value))).toBe(Method.Hdr);
      expect(limbsForScale(new Decimal(value), 96)).toBe(8);
    }
  });

  it('preserves the exact Direct gate, including the legacy explicit threshold', () => {
    expect(DEFAULT_TUNING.directExponent).toBe(14.75);
    expect(normalizeTuning({ directExponent: 5 }).directExponent).toBe(14.75);
    for (const value of ['1e-5', '1e-8', '1e-12', '2e-15']) {
      expect(methodForScale(new Decimal(value))).toBe(Method.Direct);
    }
    for (const directExponent of [5, 8, 14.75, 20]) {
      const tuning = { ...DEFAULT_TUNING, directExponent };
      const gate = new Decimal(directExponent === 5 ? 1e-5 : 10 ** -directExponent);
      expect(methodForScale(gate.times(1.001), tuning)).toBe(Method.Direct);
      expect(methodForScale(gate, tuning)).toBe(Method.Hdr);
      expect(methodForScale(gate.times(.999), tuning)).toBe(Method.Hdr);
    }
  });

  it('retains the obsolete threshold metadata without exposing an editable control', () => {
    expect([...EDITABLE_TUNING_KEYS]).not.toContain('hdrExponent');
    expect(normalizeTuning({ hdrExponent: 10 }).hdrExponent).toBe(25);
    for (const hdrExponent of [1, 20, 25, 100]) {
      expect(methodForScale(new Decimal(high), { ...DEFAULT_TUNING, hdrExponent })).toBe(Method.Hdr);
    }
  });

  it.each([[high, low], [low, high]])('allows same-profile live work across %s to %s', (from, to) => {
    const q = request(from), live = request(to);
    const r = renderer(); r.currentView = live;
    expect(() => r.requireLiveMethod(q)).not.toThrow();
    expect(sampleKey(r, q)).toBe(sampleKey(r, live));
    // Geometry is still part of full field identity; this does not claim an old
    // resolution is already a complete field for the new request.
    expect(r.fieldIdentity(q, 'mandelbrot', '', selected(q), 1, false, 12))
      .not.toBe(r.fieldIdentity(live, 'mandelbrot', '', selected(live), 1, false, 12));
  });

  it('keeps pending reference compatibility independent of the obsolete label', () => {
    const r = renderer(), q = request(), demand = r.referenceDemand(q, 8);
    expect(r.referenceDemandCompatible(demand, request(low))).toBe(true);
    expect(r.referenceDemandCompatible(demand, request('9e-34'))).toBe(false);
    expect(r.referenceDemandCompatible(demand, request(low, { forceMethod: Method.Direct }))).toBe(false);
  });

  it('keeps completed fields and recolour compatibility when only historical threshold metadata changes', () => {
    const q = request(), latest = { ...q, tuning: { ...DEFAULT_TUNING, hdrExponent: 24 } };
    const r = completed(q);
    expect(r.isComplete(latest)).toBe(true);
    expect(r.appearanceCompatible(q, latest, selected(q), 1, false)).toBe(true);
    expect(r.fieldSupportsAppearance(latest, selected(latest), 1)).toBe(true);
    expect(r.isComplete(request(low))).toBe(false);
    expect(r.fieldSupportsAppearance(request(low), selected(request(low)), 1)).toBe(false);
  });

  it('preserves otherwise-compatible cap-upgrade eligibility across inert tuning metadata', () => {
    const q = request(), latest = { ...q, dynamicIterations: true, maxIterations: q.maxIterations + 1000,
      tuning: { ...DEFAULT_TUNING, hdrExponent: 24 } };
    const r = completed(q);
    expect(r.capUpgradeBase(latest)).toBe(r.completedFrame);
    expect(r.capUpgradeBase({ ...latest, forceMethod: Method.Plain })).toBeNull();
  });

  it.each([Method.Direct, Method.Plain, Method.Hdr])('keeps forced method %s exact at every automatic scale', method => {
    for (const spacing of ['1e-3', high, low, '1e-40']) {
      const q = request(spacing, { forceMethod: method }), r = completed(q);
      expect(r.isComplete(q)).toBe(true);
      expect(r.completedFrame.method).toBe(method);
      r.currentView = { ...q, forceMethod: method === Method.Plain ? Method.Hdr : Method.Plain };
      expect(() => r.requireLiveMethod(q)).toThrow();
      expect(r.isComplete(r.currentView)).toBe(false);
      expect(r.fieldSupportsAppearance(r.currentView, selected(r.currentView), 1)).toBe(false);
      expect(sampleKey(r, q)).not.toBe(sampleKey(r, r.currentView));
    }
  });

  it.each([[high, low], [low, high]])('allows a fixed forced Plain diagnostic to cross %s to %s', (from, to) => {
    const q = request(from, { forceMethod: Method.Plain }), r = renderer();
    r.currentView = request(to, { forceMethod: Method.Plain });
    expect(() => r.requireLiveMethod(q)).not.toThrow();
  });

  it('rejects real precision-profile changes despite a stable automatic method', () => {
    const q = request('1e-33'), next = request('9e-34'), r = renderer();
    expect(selected(q)).toBe(selected(next));
    expect(limbsForScale(q.unitsPerPixel, 96)).toBe(8);
    expect(limbsForScale(next.unitsPerPixel, 96)).toBe(16);
    r.currentView = next; expect(() => r.requireLiveMethod(q)).toThrow();
    r.currentView = q; expect(() => r.requireLiveMethod(next)).toThrow();
    expect(sampleKey(r, q)).not.toBe(sampleKey(r, next));
  });

  it('rejects actual Direct/perturbation transitions in both directions', () => {
    const a = request('2e-15'), b = request('1e-15'), r = renderer();
    expect(selected(a)).toBe(Method.Direct); expect(selected(b)).toBe(Method.Hdr);
    r.currentView = b; expect(() => r.requireLiveMethod(a)).toThrow();
    r.currentView = a; expect(() => r.requireLiveMethod(b)).toThrow();
  });

  it('retains Julia family, constant, forced method and real precision guards', () => {
    const constants = { family: 'julia' as const, juliaX: new Decimal('-.8'), juliaY: new Decimal('.156') };
    const q = request(high, constants), r = renderer();
    r.currentView = request(low, constants); expect(() => r.requireLiveMethod(q)).not.toThrow();
    for (const live of [request(low), request(low, { ...constants, juliaX: new Decimal('-.7') }),
      request(low, { ...constants, forceMethod: Method.Plain }), request('9e-34', constants)]) {
      r.currentView = live; expect(() => r.requireLiveMethod(q)).toThrow();
    }
  });

  it('does not merge approximation, oversampling or outward-release cancellation guards', () => {
    const q = request(), r = renderer();
    for (const live of [request(low, { useApprox: false }), request(low, { stationaryOversampling: true })]) {
      r.currentView = live; expect(() => r.requireLiveMethod(q)).toThrow();
    }
    r.currentView = request(low, { zoom: 0 });
    expect(() => r.requireLiveMethod({ ...q, zoom: -1 })).toThrow();
  });
});
