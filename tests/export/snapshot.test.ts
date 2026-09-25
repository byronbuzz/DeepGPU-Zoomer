import {expect,it} from 'vitest';
import Decimal from 'decimal.js';
import {snapshotExportRequest} from '../../src/export/render';
import {DEFAULT_COLORS} from '../../src/logic/colorSettings';
import {DEFAULT_TUNING} from '../../src/tuning';

it('freezes export appearance and detaches live navigation callbacks and padding',()=>{
  const colors={...DEFAULT_COLORS,stops:['#000000','#ffffff'],positions:[0,1],locks:[false,true],postAntialias:true};
  const tuning={...DEFAULT_TUNING,hardPixelBudget:128};
  const request={centerX:new Decimal('-0.7'),centerY:new Decimal('.1'),unitsPerPixel:new Decimal('1e-87'),width:800,height:600,
    maxIterations:12345,colors,tuning,followView:true,overscanPixels:{x:64,y:128},workView:true,
    dynamicIterations:true,provisionalNavigationCap:true,isCurrent:()=>false,betweenBatches:async()=>{}};
  const snapshot=snapshotExportRequest(request);
  colors.stops[0]='#ff0000';colors.positions[0]=.5;colors.locks[0]=true;tuning.batchMultiplier=1;
  expect(snapshot.colors.stops).toEqual(['#000000','#ffffff']);expect(snapshot.colors.positions).toEqual([0,1]);
  expect(snapshot.colors.locks).toEqual([false,true]);expect(snapshot.colors.postAntialias).toBe(true);
  expect(snapshot.maxIterations).toBe(12345);expect(snapshot.tuning?.batchMultiplier).toBe(DEFAULT_TUNING.batchMultiplier);
  expect(snapshot.tuning?.hardPixelBudget).toBe(0);expect(snapshot.followView).toBe(false);
  expect(snapshot.isCurrent).toBeUndefined();expect(snapshot.betweenBatches).toBeUndefined();
  expect(snapshot.overscanPixels).toBeUndefined();expect(snapshot.workView).toBeUndefined();
  expect(snapshot.dynamicIterations).toBe(false);expect(snapshot.provisionalNavigationCap).toBe(false);
});
