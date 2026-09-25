import { expect, it } from 'vitest';
import {
  DEFAULT_COLORS, EFFECTS, FORMULAS, decodeColors, encodeColors,
  needsEndpoints, validateColors,
} from '../src/logic/colorSettings';

it('keeps legacy cheap AA off and only restores explicitly selected oversampling',()=>{
  const legacy=encodeColors(DEFAULT_COLORS).split('.').slice(0,28);legacy[26]='1';
  expect(decodeColors(legacy.join('.'))).toMatchObject({postAntialias:false,oversampling:false});
  expect(validateColors({...DEFAULT_COLORS,postAntialias:true})).toMatchObject({postAntialias:false,oversampling:false});
  expect(decodeColors(encodeColors({...DEFAULT_COLORS,oversampling:true}))).toMatchObject({postAntialias:false,oversampling:true});
});

it('appends ten choices to each catalogue while preserving released IDs', () => {
  expect(FORMULAS.slice(0, 15)).toEqual([
    'Smooth escape', 'Classic iteration bands', 'Binary decomposition', 'Colour decomposition',
    'Biomorphs', 'Endpoint angle', 'Endpoint radius', 'Endpoint real bands',
    'Endpoint imaginary bands', 'Endpoint checker', 'Endpoint log-polar weave',
    'Fractional escape bands', 'Escape parity', 'Triangular escape wave', 'Golden phase bands',
  ]);
  expect(EFFECTS.slice(0, 11)).toEqual([
    'None', 'Contour Ink', 'Terraces', 'Fluted Ridges', 'Interference', 'Phase Weave',
    'Neon Filaments', 'Pearl Relief', 'Brushed Relief', 'Engraved Relief', 'Depth Mist',
  ]);
  expect(FORMULAS).toHaveLength(25);
  expect(EFFECTS).toHaveLength(21);
  expect(new Set(FORMULAS).size).toBe(FORMULAS.length);
  expect(new Set(EFFECTS).size).toBe(EFFECTS.length);
});

it('roundtrips every new choice without requesting extra numerical channels', () => {
  for (let formula = 15; formula < FORMULAS.length; formula++) {
    for (let effect = 11; effect < EFFECTS.length; effect++) {
      const colors = validateColors({ ...DEFAULT_COLORS, formula, effect });
      const decoded = decodeColors(encodeColors(colors))!;
      expect([decoded.formula, decoded.effect]).toEqual([formula, effect]);
      expect(needsEndpoints(decoded)).toBe(false);
      expect(decoded.mode).toBe(DEFAULT_COLORS.mode);
      expect(decoded.supersample).toBe(DEFAULT_COLORS.supersample);
      expect(decoded.capped).toBe(0);
    }
  }
});

it('retains legacy endpoint requirements and rejects choices beyond the catalogue', () => {
  for (const formula of [2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    expect(needsEndpoints({ ...DEFAULT_COLORS, formula })).toBe(true);
  }
  expect(needsEndpoints({ ...DEFAULT_COLORS, effect: 5 })).toBe(true);
  expect(() => validateColors({ ...DEFAULT_COLORS, formula: FORMULAS.length })).toThrow();
  expect(() => validateColors({ ...DEFAULT_COLORS, effect: EFFECTS.length })).toThrow();
});
