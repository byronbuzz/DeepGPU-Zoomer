import { describe, expect, it } from 'vitest';
import { Camera, HOME, homePosition, encodeView, decodeView, validateView } from '../src/state';
import { PLACES } from '../src/places';
import Decimal from 'decimal.js';
import {depthLabel,iterationFromSlider,iterationToSlider} from '../src/state';
import {CAPPED,DEFAULT_COLORS,FORMULAS,PRESETS,cycleFromSlider,cycleToSlider,decodeColors,encodeColors,needsEndpoints,validateColors} from '../src/logic/colorSettings';
import {paletteStops,withStops} from '../src/palette-editor';

describe('exact view state',()=>{
  it('uses the released Home iteration default',()=>{
    expect(HOME.iterations).toBe(1000);
  });
  it('restores Home geometry and 1000 iterations while preserving family and appearance',()=>{
    const appearance=validateColors({...DEFAULT_COLORS,cycle:317,effect:8,postAntialias:true});
    for(const family of ['mandelbrot','julia'] as const){
      const current={...HOME,family,x:'1.25',y:'-.75',span:'0.001',jx:'-.2',jy:'.3',iterations:7321,appearance};
      expect(homePosition(current)).toEqual({...current,x:family==='julia'?'0':'-0.6',y:'0',span:'2.8',iterations:1000});
      expect(depthLabel(new Decimal(homePosition(current).span))).toBe('10^0.00×');
    }
  });
  it('formats depth without overflow and maps continuous limits to exact integers',()=>{
    expect(depthLabel(new Decimal('2.8'))).toBe('10^0.00×');
    expect(depthLabel(new Decimal('2.8e-2000'))).toBe('10^2000.00×');
    for(const n of [1,32,1000,100000,1000000]){expect(iterationFromSlider(iterationToSlider(n))).toBe(n);expect(validateView({...HOME,iterations:n}).iterations).toBe(n);}
    expect(()=>validateView({...HOME,iterations:10000001})).toThrow();
  });
  it('roundtrips appearance and accepts old links without appearance',()=>{
    const appearance=validateColors({...DEFAULT_COLORS,stops:['#123456','#abcdef'],positions:[.123,.789],locks:[true,false],effect:8,formula:4,capped:2,repeating:false});
    const v={...PLACES[4],appearance};expect(decodeView(encodeView(v))).toEqual(validateView(v));
    expect(decodeView(encodeView(HOME))).toEqual(HOME);
    const legacy={...HOME,iterationMode:'dynamic'};
    expect(decodeView(encodeView(legacy))).toEqual(HOME);
  });
  it('preserves an explicitly saved limit while discarding obsolete dynamic mode',()=>{
    const old={...HOME,iterations:2173,iterationMode:'dynamic'};
    expect(validateView(old)).toEqual({...HOME,iterations:2173});
    expect(iterationFromSlider(0)).toBe(1);
  });
  it('keeps released formula IDs and roundtrips all appended appearance fields',()=>{
    expect(FORMULAS.slice(0,5)).toEqual(['Smooth escape','Classic iteration bands','Binary decomposition','Colour decomposition','Biomorphs']);
    expect(FORMULAS).toHaveLength(25);
    const c=validateColors({...DEFAULT_COLORS,cycle:4096,formula:14,effect:10,capped:12,postAntialias:true,repeating:false,
      positions:[0,.16,.42,.6425,.8575,1],locks:[true,false,true,false,false,true]});
    expect(decodeColors(encodeColors(c))).toEqual(c);
    expect(decodeView(encodeView({...HOME,appearance:c}))).toEqual(validateView({...HOME,appearance:c}));
    for(const id of [2,3,4,5,6,7,8,9,10])expect(needsEndpoints({...c,formula:id,capped:0,effect:0})).toBe(true);
    for(const id of [0,1,11,12,13,14])expect(needsEndpoints({...c,formula:id,capped:0,effect:0})).toBe(false);
    expect(CAPPED).toHaveLength(13);
    expect(PRESETS.every(p=>!p.name.includes('adapted'))).toBe(true);
  });
  it('defaults old colour records to zero hue and roundtrips a full-turn hue setting',()=>{
    expect(DEFAULT_COLORS.hueRotation).toBe(0);
    const legacy=encodeColors(DEFAULT_COLORS).split('.').slice(0,27).join('.');
    expect(decodeColors(legacy)?.hueRotation).toBe(0);
    for(const hueRotation of [0,120,360]){
      const colors=validateColors({...DEFAULT_COLORS,hueRotation});
      expect(decodeColors(encodeColors(colors))).toEqual(colors);
    }
    expect(()=>validateColors({...DEFAULT_COLORS,hueRotation:-1})).toThrow();
    expect(()=>validateColors({...DEFAULT_COLORS,hueRotation:361})).toThrow();
  });
  it('preserves hue rotation when palette stops are edited',()=>{
    const colors=validateColors({...DEFAULT_COLORS,hueRotation:135});
    const stops=paletteStops(colors);
    stops[0].color='#123456';
    expect(withStops(colors,stops).hueRotation).toBe(135);
  });
  it('maps colour spacing exponentially without losing endpoints',()=>{
    expect(DEFAULT_COLORS.cycle).toBe(64);
    for(const value of [8,32,64,256,512,1024,4096,16384,65536]){
      expect(cycleFromSlider(cycleToSlider(value))).toBeCloseTo(value,10);
      expect(decodeColors(encodeColors({...DEFAULT_COLORS,cycle:value}))?.cycle).toBe(value);
    }
  });
  it('roundtrips the expanded relief range and rejects invalid live values',()=>{
    const maximum=validateColors({...DEFAULT_COLORS,slopeDepth:80});
    expect(decodeColors(encodeColors(maximum))?.slopeDepth).toBe(80);
    const oversized=encodeColors(maximum).split('.');oversized[11]='9000';
    expect(decodeColors(oversized.join('.'))?.slopeDepth).toBe(80);
    expect(decodeColors(encodeColors({...DEFAULT_COLORS,slopeDepth:20}))?.slopeDepth).toBe(20);
    expect(()=>validateColors({...DEFAULT_COLORS,slopeDepth:80.1})).toThrow();
    expect(()=>validateColors({...DEFAULT_COLORS,slopeDepth:-.1})).toThrow();
  });
  it('round trips every coordinate digit, Julia constant and span',()=>{
    const v={...PLACES[4],span:'2.812345678901234567890123456789e-50'};
    expect(decodeView(encodeView(v))).toEqual(validateView(v));
  });
  it('rejects malformed and unusable saved views',()=>{
    for(const span of ['0','-1','NaN','Infinity','9']) expect(()=>validateView({...HOME,span})).toThrow();
    expect(()=>validateView({...HOME,iterations:NaN})).toThrow();
  });
});
describe('wall-clock camera',()=>{
  it('keeps the pointer anchor fixed at depth',()=>{
    const c=new Camera();c.load(PLACES[4]);const p=c.point(97,62,720,480);
    c.zoom(-.4,97,62,720,480);const after=c.point(97,62,720,480);
    expect(after.x.minus(p.x).abs().lt('1e-110')).toBe(true);
    expect(after.y.minus(p.y).abs().lt('1e-110')).toBe(true);
  });
  it('integrates elapsed time independently of frame count and reverses',()=>{
    const a=new Camera(),b=new Camera();a.load(PLACES[3]);b.load(PLACES[3]);
    for(let i=0;i<60;i++)a.zoom(-1/60,360,240,720,480);
    for(let i=0;i<20;i++)b.zoom(-1/20,360,240,720,480);
    expect(a.span.div(b.span).minus(1).abs().lt('1e-13')).toBe(true);
    for(let i=0;i<60;i++)a.zoom(1/60,360,240,720,480);
    expect(a.span.div(PLACES[3].span).minus(1).abs().lt('1e-13')).toBe(true);
  });
});
