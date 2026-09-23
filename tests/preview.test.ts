import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import Decimal from 'decimal.js';
import {expect,it} from 'vitest';
import {DEFAULT_COLORS,needsEndpoints,renderColors} from '../src/logic/colorSettings';
const source=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
const fn=source.slice(source.indexOf('async function computeJuliaPreview()'),source.indexOf('\nfunction switchJuliaView()'));
const js=ts.transpileModule(fn,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
for(const outcome of ['success','error','resize','close-reopen'])it(`only the latest preview settles display and busy state after stale ${outcome}`,async()=>{
  const elements=new Map<string,any>();const published:any[]=[];
  let finish!:(v:any)=>void,fail!:(e:any)=>void;
  const box:any={Decimal,needsEndpoints,renderColors,stopped:false,previewBusy:false,previewPending:true,previewEnabled:true,selectedJulia:{x:'0',y:'0'},gpuContext:{},previewEpoch:1,previewLifetime:0,
    previewSize:{width:240,height:160},view:{family:'mandelbrot'},colors:DEFAULT_COLORS,previewCanvas:{width:240,height:160},previewRenderedEpoch:0,displayedJulia:{x:'-1',y:'0'},
    el(id:string){if(!elements.has(id))elements.set(id,{textContent:'previous',attrs:{'aria-busy':'true'},setAttribute(k:string,v:string){this.attrs[k]=v;}});return elements.get(id);},
    previewEngine:{render(req:any){box.req=req;return new Promise((resolve,reject)=>{finish=resolve;fail=reject;});},reproject(req:any){published.push(req);}}};
  vm.createContext(box);vm.runInContext(js,box);
  const pending=vm.runInContext('computeJuliaPreview()',box);
  box.previewEpoch++;box.previewPending=true;box.selectedJulia={x:'-.5',y:'.1'};
  if(outcome==='resize')box.previewSize={width:320,height:200};
  if(outcome==='close-reopen')box.previewLifetime++;
  expect(box.req.isCurrent()).toBe(false);
  if(outcome==='error')fail(Error('old failure'));else finish({completed:true});
  await pending;
  expect(published).toHaveLength(0);expect(box.displayedJulia).toEqual({x:'-1',y:'0'});
  expect(box.previewCanvas).toEqual({width:240,height:160});expect(box.previewBusy).toBe(false);expect(box.previewPending).toBe(true);
  expect(box.el('julia-preview').attrs['aria-busy']).toBe('true');
  const latest=vm.runInContext('computeJuliaPreview()',box);expect(box.req.isCurrent()).toBe(true);finish({completed:true});await latest;
  expect(published).toHaveLength(1);expect(box.displayedJulia).toEqual(box.selectedJulia);expect(box.previewRenderedEpoch).toBe(2);
  expect(box.el('julia-preview').attrs['aria-busy']).toBe('false');
});
