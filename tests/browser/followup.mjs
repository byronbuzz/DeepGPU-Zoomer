import {chromium} from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const base=process.env.GPU_ZOOMER_URL||'http://127.0.0.1:5183';
const output=process.env.GPU_ZOOMER_TEST_DIR||'F:/Coding/Temp/GPU-Zoomer-3-ui-followup';
fs.mkdirSync(output,{recursive:true});
const context=await chromium.launchPersistentContext(path.join(output,'edge-profile'),{channel:'msedge',headless:true,chromiumSandbox:true,ignoreDefaultArgs:['--enable-unsafe-swiftshader'],viewport:{width:960,height:720}});
const page=await context.newPage(),checks=[],errors=[];
page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('404'))errors.push(m.text());});
const check=(name,pass,detail)=>{checks.push({name,pass,detail});console.log(`${pass?'PASS':'FAIL'} ${name}${detail?` ${JSON.stringify(detail)}`:''}`);};
const app=(fn,arg)=>page.evaluate(fn,arg);
const status=()=>app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);return a.testing.status();});
const snapshot=()=>app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);return a.testing.snapshot();});
const canvasFocus=()=>page.locator('#fractal').evaluate(node=>({focused:document.activeElement===node,focusVisible:node.matches(':focus-visible'),outlineStyle:getComputedStyle(node).outlineStyle,outlineWidth:getComputedStyle(node).outlineWidth,outlineColor:getComputedStyle(node).outlineColor}));
const settle=async()=>{const started=Date.now();for(;;){const s=await status();if(s.error)throw Error(s.error);if(!s.busy&&!s.dirty&&s.quality===1&&s.progress?.complete)return s;if(Date.now()-started>120000)throw Error('settle timeout');await page.waitForTimeout(50);}};

