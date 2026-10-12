import type { SavedView } from '../state';
import { readPngScene } from './png-scene';
import { decodePngImage, samePngRevision, type PngImage, type PngRevision } from './png-image';

export function setupPngSceneImport(options: {open: (view: SavedView, image: PngImage) => void; revision: () => PngRevision; message: (text: string) => void}) {
  const button = document.getElementById('open-png') as HTMLButtonElement;
  const input = document.getElementById('open-png-file') as HTMLInputElement;
  let version = 0;
  async function openFiles(files: FileList | readonly File[]) {
    const ticket = ++version, revision = options.revision();
    if (files.length !== 1) { options.message('Choose one DeepGPU PNG to load.'); return; }
    let image: PngImage | undefined;
    try {
      const scene = await readPngScene(files[0]);
      if (ticket !== version) return;
      if (!samePngRevision(options.revision(), revision)) { options.message('PNG loading cancelled because the view changed.'); return; }
      image = await decodePngImage(files[0]);
      if (ticket !== version) return;
      if (!samePngRevision(options.revision(), revision)) { options.message('PNG loading cancelled because the view changed.'); return; }
      options.open(scene, image); image = undefined; // Display now owns the decoded image.
      options.message(scene.rotatePalette||scene.rotateLight?'PNG loaded. Preparing the saved animation; the original image stays visible until ready.':'PNG loaded. Navigate to continue exploring. Recolouring needs calculation because PNGs store colours, not escape data.');
    } catch (error) {
      if (ticket === version && samePngRevision(options.revision(), revision))
        options.message(error instanceof Error ? error.message : 'The PNG location could not be read.');
    } finally { image?.release(); }
  }
  button.onclick = () => input.click();
  input.onchange = () => {
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length) void openFiles(files);
  };
  window.addEventListener('dragover', event => {
    if (event.dataTransfer?.types.includes('Files')) {
      event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
    }
  });
  window.addEventListener('drop', event => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    void openFiles(Array.from(event.dataTransfer.files));
  });
}
