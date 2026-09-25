import {describe, expect, it} from 'vitest';
import {BatchFeedback} from '../../src/render/batch-feedback';

describe('local batch feedback', () => {
  it('starts and explicitly reseeds at the original allowance, preserving compatible warm feedback', () => {
    const feedback = new BatchFeedback();
    feedback.enterTarget(true);
    expect(feedback.budget(65_536, 8, 1_000_000)).toBe(65_536);
    feedback.observe(feedback.submit(65_536, 1, 8), 128, 'gpu');
    const warm = feedback.budget(65_536, 8, 1_000_000);
    expect(warm).toBe(4096);
    feedback.enterTarget();
    expect(feedback.budget(65_536, 8, 1_000_000)).toBe(warm);
    feedback.enterTarget(true);
    expect(feedback.budget(65_536, 8, 1_000_000)).toBe(65_536);
  });

  it('accepts lagged callbacks but rejects accepted-newer results, retired targets and invalid measurements', () => {
    const feedback = new BatchFeedback();
    const old = feedback.submit(1000, 1, 8), current = feedback.submit(1000, 1, 8);
    expect(feedback.observe(old, 8, 'gpu')).toBe(true);
    expect(feedback.observe(current, NaN, 'gpu')).toBe(false);
    expect(feedback.observe(current, 8, 'gpu')).toBe(true);
    expect(feedback.observe(old, 100, 'gpu')).toBe(false);
    expect(feedback.observe(current, 100, 'gpu')).toBe(false);
    const delayed = feedback.submit(1000, 1, 8), newer = feedback.submit(1000, 1, 8);
    expect(feedback.observe(newer, 8, 'gpu')).toBe(true);
    expect(feedback.observe(delayed, 100, 'gpu')).toBe(false);
    const retired = feedback.submit(1000, 1, 8);
    feedback.enterTarget();
    expect(feedback.observe(retired, 100, 'gpu')).toBe(false);
    expect(feedback.observe(feedback.submit(0, 1, 8), 8, 'gpu')).toBe(false);
    expect(feedback.observe(feedback.submit(Infinity, 1, 8), 8, 'gpu')).toBe(false);
    expect(feedback.msPerVisit).toBe(.008);
  });

  it('recovers from a slow estimate on quantized zero without an unlimited next batch', () => {
    const feedback = new BatchFeedback();
    feedback.budget(4096, 8, 1_000_000);
    feedback.observe(feedback.submit(4096, 1, 8), 512, 'gpu');
    expect(feedback.budget(4096, 8, 1_000_000)).toBe(64);
    feedback.observe(feedback.submit(64, 1, 8), 0, 'gpu');
    expect(feedback.budget(4096, 8, 1_000_000)).toBe(128);
    feedback.observe(feedback.submit(128, 1, 8), 0, 'gpu');
    expect(feedback.budget(4096, 8, 1_000_000)).toBe(256);
    expect(feedback.msPerVisit).toBeGreaterThan(0);
  });

  it('bounds growth by actual work and does not transfer coarse growth into dense admission', () => {
    const feedback = new BatchFeedback();
    feedback.budget(4096, 8, 1_000_000);
    feedback.observe(feedback.submit(4096, 16, 8), .001, 'gpu');
    expect(feedback.budget(4096, 8, 1_000_000, 16)).toBe(8192);
    expect(feedback.budget(4096, 8, 1_000_000, 1)).toBe(4096);
    feedback.observe(feedback.submit(4096, 1, 8), .001, 'gpu');
    expect(feedback.budget(4096, 8, 1_000_000)).toBe(8192);
    expect(feedback.budget(4096, 8, 100)).toBe(100);
  });

  it('continues adapting without GPU timestamps and separates fixed wall overhead from work', () => {
    const feedback = new BatchFeedback();
    feedback.budget(4096, 8, 1_000_000);
    expect(feedback.observe(feedback.submit(4096, 1, 8), 20, 'fallback')).toBe(true);
    expect(feedback.budget(4096, 8, 1_000_000)).toBe(2048);
    feedback.enterTarget();
    expect(feedback.observe(feedback.submit(2048, 1, 8), 20, 'fallback')).toBe(true);
    expect(feedback.budget(4096, 8, 1_000_000)).toBe(4096);
    expect(feedback.observe(feedback.submit(4096, 1, 8), 20, 'fallback')).toBe(true);
    expect(feedback.budget(4096, 8, 1_000_000)).toBe(8192);
    // A later increase proportional to work is still allowed to reduce admission.
    expect(feedback.observe(feedback.submit(8192, 1, 8), 100, 'fallback')).toBe(true);
    expect(feedback.budget(4096, 8, 1_000_000)).toBe(4096);
    expect(feedback.observe(feedback.submit(4096, 1, 8), 50, 'fallback')).toBe(true);
    expect(feedback.budget(4096, 8, 1_000_000)).toBe(2048);
  });
});