try{
  await page.goto(base);await app(()=>localStorage.clear());await page.goto(base);await page.waitForFunction(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);await a.ready;return !!a.testing?.engine;});await settle();
  const initialFocus=await canvasFocus();check('initial canvas has no viewport outline',initialFocus.outlineStyle==='none',initialFocus);
  const pointerSpan=(await snapshot()).span;await page.mouse.move(300,300);await page.mouse.down();await page.waitForTimeout(120);const pointerDuring=await canvasFocus();await page.mouse.up();await settle();const pointerAfter=await canvasFocus();
  check('pointer zoom focuses the canvas without a viewport outline',(await snapshot()).span!==pointerSpan&&pointerDuring.focused&&pointerDuring.outlineStyle==='none'&&pointerAfter.outlineStyle==='none',{pointerDuring,pointerAfter});
  await page.screenshot({path:path.join(output,'canvas-pointer-zoom.png')});
  await page.locator('#reset').click();await settle();const homeFocus=await canvasFocus();check('Home leaves no canvas viewport outline',homeFocus.outlineStyle==='none',homeFocus);
  const keyboardSpan=(await snapshot()).span;await page.locator('#fractal').focus();await page.keyboard.down('+');await page.waitForTimeout(120);const keyboardDuring=await canvasFocus();await page.keyboard.up('+');await settle();
  check('keyboard zoom works without a canvas viewport outline',(await snapshot()).span!==keyboardSpan&&keyboardDuring.focused&&keyboardDuring.outlineStyle==='none',{keyboardDuring});
  await page.screenshot({path:path.join(output,'canvas-keyboard-zoom.png')});
  await page.locator('#reset').click();await settle();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');const buttonFocus=await page.locator('#reset').evaluate(node=>({active:document.activeElement===node,focusVisible:node.matches(':focus-visible'),outlineStyle:getComputedStyle(node).outlineStyle,outlineWidth:getComputedStyle(node).outlineWidth}));await page.keyboard.press('Tab');await page.keyboard.press('Tab');const inputFocus=await page.locator('#location-name').evaluate(node=>({active:document.activeElement===node,focusVisible:node.matches(':focus-visible'),outlineStyle:getComputedStyle(node).outlineStyle,outlineWidth:getComputedStyle(node).outlineWidth}));
  check('button and input keyboard focus indicators remain visible',buttonFocus.active&&buttonFocus.focusVisible&&buttonFocus.outlineStyle!=='none'&&buttonFocus.outlineWidth!=='0px'&&inputFocus.active&&inputFocus.focusVisible&&inputFocus.outlineStyle!=='none'&&inputFocus.outlineWidth!=='0px',{buttonFocus,inputFocus});
  const save=async name=>{await page.locator('#location-name').fill(name);await page.locator('#save').click();};
  await save('First timer');await page.waitForTimeout(1800);await save('Fresh timer');await page.waitForTimeout(1500);
  check('successive saves replace the old dismissal timer',await page.locator('#message').innerText()==='Location saved on this browser.');
  await page.waitForTimeout(1900);check('save success fades and clears after a few seconds',await page.locator('#message').innerText()==='');

  await save('Before error');await page.waitForTimeout(500);await app(()=>{const input=document.querySelector('#cx');input.value='not-a-coordinate';document.querySelector('#coordinates').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
  const persistentError=await page.locator('#message').innerText();await page.waitForTimeout(3000);
  check('an intervening error is not dismissed by the old save timer',persistentError.length>0&&await page.locator('#message').innerText()===persistentError,{persistentError});
  await app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);a.testing.load(a.testing.snapshot());});await settle();

  await page.emulateMedia({reducedMotion:'reduce'});const reducedTransition=await page.locator('#message').evaluate(node=>{node.classList.add('message-fading');const value=getComputedStyle(node).transitionDuration;node.classList.remove('message-fading');return value;});
  await save('Reduced motion');await page.waitForTimeout(3150);
  check('reduced motion removes the fade but still dismisses success',reducedTransition==='0s'&&await page.locator('#message').innerText()==='',{reducedTransition});

  await page.emulateMedia({reducedMotion:'no-preference'});await page.locator('#tab-colouring').click();const before=await status();
  await page.locator('#cycle').evaluate(input=>{input.value='1';input.dispatchEvent(new Event('input',{bubbles:true}));});const after=await settle(),appearance=(await snapshot()).appearance;
  check('colour spacing reaches 4096 and recolours without numerical calculation',appearance.cycle===4096&&await page.locator('#cycle-value').innerText()==='4096'&&after.fields===before.fields&&after.recolours>before.recolours,{cycle:appearance.cycle,beforeFields:before.fields,afterFields:after.fields,beforeRecolours:before.recolours,afterRecolours:after.recolours});
  await page.screenshot({path:path.join(output,'followup.png')});await page.locator('#tab-main').click();await save('4096 spacing');const savedCycle=await app(()=>JSON.parse(localStorage.getItem('gpu-zoomer-locations')).at(-1).view.appearance.cycle);
  check('saved locations retain colour spacing 4096',savedCycle===4096,{savedCycle});
  const sharedCycle=await app(async()=>{const a=await import(document.querySelector('script[type="module"][src*="/src/main.ts"]').src);const {encodeView,decodeView}=await import('/src/state.ts');return decodeView(encodeView(a.testing.snapshot())).appearance.cycle;});
  check('exact share payload retains colour spacing 4096',sharedCycle===4096,{sharedCycle});
  await page.locator('#tab-colouring').click();await page.locator('#open-palette').click();await page.locator('#palette').selectOption('2');await page.locator('#close-palette').click();await settle();await page.locator('#tab-main').click();await page.locator('#locations').selectOption('place:0');await settle();await page.locator('#location-name').fill('Legacy path');
  check('legacy palette workflow returns to visible Main controls',await page.locator('#panel-main').isVisible()&&await page.locator('#locations').inputValue()==='place:0'&&await page.locator('#location-name').inputValue()==='Legacy path');
}catch(error){errors.push(String(error));console.error(error);}finally{
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,browser:context.browser()?.version()},null,2));await context.close();if(errors.length||checks.some(c=>!c.pass))process.exitCode=1;
}
