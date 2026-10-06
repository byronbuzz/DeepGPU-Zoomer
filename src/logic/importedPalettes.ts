import type { Preset } from './colorSettings';

/**
 * Eight-stop adaptations from https://github.com/techmatt/fractals
 * Revision: 32741f0ad92542e87b06e456ee8081fc2d7c49fb
 * Selected from 1,021 gradients against the 33 incumbent presets using
 * perceptual curve distance, allowing cyclic rotations and reversal.
 * The source comment on each entry preserves the original palette identity.
 *
 * MIT License
 * 
 * Copyright (c) 2026 Matt Fisher
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
export const FRACTALS_PALETTES: Preset[] = [
  // Source: Green, Violet, Bone
  { name: "Jade Alchemy", stops: ["#ded2f4","#9655e3","#3d0477","#a353ba","#e3d9c8","#519d38","#0b5216","#00813f"] },
  // Source: cet_linear_kbc_5_95_c73
  { name: "Cerulean Climb", stops: ["#00014e","#10029a","#1719e5","#3052fc","#2d85fe","#32b4fc","#3ee0fa","#b3fff6"] },
  // Source: paezing
  { name: "Crystal Pulse", stops: ["#003e6f","#38bfde","#fcc4f3","#a222d4","#ed86ea","#7ef0f8","#026aa6","#000416"] },
  // Source: Neon Grid
  { name: "Neon Rift", stops: ["#010207","#004658","#00abc3","#0d9bb2","#040612","#fe2dd5","#b32196","#4b1344"] },
  // Source: spring
  { name: "Candy Corona", stops: ["#ff00ff","#ff25da","#ff49b6","#ff6e91","#ff926d","#ffb748","#ffdb24","#ffff00"] },
  // Source: freedor
  { name: "Glacial Jade", stops: ["#90dec2","#8ef39d","#b6febf","#ecfff4","#befec7","#86f696","#99e1c6","#8cc5af"] },
  // Source: wallhaven_wallhaven-1jo7vv
  { name: "Lava Flow", stops: ["#5c1b0d","#85270f","#b03312","#de3f18","#ff5625","#d83e17","#ab3111","#7f260f"] },
  // Source: Vice Nightfall
  { name: "Afterglow", stops: ["#090112","#752ba7","#aa74de","#140419","#e8255f","#ff7f33","#a94d00","#47170b"] },
  // Source: dreamcatcher-25
  { name: "Tropical Drift", stops: ["#88b741","#b2860d","#349557","#028ab6","#0875fb","#049fc3","#0aaeb7","#1ec6a1"] },
  // Source: Ember Triad
  { name: "Alchemist's Flame", stops: ["#010501","#012d07","#001503","#a35d05","#050100","#891679","#e78bdf","#ded9dd"] },
  // Source: autumn
  { name: "Solar Flare", stops: ["#ff0000","#ff2500","#ff4900","#ff6e00","#ff9200","#ffb700","#ffdb00","#ffff00"] },
  // Source: reelati
  { name: "Bluegrass Arc", stops: ["#0234a8","#86c4eb","#abe00d","#295301","#150602","#4a8801","#f5fba0","#2092f1"] },
  // Source: winter
  { name: "Polar Current", stops: ["#0000ff","#0025ed","#0049da","#006ec8","#0092b6","#00b7a4","#00db91","#00ff80"] },
  // Source: duckol
  { name: "Citrine Mirage", stops: ["#5b4315","#71329b","#aee3df","#083d48","#78d7d3","#874aa4","#46310f","#f2d848"] },
  // Source: Malachite & Rose
  { name: "Emerald Velvet", stops: ["#062914","#005a22","#00872a","#dceab9","#de47a5","#a4056f","#520633","#201114"] },
  // Source: cet_cyclic_ymcgy_60_90_c67_s25
  { name: "Aurora Circuit", stops: ["#8cc900","#e4e412","#ffa199","#fc3ff7","#c1aefe","#36f2ed","#32cd80","#25af16"] },
  // Source: gnuplot2
  { name: "Radiant Escape", stops: ["#000000","#000092","#1e00ff","#9007f8","#fc4fb0","#ff9867","#ffe11e","#ffffff"] },
  // Source: commons_Julia_set_spiral
  { name: "Kaleidoscope Vortex", stops: ["#27316f","#623d98","#e9542e","#e0f607","#00b201","#f6e614","#dd4239","#632594"] },
  // Source: magic-mushroom-25
  { name: "Electric Bloom", stops: ["#fe6efa","#db3d76","#7954d2","#7c8cfb","#73f6fe","#7c8cfb","#7954d2","#db3d76"] },
  // Source: Cyan, Magenta, Amber
  { name: "Photon Ribbon", stops: ["#006974","#02bacf","#41d0e9","#e8bae5","#870b72","#2a020d","#db8e0a","#050e0d"] },
  // Source: hollow-worlds-25
  { name: "Honey Halo", stops: ["#fe9a34","#fed141","#fffe68","#ffffe0","#ffff9c","#ffe446","#feb041","#e89235"] },
  // Source: hsv
  { name: "Chromatic Orbit", stops: ["#ff3d00","#f3f400","#3bff00","#00ff87","#00b4ff","#1102ff","#d200ff","#ff0069"] },
  // Source: cet_linear_bmw_5_95_c89
  { name: "Orchid Ascent", stops: ["#000558","#0012b1","#001ef5","#881fff","#dd2cff","#ff70ff","#ffb3ff","#feebfe"] },
  // Source: Olive, Green, Ochre
  { name: "Ancient Canopy", stops: ["#0c2b1a","#1d6132","#72b26e","#5f8343","#3b481a","#5a5627","#988244","#e7d6a3"] },
  // Source: Green Fire, Black Ash
  { name: "Verdant Ignition", stops: ["#1da14e","#3ee071","#ebf9ed","#1c120a","#f8342e","#8f181a","#240908","#010101"] },
  // Source: re-entry-25
  { name: "Opal Haze", stops: ["#f5c692","#fef7de","#ebd8fe","#bbaffd","#e4d2fe","#fefbec","#fbcb9b","#d7af86"] },
  // Source: carried-away-25
  { name: "Violet Gravity", stops: ["#b1ceff","#415eec","#2d114f","#9107e6","#a20bf7","#3e0553","#3954d7","#a3c0ff"] },
  // Source: meloni
  { name: "Amber Brocade", stops: ["#0d1a1a","#766932","#feb63b","#e7c6dd","#bc529b","#eed6e6","#faa535","#636133"] },
  // Source: seismic
  { name: "Frostfire", stops: ["#00004d","#0000b3","#2626ff","#b8b8ff","#ffb4b4","#ff2222","#c70000","#800000"] },
  // Source: wallhaven_wallhaven-0125mv
  { name: "Confetti Nebula", stops: ["#5ac7de","#ac9fd9","#9e60d6","#b7232a","#d93992","#5c92ed","#d799bd","#53e59e"] },
  // Source: torment-of-the-skies-25
  { name: "Stormglass", stops: ["#949faa","#445363","#23368c","#2b83eb","#6edefe","#2b83eb","#23368c","#445363"] },
  // Source: hellid-25
  { name: "Bronze Horizon", stops: ["#9db07c","#876034","#e65116","#feb022","#fee22f","#fe7918","#ba510c","#7e885f"] },
  // Source: wallhaven_wallhaven-422xr6
  { name: "Charged Horizons", stops: ["#ffff8d","#00b1ff","#00009d","#2a0000","#dd0300","#160000","#0001bf","#00c7ff"] },
  // Source: mossy-25
  { name: "Lichen Light", stops: ["#e8fe5b","#84ce33","#77982b","#7d6f26","#505b20","#668527","#7da32d","#9ce83a"] },
  // Source: Twin Mineral Peaks
  { name: "Oxide Tide", stops: ["#005556","#00acaa","#26352c","#592d17","#c3603d","#772a18","#341009","#000404"] },
  // Source: rondo
  { name: "Apricot Eclipse", stops: ["#ced3f6","#f7ab2e","#9e4f73","#4204be","#060021","#570bc9","#a75575","#fcbe3a"] },
  // Source: cmr.gem
  { name: "Garnet Spectrum", stops: ["#410206","#65053c","#7f1981","#8a37ca","#7d66f9","#5e9afe","#3ec4f8","#44e9ee"] },
  // Source: 02604_platform_2560x1600
  { name: "Tidal Amethyst", stops: ["#2cc18b","#165552","#342889","#d11fae","#4a2891","#13494b","#2bb282","#d5fef4"] },
  // Source: cmr.tree
  { name: "Woodland Glow", stops: ["#000000","#261208","#502a02","#5c511b","#5c7742","#49a15e","#26cc53","#37f611"] },
  // Source: terrain
  { name: "Terra Vista", stops: ["#333399","#0393f2","#26d46e","#b8f18b","#d9cf85","#90715d","#b8a49f","#ffffff"] },
  // Source: Indigo Teal Crests
  { name: "Kelp Depths", stops: ["#00030f","#005a74","#007c94","#00373c","#006553","#10b07f","#006333","#002b18"] },
  // Source: Reef at Midnight
  { name: "Abyssal Garden", stops: ["#1c2906","#9bd140","#355100","#000d0d","#1cc5c5","#171a1c","#b02b5f","#7e043e"] },
  // Source: Sorbet Cellar
  { name: "Mineral Dusk", stops: ["#2d2836","#c3b1e3","#63408c","#0e1417","#035e4a","#a9c4ba","#59371a","#d18b54"] },
  // Source: standard-25
  { name: "Cosmic Porcelain", stops: ["#893923","#d49a91","#3b315e","#6571ee","#342944","#bd8d97","#9d4826","#020102"] },
  // Source: triglandal
  { name: "Rose Quartz", stops: ["#cac361","#203928","#87213c","#ffcae2","#a84d78","#ffafd1","#701326","#3d4311"] },
  // Source: commons_Spiralarm_Julia-Menge_-0_2C5R_0I_01072019_16K
  { name: "Mulberry Field", stops: ["#932176","#955284","#c1458f","#b95fda","#c34d9e","#975c8d","#901968","#842ba3"] },
  // Source: Sulphur in the Vault
  { name: "Gilded Void", stops: ["#05020e","#381f65","#7b58b2","#b69dda","#4c337a","#120f12","#e4b227","#7d5800"] },
  // Source: nipy_spectral
  { name: "Prismatic Cascade", stops: ["#000000","#1d00ab","#008fdb","#00a036","#00ed00","#f3e200","#f70500","#cccccc"] },
  // Source: PiYG
  { name: "Petal Grove", stops: ["#8e0152","#d04392","#efadd4","#fce7f1","#ebf6db","#aeda7a","#61a22e","#276419"] },
  // Source: commons_Js17eta
  { name: "Ion Stream", stops: ["#ff4500","#ffd700","#39ffcc","#00a4ff","#0024fb","#00b2ff","#57ffae","#ffc800"] },
];
