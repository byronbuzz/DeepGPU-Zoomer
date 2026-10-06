import { referenceIdentity, referenceSampleWords, REFERENCE_FORMAT_VERSION, type ReferenceOrbitInput } from './reference-orbit';
import type { PreparedReference } from './reference-preparation';

/** Immutable completed CPU payloads only. GPU ownership stays with the renderer. */
export class ReferenceOrbitCache {
  private readonly orbits=new Map<string,PreparedReference>();
  private bytes=0;
  constructor(private readonly maxOrbits:number,private readonly maxBytes:number) {}
  get(input:ReferenceOrbitInput):PreparedReference|undefined {
    const key=referenceIdentity(input),orbit=this.orbits.get(key);
    if(!orbit)return undefined;
    this.orbits.delete(key);this.orbits.set(key,orbit);
    return orbit;
  }
  remember(input:ReferenceOrbitInput,orbit:PreparedReference):void {
    const key=referenceIdentity(input);
    if(orbit.terminal.identity!==key||orbit.formatVersion!==REFERENCE_FORMAT_VERSION||
       orbit.sampleWords!==referenceSampleWords(input.family)||
       orbit.length!==orbit.terminal.iteration+1||orbit.samples.length!==orbit.length*orbit.sampleWords||
       orbit.samples.byteOffset!==0||orbit.samples.byteLength!==orbit.samples.buffer.byteLength||
       orbit.escaped!==orbit.terminal.escaped||!orbit.escaped&&orbit.terminal.iteration<input.maxIterations) {
      throw Error('Cannot cache an incomplete or incompatible reference');
    }
    const old=this.orbits.get(key);
    if(old&&(old.escaped||old.terminal.iteration>orbit.terminal.iteration))return;
    if(orbit.samples.byteLength>this.maxBytes)return;
    if(old){this.orbits.delete(key);this.bytes-=old.samples.byteLength;}
    this.orbits.set(key,orbit);this.bytes+=orbit.samples.byteLength;
    while(this.orbits.size>this.maxOrbits||this.bytes>this.maxBytes){
      const first=this.orbits.entries().next().value;
      if(!first)break;
      this.orbits.delete(first[0]);this.bytes-=first[1].samples.byteLength;
    }
  }
  clear():void {this.orbits.clear();this.bytes=0;}
}
