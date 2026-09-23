import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { boundedRetainedView, createSampleGridAnchor, planRetainedView, sampleGridRemap } from "../../src/render/sample-grid";
import { mapUv, reprojectionFor } from "../../src/render/reprojection";
import type { FrameView } from "../../src/render/reprojection";

const frame = (spacing = "1", x = "0", y = "0", width = 65, height = 49): FrameView => ({
  centerX: new Decimal(x), centerY: new Decimal(y), unitsPerPixel: new Decimal(spacing), width, height,
});

describe("stable sample grids", () => {
  it('bounds padded retained grids by coarsening the anchored lattice, including device limits',()=>{
    const old=frame('.001','-.6','0',5120,2880),anchor=createSampleGridAnchor(old);
    for(const deviceLimit of [8192,2048,1024])for(const angle of [0,37,90]){
      const view={...old,unitsPerPixel:new Decimal('.00099'),angle};
      const retained=planRetainedView(view,anchor,{overscan:1,deviceLimit});
      expect(retained.width).toBeLessThanOrEqual(Math.min(2560,deviceLimit));
      expect(retained.height).toBeLessThanOrEqual(Math.min(1440,deviceLimit));
      const m=reprojectionFor(retained,view,true)!;
      for(const [x,y] of [[0,0],[1,0],[0,1],[1,1]]){
        const p=mapUv(m,x,y);expect(p.x).toBeGreaterThanOrEqual(-1e-12);expect(p.x).toBeLessThanOrEqual(1+1e-12);
        expect(p.y).toBeGreaterThanOrEqual(-1e-12);expect(p.y).toBeLessThanOrEqual(1+1e-12);
      }
      if(!angle){
        const first=createSampleGridAnchor(retained);
        expect(first.originX.minus(retained.unitsPerPixel.div(2)).minus(anchor.originX.minus(old.unitsPerPixel.div(2))).div(retained.unitsPerPixel).isInteger()).toBe(true);
      }
    }
  });

  it('keeps uncapped snapshots identical and preserves uniform rotated mapping at odd sizes',()=>{
    const small=frame('1e-52','-.7','.1',65,49);
    const same=boundedRetainedView(small);expect(same).toEqual(small);
    const rotated={...small,width:5121,height:2881,angle:37};
    const retained=boundedRetainedView(rotated,8192);
    expect(retained.width).toBeLessThanOrEqual(2560);expect(retained.height).toBeLessThanOrEqual(1440);
    expect(retained.centerX.eq(rotated.centerX)&&retained.centerY.eq(rotated.centerY)).toBe(true);
    expect(retained.angle).toBe(37);
    const p=mapUv(reprojectionFor(rotated,retained,true)!,0.5,0.5);
    expect(p.x).toBeCloseTo(.5,14);expect(p.y).toBeCloseTo(.5,14);
  });
  it("nests presentation pixel edges when magnifying retained colour blocks",()=>{
    const source=frame("1","0","0",64,48),anchor=createSampleGridAnchor(source);
    const grid=planRetainedView({...source,unitsPerPixel:new Decimal(1).div(1024)},anchor);
    const first=createSampleGridAnchor(grid);
    const sourceEdge=anchor.originX.minus(source.unitsPerPixel.div(2));
    const retainedEdge=first.originX.minus(grid.unitsPerPixel.div(2));
    expect(retainedEdge.minus(sourceEdge).div(grid.unitsPerPixel).isInteger()).toBe(true);
  });
  it("keeps presentation proxies on exact lattice phases across fractional pans", () => {
    const anchor=createSampleGridAnchor(frame()); let previous=planRetainedView(frame(),anchor);
    for(let i=1;i<=80;i++){
      const next=planRetainedView(frame("1",String(i*.4)),anchor);
      const map=sampleGridRemap(previous,next);
      expect(map).not.toBeNull(); expect(map!.denominator).toBe(1);
      expect(sampleGridRemap(planRetainedView(frame(),anchor),next)).not.toBeNull();
      previous=next;
    }
  });

  it("maps only identical world samples during pan, refinement and coarsening", () => {
    const old = frame(), oldAnchor = createSampleGridAnchor(old);
    for (const desired of [frame("1", "3", "-2"), frame(".5"), frame("2")]) {
      const next = desired, anchor = createSampleGridAnchor(next), map = sampleGridRemap(old, next)!;
      expect(map).not.toBeNull();
      let reused = 0, missing = 0;
      for (let y = 0; y < next.height; y++) for (let x = 0; x < next.width; x++) {
        const ox = (map.offsetX + x * map.step) / map.denominator;
        const oy = (map.offsetY + y * map.step) / map.denominator;
        if (!Number.isInteger(ox) || !Number.isInteger(oy) || ox < 0 || oy < 0 || ox >= old.width || oy >= old.height) { missing++; continue; }
        reused++;
        expect(oldAnchor.originX.plus(old.unitsPerPixel.times(ox)).eq(anchor.originX.plus(next.unitsPerPixel.times(x)))).toBe(true);
        expect(oldAnchor.originY.minus(old.unitsPerPixel.times(oy)).eq(anchor.originY.minus(next.unitsPerPixel.times(y)))).toBe(true);
      }
      expect(reused).toBeGreaterThan(0); expect(missing).toBeGreaterThan(0);
    }
  });

  it("retains exact deep-coordinate identity without a Number centre conversion", () => {
    const view = frame("1e-52", "-0.527503118643534610789746402444915337566745947811707285339875197003203011", "0.075912178352287867071814194826348046366422194847978022539732593449186891");
    const anchor = createSampleGridAnchor(view), grid = {...view,width:view.width+2,height:view.height+2}, target = createSampleGridAnchor(grid);
    const map = sampleGridRemap(view, grid);
    expect(map).not.toBeNull();
    expect(map!.denominator).toBe(1);
    expect(anchor.originX.plus(view.unitsPerPixel.times(map!.offsetX)).eq(target.originX)).toBe(true);
    expect(anchor.originY.minus(view.unitsPerPixel.times(map!.offsetY)).eq(target.originY)).toBe(true);
  });

  it("rejects fractional lattice phases and unsafe remap arithmetic", () => {
    expect(sampleGridRemap(frame(), frame("1", ".25"))).toBeNull();
    expect(sampleGridRemap(frame(), frame(".7"))).toBeNull();
    expect(sampleGridRemap(frame(), frame("1", "1e20"))).toBeNull();
    expect(sampleGridRemap(frame(), frame("2147483648"))).toBeNull();
    expect(sampleGridRemap(frame(), frame("1073741824"))).toBeNull();
  });
});
