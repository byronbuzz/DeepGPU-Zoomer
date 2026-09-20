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
  positions?: number[];
  locks?: boolean[];
  repeating?: boolean;
  formula?: number;
  effect?: number;
  capped?: number;
  /** Completed-image presentation filter. Never changes the numerical field. */
  postAntialias?: boolean;

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
  // Distance lighting propagates a derivative in the same orbit and reads
  // known neighbouring field samples. It is an explicit compute-costly option.
  mode: 0,
  palette: PALETTE_CUSTOM,
  cycle: 64,
  offset: 0,
  smooth: true,
  mapping: 1,
  mirror: false,
  interior: "#000000",
  // Editable RGB representation of the original Ultra gradient.
  stops: ["#000764", "#206bcb", "#edffff", "#ffaa00", "#000200", "#000764"],
  positions: [0, 0.16, 0.42, 0.6425, 0.8575, 1],

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
  postAntialias: false,
};

/** IDs 0–4 are the released mappings and must remain stable in saved views. */
export const FORMULAS=[
  'Smooth escape',
  'Classic iteration bands',
  'Binary decomposition',
  'Colour decomposition',
  'Biomorphs',
  'Final endpoint angle',
  'Final endpoint radius',
  'Final endpoint real bands',
  'Final endpoint imaginary bands',
  'Final endpoint checker',
  'Final endpoint log-polar weave',
  'Fractional escape bands',
  'Escape parity',
  'Triangular escape wave',
  'Golden phase bands',
] as const;
export const EFFECTS=['None','Contour Ink','Terraces','Fluted Ridges','Interference','Phase Weave','Neon Filaments','Pearl Relief','Brushed Relief','Engraved Relief','Depth Mist'];
/** IDs 0–2 are released and remain stable in saved links. */
export const CAPPED=[
  'Solid black','Final endpoint angle','Final endpoint magnitude',
  'Endpoint ratio · XaoS adapted','Radial cosine · XaoS adapted','Hyperbolic wave · XaoS adapted',
  'Orbit-product angle · XaoS adapted','Endpoint checker · XaoS adapted',
  'Cartesian weave','Concentric rings','Angular petals','Diamond lattice','Soft orbit glow',
] as const;
export function stopPositions(c:ColorSettings){return c.positions??c.stops.map((_,i)=>i/(c.repeating===false?c.stops.length-1:c.stops.length));}
const ENDPOINT_FORMULAS = new Set([2,3,4,5,6,7,8,9,10]);
export function needsEndpoints(c:ColorSettings){return ENDPOINT_FORMULAS.has(c.formula??0)||c.effect===5||(c.capped??0)>0;}
const CYCLE_MIN=8,CYCLE_MAX=4096;
export function cycleFromSlider(value:number){return CYCLE_MIN*Math.pow(CYCLE_MAX/CYCLE_MIN,Math.max(0,Math.min(1,value)));}
export function cycleToSlider(value:number){return Math.log(Math.max(CYCLE_MIN,Math.min(CYCLE_MAX,value))/CYCLE_MIN)/Math.log(CYCLE_MAX/CYCLE_MIN);}
export function validateColors(value:unknown):ColorSettings {
  const v=value as ColorSettings;
  if(!v||!Array.isArray(v.stops)||v.stops.length<2||v.stops.length>8||v.stops.some(s=>typeof s!=='string'||!/^#[0-9a-f]{6}$/i.test(s)))throw Error('Palette needs 2–8 RGB colours');
  const c={...DEFAULT_COLORS};
  for(const key of Object.keys(DEFAULT_COLORS) as (keyof ColorSettings)[]){
    if(key==='stops')continue;
    const val=v[key];if(val===undefined)continue;
    if(typeof val!==typeof c[key]||typeof val==='number'&&!Number.isFinite(val))throw Error(`Invalid appearance ${key}`);
    (c as unknown as Record<string,unknown>)[key]=val;
  }
  c.stops=[...v.stops];
  const positions=v.positions??stopPositions({...c,positions:undefined,repeating:v.repeating});
  if(positions.length!==c.stops.length||positions.some((p,i)=>!Number.isFinite(p)||p<0||p>1||i>0&&p<positions[i-1]))throw Error('Invalid palette positions');
  c.positions=[...positions];c.locks=c.stops.map((_,i)=>v.locks?.[i]===true);c.repeating=v.repeating!==false;
  for(const [key,max] of [['formula',FORMULAS.length-1],['effect',10],['capped',CAPPED.length-1]] as const){const n=v[key]??0;if(!Number.isInteger(n)||n<0||n>max)throw Error(`Invalid ${key}`);c[key]=n;}
  if(![0,1,2].includes(c.mode)||!Number.isInteger(c.palette)||c.palette<0||c.palette>5||c.cycle<1||c.cycle>1000000||c.gamma<1||c.gamma>4||![1,2,3].includes(c.supersample))throw Error('Invalid colouring settings');
  return c;
}

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
  { name: "Viridis · adapted", stops: ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"] },
  { name: "Plasma · adapted", stops: ["#0d0887", "#7e03a8", "#cc4778", "#f89540", "#f0f921"] },
  { name: "Toxic", stops: ["#03120a", "#0b6b32", "#5df08a", "#f0ffe0", "#0a2a12"] },
  { name: "Inferno · adapted", stops: ["#000004", "#57106e", "#bc3754", "#f98e09", "#fcffa4"] },
  { name: "Nebula", stops: ["#05010f", "#3a1178", "#8b3fd4", "#f0a6ff", "#1a0533"] },
  { name: "Copper", stops: ["#0d0603", "#5c2b12", "#c9743a", "#ffd9a8", "#2a1408"] },
  { name: "Magma · adapted", stops: ["#000004", "#51127c", "#b73779", "#fc8961", "#fcfdbf"] },
  { name: "Cividis · adapted", stops: ["#00224e", "#434e6c", "#7d7c78", "#bcae6c", "#fee838"] },
  { name: "Mono", stops: ["#000000", "#3a3a3a", "#ffffff", "#4a4a4a", "#0d0d0d"] },
  { name: "Sunset", stops: ["#0b0221", "#5c1a5e", "#e0563f", "#ffc46b", "#fff4d6"] },
  { name: "Turbo · adapted", stops: ["#30123b", "#28bbec", "#a4fc3c", "#fb7e21", "#7a0403"] },
  { name: "Twilight · adapted", stops: ["#e2d9e2", "#7790b4", "#3e356b", "#60203f", "#bd5a56"] },
  { name: "Spectral · adapted", stops: ["#9e0142", "#f46d43", "#ffffbf", "#66c2a5", "#5e4fa2"] },
  { name: "Coolwarm · adapted", stops: ["#3b4cc0", "#8db0fe", "#dddcdc", "#f4987a", "#b40426"] },
  { name: "Cubehelix · adapted", stops: ["#000000", "#1a354c", "#a07949", "#d3c1d9", "#ffffff"] },
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
    stopPositions(settings).map(position=>Math.round(position*1_000_000)).join(','),
    (settings.locks??[]).map(locked=>locked?'1':'0').join(''),
    settings.repeating===false?0:1,
    settings.formula??0,
    settings.effect??0,
    settings.capped??0,
    settings.postAntialias?1:0,
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
  const decodedStops=stops.length ? stops : d.stops;
  const positions=(parts[20]??'').split(',').map(Number).filter(Number.isFinite).map(v=>v/1_000_000);
  const locks=(parts[21]??'').split('').map(v=>v==='1');
  return validateColors({
    palette: clamp(number(parts[0], d.palette), 0, 5),
    cycle: clamp(number(parts[1], d.cycle), 8, 4096),
    offset: clamp(number(parts[2], 0) / 1000, 0, 1),
    smooth: parts[3] !== "0",
    mapping: clamp(number(parts[4], 0), 0, 2),
    mirror: parts[5] === "1",
    interior: color(parts[6], d.interior),
    stops: decodedStops,

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
    positions:positions.length===decodedStops.length?positions:undefined,
    locks:locks.length===decodedStops.length?locks:undefined,
    repeating:parts[22]===undefined?d.repeating:parts[22]!=='0',
    formula:clamp(number(parts[23],d.formula??0),0,FORMULAS.length-1),
    effect:clamp(number(parts[24],d.effect??0),0,EFFECTS.length-1),
    capped:clamp(number(parts[25],d.capped??0),0,CAPPED.length-1),
    postAntialias:parts[26]===undefined?false:parts[26]==='1',
  });
}
