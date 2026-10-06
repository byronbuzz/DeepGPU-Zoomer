/** WebGPU adapter/device acquisition plus the capability report the UI shows. */

export interface GpuCapabilities {
  adapterInfo: string;
  maxStorageBufferBindingSize: number;
  maxComputeWorkgroupStorageSize: number;
  maxComputeInvocationsPerWorkgroup: number;
  hasTimestampQuery: boolean;
  hasSubgroups: boolean;
}

export interface GpuContext {
  device: GPUDevice;
  /** Most recent numerical submission, shared by viewport, preview and export. */
  lastNumericalWork?: Readonly<{route:string;method:string;family:string;maxIterations:number;width:number;height:number;stride:number;sampleGrid:number;operations:number|null;submittedAt:string}>;
  capabilities: GpuCapabilities;
  /** Resolves if the device is ever lost, so pipelines can be rebuilt. */
  lost: Promise<GPUDeviceLostInfo>;
}

export class WebGpuUnavailable extends Error {}

/** Scope only synchronous GPU calls; other renderers cannot enter across an await. */
export async function checkedGpu<T>(device:GPUDevice,operation:()=>T):Promise<Awaited<T>> {
  device.pushErrorScope('validation');device.pushErrorScope('out-of-memory');device.pushErrorScope('internal');
  let value:T;
  try{value=operation();}catch(error){
    await Promise.all([device.popErrorScope(),device.popErrorScope(),device.popErrorScope()]);throw error;
  }
  const errors=Promise.all([device.popErrorScope(),device.popErrorScope(),device.popErrorScope()]);
  const [result,reported]=await Promise.all([value,errors]);
  const failure=reported.find(Boolean);if(failure)throw Error(`GPU operation failed: ${failure.message}`);
  return result;
}

export function validateRenderSize(limits:Pick<GPUSupportedLimits,'maxTextureDimension2D'|'maxStorageBufferBindingSize'|'maxBufferSize'>,width:number,height:number,bytesPerSample=8){
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1)throw Error('Render dimensions must be positive integers.');
  if(width>limits.maxTextureDimension2D||height>limits.maxTextureDimension2D)throw Error('Render dimensions exceed this GPU’s texture capacity.');
  if(width*height*bytesPerSample>Math.min(limits.maxStorageBufferBindingSize,limits.maxBufferSize))throw Error('The sample field exceeds this GPU’s buffer capacity. Reduce the viewport.');
}

export function backingSize(width:number,height:number,dpr:number,limits:Pick<GPUSupportedLimits,'maxTextureDimension2D'|'maxStorageBufferBindingSize'|'maxBufferSize'>,bytesPerSample=8){
  const pixels=Math.min(limits.maxStorageBufferBindingSize,limits.maxBufferSize)/bytesPerSample;
  const scale=Math.min(dpr,limits.maxTextureDimension2D/width,limits.maxTextureDimension2D/height,Math.sqrt(pixels/(width*height)));
  const roundedWidth=Math.round(width*scale),roundedHeight=Math.round(height*scale);
  const round=scale<dpr||roundedWidth>limits.maxTextureDimension2D||roundedHeight>limits.maxTextureDimension2D||roundedWidth*roundedHeight>pixels?Math.floor:Math.round;
  return {width:Math.max(1,round(width*scale)),height:Math.max(1,round(height*scale))};
}

export function isWebGpuAvailable(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

export async function acquireGpu(): Promise<GpuContext> {
  if (!isWebGpuAvailable()) {
    throw new WebGpuUnavailable(
      "This browser does not expose navigator.gpu. WebGPU is required for the arbitrary-precision engine."
    );
  }

  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
  });
  if (!adapter) {
    throw new WebGpuUnavailable("No WebGPU adapter is available on this device.");
  }

  // Only ever *optional*: never assume either exists.
  const optional: GPUFeatureName[] = [];
  if (adapter.features.has("timestamp-query")) optional.push("timestamp-query");
  if (adapter.features.has("subgroups" as GPUFeatureName)) {
    optional.push("subgroups" as GPUFeatureName);
  }

  const limits = adapter.limits;
  const device = await adapter.requestDevice({
    requiredFeatures: optional,
    requiredLimits: {
      maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
      maxBufferSize: limits.maxBufferSize,
      maxComputeWorkgroupStorageSize: limits.maxComputeWorkgroupStorageSize,
      maxComputeInvocationsPerWorkgroup: limits.maxComputeInvocationsPerWorkgroup,
    },
  });

  const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;

  return {
    device,
    lost: device.lost,
    capabilities: {
      adapterInfo: info
        ? [info.vendor, info.architecture, info.device, info.description]
            .filter(Boolean)
            .join(" ") || "unknown adapter"
        : "unknown adapter",
      maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
      maxComputeWorkgroupStorageSize: device.limits.maxComputeWorkgroupStorageSize,
      maxComputeInvocationsPerWorkgroup:
        device.limits.maxComputeInvocationsPerWorkgroup,
      hasTimestampQuery: device.features.has("timestamp-query"),
      hasSubgroups: device.features.has("subgroups" as GPUFeatureName),
    },
  };
}

/**
 * Compiles WGSL and throws with the real diagnostics on failure. Without this
 * a bad shader silently produces a pipeline that writes nothing, which looks
 * exactly like an arithmetic bug.
 */
export async function compileShader(
  device: GPUDevice,
  code: string,
  label: string
): Promise<GPUShaderModule> {
  device.pushErrorScope("validation");
  const module = device.createShaderModule({ label, code });

  const validationResult=device.popErrorScope();
  const info = await module.getCompilationInfo();
  const problems = info.messages.filter((m) => m.type === "error");
  const validation = await validationResult;

  if (problems.length || validation) {
    const lines = code.split("\n");
    const detail = problems
      .map((m) => `  ${label}:${m.lineNum}:${m.linePos} ${m.message}\n    > ${lines[m.lineNum - 1] ?? ""}`)
      .join("\n");
    throw new Error(
      `WGSL compilation failed for ${label}:\n${detail || `  ${validation?.message}`}`
    );
  }
  return module;
}

/** Creates a storage buffer sized for `words` u32/f32 values. */
export function storageBuffer(
  device: GPUDevice,
  words: number,
  label: string,
  extraUsage: GPUBufferUsageFlags = 0
): GPUBuffer {
  return device.createBuffer({
    label,
    size: Math.max(4, words * 4),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | extraUsage,
  });
}

/** Reads a GPU buffer back to the CPU. */
export async function readBuffer(
  device: GPUDevice,
  source: GPUBuffer,
  byteLength: number
): Promise<ArrayBuffer> {
  const staging = device.createBuffer({
    size: byteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(source, 0, staging, 0, byteLength);
  device.queue.submit([encoder.finish()]);

  try {
    await staging.mapAsync(GPUMapMode.READ);
    return staging.getMappedRange().slice(0);
  } finally {
    if(staging.mapState==='mapped')staging.unmap();
    staging.destroy();
  }
}
