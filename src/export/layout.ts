import Decimal from 'decimal.js';

export const MAX_EXPORT_PIXELS = 80_000_000;
export const MAX_EXPORT_DIMENSION = 32_768;
export const EXPORT_MEMORY_LIMIT = 768 * 1024 * 1024;
const WORKING_LIMIT = 64 * 1024 * 1024;
const ENCODER_RESERVE = 16 * 1024 * 1024;
export const PNG_IDAT_BYTES = 64 * 1024;

export interface ExportRect { x: number; y: number; width: number; height: number }
export interface ExportTile { core: ExportRect; padded: ExportRect }
export interface ExportStrip { y: number; height: number; tiles: Iterable<ExportTile> }
export interface ExportLimits {
  maxTextureDimension2D: number;
  maxStorageBufferBindingSize: number;
  maxBufferSize: number;
}
export interface ExportPlanOptions {
  limits: ExportLimits;
  sampleGrid: number;
  endpointBytesPerSample: 0 | 16;
  /** Six pixels for post AA, one for lighting without post AA. */
  halo: number;
  stripRows?: number;
}
export interface ExportPlan {
  width: number;
  height: number;
  stripRows: number;
  tileWidth: number;
  stripCount: number;
  tileCount: number;
  maxEncodedBytes: number;
  workingBytes: number;
  /** Export allocation estimate, including a possible Blob copy of all chunks.
   * Existing screen/reference resources and browser internals are not measured. */
  peakBytes: number;
  strips(): Iterable<ExportStrip>;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive whole number.`);
  return value;
}

export function checkedExportDimensions(width: number, height: number) {
  positiveInteger(width, 'Width'); positiveInteger(height, 'Height');
  if (width > MAX_EXPORT_DIMENSION || height > MAX_EXPORT_DIMENSION) throw new Error('PNG width and height are limited to 32,768 pixels each.');
  if (width > Math.floor(MAX_EXPORT_PIXELS / height)) {
    throw new Error('PNG output is limited to 80 million pixels. Choose smaller dimensions.');
  }
  const pixels = width * height;
  const filteredBytes = (width * 4 + 1) * height;
  // Reserve beyond incompressible input, plus block/chunk overhead. This is a
  // policy cap, not a promise about every native compressor; enforce it live.
  const compressedAllowance = Math.ceil(filteredBytes * 1.125) + 65536;
  const maxEncodedBytes = 45 + compressedAllowance + Math.ceil(compressedAllowance / PNG_IDAT_BYTES) * 12;
  return { width, height, pixels, filteredBytes, maxEncodedBytes };
}

/** Preserve center, rotation and vertical span; crop or extend horizontally. */
export function frameForExport(view: { width: number; height: number; unitsPerPixel: Decimal }, width: number, height: number): Decimal {
  checkedExportDimensions(width, height);
  positiveInteger(view.width, 'Viewport width'); positiveInteger(view.height, 'Viewport height');
  if (!view.unitsPerPixel.isFinite() || !view.unitsPerPixel.gt(0)) throw new Error('The current view scale is invalid.');
  const D = Decimal.clone({ precision: Math.max(Decimal.precision, view.unitsPerPixel.sd() + 32) });
  const scale = new D(view.unitsPerPixel.toString());
  return new Decimal(scale.times(view.height).div(height).toString());
}

/** Sequential full-width scanline strips, assembled from bounded padded tiles.
 * Pixel allocation is bounded independently of output dimensions. Both fields,
 * endpoint samples, retained/AA textures, readback, strip/filter copies and an
 * encoder reserve are included. Orbit/BLA resources remain renderer-validated. */
export function planExport(width: number, height: number, options: ExportPlanOptions): ExportPlan {
  const { maxEncodedBytes } = checkedExportDimensions(width, height);
  const { limits, sampleGrid, endpointBytesPerSample, halo } = options;
  for (const [key, value] of Object.entries(limits)) positiveInteger(value, key);
  if (![1, 2, 3].includes(sampleGrid)) throw new Error('Unsupported export sample grid.');
  if (![0, 16].includes(endpointBytesPerSample)) throw new Error('Unsupported export endpoint channels.');
  if (!Number.isSafeInteger(halo) || halo < 0 || halo > 64) throw new Error('Invalid export halo.');
  let stripRows = Math.min(height, options.stripRows ?? 64);
  positiveInteger(stripRows, 'Strip height');
  if (stripRows > 64) throw new Error('Export strips may contain at most 64 rows.');
  let tileWidth = Math.min(width, 1024, limits.maxTextureDimension2D);
  const bindingLimit = Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize);
  const estimate = () => {
    const paddedWidth = Math.min(width, tileWidth + 2 * halo), paddedHeight = Math.min(height, stripRows + 2 * halo);
    const pixels = paddedWidth * paddedHeight, samples = pixels * sampleGrid * sampleGrid;
    const readback = Math.ceil(paddedWidth * 4 / 256) * 256 * paddedHeight;
    const workingBytes = Math.ceil(width * stripRows * 12 + samples * (16 + endpointBytesPerSample) + pixels * 48 + readback * 2 + ENCODER_RESERVE);
    const fits = paddedWidth <= limits.maxTextureDimension2D && paddedHeight <= limits.maxTextureDimension2D &&
      samples * 8 <= bindingLimit && samples * endpointBytesPerSample <= bindingLimit && readback <= limits.maxBufferSize &&
      workingBytes <= WORKING_LIMIT && 2 * maxEncodedBytes + workingBytes <= EXPORT_MEMORY_LIMIT;
    return { fits, workingBytes };
  };
  while (!estimate().fits) {
    if (tileWidth > 1) tileWidth = Math.max(1, Math.floor(tileWidth / 2));
    else if (stripRows > 1) { stripRows = Math.max(1, Math.floor(stripRows / 2)); tileWidth = Math.min(width, 1024, limits.maxTextureDimension2D); }
    else throw new Error('These dimensions exceed the export memory or GPU limits. Choose smaller dimensions.');
  }
  const workingBytes = estimate().workingBytes, stripCount = Math.ceil(height / stripRows);
  function* tiles(y: number, rows: number): Iterable<ExportTile> {
    for (let x = 0; x < width; x += tileWidth) {
      const core = { x, y, width: Math.min(tileWidth, width - x), height: rows };
      const left = Math.max(0, x - halo), top = Math.max(0, y - halo);
      const right = Math.min(width, x + core.width + halo), bottom = Math.min(height, y + rows + halo);
      yield { core, padded: { x: left, y: top, width: right - left, height: bottom - top } };
    }
  }
  return { width, height, stripRows, tileWidth, stripCount, tileCount: stripCount * Math.ceil(width / tileWidth), maxEncodedBytes,
    workingBytes, peakBytes: 2 * maxEncodedBytes + workingBytes,
    *strips() { for (let y = 0; y < height; y += stripRows) { const rows = Math.min(stripRows, height - y); yield { y, height: rows, tiles: tiles(y, rows) }; } },
  };
}
