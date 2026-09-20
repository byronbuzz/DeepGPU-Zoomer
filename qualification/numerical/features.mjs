export async function featureChecks(gpu,engine,Decimal,defaults){
  const checks=[],add=(name,pass,detail)=>checks.push({name,pass,detail});
  const req={centerX:new Decimal('-.6'),centerY:new Decimal(0),unitsPerPixel:new Decimal('2.8').div(128),width:192,height:128,maxIterations:1000,colors:{...defaults},family:'mandelbrot',juliaX:new Decimal('-.8'),juliaY:new Decimal('.156')};
  engine.invalidateHistory();let stats=await engine.render(req);let field=await engine.debugReadField();
  const {readBuffer}=await import('/src/gpu/device.ts');
  add('sample counters agree with a fresh exact field',stats.computedSamples===192*128&&stats.cappedRatio<=1,{stats,raw:Array.from(new Uint32Array(await readBuffer(gpu.device,engine.statsBuffer,48)))});
  const points=Array.from({length:192*128},(_,i)=>[i%192,Math.floor(i/192)]);
  const fingerprints=[],formulaFingerprints=[];
  for(let formula=0;formula<15;formula++){
    const result=await engine.render({...req,colors:{...defaults,formula}});
    const current=await engine.debugReadField();add(`formula ${formula} preserves escape counts`,current.every((v,i)=>i%2!==0||v===field[i]));
    const formulaPixels=await engine.debugReadPixels(points);let formulaHash=2166136261;for(const p of formulaPixels)for(const b of p.slice(0,3))formulaHash=Math.imul(formulaHash^b,16777619)>>>0;formulaFingerprints.push(formulaHash);
    const recolour=await engine.render({...req,colors:{...defaults,formula,palette:5,offset:.13}});
    add(`formula ${formula} palette edits reuse scalars`,!recolour.computed&&recolour.computedSamples===0);
  }
  add('all formula shader outputs are distinct',new Set(formulaFingerprints).size===15&&formulaFingerprints[0]!==formulaFingerprints[1],{formulaFingerprints});
  for(let effect=0;effect<=10;effect++){
    await engine.render({...req,colors:{...defaults,effect}});
    const pixels=await engine.debugReadPixels(points);let hash=2166136261;for(const p of pixels)for(const b of p.slice(0,3))hash=Math.imul(hash^b,16777619)>>>0;fingerprints.push(hash);
  }
  add('ten styles produce distinct real shader output',new Set(fingerprints).size===11,{fingerprints});
  const defaultAgain=await engine.render(req);
  const moved=await engine.render({...req,centerX:req.centerX.plus(req.unitsPerPixel)});
  add('leaving endpoint modes restores scalar remap on movement',!defaultAgain.computed&&moved.reusedSamples>0,{reused:moved.reusedSamples});
  await engine.render({...req,colors:{...defaults,formula:2}});
  for(const capped of [1,2]){const result=await engine.render({...req,colors:{...defaults,capped}});add(`capped pattern ${capped} reuses available channels`,!result.computed);}
  engine.invalidateHistory();let partialDistance=false;
  const distance={...req,colors:{...defaults,mode:1},tileRows:8,betweenBatches:async()=>{
    const f=await engine.debugReadField();partialDistance ||= f.some((v,i)=>i%2===1&&v<0)&&f.some((v,i)=>i%2===1&&v>=0);
  }};
  await engine.render(distance);const progressiveDistance=await engine.debugReadPixels(points);
  engine.invalidateHistory();await engine.render({...distance,publishPartial:false,betweenBatches:undefined});
  const coherentDistance=await engine.debugReadPixels(points);
  add('distance refinement keeps unknowns and finishes with coherent neighbours',partialDistance&&progressiveDistance.every((p,i)=>p.every((v,j)=>v===coherentDistance[i][j])));
  const {PLACES}=await import('/src/places.ts'),deepPlace=PLACES[2];
  const deep={...req,width:32,height:24,centerX:new Decimal(deepPlace.x),centerY:new Decimal(deepPlace.y),unitsPerPixel:new Decimal(deepPlace.span).div(24),maxIterations:deepPlace.iterations};
  engine.invalidateHistory();const omitted=await engine.render(deep),beforeTable=engine.laLevels;
  const opted=await engine.render({...deep,useApprox:true}),residentTable=engine.laBuffer,residentLevels=engine.laLevels;
  const optedRecolour=await engine.render({...deep,useApprox:true,colors:{...deep.colors,offset:.13}});
  const disabled=await engine.render({...deep,useApprox:false});
  const disabledRecolour=await engine.render({...deep,useApprox:false,colors:{...deep.colors,offset:.17}});
  const reopted=await engine.render({...deep,useApprox:true});
  const contained=await engine.render(deep),residentAfterContainment=engine.laBuffer;
  const containedRecolour=await engine.render({...deep,colors:{...deep.colors,offset:.21}});
  let batches=0;const interrupted=await engine.render({...deep,useApprox:true,centerX:deep.centerX.plus(deep.unitsPerPixel),tileRows:1,betweenBatches:async()=>{if(++batches===1)engine.abort();}});
  const recovered=await engine.render({...deep,centerX:deep.centerX.plus(deep.unitsPerPixel)});
  add('BLA requires explicit development opt-in across resident-table and field transitions',
    omitted.completed&&omitted.skippedIterations===0&&beforeTable===0&&omitted.tableMs===0&&
    opted.completed&&opted.skippedIterations>0&&opted.tableMs>0&&residentLevels>0&&
    !optedRecolour.computed&&optedRecolour.computedSamples===0&&
    disabled.completed&&disabled.computed&&disabled.skippedIterations===0&&disabled.tableMs===0&&
    !disabledRecolour.computed&&disabledRecolour.computedSamples===0&&
    reopted.completed&&reopted.computed&&reopted.skippedIterations>0&&
    contained.completed&&contained.computed&&contained.skippedIterations===0&&contained.tableMs===0&&residentAfterContainment===residentTable&&
    !containedRecolour.computed&&containedRecolour.computedSamples===0&&
    !interrupted.completed&&batches===1&&recovered.completed&&recovered.skippedIterations===0,
    {omitted,beforeTable,opted,residentLevels,optedRecolour,disabled,disabledRecolour,reopted,contained,containedRecolour,
      interrupted,batches,recovered,tableRetained:residentAfterContainment===residentTable});
  // Seed a low counter close to its boundary; real subsequent dispatches carry.
  engine.invalidateHistory();let seeded=false;
  const carry=await engine.render({...req,width:64,height:16,centerX:new Decimal(0),unitsPerPixel:new Decimal('.001'),tileRows:8,betweenBatches:async()=>{
    if(!seeded){seeded=true;gpu.device.queue.writeBuffer(engine.statsBuffer,12,new Uint32Array([0xfffffff0]));}
  }});
  add('aggregate work carries above u32 without wrapping',carry.plainIterations===0xfffffff0+512000,{plainIterations:carry.plainIterations});
  engine.invalidateHistory();const high=await engine.render({...req,width:8,height:8,centerX:new Decimal(3),centerY:new Decimal(3),unitsPerPixel:new Decimal('.001'),maxIterations:1000000});
  add('one-million cap accepts bounded escaping GPU work',high.completed&&high.computedSamples===64,{stats:high});
  engine.invalidateHistory();const million=await engine.render({...req,width:1,height:1,centerX:new Decimal(0),centerY:new Decimal(0),unitsPerPixel:new Decimal(1),maxIterations:1000000});
  add('one actual million-step capped sample completes exactly',million.completed&&million.computedSamples===1&&million.plainIterations===1000000&&million.cappedRatio===1,{stats:million});
  // High-cap reference cancellation allocates capacity, then stops cooperatively.
  engine.invalidateHistory();let active=true;const timer=setTimeout(()=>{active=false;},30);let cancelled=false;
  try{await engine.render({...req,width:8,height:8,centerX:new Decimal(0),unitsPerPixel:new Decimal('1e-50'),maxIterations:1000000,isCurrent:()=>active});}catch(e){cancelled=e.name==='AbortError';}finally{clearTimeout(timer);}
  add('one-million reference allocation remains cancellable',cancelled&&!active,{orbitBytes:engine.orbitBuffer?.size});
  return checks;
}
