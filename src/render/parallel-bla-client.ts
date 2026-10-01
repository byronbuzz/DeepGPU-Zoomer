import type Decimal from 'decimal.js';
import type {BlaTable,BuildOptions} from './parallel-bla';
let workers:Worker[]=[];let nextId=0;let active=false;let generation=0;
const pending=new Map<number,{resolve:(v:any)=>void,reject:(e:unknown)=>void}>();
export function disposeBlaWorkers(error:unknown=new DOMException('Preparation cancelled','AbortError')){
 for(const w of workers)w.terminate();workers=[];
 for(const job of pending.values())job.reject(error);pending.clear();
}
function ensure(){if(workers.length)return;workers=Array.from({length:4},()=>{
 const w=new Worker(new URL('./parallel-bla-worker.ts',import.meta.url),{type:'module'});
 w.onmessage=({data})=>{const job=pending.get(data.id);if(!job)return;pending.delete(data.id);data.error?job.reject(Error(data.error)):job.resolve(data);};
 w.onerror=e=>{e.preventDefault();disposeBlaWorkers(Error(e.message));};
 w.onmessageerror=()=>disposeBlaWorkers(Error('Invalid preparation worker response'));
 return w;
});}
function send(w:Worker,payload:object,transfer:Transferable[]){return new Promise<any>((resolve,reject)=>{
 const id=++nextId;pending.set(id,{resolve,reject});try{w.postMessage({...payload,id},transfer);}catch(e){pending.delete(id);reject(e);}
});}
export async function parallelBla(orbit:Float32Array,length:number,radius:number|Decimal,checkpoint:()=>Promise<void>,options:BuildOptions={}):Promise<BlaTable>{
 if(active)throw Error('Parallel preparation already active');active=true;const token=++generation;
 let timer:ReturnType<typeof setInterval>|undefined;let checking=false;
 try{
  await checkpoint();ensure();
  timer=setInterval(()=>{if(checking)return;checking=true;void checkpoint().catch(e=>{if(token===generation)disposeBlaWorkers(e);}).finally(()=>{checking=false;});},20);
  const count=Math.floor(Math.max(0,length-2)/4),words=options.sampleWords??6;
  const common={radius:radius.toString(),epsilon:options.epsilonLog2??-29};
  const results=await Promise.all(workers.map((w,i)=>{
   const from=Math.floor(count*i/4),to=Math.floor(count*(i+1)/4);
   const buffer=orbit.slice(from*4*words,(to*4+2)*words).buffer;
   return send(w,{...common,kind:'blocks',buffer,words},[buffer]);
  }));
  const buffers=results.map(r=>r.buffer as ArrayBuffer);
  const result=await send(workers[0],{...common,kind:'join',buffers},buffers);
  clearInterval(timer);await checkpoint();return result.table;
 }catch(e){disposeBlaWorkers(e);throw e;}
 finally{if(timer)clearInterval(timer);generation++;active=false;}
}
