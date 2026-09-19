// Exposes the big-fixed primitives as compute entry points so they can be
// checked against the BigInt oracle.
// Concatenated after arithtest-bindings.wgsl and bigfixed.wgsl.

// mul32 has no shared state, so each thread can check its own inputs.
@compute @workgroup_size(256)
fn testMul32(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= tp.cases) { return; }
    let p = mul32(operands[i * 2u], operands[i * 2u + 1u]);
    results[i * 2u] = p.lo;
    results[i * 2u + 1u] = p.hi;
}

// The big-number routines are collective, so one workgroup walks the cases.
@compute @workgroup_size(256)
fn testBigOp(@builtin(local_invocation_id) local: vec3<u32>) {
    let tid = local.x;

    for (var c: u32 = 0u; c < tp.cases; c = c + 1u) {
        let aIn = c * 2u * LIMBS;
        let bIn = aIn + LIMBS;

        for (var i: u32 = tid; i < LIMBS; i = i + WG) {
            scratch[slot(S_X) + i] = operands[aIn + i];
            scratch[slot(S_Y) + i] = operands[bIn + i];
        }
        sync();

        if (tp.op == 0u) {
            mulFixed(tid, S_X, S_Y, S_XX);
        } else if (tp.op == 1u) {
            if (tid == 0u) {
                for (var i: u32 = 0u; i < LIMBS; i = i + 1u) {
                    scratch[slot(S_XX) + i] = scratch[slot(S_X) + i];
                }
                addInto(slot(S_XX), slot(S_Y));
            }
            sync();
        } else {
            if (tid == 0u) {
                for (var i: u32 = 0u; i < LIMBS; i = i + 1u) {
                    scratch[slot(S_XX) + i] = scratch[slot(S_X) + i];
                }
                subInto(slot(S_XX), slot(S_Y));
            }
            sync();
        }

        for (var i: u32 = tid; i < LIMBS; i = i + WG) {
            results[c * LIMBS + i] = scratch[slot(S_XX) + i];
        }
        sync();
    }
}
