// Reused compensated f32-pair operations; see NOTICE.md.
// WGSL may reassociate expressions. Qualification comes from actual GPU field
// comparisons, not a blanket claim that these transforms are error-free.
const SPLITTER: f32 = 4097.0;

fn quickTwoSum(a: f32, b: f32) -> vec2f {
  let sum = a + b;
  return vec2f(sum, b - (sum - a));
}

fn twoSum(a: f32, b: f32) -> vec2f {
  let sum = a + b;
  let bVirtual = sum - a;
  let error = (a - (sum - bVirtual)) + (b - bVirtual);
  return vec2f(sum, error);
}

fn dsAdd(left: vec2f, right: vec2f) -> vec2f {
  let high = twoSum(left.x, right.x);
  let low = twoSum(left.y, right.y);
  let combined = quickTwoSum(high.x, high.y + low.x);
  return quickTwoSum(combined.x, combined.y + low.y);
}

fn dsSubtract(left: vec2f, right: vec2f) -> vec2f {
  return dsAdd(left, vec2f(-right.x, -right.y));
}

fn dsMultiply(left: vec2f, right: vec2f) -> vec2f {
  let product = left.x * right.x;
  let leftSplit = SPLITTER * left.x;
  let rightSplit = SPLITTER * right.x;
  let leftHigh = leftSplit - (leftSplit - left.x);
  let rightHigh = rightSplit - (rightSplit - right.x);
  let leftLow = left.x - leftHigh;
  let rightLow = right.x - rightHigh;
  let productError = ((leftHigh * rightHigh - product) + leftHigh * rightLow + leftLow * rightHigh)
    + leftLow * rightLow;
  return twoSum(product, productError + left.x * right.y + left.y * right.x + left.y * right.y);
}

fn complexAdd(left: vec4f, right: vec4f) -> vec4f {
  let real = dsAdd(left.xy, right.xy);
  let imaginary = dsAdd(left.zw, right.zw);
  return vec4f(real.x, real.y, imaginary.x, imaginary.y);
}

fn complexMultiply(left: vec4f, right: vec4f) -> vec4f {
  let real = dsSubtract(dsMultiply(left.xy, right.xy), dsMultiply(left.zw, right.zw));
  let imaginary = dsAdd(dsMultiply(left.xy, right.zw), dsMultiply(left.zw, right.xy));
  return vec4f(real.x, real.y, imaginary.x, imaginary.y);
}

fn complexScale(value: vec4f, factor: f32) -> vec4f {
  let real = dsMultiply(value.xy, vec2f(factor, 0.0));
  let imaginary = dsMultiply(value.zw, vec2f(factor, 0.0));
  return vec4f(real.x, real.y, imaginary.x, imaginary.y);
}

fn complexMagnitudeSquared(value: vec4f) -> vec2f {
  return dsAdd(dsMultiply(value.xy, value.xy), dsMultiply(value.zw, value.zw));
}
