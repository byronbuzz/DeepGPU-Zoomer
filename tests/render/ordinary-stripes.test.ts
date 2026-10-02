import {describe,expect,it} from 'vitest';
import {MIN_BATCH_SAMPLES,ordinaryStripeRows,learnOrdinaryStripeCost} from '../../src/render/ordinary-stripes';

describe('ordinary inward region stripes',()=>{
  it('covers the original sample lattice once, including clipped tails and nonzero origins',()=>{
    for(const width of [1,17,1600,3200])for(const height of [1,19,65,901,1792])for(const stride of [1,2,4,8,16]){
      const origin=3*stride,yRows:number[]=[];
      let done=0,visits=0;
      while(done<height){
        const rows=ordinaryStripeRows(width,height-done,stride,.05);
        expect(rows).toBeGreaterThan(0);
        expect(rows).toBeLessThanOrEqual(height-done);
        if(done+rows<height)expect(rows%(8*stride)).toBe(0);
        expect(done%(8*stride)).toBe(0);
        for(let y=0;y<rows;y+=stride)yRows.push(origin+done+y);
        visits+=Math.ceil(width/stride)*Math.ceil(rows/stride);
        done+=rows;
      }
      expect(done).toBe(height);
      expect(yRows).toEqual(Array.from({length:Math.ceil(height/stride)},(_,i)=>origin+i*stride));
      expect(visits).toBe(Math.ceil(width/stride)*Math.ceil(height/stride));
    }
  });

  it('honours explicit 8ms and default 12ms allowances above the occupancy minimum',()=>{
    const rows=ordinaryStripeRows(1600,900,1,.00005,8);
    expect(rows%8).toBe(0);
    expect(rows*1600*.00005).toBeLessThanOrEqual(8);
    expect((rows+8)*1600*.00005).toBeGreaterThan(8);
    const defaultRows=ordinaryStripeRows(1600,900,1,.00005);
    expect(defaultRows%8).toBe(0);
    expect(defaultRows).toBeGreaterThan(rows);
    expect(defaultRows*1600*.00005).toBeLessThanOrEqual(12);
    expect((defaultRows+8)*1600*.00005).toBeGreaterThan(12);
  });

  it('rounds the 16K occupancy minimum up to eight sample rows without extending a clipped tail',()=>{
    expect(MIN_BATCH_SAMPLES).toBe(16_384);
    for(const [width,stride,expectedRows] of [[1600,1,16],[3200,8,384],[2624,4,128],[1600,2,48]] as const){
      const rows=ordinaryStripeRows(width,1792,stride,.05);
      const columns=Math.ceil(width/stride);
      expect(rows).toBe(expectedRows);
      expect(rows%(8*stride)).toBe(0);
      expect(columns*Math.ceil(rows/stride)).toBeGreaterThanOrEqual(MIN_BATCH_SAMPLES);
      expect(columns*Math.ceil((rows-8*stride)/stride)).toBeLessThan(MIN_BATCH_SAMPLES);
      expect(ordinaryStripeRows(width,rows-3,stride,.05)).toBe(rows-3);
    }
    expect(ordinaryStripeRows(1600,5,1,.01,8)).toBe(5);
  });

  it('recovers from an inflated sparse estimate without hundreds of tiny reused stripes',()=>{
    let remaining=900,cost=.02,stripes=0,largest=0;
    while(remaining){
      const rows=ordinaryStripeRows(1600,remaining,1,cost);
      largest=Math.max(largest,rows);remaining-=rows;stripes++;
      cost=learnOrdinaryStripeCost(cost,1600*rows*.000001,1600*rows);
    }
    expect(stripes).toBeLessThan(25);
    expect(largest).toBeGreaterThanOrEqual(128);
  });

  it('limits cheaper or zero-time growth and responds immediately to an expensive stripe',()=>{
    expect(learnOrdinaryStripeCost(.01,0,1000)).toBe(.005);
    expect(learnOrdinaryStripeCost(.01,.1,1000)).toBe(.005);
    expect(learnOrdinaryStripeCost(.01,25,1000)).toBe(.025);
    for(const ms of [-1,NaN,Infinity])expect(learnOrdinaryStripeCost(.01,ms,1000)).toBe(.01);
    expect(learnOrdinaryStripeCost(.01,1,0)).toBe(.01);
  });

  it('packs only a short final tail, retaining two full minimum stripes at the boundary',()=>{
    expect(ordinaryStripeRows(1600,16,1,.05)).toBe(16);
    expect(ordinaryStripeRows(1600,17,1,.05)).toBe(17);
    expect(ordinaryStripeRows(1600,31,1,.05)).toBe(31);
    expect(ordinaryStripeRows(1600,32,1,.05)).toBe(16);
    expect(ordinaryStripeRows(1600,33,1,.05)).toBe(16);
    const partition=(height:number)=>{
      const rows:number[]=[];
      while(height){const next=ordinaryStripeRows(1600,height,1,.05);rows.push(next);height-=next;}
      return rows;
    };
    expect(partition(47)).toEqual([16,31]);
    expect(partition(48)).toEqual([16,16,16]);
    expect(partition(49)).toEqual([16,16,17]);
  });

  it('also packs the tail of a measured stripe without altering the explicit allowance calculation',()=>{
    expect(ordinaryStripeRows(1600,900,1,.00005)).toBe(144);
    expect(ordinaryStripeRows(1600,153,1,.00005)).toBe(153);
    expect(ordinaryStripeRows(1600,160,1,.00005)).toBe(144);
    expect(ordinaryStripeRows(1600,900,1,.00005,8)).toBe(96);
    expect(ordinaryStripeRows(1600,111,1,.00005,8)).toBe(111);
    expect(ordinaryStripeRows(1600,112,1,.00005,8)).toBe(96);
  });

  it('preserves every anchor under changing local costs and never leaves an underfilled final stripe',()=>{
    for(const width of [17,1599,3200])for(const height of [19,901,1792])for(const stride of [1,2,8,16]){
      const minimum=Math.ceil(MIN_BATCH_SAMPLES/(Math.ceil(width/stride)*8))*8*stride;
      const origin=5*stride,anchors:number[]=[];
      const costs=[.05,.00001,.001,0,.02];
      let done=0,index=0;
      while(done<height){
        const before=height-done;
        const rows=ordinaryStripeRows(width,before,stride,costs[index++%costs.length]);
        expect(rows).toBeGreaterThan(0);
        expect(rows).toBeLessThanOrEqual(before);
        if(rows<before){
          expect(rows%(8*stride)).toBe(0);
          expect(before-rows).toBeGreaterThanOrEqual(minimum);
        }
        for(let y=0;y<rows;y+=stride)anchors.push(origin+done+y);
        done+=rows;
      }
      expect(done).toBe(height);
      expect(anchors).toEqual(Array.from({length:Math.ceil(height/stride)},(_,i)=>origin+i*stride));
    }
  });

  it('preserves anchor ownership and reuse phase at both workgroup heights and control extremes',()=>{
    for(const workgroupRows of [4,8])for(const minimumSamples of [1024,16384,1048576])
      for(const allowance of [1,12,250])for(const width of [1,97,1599,8192])
        for(const height of [19,129,901])for(const stride of [1,4,16]){
          const alignment=2*workgroupRows*stride,columns=Math.ceil(width/stride);
          const minimumRows=Math.ceil(minimumSamples/(columns*2*workgroupRows))*alignment;
          const origin=7,anchors:number[]=[],costs=[.5,.000001,.01,0,Infinity];
          let done=0,index=0;
          while(done<height){
            const remaining=height-done;
            const rows=ordinaryStripeRows(width,remaining,stride,costs[index++%costs.length],allowance,minimumSamples,workgroupRows);
            expect(done%alignment).toBe(0);
            expect(rows).toBeGreaterThan(0);expect(rows).toBeLessThanOrEqual(remaining);
            if(rows<remaining){
              expect(rows%alignment).toBe(0);
              expect(columns*Math.ceil(rows/stride)).toBeGreaterThanOrEqual(minimumSamples);
              expect(remaining-rows).toBeGreaterThanOrEqual(minimumRows);
            }
            for(let y=0;y<rows;y+=stride)anchors.push(origin+done+y);
            done+=rows;
          }
          expect(anchors).toEqual(Array.from({length:Math.ceil(height/stride)},(_,i)=>origin+i*stride));
        }
  });

  it('keeps 8x8 workgroup stripes on the full sixteen-sample-row reuse phase',()=>{
    const rows=ordinaryStripeRows(1600,900,1,.00005,12,16384,8);
    expect(rows).toBe(144);
    expect(rows%16).toBe(0);
    expect(ordinaryStripeRows(1600,159,1,.00005,12,16384,8)).toBe(159);
    expect(ordinaryStripeRows(1600,160,1,.00005,12,16384,8)).toBe(144);
    // With a larger occupancy floor, row alignment still governs the minimum.
    expect(ordinaryStripeRows(1600,900,1,.05,1,32768,8)).toBe(32);
  });
});
