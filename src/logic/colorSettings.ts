/** Maximum custom stops — must match MAX_STOPS in the shaders. */
export const MAX_STOPS = 8;

export const PALETTE_CUSTOM = 5;

export const MAPPINGS = ["linear", "sqrt", "log"] as const;
export type Mapping = (typeof MAPPINGS)[number];

/**
 * Colouring modes.
 *
 * `iteration` is the classic escape-count banding. `distance` is analytic
 * distance estimation: the orbit carries its derivative, and on escape
 * `0.5 * |z| * log|z| / |dz|` gives the distance to the set, which normalised
 * against the size of a screen pixel stays meaningful at any zoom depth. That
 * field is what the slope lighting shades, and what makes the bands flow and
 * fold as you zoom rather than sliding rigidly.
 */
export const COLOR_MODES = ["iteration", "distance"] as const;
export type ColorMode = (typeof COLOR_MODES)[number];

export interface ColorSettings {
  mode: number;
  palette: number;
  cycle: number;
  offset: number;
  smooth: boolean;
  mapping: number;
  mirror: boolean;
  interior: string;
  stops: string[];

  // --- distance-estimation colouring ---
  /** Palette cycles per octave of the distance field. */
  colorDensity: number;
  /** Constant phase added to the palette coordinate, 0..1. */
  colorPhase: number;
  /** Strength of the fake surface relief. */
  slopeDepth: number;
  /** Light direction in the screen plane, degrees. */
  lightAngle: number;
  /** Light elevation above the screen plane, degrees. */
  lightElevation: number;
  ambientLight: number;
  diffuseStrength: number;
  specularStrength: number;
  /** Turn the pseudo-3D lighting off and keep flat palette bands. */
  slopeLighting: boolean;
  /** Samples per axis: 1 = off, 2 = 2x2, 3 = 3x3. */
  supersample: number;
  /** Output gamma. Shading is done in linear light and encoded at the end. */
  gamma: number;
}

export const DEFAULT_COLORS: ColorSettings = {
  // Iteration bands by default: one evaluation per pixel, no supersampling.
  // Distance estimation costs three evaluations per sample (centre plus two
  // neighbours for the gradient) times the supersample grid, so it is a
  // deliberate opt-in for stills rather than the everyday mode.
  mode: 0,
  palette: 1,
  cycle: 64,
  offset: 0,
  smooth: true,
  mapping: 1,
  mirror: false,
  interior: "#000000",
  stops: ["#08103a", "#2f6bcb", "#f2ffff", "#ffaa00", "#3a1400"],

  colorDensity: 0.12,
  colorPhase: 0,
  slopeDepth: 2.5,
  lightAngle: 135,
  lightElevation: 40,
  ambientLight: 0.35,
  diffuseStrength: 0.9,
  specularStrength: 0.25,
  slopeLighting: true,
  supersample: 1,
  gamma: 2.2,
};

const HEX = /^#[0-9a-f]{6}$/i;

export function hexToRgb(hex: string): [number, number, number] {
  const value = HEX.test(hex) ? hex : "#000000";
  return [
    parseInt(value.slice(1, 3), 16) / 255,
    parseInt(value.slice(3, 5), 16) / 255,
    parseInt(value.slice(5, 7), 16) / 255,
  ];
}

/**
 * Ready-made palettes. Distance-estimation shading wants gradients with real
 * dark and bright sections — a flat rainbow washes the relief out, because the
 * lighting multiplies the base colour and needs luminance range to work with.
 */
export interface Preset {
  name: string;
  stops: string[];
  interior?: string;
}

