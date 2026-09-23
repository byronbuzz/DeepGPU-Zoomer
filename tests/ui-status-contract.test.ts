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
});
