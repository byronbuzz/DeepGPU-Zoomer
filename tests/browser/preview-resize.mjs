import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

/** Exercises the native resize grip and the real preview renderer. */
export async function previewResizeChecks(context, url, artifactsDir) {
  const page = await context.newPage();
  const checks = [], errors = [], messages = [];
  let lastState;
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => {
    if (message.type() === 'warning' || message.type() === 'error') {
      const previous = messages.find(item => item.text === message.text());
      if (previous) previous.count++;
      else messages.push({ type: message.type(), text: message.text(), count: 1 });
    }
  });
  const read = async () => {
    let timer;
    try { return await Promise.race([page.evaluate(async () => {
    const { testing } = await import(document.querySelector('script[type=module][src*="/src/main.ts"]').src);
    const canvas = document.querySelector('#julia-preview-canvas');
    const rect = canvas.getBoundingClientRect();
    const panel = document.querySelector('#julia-preview').getBoundingClientRect();
    const status = testing.status();
    return {
      preview: testing.juliaPreview(), view: testing.snapshot(),
      main: { busy: status.busy, dirty: status.dirty, error: status.error, fields: status.fields, revision: status.revision },
      progress: testing.engine?.debugProgress?.(),
      backing: { width: canvas.width, height: canvas.height },
      css: { width: rect.width, height: rect.height }, dpr: devicePixelRatio,
      panel: { x: panel.x, y: panel.y, width: panel.width, height: panel.height },
      window: { width: innerWidth, height: innerHeight },
    };
    }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Preview state evaluation exceeded 8 seconds')), 8000); })]);
    } finally { clearTimeout(timer); }
  };
  const until = async condition => {
    const deadline = Date.now() + 120000;
    let logged = 0;
    for (;;) {
      const state = lastState = await read();
      if (Date.now() - logged > 2000) {
        logged = Date.now();
        console.log('WAIT ' + JSON.stringify({ main: state.main, preview: state.preview, progress: state.progress, messages, errors }));
      }
      if (state.main.error) throw Error(state.main.error);
      if (messages.some(item => /invalid|cannot be used|validation/i.test(item.text))) throw Error('GPU validation warning; see captured diagnostics');
      if (condition(state)) return state;
      if (Date.now() > deadline) throw Error(`Preview timeout: ${JSON.stringify(state)}`);
      await page.waitForTimeout(50);
    }
  };
  const previewSettled = () => until(({ preview: s, backing, css, dpr }) =>
    s.enabled && !s.busy && !s.pending && s.epoch === s.renderedEpoch &&
    backing.width === s.size.width && backing.height === s.size.height &&
    backing.width === Math.round(css.width*dpr) && backing.height === Math.round(css.height*dpr));
  const check = (name, condition, detail) => {
    checks.push({ name, pass: Boolean(condition), detail });
    console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
    assert.ok(condition, `${name}: ${JSON.stringify(detail)}`);
  };
  const checkPixels = state => {
    check('preview backing follows DPR and displayed dimensions',
      state.backing.width === Math.max(1,Math.round(state.css.width * state.dpr)) &&
      state.backing.height === Math.max(1,Math.round(state.css.height * state.dpr)), state);
    // Each backing pixel gets the same complex units; CSS scaling must match on both axes.
    const xScale = state.backing.width / state.css.width;
    const yScale = state.backing.height / state.css.height;
    check('preview keeps square complex pixels', Math.abs(xScale - yScale) <=
      1 / state.css.width + 1 / state.css.height, { xScale, yScale });
  };
  try {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto(url);
    await page.evaluate(async () => {
      const a = await import(document.querySelector('script[type=module][src*="/src/main.ts"]').src); await a.ready;
      const { HOME } = await import('/src/state.ts'); a.testing.load(HOME);
    });
    const adapter = await page.evaluate(async () => {
      const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      return { vendor: a.info.vendor, architecture: a.info.architecture, fallback: a.info.isFallbackAdapter };
    });
    check('physical AMD WebGPU adapter', adapter.vendor === 'amd' && adapter.fallback === false, adapter);
    await until(({ main }) => !main.busy && !main.dirty);
    check('GPU profiling starts disabled', !await page.locator('#profiling').isChecked());
    await page.locator('details summary').click();
    await page.getByLabel('Measure GPU timings').check();
    check('profiling checkbox controls renderer', await page.evaluate(async () => {
      const a = await import(document.querySelector('script[type=module][src*="/src/main.ts"]').src);
      return a.testing.engine.performance().enabled;
    }));
    await page.getByLabel('Measure GPU timings').uncheck();
    await page.locator('details summary').click();
    await page.evaluate(async () => {
      const { testing } = await import(document.querySelector('script[type=module][src*="/src/main.ts"]').src);
      const proto = Object.getPrototypeOf(testing.engine);
      const render = proto.render, reproject = proto.reproject;
      window.previewGeometry = [];
      const record = (renderer, req, phase) => {
        if (renderer === testing.engine || req.family !== 'julia') return;
        const canvas = document.querySelector('#julia-preview-canvas');
        const current = renderer.currentView;
        const selected = testing.juliaPreview().selected;
        window.previewGeometry.push({ phase, width: req.width, height: req.height,
          backingMatches: canvas.width === req.width && canvas.height === req.height,
          viewMatches: current?.width === req.width && current?.height === req.height &&
            current?.unitsPerPixel.eq(req.unitsPerPixel) && current?.juliaX.eq(req.juliaX) && current?.juliaY.eq(req.juliaY),
          verticalSpan: req.unitsPerPixel.mul(req.height).toNumber(),
          latestC: selected?.x === req.juliaX.toString() && selected?.y === req.juliaY.toString() });
      };
      proto.render = function(req) { record(this, req, 'start'); return render.call(this, req); };
      proto.reproject = function(req) {
        const result = reproject.call(this, req);
        record(this, req, 'publish');
        return result;
      };
    });
    await page.mouse.move(540, 340);
    await page.locator('#fractal').focus(); await page.keyboard.press('j');
    const initial = await previewSettled(); checkPixels(initial);
    const before = JSON.stringify(initial.view);

    const grip = initial.panel;
    await page.mouse.move(grip.x + grip.width - 3, grip.y + grip.height - 3);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width + 117, grip.y + grip.height + 77, { steps: 12 });
    await page.mouse.up();
    const grown = await previewSettled();
    check('native bottom-right drag enlarges both dimensions',
      grown.panel.width > grip.width + 50 && grown.panel.height > grip.height + 30,
      { before: grip, after: grown.panel });
    checkPixels(grown);
    check('resizing leaves main view and selected c unchanged',
      JSON.stringify(grown.view) === before &&
      JSON.stringify(grown.preview.selected) === JSON.stringify(initial.preview.selected), grown.preview);

    // Coalesce competing size/selection changes through the real observer and handlers.
    for (const [width, height, x, y] of [[470, 420, 620, 330], [350, 510, 650, 370], [430, 450, 700, 420]]) {
      await page.locator('#julia-preview').evaluate((panel, size) => {
        panel.style.width = `${size[0]}px`; panel.style.height = `${size[1]}px`;
      }, [width, height]);
      await page.mouse.click(x, y);
    }
    const latest = await previewSettled(); checkPixels(latest);
    const geometry = await page.evaluate(() => window.previewGeometry);
    check('resized preview publishes matching backing and current view',
      new Set(geometry.filter(p => p.phase === 'start').map(p => `${p.width}x${p.height}`)).size > 1 &&
      geometry.filter(p=>p.phase==='publish').every(p => p.backingMatches && p.viewMatches && Math.abs(p.verticalSpan - 3.2) < 1e-12), geometry);
    check('preview publishes coherent completed images during resize',
      geometry.some(p => p.phase === 'publish') && geometry.filter(p=>p.phase==='start').every(p=>Math.abs(p.verticalSpan-3.2)<1e-12), geometry);
    if (artifactsDir) await page.screenshot({ path: `${artifactsDir}/preview-resized.png` });
    const expected = await page.evaluate(async () => {
      const a = await import(document.querySelector('script[type=module][src*="/src/main.ts"]').src);
      const p = a.testing.camera.point(700, 420, innerWidth, innerHeight);
      return { x: p.x.toString(), y: p.y.toString() };
    });
    check('latest resized preview uses latest exact c',
      JSON.stringify(latest.preview.selected) === JSON.stringify(expected) &&
      latest.preview.renderedEpoch === latest.preview.epoch, latest.preview);
    check('selection during resize does not navigate Mandelbrot', JSON.stringify(latest.view) === before);

    await page.locator('#julia-preview').evaluate(panel => { panel.style.width = '500px'; });
    await page.keyboard.press('j');
    await until(({ preview }) => !preview.busy);
    const closed = await read();
    check('closing invalidates queued resize', !closed.preview.enabled && !closed.preview.pending, closed.preview);
    await page.keyboard.press('j'); await previewSettled();
    await page.keyboard.press('m');
    const promoted = await read();
    check('M promotes exact selected c after resize', promoted.view.family === 'julia' &&
      promoted.view.jx === expected.x && promoted.view.jy === expected.y, promoted.view);
    await page.keyboard.press('m');
    check('M returns unchanged Mandelbrot after resize', JSON.stringify((await read()).view) === before);

    await page.keyboard.press('j'); await previewSettled();
    await page.setViewportSize({ width: 360, height: 640 });
    const narrow = await previewSettled(); checkPixels(narrow);
    check('resized preview clamps inside narrow viewport',
      narrow.panel.x >= 0 && narrow.panel.y >= 0 &&
      narrow.panel.x + narrow.panel.width <= narrow.window.width &&
      narrow.panel.y + narrow.panel.height <= narrow.window.height, narrow.panel);
    if (artifactsDir) await page.screenshot({ path: `${artifactsDir}/preview-narrow.png` });
    check('no observer or runtime errors', errors.length === 0, errors);
    return checks;
  } catch (error) {
    console.error('PREVIEW_FAILURE ' + JSON.stringify({ lastState, errors, messages, error: String(error) }));
    if (artifactsDir) {
      const fs = await import('node:fs');
      fs.writeFileSync(`${artifactsDir}/failure.json`, JSON.stringify({ lastState, errors, messages, error: String(error) }, null, 2));
    }
    throw error;
  } finally { await page.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { chromium } = await import('playwright-core');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const output = process.env.GPU_ZOOMER_TEST_DIR || 'F:/Coding/Temp/GPU-Zoomer-3-streaming/preview-resize';
  fs.mkdirSync(output, { recursive: true });
  const context = await chromium.launchPersistentContext(path.join(output, 'edge-profile'), {
    channel: 'msedge', headless: true, chromiumSandbox: true,
    ignoreDefaultArgs: ['--enable-unsafe-swiftshader'], viewport: { width: 1100, height: 800 },
    deviceScaleFactor: Number(process.env.GPU_ZOOMER_TEST_DPR || 1),
  });
  try {
    const checks = await previewResizeChecks(context, process.env.GPU_ZOOMER_URL || 'http://127.0.0.1:5183', output);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(checks, null, 2));
    for (const result of checks) console.log(`PASS ${result.name}`);
  } finally { await context.close(); }
}
