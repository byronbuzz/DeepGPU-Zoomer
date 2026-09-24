import {describe,expect,it} from 'vitest';
import shader from '../../src/render/perturbation.wgsl?raw';
import {continuationEntry} from '../../src/render/continuation';
import {PendingRegions} from '../../src/render/regions';

describe('incremental Dynamic integration',()=>{
  it('keeps the continuation entry aligned with the ordinary field skip gate',()=>{
    const continued=continuationEntry(shader);
    expect(continued).toContain('if (continuation.resume == 0u && skipKnown) {');
    expect(continued).toContain('let stateIndex = gid.y * continuation.columns + gid.x;');
    expect(continued).toContain('let resolved = previous.x >= -1.0 || previous.x <= -(f32(u.maxIterations) + 2.0);');
  });
  it('reopens exact region work even when the prior presentation covered the whole view',()=>{
    const pending=new PendingRegions();
    pending.reset(32,32,4,true);
    const demand={x:16,y:16,zoom:0,covered:[{x:0,y:0,width:32,height:32,spacing:1}]};
    let exactArea=0,visits=0;
    while(pending.size){
      const region=pending.take(256,demand);
      expect(region).toBeDefined();
      if(region!.stride===1)exactArea+=region!.width*region!.height;
      if(++visits>100)throw Error('Pending region queue did not drain');
    }
    expect(exactArea).toBe(32*32);
  });
});
