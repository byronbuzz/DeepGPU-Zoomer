import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import Decimal from 'decimal.js';
import {generatePackedReference,type ReferenceOrbitInput,type PackedReferenceOrbit} from '../src/render/reference-orbit';
import {buildBla} from '../src/render/bla';
import {buildBla as buildQuadratic} from '../src/render/parallel-bla';

const base:ReferenceOrbitInput={family:'mandelbrot',centerX:'-.1',centerY:'.2',juliaX:'-.8',juliaY:'.156',limbs:8,maxIterations:257};
// Captured from the independently frozen 20-word producer before compaction.
// Julia keeps that entire byte stream; Mandelbrot reconstructs its duplicated
// half only here to compare against the same historical transport hash.
const fixtures=[
  {name:'mandelbrot-capped',input:base,length:258,escaped:false,escapeIndex:0,
    terminalX:'-3063780931089742953652404435563393872059037025217756806226254500514',
    terminalY:'4393432788396909430730296010414287681437470373662563814306957886997',
    legacySha256:'5e62b03044b7ca2a01d9437e4d13d9c9fcf5edcd6cd9a1c6985017fcac4a745a',
    linearSha256:'4059b66ce9f07b079e05cd6a9c53e2d5c16bd3cc7f9e237d79d7ced8b65f4678',
    quadraticSha256:'6a6724ffddbdec57cd462bdbbccee18b39daaa74f88d6dbda64f4d5b0b7bc5f4'},
  {name:'mandelbrot-escaped',input:{...base,centerX:'.5'},length:8,escaped:true,escapeIndex:7,
    terminalX:'-666261304295672951270665956919672314803586588691872185542307513989308',
    terminalY:'565648844996861075143850773523009239323027494200519932647044349111969',
    legacySha256:'7a5a5394359404afe42888d22ccef3b4fc95deff649773332fb0bc555afb16e3',
    linearSha256:'1e517e8623d9ad91b829cdec5710d6279c9e98f49f76dcd600a53d24350466c6',
    quadraticSha256:'52cb148876642bcafe26cc29950d49cf9b62af9e5d018ba3491e8b8c93827f6e'},
  {name:'julia-capped',input:{...base,family:'julia' as const,centerX:'.123456789',centerY:'-.2',juliaX:'-.1',juliaY:'.2'},
    length:258,escaped:false,escapeIndex:0,
    terminalX:'-3063780931089742953652404435563393872059037025217756806226254500514',
    terminalY:'4393432788396909430730296010414287681437470373662563814306957886997',
    legacySha256:'0b389985daafdedc89006202b824b18d315fcf49c34bb2a76bcd18ec59b11d2a',
    linearSha256:'068870fc7f3799f3ca2e5771ee7f2fdafd772b5f0d0176d1e67c0e28cf2915fe',
    quadraticSha256:'4b1b7452f76ee9924ddffc9b1c07efca249e92e7913761f4c772ce2e17e541d5'},
  {name:'julia-escaped',input:{...base,family:'julia' as const,centerX:'2',centerY:'2'},length:3,escaped:true,escapeIndex:2,
    terminalX:'-1797698302307684824123367574119538211914031132175531346672342382230772',
    terminalY:'-347610768347573489256518625725996310053607885326469125342357509109294',
    legacySha256:'04590f2c29fea03f160e63e3104daa8834325d191d2a784e68a254eb3d37c643',
    linearSha256:'17b0761f87b081d5cf10757ccc89f12be355c70e2e29df288b65b30710dcbcd1',
    quadraticSha256:'38723a2e5e8a17aa7950dc008209944e898f69a7bd10a23c839d341e935fd5ca'},
];
const hash=(data:ArrayBufferView)=>createHash('sha256').update(new Uint8Array(data.buffer,data.byteOffset,data.byteLength)).digest('hex');
function legacyBytes(orbit:PackedReferenceOrbit):Uint32Array{
  const source=new Uint32Array(orbit.buffer);
  if(orbit.sampleWords===20)return source;
  const expanded=new Uint32Array(orbit.length*20);
  for(let i=0;i<orbit.length;i++){
    const sample=source.subarray(i*10,(i+1)*10);
    expanded.set(sample,i*20);expanded.set(sample,i*20+10);
  }
  return expanded;
}

describe('compact reference transport against frozen legacy fixtures',()=>{
  it.each(fixtures)('keeps the complete $name transport and exact terminal value',fixture=>{
    const orbit=generatePackedReference(fixture.input);
    expect(orbit).toMatchObject({formatVersion:2,sampleWords:fixture.input.family==='julia'?20:10,
      length:fixture.length,escaped:fixture.escaped,escapeIndex:fixture.escapeIndex});
    expect(orbit.buffer.byteLength).toBe(orbit.length*(fixture.input.family==='julia'?80:40));
    expect(orbit.terminal.x.toString()).toBe(fixture.terminalX);expect(orbit.terminal.y.toString()).toBe(fixture.terminalY);
    expect(hash(legacyBytes(orbit))).toBe(fixture.legacySha256);
  });
  it.each(fixtures)('keeps every linear and quadratic BLA byte for $name',fixture=>{
    const orbit=generatePackedReference(fixture.input),samples=new Float32Array(orbit.buffer);
    const julia=fixture.input.family==='julia',radius=new Decimal(julia?0:'1e-12');
    const linear=buildBla(samples,orbit.length,radius,{sampleWords:orbit.sampleWords,epsilonLog2:julia?-40:undefined,omitSingleStep:true});
    const quadratic=buildQuadratic(samples,orbit.length,radius,{sampleWords:orbit.sampleWords,epsilonLog2:-29});
    expect(hash(linear.data)).toBe(fixture.linearSha256);expect(hash(quadratic.data)).toBe(fixture.quadraticSha256);
  });
});