export const PRESETS: Preset[] = [
  { name: "Ultra", stops: ["#08103a", "#2f6bcb", "#f2ffff", "#ffaa00", "#3a1400"] },
  { name: "Midnight", stops: ["#01030f", "#10265c", "#4f8ff7", "#dbe9ff", "#0a1230"] },
  { name: "Ember", stops: ["#120200", "#7a1f05", "#ff7b18", "#ffe6b0", "#2b0a00"] },
  { name: "Ice", stops: ["#01080f", "#0d4a6b", "#5fd0f0", "#eaffff", "#062033"] },
  { name: "Gold", stops: ["#0a0600", "#5a3d02", "#d9a428", "#fff3c4", "#2a1a00"] },
  { name: "Toxic", stops: ["#03120a", "#0b6b32", "#5df08a", "#f0ffe0", "#0a2a12"] },
  { name: "Magma", stops: ["#000000", "#3b0a3f", "#c2185b", "#ff9e3d", "#fff2c9"] },
  { name: "Nebula", stops: ["#05010f", "#3a1178", "#8b3fd4", "#f0a6ff", "#1a0533"] },
  { name: "Copper", stops: ["#0d0603", "#5c2b12", "#c9743a", "#ffd9a8", "#2a1408"] },
  { name: "Abyss", stops: ["#000205", "#01243a", "#0a7ea3", "#9fe8f5", "#00060c"] },
  { name: "Rose", stops: ["#12030a", "#6b1436", "#e0517e", "#ffd6e2", "#2b0714"] },
  { name: "Mono", stops: ["#000000", "#3a3a3a", "#ffffff", "#4a4a4a", "#0d0d0d"] },
  { name: "Sunset", stops: ["#0b0221", "#5c1a5e", "#e0563f", "#ffc46b", "#fff4d6"] },
  { name: "Forest", stops: ["#03100a", "#14432a", "#4f9e52", "#d8f0a8", "#0a2314"] },
  { name: "Steel", stops: ["#04070a", "#243a4d", "#7d9bb5", "#e8f2fa", "#101a24"] },
  { name: "Candy", stops: ["#170524", "#7a1f9e", "#f062c0", "#ffe6a8", "#3d0a52"] },
];

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

/**
 * Serialises to a dot-separated record. Fields are positional and appended
 * only at the end, so older links keep decoding: anything missing falls back
 * to the default.
 */
export function encodeColors(settings: ColorSettings): string {
  const fields: (string | number)[] = [
    settings.palette,
    Math.round(settings.cycle),
    Math.round(settings.offset * 1000),
    settings.smooth ? 1 : 0,
    settings.mapping,
    settings.mirror ? 1 : 0,
    settings.interior.slice(1),
    settings.stops.map((stop) => stop.slice(1)).join(""),
    settings.mode,
    Math.round(settings.colorDensity * 1000),
    Math.round(settings.colorPhase * 1000),
    Math.round(settings.slopeDepth * 100),
    Math.round(settings.lightAngle),
    Math.round(settings.lightElevation),
    Math.round(settings.ambientLight * 100),
    Math.round(settings.diffuseStrength * 100),
    Math.round(settings.specularStrength * 100),
    settings.slopeLighting ? 1 : 0,
    settings.supersample,
    Math.round(settings.gamma * 100),
  ];
  return fields.join(".");
}

export function decodeColors(code: string): ColorSettings | null {
  const parts = code.split(".");
  if (parts.length < 7) return null;

  const number = (text: string | undefined, fallback: number) => {
    if (text === undefined) return fallback;
    const value = Number.parseInt(text, 10);
    return Number.isFinite(value) ? value : fallback;
  };
  const color = (text: string | undefined, fallback: string) =>
    text && HEX.test(`#${text}`) ? `#${text}` : fallback;

  const packedStops = parts[7] ?? "";
  const stops: string[] = [];
  for (let i = 0; i + 6 <= packedStops.length && stops.length < MAX_STOPS; i += 6) {
    stops.push(color(packedStops.slice(i, i + 6), "#000000"));
  }

  const d = DEFAULT_COLORS;
  return {
    palette: clamp(number(parts[0], d.palette), 0, 5),
    cycle: clamp(number(parts[1], d.cycle), 4, 400),
    offset: clamp(number(parts[2], 0) / 1000, 0, 1),
    smooth: parts[3] !== "0",
    mapping: clamp(number(parts[4], 0), 0, 2),
    mirror: parts[5] === "1",
    interior: color(parts[6], d.interior),
    stops: stops.length ? stops : d.stops,

    mode: clamp(number(parts[8], d.mode), 0, COLOR_MODES.length - 1),
    colorDensity: clamp(number(parts[9], d.colorDensity * 1000) / 1000, 0.01, 8),
    colorPhase: clamp(number(parts[10], 0) / 1000, 0, 1),
    slopeDepth: clamp(number(parts[11], d.slopeDepth * 100) / 100, 0, 20),
    lightAngle: number(parts[12], d.lightAngle) % 360,
    lightElevation: clamp(number(parts[13], d.lightElevation), 0, 90),
    ambientLight: clamp(number(parts[14], d.ambientLight * 100) / 100, 0, 2),
    diffuseStrength: clamp(number(parts[15], d.diffuseStrength * 100) / 100, 0, 3),
    specularStrength: clamp(number(parts[16], d.specularStrength * 100) / 100, 0, 3),
    slopeLighting: parts[17] === undefined ? d.slopeLighting : parts[17] === "1",
    supersample: clamp(number(parts[18], d.supersample), 1, 3),
    gamma: clamp(number(parts[19], d.gamma * 100) / 100, 1, 4),
  };
}
