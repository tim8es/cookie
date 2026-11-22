import assert from 'node:assert/strict';
import test from 'node:test';

import { runStartupSeries } from './f1-chromium-stress.mjs';

const ready = (attempt = 1, failures = []) => ({
  attempt, startup: { elapsedMs: 32, stage: 'page-target', probes: 2 }, failures,
});

test('bounded samples execute sequentially and preserve recovered startup evidence', async () => {
  const calls = [];
  const summary = await runStartupSeries(3, async (sample) => {
    calls.push('begin-' + sample);
    await Promise.resolve();
    calls.push('end-' + sample);
    return sample === 2 ? ready(2, ['synthetic port-file timeout']) : ready();
  });
  assert.deepEqual(calls, ['begin-1', 'end-1', 'begin-2', 'end-2', 'begin-3', 'end-3']);
  assert.equal(summary.passed, 3);
  assert.equal(summary.failed, 0);
  assert.equal(summary.recovered, 1);
  assert.deepEqual(summary.results.map((x) => x.attempt), [1, 2, 1]);
  assert.equal(summary.results[1].recoveredFailures[0], 'synthetic port-file timeout');
});

test('failures are not silently retried or dropped and later samples still run', async () => {
  const called = [];
  const summary = await runStartupSeries(3, async (sample) => {
    called.push(sample);
    if (sample === 2) throw new Error('two bounded attempts timed out at port-file');
    return ready();
  });
  assert.deepEqual(called, [1, 2, 3]);
  assert.deepEqual(summary.results.map((x) => x.status), ['PASS', 'FAIL', 'PASS']);
  assert.equal(summary.passed, 2);
  assert.equal(summary.failed, 1);
  assert.match(summary.results[1].diagnostic, /port-file/);
});

test('invalid observations count as failures instead of false green', async () => {
  const summary = await runStartupSeries(2, async (sample) =>
    sample === 1 ? { attempt: 3, startup: { elapsedMs: 1 }, failures: [] } : ready());
  assert.equal(summary.failed, 1);
  assert.equal(summary.results[0].status, 'FAIL');
  assert.match(summary.results[0].diagnostic, /Invalid Chromium startup observation/);
});

test('rejects invalid or unbounded samples without launching', async () => {
  let launched = 0;
  for (const count of [0, -1, 21, 1.5, NaN, Infinity]) {
    await assert.rejects(runStartupSeries(count, async () => { launched++; return ready(); }), /1\.\.20/);
  }
  assert.equal(launched, 0);
});

test('diagnostics are bounded for machine-readable logging', async () => {
  const summary = await runStartupSeries(2, async (sample) => {
    if (sample === 1) return ready(2, ['x'.repeat(9999)]);
    throw new Error('y'.repeat(9999));
  });
  assert.equal(summary.results[0].recoveredFailures[0].length, 1200);
  assert.equal(summary.results[1].diagnostic.length, 1600);
});
