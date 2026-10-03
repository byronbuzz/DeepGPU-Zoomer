/** Display-size estimate; browser zoom can affect the reported pixel ratio. */
export function displayPixels(screen:Pick<Screen,'width'|'height'>=window.screen,ratio=window.devicePixelRatio) {
  const {width,height}=screen;
  if(![width,height,ratio].every(n=>Number.isFinite(n)&&n>0))return null;
  const w=Math.round(width*ratio),h=Math.round(height*ratio);
  return Number.isSafeInteger(w)&&Number.isSafeInteger(h)&&w>0&&h>0?{width:w,height:h}:null;
}
