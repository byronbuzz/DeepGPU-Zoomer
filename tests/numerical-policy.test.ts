import { describe,it,expect } from 'vitest';
import { classifyIterationEntry,reusableIterationEntry,iterationEntryFromDistance } from '../src/render/iteration-classification';
import { createPointRecovery,exactAnalyticInterior,comparePointObservations } from '../src/render/point-recovery';
import adverse from './fixtures/adverse-eight.json';

describe('numerical result provenance',()=>{
  it('does not promote finite periodicity to cap-independent interior',()=>{
    expect(classifyIterationEntry([-1,0])).toEqual({kind:'analytic-interior'});
    expect(classifyIterationEntry([-2,79_000])).toEqual({kind:'numerical-periodic',qualifiedCap:79_000});
    expect(reusableIterationEntry([-2,79_000],79_000)).toBe(true);
    expect(reusableIterationEntry([-2,79_000],79_001)).toBe(false);
    expect(reusableIterationEntry([-1,0],10_000_000)).toBe(true);
  });
  it('preserves escape at the cap and unresolved nonescape through appearance conversion',()=>{
    expect(iterationEntryFromDistance(true,79_000,300)).toEqual([79_000,300]);
    const capped=iterationEntryFromDistance(false,79_000,2);
    expect(classifyIterationEntry(capped)).toEqual({kind:'cap-unresolved',cap:79_000});
    expect(reusableIterationEntry(capped,79_001)).toBe(false);
    expect(reusableIterationEntry([79_000,300],78_999)).toBe(false);
  });
  it('keeps the smallest cap, periodic marker and pending convention distinct',()=>{
    expect(classifyIterationEntry([-3,1])).toEqual({kind:'cap-unresolved',cap:1});
    expect(classifyIterationEntry([-2,1])).toEqual({kind:'numerical-periodic',qualifiedCap:1});
    expect(classifyIterationEntry([0,-1])).toEqual({kind:'pending'});
    expect(classifyIterationEntry([-1,Number.NaN])).toEqual({kind:'pending'});
  });
  it('retains exact cap identity at the maximum supported product cap',()=>{
    const field=new Float32Array([-2,10_000_000]);
    expect(classifyIterationEntry([field[0],field[1]])).toEqual({kind:'numerical-periodic',qualifiedCap:10_000_000});
    expect(classifyIterationEntry([Math.fround(-10_000_002),0])).toEqual({kind:'cap-unresolved',cap:10_000_000});
  });
});

const r=(n:bigint,d=1n)=>({numerator:n,denominator:d});
const point=(x:bigint,xd=1n,y=0n,yd=1n)=>({x:r(x,xd),y:r(y,yd)});
describe('independent selected-point enclosure',()=>{
  it('only escalates comparable evidence and does not certify agreement',()=>{
    const a={point:point(-2n),maxIterations:100,escapeIteration:null,methodIdentity:'wide',referenceIdentity:'first'};
    expect(comparePointObservations(a,{...a,methodIdentity:'wide-bla'})).toBe('agreement-without-certification');
    expect(comparePointObservations(a,{...a,escapeIteration:90,methodIdentity:'direct'})).toBe('method-disagreement');
    expect(comparePointObservations(a,{...a,escapeIteration:90,referenceIdentity:'second'})).toBe('reference-disagreement');
    expect(comparePointObservations(a,{...a,point:point(-1n),escapeIteration:90})).toBe('incomparable');
    expect(comparePointObservations(a,{...a,maxIterations:200})).toBe('incomparable');
  });
  it('uses exact analytic inequalities and leaves boundary points unclassified',()=>{
    expect(exactAnalyticInterior(point(0n))).toBe('main-cardioid');
    expect(exactAnalyticInterior(point(-1n))).toBe('period-two-bulb');
    expect(exactAnalyticInterior(point(1n,4n))).toBeNull();
    expect(exactAnalyticInterior(point(-5n,4n))).toBeNull();
    expect(exactAnalyticInterior(point(10000000000000001n,40000000000000000n))).toBeNull();
  });
  it.each([[17n,1],[16n,2],[2n,3],[1n,4]] as const)('certifies strict radius-16 escape for c=%s',(x,expected)=>{
    const calc=createPointRecovery({point:point(x),maxIterations:10,precisions:[64],trigger:'explicit-selection'});
    const result=calc.step(10);
    expect(result.status).toBe('escaped');
    expect(result.iterations).toBe(expected);
  });
  it('does not use a finite repeated orbit as an interior certificate',()=>{
    const calc=createPointRecovery({point:point(-2n),maxIterations:100,precisions:[64],trigger:'numerical-periodicity'});
    const first=calc.step(7);
    expect(first.status).toBe('running');
    expect(first.operations).toBe(7);
    const result=calc.step(93);
    expect(result.status).toBe('cap-unresolved');
    expect(result.iterations).toBe(100);
    expect(result.operations).toBe(100);
  });
  it('validates exact rational and computational budgets',()=>{
    expect(()=>createPointRecovery({point:point(1n,0n),maxIterations:10,precisions:[64],trigger:'explicit-selection'})).toThrow();
    expect(()=>createPointRecovery({point:point(2n),maxIterations:10,precisions:[64,32],trigger:'explicit-selection'})).toThrow();
  });
  it('reports exhausted precision instead of guessing the difficult Wide result',()=>{
    const row=adverse.points.find(row=>row.id==='direct-7-wrong-count')!;
    const rational=(value:{numerator:string;denominator:string})=>
      ({numerator:BigInt(value.numerator),denominator:BigInt(value.denominator)});
    const calc=createPointRecovery({point:{x:rational(row.rationals[0]),y:rational(row.rationals[1])},
      maxIterations:row.cap,precisions:[128],trigger:'reference-disagreement'});
    let result=calc.step(1000);
    while(result.status==='running')result=calc.step(1000);
    expect(result.status).toBe('precision-exhausted');
    expect(result.iterations).toBeLessThan(65580);
  });
  it.each(adverse.points)('encloses the independent oracle result for $id',row=>{
    const rational=(value:{numerator:string;denominator:string})=>
      ({numerator:BigInt(value.numerator),denominator:BigInt(value.denominator)});
    const calc=createPointRecovery({point:{x:rational(row.rationals[0]),y:rational(row.rationals[1])},
      maxIterations:row.cap,precisions:[128,256],trigger:'method-disagreement'});
    let result=calc.step(1024),previousOperations=0;
    while(result.status==='running'){
      expect(result.operations-previousOperations).toBeLessThanOrEqual(1024);
      previousOperations=result.operations;
      result=calc.step(1024);
    }
    expect(result.status).toBe(row.expectedField<0?'cap-unresolved':'escaped');
    expect(result.iterations).toBe(row.expectedField<0?row.cap:row.expectedField);
    if(row.id==='direct-7-wrong-count'){
      expect('attempts' in result&&result.attempts).toBe(2);
      expect('enclosure' in result&&result.enclosure.bits).toBe(256);
    }
  });
});
