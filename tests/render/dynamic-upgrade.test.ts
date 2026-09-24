import {describe,expect,it} from 'vitest';
import shader from '../../src/render/perturbation.wgsl?raw';
import continuationShader from '../../src/render/continuation.wgsl?raw';
import {continuationEntry} from '../../src/render/continuation';
import {PendingRegions} from '../../src/render/regions';

describe('incremental Dynamic integration',()=>{
  it('keeps the continuation entry aligned with the ordinary field skip gate',()=>{
    const continued=continuationEntry(shader);
    expect(continued).toContain('if (continuation.resume == 0u && skipKnown) {');
    expect(continued).toContain('let stateIndex = gid.y * continuation.columns + gid.x;');
    expect(continued).toContain('let resolved = previous.x >= -1.0 || previous.x <= -(f32(u.maxIterations) + 2.0);');
  });
  it('keeps Direct resume exact and publishes only resolved samples',()=>{
    expect(continuationShader).toContain('if (DIRECT) { return iterateDirectContinued(pixel,stateIndex); }');
    expect(continuationShader).toContain('sameHdrBits(z,checkpoint)');
    expect(continuationShader).toContain('wideFromHdr(checkpoint)');
    expect(continuationShader).toContain('return Sample(false,n,hdrValue(z),-1.0');
    expect(continuationShader).toContain('sameWideBits(delta, checkpointDelta) && sameWideBits(z, checkpointZ)');
    expect(continuationShader).toContain('checkpointZ = saved.checkpointZ; checkpointDelta = saved.checkpointDelta;');
    const entry=continuationEntry(shader);
    expect(entry).toContain('if (s.z2 < 0.0) { return; }');
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
