// Independently structured direct evaluator: fused BigInt products, no orbit
// transport, perturbation, rebasing, BLA, or production arithmetic imports.
export function parseFixed(text,bits){
  const [body,exp='0']=text.toLowerCase().split('e');
  const negative=body.startsWith('-');const [whole,fraction='']=body.replace(/^[-+]/,'').split('.');
  let n=BigInt(whole+fraction),d=1n,k=Number(exp)-fraction.length;
  if(k>=0)n*=10n**BigInt(k);else d=10n**BigInt(-k);
  return (negative?-n:n)*(1n<<BigInt(bits))/d;
}
export function direct(view,x,y,width,height,bits){
  const S=1n<<BigInt(bits),span=parseFixed(view.span,bits);
  const px=parseFixed(view.x,bits)+span*BigInt(2*x+1-width)/BigInt(2*height);
  const py=parseFixed(view.y,bits)+span*BigInt(height-2*y-1)/BigInt(2*height);
  const julia=view.family==='julia';
  const cx=julia?parseFixed(view.jx,bits):px,cy=julia?parseFixed(view.jy,bits):py;
  let zx=julia?px:0n,zy=julia?py:0n;
  if(zx*zx+zy*zy>256n*S*S)return 0;
  for(let n=1;n<=view.iterations;n++){
    const xx=zx*zx,yy=zy*zy,xy=zx*zy;
    zx=(xx-yy)/S+cx;zy=2n*xy/S+cy;
    if(zx*zx+zy*zy>256n*S*S)return n;
  }
  return -1;
}
