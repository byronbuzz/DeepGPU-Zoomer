import {it,expect} from 'vitest';
import {DEFAULT_COLORS,validateColors} from '../src/logic/colorSettings';
import {paletteStops,randomizePalette,withStops} from '../src/palette-editor';
it('randomisation preserves locks, count and non-seam positions',()=>{
  const c=validateColors({...DEFAULT_COLORS,locks:[true,false,true,false,false]});
  const original=paletteStops(c);
  for(const all of [false,true])for(let i=0;i<40;i++){
    const next=randomizePalette(c,all,true),stops=paletteStops(next);
    expect(stops.length).toBeGreaterThanOrEqual(2);expect(stops.length).toBeLessThanOrEqual(8);
    for(const s of original.filter(s=>s.locked))expect(stops).toContainEqual(s);
    if(!all){expect(next.positions?.slice(0,-1)).toEqual(c.positions?.slice(0,-1));expect(next.positions?.at(-1)).toBeLessThanOrEqual(c.positions!.at(-1)!);}
    expect(next.formula).toBe(c.formula);expect(next.effect).toBe(c.effect);
  }
});
it('rejects malformed positions and palette cardinality',()=>{
  for(const stops of [[],['#000000'],Array(9).fill('#000000')])expect(()=>validateColors({...DEFAULT_COLORS,stops})).toThrow();
  expect(()=>validateColors({...DEFAULT_COLORS,positions:[0,0,.7,.2,1]})).toThrow();
});
it('turns edited legacy endpoints into a seamless repeating interval',()=>{
  const legacy=validateColors({...DEFAULT_COLORS,stops:['#000000','#ffffff'],positions:[0,1],repeating:false});
  const edited=withStops(legacy,paletteStops(legacy));
  expect(edited.repeating).toBe(true);expect(edited.positions?.at(-1)).toBeLessThan(1);
});
