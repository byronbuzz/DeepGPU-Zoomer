import { decodeView, validateView, type SavedView } from './state';

/** Inspect only scene text; a pasted URL never causes an external request. */
export function readClipboardScene(text: string): SavedView | null {
  if (text.length > 256 * 1024) return null;
  const value = text.trim();
  if (!value) return null;
  try {
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value);
      return url.hash ? decodeView(url.hash.slice(1)) : null;
    }
    if (value.startsWith('#')) return decodeView(value.slice(1));
    if (value.startsWith('{')) {
      const record = JSON.parse(value);
      if (record.format !== undefined) return record.format === 'DeepGPU-Zoomer' && record.version === 1 ? validateView(record.view) : null;
      return validateView(record);
    }
    return decodeView(value);
  } catch { return null; }
}

export function setupClipboardLink(options: {button: HTMLButtonElement; load: (view: SavedView) => void; revision: () => string; message: (text: string) => void}) {
  const {button} = options;
  let ticket = 0;
  const unknown = () => { ticket++; button.disabled = false; button.title = 'Load a DeepGPU link or scene from the clipboard'; };
  async function read(open: boolean) {
    const id = ++ticket, revision = options.revision();
    try {
      const scene = readClipboardScene(await navigator.clipboard.readText());
      if (id !== ticket) return;
      button.disabled = !scene;
      button.title = scene ? 'Load the DeepGPU view from the clipboard' : 'No DeepGPU link or scene on the clipboard';
      if (!open) return;
      if (!scene) { options.message('The clipboard has no valid DeepGPU link or scene.'); return; }
      if (options.revision() !== revision) { options.message('Pasting cancelled because the view changed.'); return; }
      options.load(scene); options.message('Pasted location opened.');
    } catch {
      if (id !== ticket) return;
      unknown();
      if (open) options.message('Clipboard access is unavailable. Copy a DeepGPU link, focus the fractal and press Ctrl+V.');
    }
  }
  async function inspect() {
    unknown(); const id = ticket;
    try {
      const permission = await navigator.permissions.query({name: 'clipboard-read' as PermissionName});
      // Never ask for clipboard permission merely to update a button.
      if (id === ticket && permission.state === 'granted' && document.hasFocus()) void read(false);
    } catch { /* Unsupported permissions remain unknown until the user pastes. */ }
  }
  button.onclick = () => { void read(true); };
  window.addEventListener('blur', unknown);
  window.addEventListener('focus', () => { void inspect(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void inspect(); });
  navigator.clipboard?.addEventListener?.('clipboardchange', () => { void inspect(); });
  window.addEventListener('paste', event => {
    const target = event.target as Element | null;
    if (target?.closest?.('input,textarea,[contenteditable]:not([contenteditable="false"])')) return;
    const scene = readClipboardScene(event.clipboardData?.getData('text/plain') ?? '');
    if (!scene) return;
    event.preventDefault(); unknown(); options.load(scene); options.message('Pasted location opened.');
  });
  void inspect();
  return {copied: unknown};
}
