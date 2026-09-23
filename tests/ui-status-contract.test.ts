import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../src/style.css',import.meta.url),'utf8');
const main=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');

describe('bounded controls and footer wording',()=>{
  it('removes the iteration helper and leaves exactly eight pixels of top padding inside each tab',()=>{
    expect(html).not.toContain('iteration-detail');
    expect(html).not.toContain('Fixed limit.');
    expect((html.match(/class="tab-panel"/g)??[])).toHaveLength(3);
    expect(css).toContain('.tab-panel{min-width:0;padding:8px 16px 0}');
  });
  it('keeps ordinary preparation numeric-only, without adding a replacement status',()=>{
    expect(html).toContain('<span id="freshness">Time taken: 00:00.00</span>');
    expect(html).not.toContain('Preparing first field');
    expect(main).not.toContain('Preparing current view');
    expect(main).toContain("preparingColourData?`${colourPreparationLabel()} · `:''");
    expect(main).toContain('refinementTime.text(performance.now())');
  });
  it('keeps the requested controls inside the existing panels without new footer text',()=>{
    expect(html).not.toContain('id="fullscreen"');
    expect(main).not.toContain('requestFullscreen');
    expect(main).not.toContain('fullscreenchange');
    expect(html).toContain('id="rotation" type="range" min="-180" max="180"');
    expect(html.indexOf('id="rotation"')).toBeGreaterThan(html.indexOf('id="iteration-slider"'));
    expect(html.indexOf('id="rotation"')).toBeLessThan(html.indexOf('id="family"'));
    expect(html).toContain('Controls:<br>F11 = Fullscreen, Esc/F11 = Exit fullscreen<br>J = Julia Preview, M = Julia/Mandelbrot toggle<br>Zoom in/out = left/right-click or wheel or +/− keys<br>Rotate = Ctrl+drag, Pan = Shift-drag');
    expect(html).toContain('id="location-entry"');
    expect(html).not.toContain('id="location-name"');
    expect(html).not.toContain('id="locations"');
    expect(html).not.toContain('id="reset-layout"');
    expect(html).toContain('View height (complex units)');
    expect(html.indexOf('id="location-entry"')).toBeLessThan(html.indexOf('id="save"'));
    expect(html.indexOf('id="save"')).toBeLessThan(html.indexOf('id="linked-location"'));
    const advanced=html.slice(html.indexOf('id="panel-advanced"'));
    expect(advanced.indexOf('id="panel-opacity"')).toBeLessThan(advanced.indexOf('id="post-antialias"'));
    expect(advanced.indexOf('id="post-antialias"')).toBeLessThan(advanced.indexOf('id="coordinates"'));
    expect(main).toContain('panelController.reset();load(');
  });
});
