// A whole-field certificate for a cap change, never a presentation certificate.
@group(0) @binding(0) var<storage, read> samples: array<vec2<f32>>;
@group(0) @binding(1) var<uniform> dimensions: vec4<u32>;
@group(0) @binding(2) var<storage, read_write> unresolved: array<u32>;
var<workgroup> groupUnresolved: atomic<u32>;

@compute @workgroup_size(8, 8)
fn validateCap(@builtin(global_invocation_id) gid: vec3<u32>,
               @builtin(workgroup_id) group: vec3<u32>,
               @builtin(local_invocation_index) lane: u32) {
    if (lane == 0u) { atomicStore(&groupUnresolved, 0u); }
    workgroupBarrier();
    if (gid.x < dimensions.x && gid.y < dimensions.y) {
        let value = samples[gid.y * dimensions.x + gid.x];
        let cap = f32(dimensions.z);
        // Match per-sample cap stamps, with an explicit early-escape bound.
        // A decrease has already filtered late escapes and provisional stamps.
        let resolved = (value.x >= -1.0 && value.x <= cap) ||
            value.x <= -(cap + 2.0) || (value.x == -2.0 && value.y >= cap);
        if (!(value.y >= 0.0 && resolved)) { atomicOr(&groupUnresolved, 1u); }
    }
    workgroupBarrier();
    // One exclusive output per tile, so dense interiors need no global atomics.
    if (lane == 0u) {
        unresolved[group.y * ((dimensions.x + 7u) / 8u) + group.x] = atomicLoad(&groupUnresolved);
    }
}
