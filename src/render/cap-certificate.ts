export interface CapCertificate {
  width: number;
  height: number;
  /** One zero/one unresolved flag per 8x8 tile, from the current GPU field. */
  unresolved: Uint32Array;
}

/** A tile proves all of its samples, never just its displayed colour. */
export function capRegionResolved(certificate:CapCertificate,
  region:{x:number;y:number;width:number;height:number}):boolean {
  const {x,y,width,height}=region;
  if(![x,y,width,height].every(Number.isSafeInteger)||x<0||y<0||width<1||height<1||
    x+width>certificate.width||y+height>certificate.height)return false;
  const columns=Math.ceil(certificate.width/8),rows=Math.ceil(certificate.height/8);
  if(certificate.unresolved.length!==columns*rows)return false;
  const right=Math.ceil((x+width)/8),bottom=Math.ceil((y+height)/8);
  for(let row=Math.floor(y/8);row<bottom;row++)
    for(let col=Math.floor(x/8);col<right;col++)
      if(certificate.unresolved[row*columns+col]!==0)return false;
  return true;
}
