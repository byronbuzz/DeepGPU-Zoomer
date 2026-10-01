/** Mode-0 scalar field contract shared with the WGSL emitters and remap kernels.
 * Computed escape and numerical periodicity are finite-precision observations.
 * Neither disabling BLA nor retaining one of these samples certifies its orbit.
 */
export type IterationClassification =
  | { kind:'pending' }
  | { kind:'computed-escape'; iterations:number }
  | { kind:'analytic-interior' }
  | { kind:'numerical-periodic'; qualifiedCap:number }
  | { kind:'cap-unresolved'; cap:number };

export function classifyIterationEntry(entry: readonly [number,number]): IterationClassification {
  const [value,auxiliary]=entry;
  if (!Number.isFinite(value)||!Number.isFinite(auxiliary)||auxiliary<0) return {kind:'pending'};
  if(value>=0)return {kind:'computed-escape',iterations:value};
  if(value===-1)return {kind:'analytic-interior'};
  if(value===-2)return {kind:'numerical-periodic',qualifiedCap:auxiliary};
  return {kind:'cap-unresolved',cap:-value-2};
}

/** Reuse is permission to retain an observation under the same numerical identity,
 * not an upgrade of its mathematical authority. Method/reference/BLA identity is
 * checked by the existing field owner before this per-entry predicate is used.
 */
export function reusableIterationEntry(entry: readonly [number,number],cap:number): boolean {
  const result=classifyIterationEntry(entry);
  switch(result.kind){
    case 'pending':return false;
    case 'analytic-interior':return true;
    case 'computed-escape':return result.iterations<=cap;
    case 'numerical-periodic':return result.qualifiedCap>=cap;
    case 'cap-unresolved':return result.cap>=cap;
  }
}

/** Distance mode runs through the cap for nonescape; an appearance conversion
 * cannot manufacture an interior certificate from its endpoint channels.
 */
export function iterationEntryFromDistance(escaped:boolean,iterations:number,z2:number): readonly [number,number] {
  return [escaped?iterations:-(iterations+2),z2];
}
