import {expect,it} from 'vitest';
import {backingSize,checkedGpu,validateRenderSize} from '../../src/gpu/device';
const limits={maxTextureDimension2D:8192,maxBufferSize:1024*1024,maxStorageBufferBindingSize:2*1024*1024};
it('checks actual texture and both buffer limits, including grid-one fields',()=>{
  expect(()=>validateRenderSize(limits,8192,1)).not.toThrow();
  for(const [w,h] of [[8193,1],[512,512],[0,1],[1.5,1],[NaN,1]])expect(()=>validateRenderSize(limits,w,h)).toThrow();
  expect(()=>validateRenderSize(limits,256,512,8)).not.toThrow();
  expect(()=>validateRenderSize(limits,256,512,16)).toThrow();
  const size=backingSize(2000,1000,2,limits,16);
  expect(()=>validateRenderSize(limits,size.width,size.height,16)).not.toThrow();
  expect(Math.abs(size.width/size.height-2)).toBeLessThan(.02);
  const small={maxTextureDimension2D:8,maxBufferSize:256,maxStorageBufferBindingSize:256};
  const rounded=backingSize(5,5,1.1,small);
  expect(()=>validateRenderSize(small,rounded.width,rounded.height)).not.toThrow();
});
it('pops scopes before asynchronous work yields and surfaces validation failures',async()=>{
  const stack:string[]=[];let finish!:(n:number)=>void;
  const device={pushErrorScope:(s:string)=>stack.push(s),popErrorScope:()=>{stack.pop();return Promise.resolve(null);}} as unknown as GPUDevice;
  const pending=checkedGpu(device,()=>new Promise<number>(r=>finish=r));
  expect(stack).toEqual([]);finish(7);expect(await pending).toBe(7);
  device.popErrorScope=()=>{stack.pop();return Promise.resolve({message:'allocation failed'} as GPUError);};
  await expect(checkedGpu(device,()=>9)).rejects.toThrow('allocation failed');
  await expect(checkedGpu(device,()=>{throw Error('sync failure');})).rejects.toThrow('sync failure');
  expect(stack).toEqual([]);
});
