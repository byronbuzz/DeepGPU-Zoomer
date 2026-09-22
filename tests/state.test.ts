import { describe, expect, it } from 'vitest';
import { Camera, HOME, encodeView, decodeView, effectiveIterations, validateView } from '../src/state';
import { PLACES } from '../src/places';
import Decimal from 'decimal.js';
import {depthLabel,iterationFromSlider,iterationToSlider} from '../src/state';
import {CAPPED,DEFAULT_COLORS,FORMULAS,PRESETS,cycleFromSlider,cycleToSlider,decodeColors,encodeColors,needsEndpoints,validateColors} from '../src/logic/colorSettings';

describe('exact view state',()=>{
  it('uses the released Home iteration default',()=>{
    expect(HOME.iterations).toBe(2000);
  });
  it('formats depth without overflow and maps continuous limits to exact integers',()=>{
    expect(depthLabel(new Decimal('2.8'))).toBe('10^0.00×');
    expect(depthLabel(new Decimal('2.8e-2000'))).toBe('10^2000.00×');
    for(const n of [32,1000,100000,1000000]){expect(iterationFromSlider(iterationToSlider(n))).toBe(n);expect(validateView({...HOME,iterations:n}).iterations).toBe(n);}
    expect(()=>validateView({...HOME,iterations:1000001})).toThrow();
  });
  it('roundtrips appearance and accepts old links without appearance',()=>{
    const appearance=validateColors({...DEFAULT_COLORS,stops:['#123456','#abcdef'],positions:[.123,.789],locks:[true,false],effect:8,formula:4,capped:2,repeating:false});
    const v={...PLACES[4],appearance};expect(decodeView(encodeView(v))).toEqual(validateView(v));
    expect(decodeView(encodeView(HOME))).toEqual(HOME);
    expect(validateView({...HOME,iterationMode:undefined}).iterationMode).toBe('fixed');
    expect(decodeView(encodeView({...HOME,iterationMode:'dynamic'})).iterationMode).toBe('dynamic');
  });
  it('keeps fixed limits exact and bounds the documented dynamic depth policy',()=>{
    expect(effectiveIterations(1000,new Decimal('2.8'),'fixed')).toBe(1000);
    expect(effectiveIterations(1000,new Decimal('2.8'),'dynamic')).toBe(1024);
    expect(effectiveIterations(1000,new Decimal('2.8e-2'),'dynamic')).toBe(1120);
    expect(effectiveIterations(1_000_000,new Decimal('2.8e-2000'),'dynamic')).toBe(1_000_000);
  });
  it('keeps released formula IDs and roundtrips all appended appearance fields',()=>{
    expect(FORMULAS.slice(0,5)).toEqual(['Smooth escape','Classic iteration bands','Binary decomposition','Colour decomposition','Biomorphs']);
    expect(FORMULAS).toHaveLength(15);
    const c=validateColors({...DEFAULT_COLORS,cycle:4096,formula:14,effect:10,capped:12,postAntialias:true,repeating:false,
      positions:[0,.16,.42,.6425,.8575,1],locks:[true,false,true,false,false,true]});
    expect(decodeColors(encodeColors(c))).toEqual(c);
    expect(decodeView(encodeView({...HOME,appearance:c}))).toEqual(validateView({...HOME,appearance:c}));
    for(const id of [2,3,4,5,6,7,8,9,10])expect(needsEndpoints({...c,formula:id,capped:0,effect:0})).toBe(true);
    for(const id of [0,1,11,12,13,14])expect(needsEndpoints({...c,formula:id,capped:0,effect:0})).toBe(false);
    expect(CAPPED).toHaveLength(13);
    expect(PRESETS.filter(p=>p.name.includes('adapted'))).toHaveLength(10);
  });
  it('maps colour spacing exponentially without losing endpoints',()=>{
    expect(DEFAULT_COLORS.cycle).toBe(64);
    for(const value of [8,32,64,256,512,1024,4096]){
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
