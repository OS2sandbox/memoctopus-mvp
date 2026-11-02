import { describe, expect, it, vi } from 'vitest';
import { withRetractableReport } from './retractable-report';

describe('withRetractableReport', () => {
  it('early: reports before the work, keeps the event when something was deleted', async () => {
    const retract = vi.fn();
    const order: string[] = [];
    const report = vi.fn(() => (order.push('report'), retract));
    await withRetractableReport(true, report, async () => (order.push('work'), true));
    expect(order).toEqual(['report', 'work']);
    expect(report).toHaveBeenCalledOnce();
    expect(retract).not.toHaveBeenCalled();
  });

  it('early: retracts when the work finds nothing, and when it throws (the error is rethrown)', async () => {
    const retract = vi.fn();
    await withRetractableReport(true, () => retract, async (retractIfMissing) => (retractIfMissing(), false));
    expect(retract).toHaveBeenCalledTimes(1);
    retract.mockClear();
    await expect(
      withRetractableReport(true, () => retract, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(retract).toHaveBeenCalledTimes(1);
  });

  it('not early: reports once after the work, and only when something existed', async () => {
    const report = vi.fn(() => undefined);
    await withRetractableReport(false, report, async () => false);
    expect(report).not.toHaveBeenCalled();
    await withRetractableReport(false, report, async () => true);
    expect(report).toHaveBeenCalledOnce();
    await expect(withRetractableReport(false, report, async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(report).toHaveBeenCalledOnce();
  });

  it('a delete that THROWS is reported as a failure (not silently retracted); one that found nothing is not', async () => {
    const retract = vi.fn();
    const fail = vi.fn();
    await expect(
      withRetractableReport(true, () => retract, async () => { throw new Error('boom'); }, fail),
    ).rejects.toThrow('boom');
    expect(retract).toHaveBeenCalledTimes(1);
    expect(fail).toHaveBeenCalledOnce();

    fail.mockClear();
    await expect(
      withRetractableReport(false, () => undefined, async () => { throw new Error('boom'); }, fail),
    ).rejects.toThrow('boom');
    expect(fail).toHaveBeenCalledOnce();

    // Nothing existed (retractIfMissing was called) and then the work threw: nothing to report.
    fail.mockClear();
    await expect(
      withRetractableReport(true, () => retract, async (missing) => { missing(); throw new Error('boom'); }, fail),
    ).rejects.toThrow('boom');
    expect(fail).not.toHaveBeenCalled();

    // A failure reporter that throws never hides the real error.
    await expect(
      withRetractableReport(false, () => undefined, async () => { throw new Error('real'); }, () => { throw new Error('reporter'); }),
    ).rejects.toThrow('real');
  });

  it('a report that throws never fails the delete', async () => {
    const work = vi.fn(async () => true);
    await withRetractableReport(true, () => { throw new Error('report'); }, work);
    expect(work).toHaveBeenCalledOnce();
  });
});
