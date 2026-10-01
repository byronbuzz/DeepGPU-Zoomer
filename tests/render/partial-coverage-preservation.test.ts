import Decimal from 'decimal.js';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {WebGpuRenderer} from '../../src/render/webgpu-renderer';
import {CoverageRegions} from '../../src/render/regions';
import {containsNumericalView} from '../../src/render/numerical-grid';
import {mapUv,reprojectionFor} from '../../src/render/reprojection';
import {DEFAULT_COLORS} from '../../src/logic/colorSettings';

afterEach(()=>vi.unstubAllGlobals());

function fixture(angle:number,liveSpacing:string,zoom:number){
  vi.stubGlobal('GPUTextureUsage',{TEXTURE_BINDING:4,RENDER_ATTACHMENT:16});
  const frame={family:'mandelbrot',centerX:new Decimal(0),centerY:new Decimal(0),
    unitsPerPixel:new Decimal(1),width:3200,height:1800,angle,maxIterations:100,
    useApprox:true,method:0,grid:1,colors:DEFAULT_COLORS,interacting:true,zoom};
  const live={...frame,width:1600,height:900,unitsPerPixel:new Decimal(liveSpacing)};
  const fine={...frame,width:2048,height:1440,unitsPerPixel:new Decimal('.5'),proxy:true,snapshotComplete:false,
    coveredRegions:[{x:0,y:0,width:2048,height:1440,spacing:new Decimal('.5')}]};
  const broad={...frame,width:1600,height:900,unitsPerPixel:new Decimal(4),proxy:true,snapshotComplete:true,
    coveredRegions:[{x:0,y:0,width:1600,height:900,spacing:new Decimal(4)}]};
  const fineTexture={destroy:vi.fn()},broadTexture={destroy:vi.fn()};
  const device={limits:{maxTextureDimension2D:8192},pushErrorScope:vi.fn(),popErrorScope:async()=>null,
    createTexture:(d:any)=>({...d,width:d.size[0],height:d.size[1],destroy:vi.fn()}),
    createCommandEncoder:()=>({finish:()=>({})}),queue:{submit:vi.fn()}};
  const r:any=Object.create(WebGpuRenderer.prototype);
  Object.assign(r,{ctx:{device},publicationEpoch:1,pendingRetain:null,currentView:live,incomingFrame:frame,
    target:{},partialRegions:1,retainedAnchor:null,lastFrame:fine,history:fineTexture,historyValid:true,
    coverageFrame:broad,coverageHistory:broadTexture,determined:new CoverageRegions(),encodeBlit:vi.fn()});
  r.determined.add({x:1000,y:600,width:100,height:100,spacing:1});
  return {r,live,fine,broad,broadTexture};
}

describe('partial snapshot preserves existing fallback coverage',()=>{
  it('keeps the broad completed source outside an outward partial footprint',async()=>{
    const {r,live,fine,broad,broadTexture}=fixture(0,'4',-1);
    expect(await r.retainDisplayedPartial(live,true)).toBe(true);
    const replacement=r.lastFrame;
    // The fine central source would qualify on detail alone, but neither it
    // nor the new partial snapshot covers this visible point near the edge.
    expect(r.hasFinerRetainedCoverage(fine,replacement,live)).toBe(true);
    expect(r.hasFinerRetainedCoverage(broad,replacement,live)).toBe(false);
    expect(containsNumericalView(replacement,live)).toBe(false);
    const edge={x:.9,y:.5};
    const inside=(frame:any)=>{
      const uv=mapUv(reprojectionFor(frame,live,true,true)!,edge.x,edge.y);
      return uv.x>=0&&uv.x<=1&&uv.y>=0&&uv.y<=1;
    };
    expect(inside(replacement)).toBe(false);expect(inside(fine)).toBe(false);expect(inside(broad)).toBe(true);
    expect(r.coverageFrame).toBe(broad);expect(r.coverageHistory).toBe(broadTexture);
    expect(broadTexture.destroy).not.toHaveBeenCalled();
  });

  it('keeps the existing completed coverage source for rotated partial snapshots',async()=>{
    const {r,live,fine,broad,broadTexture}=fixture(37,'1',1);
    expect(await r.retainDisplayedPartial(live,true)).toBe(true);
    const replacement=r.lastFrame;
    // Isolate the orientation guard: this crop covers the view and the front
    // has finer samples, but rotated retention keeps its existing policy.
    expect(containsNumericalView(replacement,live)).toBe(true);
    expect(r.hasFinerRetainedCoverage(fine,replacement,live)).toBe(true);
    expect(r.hasFinerRetainedCoverage(broad,replacement,live)).toBe(false);
    expect(replacement.angle).toBe(37);
    expect(r.coverageFrame).toBe(broad);expect(r.coverageHistory).toBe(broadTexture);
    expect(broadTexture.destroy).not.toHaveBeenCalled();
  });
});
