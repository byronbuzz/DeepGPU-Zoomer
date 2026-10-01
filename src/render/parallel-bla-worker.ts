/// <reference lib="webworker" />
import Decimal from 'decimal.js';
import {buildBla,type Step} from './parallel-bla';
const worker=self as DedicatedWorkerGlobalScope;
Decimal.set({precision:200});
worker.onmessage=({data:m})=>{
 try{
  if(m.kind==='join'){
   const blocks:Step[]=[];
   for(const buffer of m.buffers){const values=new Float64Array(buffer);
    for(let i=0;i<values.length;i+=20){let j=i;const coefficients:any={};
     for(const key of ['a','b','c','d','e'])coefficients[key]={x:values[j++],y:values[j++],e:values[j++]};
     blocks.push({...coefficients,radiusLog2:values[j++],errorEnvelope:Array.from(values.subarray(j,j+4))});
    }
   }
   const table=buildBla(new Float32Array(),0,new Decimal(m.radius),{epsilonLog2:m.epsilon,auditBlocks:blocks});
   worker.postMessage({id:m.id,table},[table.data.buffer]);
  }else{
   const orbit=new Float32Array(m.buffer);
   const table=buildBla(orbit,orbit.length/m.words,new Decimal(m.radius),{sampleWords:m.words,epsilonLog2:m.epsilon,maxLevels:1,keepDiagnosticSteps:true});
   const blocks=table.diagnosticSteps![0],values=new Float64Array(blocks.length*20);
   for(let i=0;i<blocks.length;i++){const s=blocks[i];let j=i*20;
    for(const key of ['a','b','c','d','e'] as const){const v=s[key]!;values[j++]=v.x;values[j++]=v.y;values[j++]=v.e;}
    values[j++]=s.radiusLog2;for(const v of s.errorEnvelope!)values[j++]=v;
   }
   worker.postMessage({id:m.id,buffer:values.buffer},[values.buffer]);
  }
 }catch(e){worker.postMessage({id:m.id,error:String(e)});}
};
