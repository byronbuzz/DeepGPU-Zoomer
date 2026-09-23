import Decimal from 'decimal.js';
import {describe,expect,it} from 'vitest';
import {Camera,HOME,decodeView,encodeView,homePosition,validateView} from '../src/state';
import {rotationBasis} from '../src/rotation';
import {mapUv,reprojectionFor,type FrameView} from '../src/render/reprojection';
import {createSampleGridAnchor,planRetainedView,sampleGridRemap} from '../src/render/sample-grid';
import {appearanceUpgradeCompatible,referenceViewportRadius,WebGpuRenderer} from '../src/render/webgpu-renderer';
import {DEFAULT_COLORS} from '../src/logic/colorSettings';

const frame=(angle=0):FrameView=>({centerX:new Decimal('-.6'),centerY:new Decimal(0),unitsPerPixel:new Decimal('.01'),width:120,height:80,angle});
describe('rotation state and camera geometry',()=>{
  it('defaults legacy records to zero and round-trips angle without changing coordinate digits',()=>{
    const {angle,...old}=HOME;
    expect(validateView(old).angle).toBe(0);
    const view={...HOME,x:'-0.6000000000000000000000000000000000001',span:'1e-60',angle:37.25};
    expect(decodeView(encodeView(view))).toEqual(view);
    expect(homePosition(view).angle).toBe(37.25);
    expect(HOME.angle).toBe(0);
    for(const angle of [NaN,Infinity,-181,181])expect(()=>validateView({...HOME,angle})).toThrow();
  });
  it('preserves the zero path and exact cardinal orientations',()=>{
    const c=new Camera();c.load({...HOME,x:'0',span:'8'});
    expect(c.point(6,4,8,8).x.toString()).toBe('2');
    c.setAngle(90);expect(c.point(6,4,8,8).x.toString()).toBe('0');expect(c.point(6,4,8,8).y.toString()).toBe('2');
    c.setAngle(180);expect(c.point(6,4,8,8).x.toString()).toBe('-2');
    expect(rotationBasis(270)).toEqual({c:0,s:-1});
  });
  it('keeps cursor zoom and screen pan anchored at depth for rotated views',()=>{
    for(const angle of [0,37,90,180]){
      const c=new Camera();c.load({...HOME,x:'-0.600000000000000000000000000000000000000001',span:'1e-60',angle});
      const p=c.point(97,62,720,480);c.zoom(-.4,97,62,720,480);
      let q=c.point(97,62,720,480);
      expect(q.x.minus(p.x).abs().lt('1e-130')).toBe(true);expect(q.y.minus(p.y).abs().lt('1e-130')).toBe(true);
      c.pan(19,-11,480);q=c.point(116,51,720,480);
      expect(q.x.minus(p.x).abs().lt('1e-130')).toBe(true);expect(q.y.minus(p.y).abs().lt('1e-130')).toBe(true);
    }
  });
});
describe('rotated frame presentation and numerical authority',()=>{
  it('maps square cardinal rotations exactly and preserves an unchanged rotated frame',()=>{
    const old={...frame(),width:80},next={...old,angle:90};
    expect(mapUv(reprojectionFor(old,next)!,1,.5)).toEqual({x:.5,y:0});
    expect(mapUv(reprojectionFor(old,{...next,angle:180})!,1,.5)).toEqual({x:0,y:.5});
    expect(reprojectionFor(next,next)).toEqual({scaleX:1,scaleY:1,offsetX:0,offsetY:0});
  });
  it('matches the camera mapping for rotated, panned and differently sized frames',()=>{
    const old={...frame(23),unitsPerPixel:new Decimal('1e-60')};
    const next={...old,angle:-72,width:160,height:96,centerX:old.centerX.plus('2e-60'),centerY:old.centerY.minus('3e-60'),unitsPerPixel:new Decimal('7e-61')};
    const m=reprojectionFor(old,next)!;
    const camera=(f:FrameView)=>{const c=new Camera();c.load({...HOME,x:f.centerX.toString(),y:f.centerY.toString(),span:f.unitsPerPixel.times(f.height).toString(),angle:f.angle});return c;};
    const a=camera(old),b=camera(next);
    for(const [x,y] of [[0,0],[1,1],[.3,.7],[.5,.5]]){
      const uv=mapUv(m,x,y),p=a.point(uv.x*old.width,uv.y*old.height,old.width,old.height),q=b.point(x*next.width,y*next.height,next.width,next.height);
      expect(p.x.minus(q.x).div(old.unitsPerPixel).abs().toNumber()).toBeLessThan(1e-12);
      expect(p.y.minus(q.y).div(old.unitsPerPixel).abs().toNumber()).toBeLessThan(1e-12);
    }
  });
  it('covers every rotated viewport corner in the reference bound',()=>{
    for(const angle of [0,37,90,180]){
      const f=frame(angle),radius=referenceViewportRadius(f,new Decimal('.2'),new Decimal('-.3'));
      const c=new Camera();c.load({...HOME,x:f.centerX.toString(),y:f.centerY.toString(),span:'.8',angle});
      for(const [x,y] of [[0,0],[120,0],[0,80],[120,80]]){
        const p=c.point(x,y,120,80),distance=Decimal.hypot(p.x.minus('.2'),p.y.plus('.3')).toNumber();
        expect(radius+1e-14).toBeGreaterThanOrEqual(distance);
      }
    }
  });
  it('declines inexact rotated sample reuse and retains visual snapshots in their source geometry',()=>{
    expect(sampleGridRemap(frame(),frame(90))).toBeNull();
    expect(sampleGridRemap(frame(37),frame(37))).toBeNull();
    const f=frame(37);expect(planRetainedView(f,createSampleGridAnchor(frame()))).toEqual(f);
    const renderer:any=Object.create(WebGpuRenderer.prototype);
    expect(renderer.coverageIn(frame(),frame(45))).toEqual([]);
    expect(renderer.coverageIn(frame(45),frame(45))).toHaveLength(1);
  });
  it('does not report a stale orientation complete or reuse it for an appearance hold',()=>{
    const renderer:any=Object.create(WebGpuRenderer.prototype);
    const old={...frame(),family:'mandelbrot' as const,maxIterations:5000,useApprox:true,colors:DEFAULT_COLORS,method:0,grid:1};
    Object.assign(renderer,{fieldComplete:true,historyValid:true,lastFrame:old});
    expect(renderer.isComplete(old)).toBe(true);
    expect(renderer.isComplete({...old,angle:90})).toBe(false);
    expect(appearanceUpgradeCompatible(old,{...old,angle:90},0,1)).toBe(false);
  });
});
