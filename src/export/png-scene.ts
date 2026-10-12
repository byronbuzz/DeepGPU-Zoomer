import { validateView, type SavedView } from '../state';
import { chunk, pngCrc } from './png-chunks';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const KEYWORD = 'DeepGPU-Zoomer Scene';
export const MAX_SCENE_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_CHUNKS = 8192;

/** Uncompressed UTF-8 iTXt, so reading a scene never needs decompression. */
export function sceneChunk(view: SavedView): Uint8Array<ArrayBuffer> {
  const text = new TextEncoder().encode(JSON.stringify({format: 'DeepGPU-Zoomer', version: 1, view: validateView(view)}));
  const prefix = new TextEncoder().encode(KEYWORD);
  const payload = new Uint8Array(prefix.length + 5 + text.length);
  if (payload.length > MAX_SCENE_BYTES) throw Error('The PNG location metadata is too large.');
  payload.set(prefix); // NUL, compression flag/method, empty language/translation.
  payload.set(text, prefix.length + 5);
  return chunk('iTXt', payload);
}

/** Read only headers and scene data. Image payloads remain in the Blob. */
export async function readPngScene(file: Blob): Promise<SavedView> {
  if (file.size < 45 || file.size > MAX_FILE_BYTES) throw Error('Choose a PNG file no larger than 512 MB.');
  const read = async (start: number, length: number) => {
    const bytes = new Uint8Array(await file.slice(start, start + length).arrayBuffer());
    if (bytes.length !== length) throw Error('The PNG file is truncated.');
    return bytes;
  };
  const signature = await read(0, 8);
  if (!SIGNATURE.every((byte, i) => signature[i] === byte)) throw Error('This file is not a PNG image.');
  let offset = 8, count = 0, imageData = false, scene: SavedView | undefined;
  while (offset < file.size && count++ < MAX_CHUNKS) {
    if (file.size - offset < 12) throw Error('The PNG file is truncated.');
    const header = await read(offset, 8), view = new DataView(header.buffer);
    const length = view.getUint32(0), type = String.fromCharCode(...header.subarray(4));
    if (length > 0x7fffffff || length > file.size - offset - 12 || !/^[A-Za-z]{4}$/.test(type)) throw Error('The PNG chunk structure is invalid.');
    if (count === 1) {
      if (type !== 'IHDR' || length !== 13) throw Error('The PNG image header is invalid.');
      const data = await read(offset + 8, 17), dimensions = new DataView(data.buffer);
      if (!dimensions.getUint32(0) || dimensions.getUint32(0) > 0x7fffffff || !dimensions.getUint32(4) || dimensions.getUint32(4) > 0x7fffffff ||
          pngCrc(new Uint8Array([...header.subarray(4), ...data.subarray(0, 13)])) !== dimensions.getUint32(13)) throw Error('The PNG image header is invalid.');
    } else if (type === 'IHDR') throw Error('The PNG contains multiple image headers.');
    if (type === 'IDAT') imageData = true;
    if (type === 'iTXt') {
      // A PNG keyword is at most 79 bytes. Inspect it before allocating text.
      const prefix = await read(offset + 8, Math.min(length, 80));
      const separator = prefix.indexOf(0);
      if (separator >= 0 && String.fromCharCode(...prefix.subarray(0, separator)) === KEYWORD) {
        if (scene) throw Error('The PNG contains multiple saved locations.');
        if (length > MAX_SCENE_BYTES || length < separator + 5) throw Error('The PNG location metadata is invalid.');
        const data = await read(offset + 8, length + 4);
        if (pngCrc(new Uint8Array([...header.subarray(4), ...data.subarray(0, length)])) !== new DataView(data.buffer).getUint32(length)) throw Error('The PNG location metadata is damaged.');
        if (data[separator + 1] !== 0) throw Error('Compressed PNG location metadata is not supported.');
        let start = separator + 3;
        for (let i = 0; i < 2; i++) {
          const end = data.subarray(0, length).indexOf(0, start);
          if (end < 0) throw Error('The PNG location metadata is invalid.');
          start = end + 1;
        }
        let record;
        try {
          record = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(data.subarray(start, length)));
        } catch { throw Error('The PNG location metadata is invalid.'); }
        if (record?.format !== 'DeepGPU-Zoomer' || record.version !== 1) throw Error('This PNG location format is not supported.');
        scene = validateView(record.view);
      }
    }
    offset += length + 12;
    if (type === 'IEND') {
      if (length !== 0 || !imageData || offset !== file.size || new DataView((await read(offset - 4, 4)).buffer).getUint32(0) !== pngCrc(header.subarray(4))) throw Error('The PNG file is incomplete or invalid.');
      if (!scene) throw Error('This PNG has no saved DeepGPU location.');
      return scene;
    }
  }
  throw Error('The PNG file is incomplete or has too many chunks.');
}
