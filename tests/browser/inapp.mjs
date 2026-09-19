// Browser-native runner for the same GPU checks, requiring no external browser.
import {presentationChecks} from './presentation.mjs';
import {streamingChecks} from './streaming.mjs';
import {retargetChecks} from './retarget.mjs';
import {proxyRetentionChecks} from './proxy-retention.mjs';
import {direct} from './direct.mjs';
import Decimal from '/node_modules/decimal.js/decimal.mjs';
import {acquireGpu} from '/src/gpu/device.ts';
import {WebGpuRenderer} from '/src/render/webgpu-renderer.ts';
import {DEFAULT_COLORS} from '/src/logic/colorSettings.ts';
import {HOME} from '/src/state.ts';
import {PLACES} from '/src/places.ts';
import {featureChecks} from './features.mjs';
const report={checks:[],numerical:[],errors:[]};
const status=document.querySelector('#status'),log=document.querySelector('#checks'),output=document.querySelector('#report');
function check(name,pass,detail){report.checks.push({name,pass,detail});log.textContent+=`${pass?'PASS':'FAIL'} ${name}\n`;output.value=JSON.stringify(report);}
const context={async newPage(){
  const iframe=document.createElement('iframe');document.querySelector('#fixture').append(iframe);let body='';
  return {async route(_,handler){await handler({fulfill:({body:b})=>{body=b;}});},async goto(){await new Promise(resolve=>{iframe.onload=resolve;iframe.srcdoc=`<base href="${location.origin}/">${body}`;});},
    async evaluate(fn,arg){iframe.contentWindow.__arg=arg;return iframe.contentWindow.eval(`(${fn.toString()})(__arg)`);},async close(){iframe.remove();}};
}};
document.querySelector('#run').onclick=async()=>{
  document.querySelector('#run').disabled=true;
  try{
    const featuresOnly=new URLSearchParams(location.search).get('suite')==='features';
    for(const [name,fn] of (featuresOnly?[]:[['presentation',presentationChecks],['streaming',streamingChecks],['retarget',retargetChecks],['proxy',proxyRetentionChecks]])){
      status.textContent=name;for(const c of await fn(context,location.origin))check(c.name,c.pass,c.detail);
    }
    status.textContent='Independent numerical oracles';
    const canvas=document.createElement('canvas');canvas.width=720;canvas.height=480;document.querySelector('#fixture').append(canvas);
    const gpu=await acquireGpu();report.adapter=gpu.capabilities;gpu.device.addEventListener('uncapturederror',e=>report.errors.push(e.error.message));
    const engine=new WebGpuRenderer(gpu,canvas);await engine.init();
    const actual={family:'mandelbrot',x:'-0.7306415249567179674564126808137349766637195178413058594098862566062443058950219458733751053543136202285',y:'0.1618038929239254474321368117854708727846076829629497296639618850035467323583391272471056909498211475756',span:'5.34547864799099529616966098711236667733050369615924011990458268501488728289618249845607183383544102148e-18',iterations:10000,jx:'-0.8',jy:'0.156'};
    const views=[...PLACES,{...HOME,family:'julia',x:'0'},{...HOME,family:'julia',x:'15',y:'15',span:'1e-30'},actual];
    let lastRequest;
    for(let index=0;index<(featuresOnly?0:views.length);index++){
      const v=views[index];status.textContent=`Oracle ${index+1}/8`;
      const req={centerX:new Decimal(v.x),centerY:new Decimal(v.y),unitsPerPixel:new Decimal(v.span).div(480),width:720,height:480,maxIterations:v.iterations,colors:{...DEFAULT_COLORS},family:v.family,juliaX:new Decimal(v.jx),juliaY:new Decimal(v.jy),followView:true};
      engine.invalidateHistory();engine.reproject(req);const stats=await engine.render(req);engine.reproject(req);lastRequest=req;
      const field=await engine.debugReadField(),points=[];
      if(index===7)for(const [x,y] of [[668,102],[668,171],[51,377]])for(const dx of [-1,0,1])for(const dy of [-1,0,1])if(dx||dy)points.push([x+dx,y+dy]);
      for(let j=0;j<7;j++)for(let i=0;i<7;i++)points.push([Math.floor((i+.5)*720/7),Math.floor((j+.5)*480/7)]);
      const rows=[];
      for(const [x,y] of points){const a=direct(v,x,y,720,480,512),b=direct(v,x,y,720,480,768);rows.push({x,y,oracle512:a,oracle768:b,gpu:field[2*(y*720+x)]});await new Promise(r=>setTimeout(r,0));}
      const mismatches=rows.filter(r=>r.oracle512!==r.oracle768||r.gpu!==r.oracle768);report.numerical.push({view:v,rows,stats,mismatches});check(`oracle ${index+1}`,!mismatches.length,{points:rows.length,mismatches});
    }
    if(lastRequest){const palette=await engine.render({...lastRequest,followView:false,colors:{...DEFAULT_COLORS,palette:5}});check('Palette edits reuse the field',!palette.computed&&palette.computedSamples===0,palette);}
    status.textContent='Appearance and high-cap shader checks';for(const c of await featureChecks(gpu,engine,Decimal,DEFAULT_COLORS))check(c.name,c.pass,c.detail);
    gpu.device.destroy();
    if(!featuresOnly){const {runSelfTest}=await import('/src/gpu/selftest.ts');await runSelfTest(c=>check(c.name,c.passed,c));}
    status.textContent=report.errors.length||report.checks.some(c=>!c.pass)?'FAILED':'PASSED';
  }catch(e){report.errors.push(String(e));status.textContent='FAILED';log.textContent+=String(e);}
  output.value=JSON.stringify(report);
};
