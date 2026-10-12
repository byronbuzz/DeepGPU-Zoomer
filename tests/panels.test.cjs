const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),ts=require(path.join(root,'node_modules/typescript'));
function panels(saved) {
  const elements=new Map(),windowEvents={},properties={};
  const element=id=>({id,hidden:false,style:{setProperty(){}},attributes:{},events:{},value:'',scrollTop:0,
    addEventListener(name,fn){this.events[name]=fn;},setAttribute(name,value){this.attributes[name]=value;},getAttribute(name){return this.attributes[name];},
    getBoundingClientRect:()=>({x:8,y:8,left:8,top:8,right:328,bottom:608,width:320,height:600}),
    focus(){document.activeElement=this;},select(){},contains:()=>false,setPointerCapture(){},hasPointerCapture:()=>false,
    querySelector:()=>null,querySelectorAll:()=>[],classList:{contains:()=>false},
  });
  const el=id=>{if(!elements.has(id))elements.set(id,element(id));return elements.get(id);};
  const controls=el('controls'),scroll=el('controls-scroll'),tabs=['tab-main','tab-colouring','tab-advanced'].map(el);
  controls.querySelector=selector=>selector==='.controls-scroll'?scroll:null;
  tabs.forEach((tab,index)=>tab.attributes['aria-controls']=['main-content','colouring-content','advanced-content'][index]);
  const classes=new Set(),body={classList:{contains:name=>classes.has(name),remove:name=>classes.delete(name),
    toggle(name,enabled){if(enabled??!classes.has(name))classes.add(name);else classes.delete(name);return classes.has(name);}}};
  const document={getElementById:el,addEventListener(){},activeElement:null,body,
    documentElement:{style:{setProperty:(name,value)=>properties[name]=value}},
    querySelectorAll:selector=>selector==='[data-panel]'?[controls]:selector==='[role=tab]'?tabs:[]};
  const exports={};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,'src/panels.ts'),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText,{exports,document,window:{addEventListener:(name,fn)=>windowEvents[name]=fn},innerWidth:1280,innerHeight:720,
    localStorage:{getItem:()=>JSON.stringify(saved??{}),setItem(){}},ResizeObserver:class{observe(){}},getComputedStyle:()=>({resize:'none'}),
    require:name=>{assert.equal(name,'./colour-picker');return {setupColourPicker:()=>({sync(){}})};}});
  const controller=exports.setupPanels();
  return {el,tabs,scroll,properties,controller,windowEvents,document};
}
test('device-local saved opacity survives setup while Full Reset uses the brighter factory opacity',()=>{
  const restored=panels({opacity:.6});
  assert.equal(restored.properties['--panel-opacity'],'0.6');assert.equal(restored.controller.snapshot().opacity,.6);
  restored.controller.reset();assert.equal(restored.properties['--panel-opacity'],'0.7');assert.equal(restored.controller.snapshot().opacity,.7);
  assert.equal(panels().controller.snapshot().opacity,.7);
});
test('mouse, keyboard and repeated tab activation reset scroll after changing selected content; dragging a tab does not',()=>{
  const ui=panels(),[main,colouring,advanced]=ui.tabs;
  ui.scroll.scrollTop=400;colouring.onclick({detail:1});
  assert.equal(ui.scroll.scrollTop,0);assert.equal(ui.el('colouring-content').hidden,false);assert.equal(ui.el('main-content').hidden,true);
  ui.scroll.scrollTop=250;colouring.onclick({detail:1});assert.equal(ui.scroll.scrollTop,0);
  let prevented=false;ui.scroll.scrollTop=320;colouring.onkeydown({key:'ArrowRight',preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.equal(ui.scroll.scrollTop,0);assert.equal(ui.document.activeElement,advanced);assert.equal(ui.el('advanced-content').hidden,false);
  ui.scroll.scrollTop=180;advanced.onkeydown({key:'Home',preventDefault(){}});assert.equal(ui.scroll.scrollTop,0);assert.equal(main.attributes['aria-selected'],'true');
  const target={closest:selector=>selector==='[role=tab]'?colouring:selector==='[data-panel]'?ui.el('controls'):null,
    getBoundingClientRect:()=>({left:8,top:8}),scrollHeight:0,clientHeight:0,scrollWidth:0,clientWidth:0};
  ui.el('controls').events.pointerdown({target,button:0,clientX:100,clientY:100,pointerId:1});
  ui.windowEvents.pointermove({clientX:120,clientY:100,pointerId:1,preventDefault(){}});
  ui.windowEvents.pointerup({pointerId:1});ui.scroll.scrollTop=220;colouring.onclick({detail:1});
  assert.equal(main.attributes['aria-selected'],'true');assert.equal(ui.scroll.scrollTop,220);
  colouring.onclick({detail:1});assert.equal(colouring.attributes['aria-selected'],'true');assert.equal(ui.scroll.scrollTop,0);
});
