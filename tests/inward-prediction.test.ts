import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { Camera } from '../src/state';
import { predictInwardView, predictedGridDemand } from '../src/render/inward-prediction';
import { reprojectionFor, mapUv, type FrameView } from '../src/render/reprojection';

const D=Decimal.clone({precision:4000});
const view=(units='1',x='-0.75',y='0.125'):FrameView=>({
  centerX:new D(x),centerY:new D(y),unitsPerPixel:new D(units),width:1600,height:900,
});
const identity=(v:FrameView)=>[v.centerX.toString(),v.centerY.toString(),v.unitsPerPixel.toString(),v.width,v.height,v.angle];
const config=()=>({precision:Decimal.precision,rounding:Decimal.rounding,
  minE:Decimal.minE,maxE:Decimal.maxE,toExpNeg:Decimal.toExpNeg,toExpPos:Decimal.toExpPos,modulo:Decimal.modulo});

describe('inward delivery prediction',()=>{
  it('maps the maximum-speed two-second forecast without a presentation reuse cutoff',()=>{
    const field=view('1e-209'),forecast=predictInwardView(field,{x:.5,y:.5},3,125,16)!;
    expect(reprojectionFor(field,forecast)).toBeNull();
    const demand=predictedGridDemand(field,forecast)!;
    expect(demand).not.toBeNull();expect(demand.spacing).toBeCloseTo(Math.exp(-6),15);
    expect(demand.width).toBeCloseTo(field.width*Math.exp(-6),12);
    expect(demand.height).toBeCloseTo(field.height*Math.exp(-6),12);
    expect(demand.x+demand.width/2).toBeCloseTo(field.width/2,12);
    expect(demand.y+demand.height/2).toBeCloseTo(field.height/2,12);
  });

  it('maps differing field and viewport sizes through world coordinates at e-2400',()=>{
    const beforeConfig=config();
    try{
      Decimal.set({precision:20,rounding:Decimal.ROUND_DOWN});
      const field=view('1e-2400'),forecast={...view('5e-2401'),width:800,height:600,
        centerX:new D(field.centerX).plus('13e-2400'),centerY:new D(field.centerY).minus('7e-2400')};
      const fieldBefore=identity(field),forecastBefore=identity(forecast),localConfig=config();
      expect(predictedGridDemand(field,forecast)).toEqual({x:613,y:307,width:400,height:300,spacing:.5});
      expect(identity(field)).toEqual(fieldBefore);expect(identity(forecast)).toEqual(forecastBefore);
      expect(config()).toEqual(localConfig);
    }finally{Decimal.set(beforeConfig);}
  });

  it('matches ordinary reprojection geometry where image reuse is permitted',()=>{
    const field=view('1e-200');
    for(const focus of [{x:0,y:0},{x:1,y:1},{x:.25,y:.75}]){
      const forecast=predictInwardView(field,focus,1,125,1)!;
      const mapping=reprojectionFor(field,forecast)!,demand=predictedGridDemand(field,forecast)!;
      const topLeft=mapUv(mapping,0,0),bottomRight=mapUv(mapping,1,1);
      expect(demand.x).toBeCloseTo(topLeft.x*field.width,11);
      expect(demand.y).toBeCloseTo(topLeft.y*field.height,11);
      expect(demand.width).toBeCloseTo((bottomRight.x-topLeft.x)*field.width,11);
      expect(demand.height).toBeCloseTo((bottomRight.y-topLeft.y)*field.height,11);
    }
  });

  it('declines unsupported or non-finite mapping geometry',()=>{
    const field=view();
    for(const invalid of [{...field,angle:90},{...field,angle:NaN},{...field,width:0},
      {...field,height:Infinity},{...field,width:1.5},view('0'),view('-1'),view('Infinity'),
      view('NaN'),view('1','NaN'),view('1','0','Infinity')]){
      expect(predictedGridDemand(invalid,field)).toBeNull();
      expect(predictedGridDemand(field,invalid)).toBeNull();
    }
    expect(predictedGridDemand(view('1e-400'),field)).toBeNull();
    expect(predictedGridDemand(field,view('1e-400'))).toBeNull();
  });

  it('halves the field of view after one doubling without moving a centred anchor',()=>{
    const current=view('1e-200'),next=predictInwardView(current,{x:.5,y:.5},Math.LN2,1000,1)!;
    expect(next.unitsPerPixel.eq('5e-201')).toBe(true);
    expect(next.centerX.eq(current.centerX)&&next.centerY.eq(current.centerY)).toBe(true);
    expect([next.width,next.height]).toEqual([current.width,current.height]);
  });

  it.each([{x:0,y:0},{x:1,y:0},{x:0,y:1},{x:1,y:1},{x:.25,y:.75}])(
    'keeps the pointer world coordinate fixed and the future viewport inside the current one: %j',focus=>{
      const current=view('1e-209');
      const next=predictInwardView(current,focus,Math.LN2,1000,1)!;
      const point=(v:FrameView)=>({
        x:new D(v.centerX).plus(new D(v.unitsPerPixel).times(new D(focus.x).times(v.width).minus(v.width/2))),
        y:new D(v.centerY).plus(new D(v.unitsPerPixel).times(new D(v.height/2).minus(new D(focus.y).times(v.height)))),
      });
      expect(point(next).x.eq(point(current).x)&&point(next).y.eq(point(current).y)).toBe(true);
      const m=reprojectionFor(current,next)!;
      expect(m).not.toBeNull();
      const anchored=mapUv(m,focus.x,focus.y);
      expect(anchored.x).toBeCloseTo(focus.x,14);expect(anchored.y).toBeCloseTo(focus.y,14);
      for(const [x,y] of [[0,0],[1,0],[0,1],[1,1]]){
        const p=mapUv(m,x,y);
        expect(p.x).toBeGreaterThanOrEqual(0);expect(p.x).toBeLessThanOrEqual(1);
        expect(p.y).toBeGreaterThanOrEqual(0);expect(p.y).toBeLessThanOrEqual(1);
      }
    });

  it.each([0,90,37])('matches the existing camera zoom at angle %s',angle=>{
    const beforeConfig=config();
    try{
      const camera=new Camera();
      camera.x=new Decimal('-.7421');camera.y=new Decimal('.1317');camera.span=new Decimal('8e-201');camera.angle=angle;
      const width=1600,height=900,focus={x:.25,y:.75},rate=1.2,ms=125;
      const current:FrameView={centerX:camera.x,centerY:camera.y,unitsPerPixel:camera.unitsPerPixel(height),width,height,angle};
      const predicted=predictInwardView(current,focus,rate,ms,1)!;
      camera.zoom(-rate*ms/1000,focus.x*width,focus.y*height,width,height);
      for(const difference of [new D(predicted.centerX).minus(camera.x),new D(predicted.centerY).minus(camera.y),
        new D(predicted.unitsPerPixel).minus(camera.unitsPerPixel(height))]){
        expect(difference.abs().div(current.unitsPerPixel).lt('1e-60')).toBe(true);
      }
    }finally{Decimal.set(beforeConfig);}
  });

  it('preserves e-2400 displacement and source digits without changing inputs or shared Decimal settings',()=>{
    const beforeConfig=config();
    try{
      Decimal.set({precision:20,rounding:Decimal.ROUND_DOWN});
      const current=view('1e-2400',new D('-.75').plus('3e-2399').toString(),new D('.125').minus('7e-2399').toString());
      const before=identity(current),localConfig=config();
      const next=predictInwardView(current,{x:1,y:0},Math.LN2,1000,1)!;
      expect(new D(next.centerX).minus(current.centerX).eq('4e-2398')).toBe(true);
      expect(new D(next.centerY).minus(current.centerY).eq('2.25e-2398')).toBe(true);
      expect(next.unitsPerPixel.eq('5e-2401')).toBe(true);
      expect(identity(current)).toEqual(before);expect(config()).toEqual(localConfig);
    }finally{Decimal.set(beforeConfig);}
  });

  it('clamps lookahead at sixteen times completion and the total horizon at two seconds',()=>{
    const current=view(),focus={x:.25,y:.75};
    expect(identity(predictInwardView(current,focus,1,10,100)!)).toEqual(identity(predictInwardView(current,focus,1,10,16)!));
    expect(identity(predictInwardView(current,focus,1,250,16)!)).toEqual(identity(predictInwardView(current,focus,1,2000,1)!));
    expect(identity(predictInwardView(current,focus,1,Number.MAX_VALUE,16)!)).toEqual(identity(predictInwardView(current,focus,1,2000,1)!));
  });

  it.each([
    ['off',1,30,0],['negative multiplier',1,30,-1],['invalid multiplier',1,30,NaN],['infinite multiplier',1,30,Infinity],
    ['no motion',0,30,1],['outward rate',-1,30,1],['invalid rate',NaN,30,1],['infinite rate',Infinity,30,1],
    ['no latency',1,0,1],['negative latency',1,-1,1],['invalid latency',1,NaN,1],['infinite latency',1,Infinity,1],
    ['underflowing forecast',Number.MAX_VALUE,2000,1],['indistinguishable forecast',Number.MIN_VALUE,30,1],
  ])('declines %s',(_name,rate,ms,multiplier)=>{
    expect(predictInwardView(view(),{x:.5,y:.5},rate as number,ms as number,multiplier as number)).toBeNull();
  });

  it('declines invalid geometry and off-canvas focus instead of manufacturing a forecast',()=>{
    for(const current of [
      {...view(),width:0},{...view(),height:NaN},{...view(),width:1.5},{...view(),angle:Infinity},
      view('0'),view('-1'),view('Infinity'),view('NaN'),view('1','NaN'),view('1','0','Infinity'),
    ])expect(predictInwardView(current,{x:.5,y:.5},1,30,1)).toBeNull();
    for(const focus of [{x:-.1,y:.5},{x:1.1,y:.5},{x:.5,y:-.1},{x:.5,y:1.1},{x:NaN,y:.5},{x:.5,y:Infinity}])
      expect(predictInwardView(view(),focus,1,30,1)).toBeNull();
  });
});
