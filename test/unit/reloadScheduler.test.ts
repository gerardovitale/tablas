import * as assert from 'assert';
import { ReloadScheduler } from '../../src/reloadScheduler';

/** A manual clock: timers fire only when the test advances time. */
function makeHarness(options: { busy?: () => boolean } = {}) {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const log: string[] = [];
  const scheduler = new ReloadScheduler({
    debounceMs: 750,
    maxWaitMs: 30_000,
    isWriteInProgress: async () => options.busy?.() ?? false,
    reload: async () => {
      log.push('reload');
    },
    onWaiting: () => {
      log.push('waiting');
    },
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
    now: () => now,
  });
  /** Moves the clock forward, firing due timers (and letting their async work settle). */
  async function advance(ms: number): Promise<void> {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) {
        break;
      }
      now = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
      await new Promise((resolve) => setImmediate(resolve));
    }
    now = target;
  }
  return { scheduler, log, advance, pending: () => timers.size };
}

describe('ReloadScheduler', () => {
  it('reloads once after the quiet period', async () => {
    const { scheduler, log, advance } = makeHarness();
    scheduler.notify();
    await advance(749);
    assert.deepStrictEqual(log, []);
    await advance(1);
    assert.deepStrictEqual(log, ['reload']);
  });

  it('collapses a burst of events into one reload', async () => {
    const { scheduler, log, advance } = makeHarness();
    scheduler.notify();
    await advance(500);
    scheduler.notify();
    await advance(500);
    scheduler.notify();
    await advance(749);
    assert.deepStrictEqual(log, []);
    await advance(1);
    assert.deepStrictEqual(log, ['reload']);
    await advance(10_000);
    assert.deepStrictEqual(log, ['reload']);
  });

  it('waits while a write is in progress, then reloads once it is done', async () => {
    let busy = true;
    const { scheduler, log, advance } = makeHarness({ busy: () => busy });
    scheduler.notify();
    await advance(750);
    await advance(750);
    assert.deepStrictEqual(log, ['waiting', 'waiting']);
    busy = false;
    await advance(750);
    assert.deepStrictEqual(log, ['waiting', 'waiting', 'reload']);
  });

  it('gives up waiting after maxWaitMs so a crashed writer cannot keep the view stale', async () => {
    const { scheduler, log, advance } = makeHarness({ busy: () => true });
    scheduler.notify();
    await advance(29_000);
    assert.ok(!log.includes('reload'));
    await advance(2_000);
    assert.strictEqual(log.filter((entry) => entry === 'reload').length, 1);
  });

  it('starts a fresh wait budget for the next burst', async () => {
    let busy = false;
    const { scheduler, log, advance } = makeHarness({ busy: () => busy });
    scheduler.notify();
    await advance(750);
    assert.deepStrictEqual(log, ['reload']);
    busy = true;
    scheduler.notify();
    await advance(750);
    assert.deepStrictEqual(log, ['reload', 'waiting']);
  });

  it('does nothing after dispose', async () => {
    const { scheduler, log, advance, pending } = makeHarness();
    scheduler.notify();
    scheduler.dispose();
    assert.strictEqual(pending(), 0);
    scheduler.notify();
    await advance(5_000);
    assert.deepStrictEqual(log, []);
  });

  it('treats a failing write check as "not busy"', async () => {
    const log: string[] = [];
    let fire: (() => void) | undefined;
    const scheduler = new ReloadScheduler({
      debounceMs: 1,
      maxWaitMs: 10,
      isWriteInProgress: () => Promise.reject(new Error('stat failed')),
      reload: async () => {
        log.push('reload');
      },
      onWaiting: () => undefined,
      setTimer: (fn) => {
        fire = fn;
        return 1;
      },
      clearTimer: () => undefined,
    });
    scheduler.notify();
    fire?.();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(log, ['reload']);
  });
});
