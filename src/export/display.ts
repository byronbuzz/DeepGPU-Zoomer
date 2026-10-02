/** Window Management is requested only by an explicit display-preset choice. */
export interface DetailedScreen extends EventTarget { width:number; height:number; devicePixelRatio:number }
export interface ScreenDetails extends EventTarget { currentScreen:DetailedScreen; screens:DetailedScreen[] }
export function displayPixels(screen:Pick<DetailedScreen,'width'|'height'|'devicePixelRatio'>) {
  const {width,height,devicePixelRatio:ratio}=screen;
  if(![width,height,ratio].every(n=>Number.isFinite(n)&&n>0))return null;
  const w=Math.round(width*ratio),h=Math.round(height*ratio);
  return Number.isSafeInteger(w)&&Number.isSafeInteger(h)&&w>0&&h>0?{width:w,height:h}:null;
}

export class DisplayDimensions {
  private attempted=false;
  private details:ScreenDetails|null=null;
  private watched:DetailedScreen|null=null;
  private permission:PermissionStatus|null=null;
  private denied=false;
  reason='permission/detection needed';
  constructor(private readonly changed:()=>void,
    private readonly getDetails:(()=>Promise<ScreenDetails>)|undefined=(window as Window&{getScreenDetails?:()=>Promise<ScreenDetails>}).getScreenDetails?.bind(window),
    private readonly queryPermission:()=>Promise<PermissionStatus>=()=>navigator.permissions.query({name:'window-management' as PermissionName})) {}
  private refresh=()=>{
    const next=this.details?.currentScreen??null;
    if(this.watched!==next){this.watched?.removeEventListener('change',this.refresh);this.watched=next;next?.addEventListener('change',this.refresh);}
    this.changed();
  };
  private permissionChanged=()=>{
    if(this.permission?.state!=='granted'){
      this.denied=true;this.reason='permission/detection needed';this.detach();this.changed();
    }
  };
  private detach(){
    this.details?.removeEventListener('currentscreenchange',this.refresh);
    this.details?.removeEventListener('screenschange',this.refresh);
    this.watched?.removeEventListener('change',this.refresh);this.watched=null;this.details=null;
  }
  pixels(){
    if(this.denied||!this.details||!this.details.screens.includes(this.details.currentScreen))return null;
    return displayPixels(this.details.currentScreen);
  }
  async choose(){
    if(this.attempted)return;
    this.attempted=true;
    if(!this.getDetails){this.reason='detection unavailable; use Custom';this.changed();return;}
    this.reason='permission/detection pending';this.changed();
    try{
      const details=await this.getDetails();
      this.details=details;details.addEventListener('currentscreenchange',this.refresh);details.addEventListener('screenschange',this.refresh);
      // Querying an existing permission never requests it. Listen for revocation.
      try{this.permission=await this.queryPermission();this.permission.addEventListener('change',this.permissionChanged);if(this.permission.state!=='granted')this.permissionChanged();}catch{/* Some implementations expose details but not the permission descriptor. */}
      this.reason='permission/detection needed';this.refresh();
    }catch{this.denied=true;this.reason='permission/detection needed; use Custom';this.detach();this.changed();}
  }
}
