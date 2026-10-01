// Copy only samples at identical complex coordinates. New positions remain
// explicitly unknown until the numerical pass computes them.
struct Mapping {
    oldWidth: i32, oldHeight: i32, width: i32, height: i32,
    offsetX: i32, offsetY: i32, step: i32, denominator: i32,
    lowerCap: i32, padding0: i32, padding1: i32, padding2: i32,
};
@group(0) @binding(0) var<storage, read> previous: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> next: array<vec2<f32>>;
@group(0) @binding(2) var<uniform> m: Mapping;

@compute @workgroup_size(8, 8)
fn remap(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = i32(gid.x); let y = i32(gid.y);
    if (x >= m.width || y >= m.height) { return; }
    let nx = m.offsetX + x * m.step;
    let ny = m.offsetY + y * m.step;
    let oldX = nx / m.denominator; let oldY = ny / m.denominator;
    var value = vec2<f32>(0.0, -1.0);
    if (nx % m.denominator == 0 && ny % m.denominator == 0 &&
        oldX >= 0 && oldY >= 0 && oldX < m.oldWidth && oldY < m.oldHeight) {
        value = previous[u32(oldY * m.oldWidth + oldX)];
        // A lower cap keeps only an already-observed early escape or analytic
        // interior. Numerical periodicity (-2), later escapes and cap stamps
        // are conservatively retried; none becomes an interior certificate.
        if (m.lowerCap > 0 && (value.x < -1.0 || value.x > f32(m.lowerCap))) {
            value = vec2<f32>(0.0, -1.0);
        }
    }
    next[gid.y * u32(m.width) + gid.x] = value;
}
