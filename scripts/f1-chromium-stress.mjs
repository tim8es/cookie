// Opt-in Linux CI diagnostic for #164. No API, DB, Booking mutations or real accounts.
// Repeats ONLY the existing bounded pre-CDP Chromium startup procedure.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { probeChromiumPage, startChromiumWithRetry } from './f1-chromium-startup.mjs';

const MAX_SAMPLES = 20;

// Injectable so aggregation, failure visibility and bounds are tested without Chromium.
export async function runStartupSeries(samples, exercise) {
  if (!Number.isInteger(samples) || samples < 1 || samples > MAX_SAMPLES || typeof exercise !== 'function') {
    throw new Error('Expected 1..20 Chromium startup samples and an exercise function');
  }
  const results = [];
  for (let sample = 1; sample <= samples; sample++) {
    try {
      const outcome = await exercise(sample);
      const startup = outcome?.startup;
      if (!Number.isInteger(outcome?.attempt) || outcome.attempt < 1 || outcome.attempt > 2 ||
          !Number.isInteger(startup?.elapsedMs) || startup.elapsedMs < 0 ||
          !Array.isArray(outcome.failures)) {
        throw new Error('Invalid Chromium startup observation');
      }
      results.push({
        sample, status: 'PASS', attempt: outcome.attempt, elapsedMs: startup.elapsedMs,
        stage: startup.stage, probes: startup.probes,
        recoveredFailures: outcome.failures.map((message) => String(message).slice(0, 1200)),
      });
    } catch (error) {
      const message = String(error?.message ?? error);
      results.push({ sample, status: 'FAIL', diagnostic: message.slice(0, 1600) });
      // Failed reaping/cleanup must not launch the next sample with a live orphan.
      if (/cleanup FAILED|Chromium child could not be reaped/.test(message)) break;
    }
  }
  const passed = results.filter((result) => result.status === 'PASS').length;
  const recovered = results.filter((result) => result.status === 'PASS' && result.recoveredFailures.length > 0).length;
  return { samples, executed: results.length, passed,
    failed: results.filter((result) => result.status === 'FAIL').length,
    incomplete: samples - results.length, recovered, results };
}

function browserBinary() {
  const options = [process.env.COOKIE_BROWSER_BINARY, 'google-chrome', 'google-chrome-stable',
    'chromium', 'chromium-browser'].filter(Boolean);
  for (const option of options) {
    const found = spawnSync('which', [option], { encoding: 'utf8' });
    if (found.status === 0) return found.stdout.trim();
    if (existsSync(option)) return option;
  }
  throw new Error('Chromium binary is required; set COOKIE_BROWSER_BINARY if needed');
}

async function stopChrome(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((done) => child.once('close', done));
  child.kill('SIGTERM');
  await Promise.race([closed, sleep(800)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([closed, sleep(800)]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error('Chromium child could not be reaped');
  }
}

function getLocal(url) {
  return new Promise((ok, fail) => {
    const req = httpGet(url, { timeout: 1800 }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 65536) req.destroy(new Error('Oversized local CDP discovery response'));
        else chunks.push(chunk);
      });
      res.on('end', () => ok({ code: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', fail);
    });
    req.on('timeout', () => req.destroy(new Error('Local CDP discovery GET timed out')));
    req.on('error', fail);
  });
}

async function probeOnce(executable) {
  const disposeAttempt = async ({ chrome, dir }) => {
    try {
      await stopChrome(chrome);
      if (chrome.exitCode === null && chrome.signalCode === null) {
        throw new Error('Chromium child could not be reaped');
      }
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      // A failed profile removal is as fatal as an unreaped child.
      throw new Error('Chromium stress cleanup FAILED: ' + error.message);
    }
  };
  const started = await startChromiumWithRetry({
    attempts: 2, startupTimeoutMs: 12000, intervalMs: 100,
    startAttempt: async () => {
      const dir = mkdtempSync(join(tmpdir(), 'kuki-f1-cdp-stress-'));
      let child;
      try {
        child = spawn(executable, [
          '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
          '--disable-background-networking', '--no-first-run',
          '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
          '--user-data-dir=' + dir, 'about:blank',
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (error) {
        rmSync(dir, { recursive: true, force: true });
        throw error;
      }
      const handle = { chrome: child, dir, logs: [], startupError: null, executable: basename(executable) };
      child.stderr?.on('data', (chunk) => {
        handle.logs.push(String(chunk).slice(0, 500));
        if (handle.logs.length > 20) handle.logs.shift();
      });
      child.on('error', (error) => { handle.startupError = error.message; });
      return handle;
    },
    probe: (handle) => probeChromiumPage(handle, {
      readPort(dir) {
        try { return readFileSync(join(dir, 'DevToolsActivePort'), 'utf8'); }
        catch (error) {
          if (error.code === 'ENOENT') return null;
          throw new Error('CDP port file read failed: ' + (error.code ?? 'unknown'));
        }
      },
      getLocal,
    }),
    disposeAttempt,
  });
  try {
    return { attempt: started.attempt, startup: started.startup, failures: started.failures };
  } finally {
    await disposeAttempt(started.handle);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && !/^--samples=\d+$/.test(args[0]))) {
      throw new Error('Usage: node scripts/f1-chromium-stress.mjs [--samples=10]');
    }
    const samples = args.length ? Number(args[0].slice('--samples='.length)) : 10;
    // Validate before locating or spawning any browser.
    if (!Number.isInteger(samples) || samples < 1 || samples > MAX_SAMPLES) {
      throw new Error('Chromium startup sample count must be 1..20');
    }
    const executable = browserBinary();
    const summary = await runStartupSeries(samples, () => probeOnce(executable));
    for (const result of summary.results) {
      console.log('F1 CHROMIUM STRESS SAMPLE', JSON.stringify(result));
    }
    console.log('F1 CHROMIUM STRESS SUMMARY', JSON.stringify({
      samples: summary.samples, executed: summary.executed, passed: summary.passed,
      failed: summary.failed, incomplete: summary.incomplete,
      recovered: summary.recovered, executable: basename(executable),
    }));
    if (summary.failed || summary.incomplete) process.exitCode = 1;
  } catch (error) {
    console.error('F1 CHROMIUM STRESS FAILED:', error.message);
    process.exitCode = 1;
  }
}
