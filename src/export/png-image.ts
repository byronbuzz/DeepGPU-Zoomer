import { checkedExportDimensions } from './layout';

export type PngRevision = string | number | readonly unknown[];
export function samePngRevision(a: PngRevision, b: PngRevision): boolean {
  return Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((value, i) => Object.is(value, b[i])) : a === b;
}
export interface PngImage { image: HTMLImageElement; release: () => void }

/** Called only after the scene reader has validated the PNG structure/header. */
export async function decodePngImage(file: Blob): Promise<PngImage> {
  const header = new DataView(await file.slice(16, 24).arrayBuffer());
  const width = header.getUint32(0), height = header.getUint32(4);
  try { checkedExportDimensions(width, height); }
  catch { throw Error('This PNG is too large to display (maximum 80 million pixels and 32,768 pixels per side).'); }
  const url = URL.createObjectURL(file), image = new Image();
  let released = false;
  const release = () => { if (!released) { released = true; image.removeAttribute('src'); URL.revokeObjectURL(url); } };
  try {
    image.src = url; await image.decode();
    if (image.naturalWidth !== width || image.naturalHeight !== height) throw Error('Unexpected PNG dimensions.');
    image.alt = ''; image.width = width; image.height = height;
    return {image, release};
  } catch { release(); throw Error('The PNG image could not be decoded. The current view was kept.'); }
}

/** Original colour pixels are a display, never a completed numerical field. */
export function setupPngImageDisplay(layer: HTMLElement, canvas: HTMLCanvasElement) {
  let current: PngImage | undefined, revision: PngRevision | undefined;
  let sampler: HTMLCanvasElement | undefined;
  const clear = () => {
    if (!current) return false;
    current.release(); current = undefined; revision = undefined;
    layer.replaceChildren(); layer.hidden = true; return true;
  };
  const patch = (x: number, y: number) => {
    if (!current) throw Error('No PNG image to sample.');
    const {image} = current, scale = canvas.height / image.naturalHeight;
    const left = (canvas.width - image.naturalWidth * scale) / 2;
    if (x < left || x >= left + image.naturalWidth * scale || y < 0 || y >= canvas.height)
      throw Error('This margin has no saved pixels. Navigate to render the current viewport.');
    sampler ??= document.createElement('canvas'); sampler.width = sampler.height = 33;
    const context = sampler.getContext('2d', {willReadFrequently: true});
    if (!context) throw Error('Image sampling is unavailable.');
    context.fillStyle = '#080b10'; context.fillRect(0, 0, 33, 33);
    context.drawImage(image, left - x + 16, -y + 16, image.naturalWidth * scale, canvas.height);
    return {width: 33, height: 33, pixels: context.getImageData(0, 0, 33, 33).data};
  };
  window.addEventListener('pagehide', clear);
  return {
    get active() { return !!current; },
    show(next: PngImage, nextRevision: PngRevision) {
      clear(); current = next; revision = nextRevision;
      layer.replaceChildren(next.image); layer.hidden = false;
    },
    retain(nextRevision: PngRevision) { if(current)revision=nextRevision; },
    reconcile(next: PngRevision) { return current && revision !== undefined && !samePngRevision(revision, next) ? clear() : false; },
    clear,
    async samplePatch(x: number, y: number) { return patch(x, y); },
    async sampleColour(x: number, y: number) {
      const data = patch(x, y).pixels, index = (16 * 33 + 16) * 4;
      return '#' + Array.from(data.subarray(index, index + 3), value => value.toString(16).padStart(2, '0')).join('');
    },
  };
}
