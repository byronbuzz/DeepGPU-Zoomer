import {describe,it,expect,vi} from 'vitest';
import {DisplayDimensions,displayPixels,type DetailedScreen,type ScreenDetails} from '../../src/export/display';
function screen(width:number,height:number,devicePixelRatio:number){return Object.assign(new EventTarget(),{width,height,devicePixelRatio}) as DetailedScreen;}
describe('display export dimensions',()=>{
  it('uses containing-screen density without window zoom or combined bounds',()=>{
    expect(displayPixels(screen(2560,1440,1.5))).toEqual({width:3840,height:2160});
    expect(displayPixels(screen(0,1440,2))).toBeNull();expect(displayPixels(screen(1920,1080,NaN))).toBeNull();
  });
  it('requests once on choice, follows containing-screen/density changes, and fails closed on revocation',async()=>{
    const first=screen(1920,1080,1),second=screen(2560,1440,1.5);
    const details=Object.assign(new EventTarget(),{currentScreen:first,screens:[first,second]}) as ScreenDetails;
    const permission=Object.assign(new EventTarget(),{state:'granted'}) as unknown as PermissionStatus;
    const get=vi.fn(async()=>details),changed=vi.fn();const controller=new DisplayDimensions(changed,get,async()=>permission);
    expect(get).not.toHaveBeenCalled();expect(controller.pixels()).toBeNull();
    await controller.choose();await controller.choose();expect(get).toHaveBeenCalledOnce();
    details.currentScreen=second;details.dispatchEvent(new Event('currentscreenchange'));
    expect(controller.pixels()).toEqual({width:3840,height:2160});
    second.devicePixelRatio=2;second.dispatchEvent(new Event('change'));expect(controller.pixels()).toEqual({width:5120,height:2880});
    Object.assign(permission,{state:'denied'});permission.dispatchEvent(new Event('change'));expect(controller.pixels()).toBeNull();
    await controller.choose();expect(get).toHaveBeenCalledOnce();controller.dispose();
  });
  it('does not prompt again after denial, and Custom callers need no detection',async()=>{
    const get=vi.fn(async()=>{throw Error('denied');});const controller=new DisplayDimensions(()=>{},get,async()=>{throw Error('unavailable');});
    await controller.choose();await controller.choose();expect(get).toHaveBeenCalledOnce();expect(controller.pixels()).toBeNull();controller.dispose();
  });
});
