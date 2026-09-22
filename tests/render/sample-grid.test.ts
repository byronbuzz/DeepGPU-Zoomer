import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { createSampleGridAnchor, planRetainedView, sampleGridCoarsen, sampleGridRemap } from "../../src/render/sample-grid";
import type { FrameView } from "../../src/render/reprojection";

const frame = (spacing = "1", x = "0", y = "0", width = 65, height = 49): FrameView => ({
  centerX: new Decimal(x), centerY: new Decimal(y), unitsPerPixel: new Decimal(spacing), width, height,
});

describe("stable sample grids", () => {
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
  it("plans arbitrary outward sampling directly from the original dense anchor",()=>{
    const precision=Decimal.precision;Decimal.set({precision:100});
    try{
      const old=frame("1e-52","-0.527503118643534610789746402444915337566745947811707285339875197003203011","0.075912178352287867071814194826348046366422194847978022539732593449186891",192,128);
      const next={...old,centerX:old.centerX.plus("0.37e-52"),unitsPerPixel:new Decimal("1.07e-52")};
      const map=sampleGridCoarsen(old,next)!;expect(map).not.toBeNull();expect(map.step).toBeCloseTo(1.07,6);
      expect(sampleGridCoarsen(next,old)).toBeNull();
      const oldAnchor=createSampleGridAnchor(old),nextAnchor=createSampleGridAnchor(next),x=80,source=Math.round(map.offsetX+x*map.step);
      const sourceX=oldAnchor.originX.plus(old.unitsPerPixel.times(source)),targetX=nextAnchor.originX.plus(next.unitsPerPixel.times(x));
      expect(sourceX.minus(targetX).abs().lte(old.unitsPerPixel.div(2))).toBe(true);
    }finally{Decimal.set({precision});}
  });
});
