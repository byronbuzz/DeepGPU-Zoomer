/** Maximum custom stops — must match MAX_STOPS in the shaders. */
export const MAX_STOPS = 8;

export const PALETTE_CUSTOM = 5;

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
  /** Four spatial samples per displayed pixel, only while stationary. */
  oversampling?: boolean;

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
  /** RGB colour of the specular highlights. */
  highlightColour: string;
  /** Turn the pseudo-3D lighting off and keep flat palette bands. */
  slopeLighting: boolean;
  /** Samples per axis: 1 = off, 2 = 2x2, 3 = 3x3. */
  supersample: number;
  /** Output gamma. Shading is done in linear light and encoded at the end. */
  gamma: number;
  /** Whole-image hue rotation in degrees; presentation only. */
  hueRotation: number;
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
  highlightColour: '#ffffff',
  slopeLighting: true,
  supersample: 1,
  gamma: 2.2,
  hueRotation: 0,
  oversampling: false,
};

/** IDs 0–4 are the released mappings and must remain stable in saved views. */
export const FORMULAS=[
  'Smooth escape',
  'Classic iteration bands',
  'Binary decomposition',
  'Colour decomposition',
  'Biomorphs',
  'Endpoint angle',
  'Endpoint radius',
  'Endpoint real bands',
  'Endpoint imaginary bands',
  'Endpoint checker',
  'Endpoint log-polar weave',
  'Fractional escape bands',
  'Escape parity',
  'Triangular escape wave',
  'Golden phase bands',
  'Log ribbons',
  'Root bands',
  'Cubic pulse bands',
  'Cosine ribbons',
  'Soft terraces',
  'Harmonic flow',
  'Interference bands',
  'Chirped bands',
  'Escape phase',
  'Dual-scale bands',
] as const;
export const EFFECTS=['None','Contour Ink','Terraces','Fluted Ridges','Interference','Phase Weave','Neon Filaments','Pearl Relief','Brushed Relief','Engraved Relief','Depth Mist',
  'Duotone','Tritone','Split tone','Cross process','Soft solarise','Posterise','Channel prism','Contour glow','Iridescent bands','Metallic bands'];
/** IDs 0–2 are released and remain stable in saved links. */
export const CAPPED=[
  'Solid black','Final endpoint angle','Final endpoint magnitude',
  'Endpoint ratio','Radial cosine','Hyperbolic wave',
  'Orbit-product angle','Endpoint checker',
  'Cartesian weave','Concentric rings','Angular petals','Diamond lattice','Soft orbit glow',
] as const;
export function stopPositions(c:ColorSettings){return c.positions??c.stops.map((_,i)=>i/(c.repeating===false?c.stops.length-1:c.stops.length));}
const ENDPOINT_FORMULAS = new Set([2,3,4,5,6,7,8,9,10]);
export function needsEndpoints(c:ColorSettings){return ENDPOINT_FORMULAS.has(c.formula??0)||c.effect===5||(c.capped??0)>0;}
/** Renderer-visible appearance. Stop locks are editor metadata only. */
export function renderColors(c:ColorSettings):ColorSettings{const {locks:_locks,...rendered}=c;return {...rendered,stops:[...rendered.stops]};}
const CYCLE_MIN=8,CYCLE_MAX=65536;
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
  if(!/^#[0-9a-f]{6}$/i.test(c.highlightColour))throw Error('Invalid highlight colour');
  const positions=v.positions??stopPositions({...c,positions:undefined,repeating:v.repeating});
  if(positions.length!==c.stops.length||positions.some((p,i)=>!Number.isFinite(p)||p<0||p>1||i>0&&p<positions[i-1]))throw Error('Invalid palette positions');
  c.positions=[...positions];c.locks=c.stops.map((_,i)=>v.locks?.[i]===true);c.repeating=v.repeating!==false;
  for(const [key,max] of [['formula',FORMULAS.length-1],['effect',EFFECTS.length-1],['capped',CAPPED.length-1]] as const){const n=v[key]??0;if(!Number.isInteger(n)||n<0||n>max)throw Error(`Invalid ${key}`);c[key]=n;}
  // Saved diagnostic appearances fall back to ordinary iteration colouring.
  if(c.mode===2)c.mode=0;
  if(![0,1].includes(c.mode)||!Number.isInteger(c.palette)||c.palette<0||c.palette>5||c.cycle<1||c.cycle>1000000||c.slopeDepth<0||c.slopeDepth>80||c.gamma<1||c.gamma>4||c.hueRotation<0||c.hueRotation>360||![1,2,3].includes(c.supersample))throw Error('Invalid colouring settings');
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
  { name: "Viridis", stops: ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"] },
  { name: "Plasma", stops: ["#0d0887", "#7e03a8", "#cc4778", "#f89540", "#f0f921"] },
  { name: "Toxic", stops: ["#03120a", "#0b6b32", "#5df08a", "#f0ffe0", "#0a2a12"] },
  { name: "Inferno", stops: ["#000004", "#57106e", "#bc3754", "#f98e09", "#fcffa4"] },
  { name: "Nebula", stops: ["#05010f", "#3a1178", "#8b3fd4", "#f0a6ff", "#1a0533"] },
  { name: "Copper", stops: ["#0d0603", "#5c2b12", "#c9743a", "#ffd9a8", "#2a1408"] },
  { name: "Magma", stops: ["#000004", "#51127c", "#b73779", "#fc8961", "#fcfdbf"] },
  { name: "Cividis", stops: ["#00224e", "#434e6c", "#7d7c78", "#bcae6c", "#fee838"] },
  { name: "Mono", stops: ["#000000", "#3a3a3a", "#ffffff", "#4a4a4a", "#0d0d0d"] },
  { name: "Sunset", stops: ["#0b0221", "#5c1a5e", "#e0563f", "#ffc46b", "#fff4d6"] },
  { name: "Turbo", stops: ["#30123b", "#28bbec", "#a4fc3c", "#fb7e21", "#7a0403"] },
  { name: "Twilight", stops: ["#e2d9e2", "#7790b4", "#3e356b", "#60203f", "#bd5a56"] },
  { name: "Spectral", stops: ["#9e0142", "#f46d43", "#ffffbf", "#66c2a5", "#5e4fa2"] },
  { name: "Coolwarm", stops: ["#3b4cc0", "#8db0fe", "#dddcdc", "#f4987a", "#b40426"] },
  { name: "Cubehelix", stops: ["#000000", "#1a354c", "#a07949", "#d3c1d9", "#ffffff"] },
];
