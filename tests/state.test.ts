import { describe, expect, it } from 'vitest';
import { Camera, HOME, encodeView, decodeView, validateView } from '../src/state';
import { PLACES } from '../src/places';

describe('exact view state',()=>{
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
