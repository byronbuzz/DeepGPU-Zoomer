import type {BuildOptions} from '../src/render/bla';

export const cases:{name:string;length:number;words:6|10|20;radius:string;options:BuildOptions}[]=[
  {name:'empty-full',length:0,words:6,radius:'0',options:{}},
  {name:'two-samples-omitted',length:2,words:10,radius:'1e-8',options:{omitSingleStep:true}},
  {name:'single-step-full',length:3,words:20,radius:'0',options:{}},
  {name:'odd-short-full',length:17,words:6,radius:'1e-8',options:{}},
  {name:'base-only-omitted',length:257,words:10,radius:'1e-90',options:{maxLevels:1,omitSingleStep:true}},
  {name:'zero-max-levels',length:257,words:20,radius:'1e-8',options:{maxLevels:0}},
  {name:'three-levels',length:257,words:10,radius:'0',options:{maxLevels:3,epsilonLog2:-40}},
  {name:'tail-reduced',length:4099,words:6,radius:'1e-90',options:{omitSingleStep:true}},
  {name:'tail-compact',length:4099,words:10,radius:'1e-8',options:{}},
  {name:'tail-paired',length:4099,words:20,radius:'1.23e-1000',options:{omitSingleStep:true}},
  {name:'larger-compact',length:8195,words:10,radius:'0',options:{omitSingleStep:true}},
  {name:'larger-julia-stride',length:8195,words:20,radius:'1e-90',options:{maxLevels:12,epsilonLog2:-40}},
];

/** Integer-generated binary inputs avoid dependence on transcendental fixtures. */
export function syntheticOrbit(length:number,words:6|10|20):Float32Array{
  const result=new Float32Array(length*words);let seed=0x27182818;
  const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)|0;return (seed>>>0)/2**31-1;};
  for(let i=0;i<length;i++){
    if(i%19===0)continue;
    const at=i*words;
    if(words===6){
      result[at]=next();result[at+1]=next()*2**-25;result[at+2]=(i%17)-8;
      result[at+3]=next();result[at+4]=next()*2**-25;result[at+5]=(i%11)-5;
    }else{
      for(let part=0;part<4;part++)result[at+part]=next()*2**(-24*part);
      result[at+4]=(i%17)-8;
      for(let part=0;part<4;part++)result[at+5+part]=next()*2**(-24*part);
      result[at+9]=(i%11)-5;
      if(words===20)for(let part=10;part<20;part++)result[at+part]=i+part;
    }
  }
  return result;
}
