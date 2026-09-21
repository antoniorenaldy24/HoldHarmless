/**
 * Shared scaffolding for the five Day-0 experiments.
 *
 * Two rules live here so no individual script can forget them:
 *
 *  1. EVERY inbound message is written to logs/<name>.jsonl verbatim, before it is
 *     interpreted. Half the value of Day 0 is in those files — the protocol details
 *     the SSOT marks as unconfirmed are found by reading the dump, not by guessing.
 *
 *  2. session.end is sent from a `finally` block, never from the success path.
 *     A script that throws mid-run leaves a socket hanging, and one unclosed session
 *     is billed for three hours (§20.2). That is the single largest avoidable expense
 *     on this project.
 */

import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

/**
 * Resolves a path against hh-day0/ rather than the current working directory,
 * so every script works whether it is run as `node e2.mjs` from inside the folder
 * or as `node hh-day0/e2.mjs` from the repository root.
 */
export const fromRoot = (...parts) => path.join(ROOT, ...parts);

/**
 * Rewrites an absolute path relative to where node was actually launched, so a
 * command printed for the user to copy actually resolves in their shell.
 */
export function forDisplay(absPath) {
  const rel = path.relative(process.cwd(), absPath);
  const out = rel && !rel.startsWith('..') ? rel : absPath;
  return out.split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** Loads the repository-root .env (Node 20.12+ / 22+). Missing file is not fatal. */
export function loadEnv() {
  const envPath = path.resolve(ROOT, '..', '.env');
  try {
    process.loadEnvFile(envPath);
  } catch {
    /* fall through to whatever is already exported in the shell */
  }

  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key || key.trim() === '') {
    console.error(
      `\n  ASSEMBLYAI_API_KEY is empty.\n` +
        `  Open ${envPath} and paste your key after the "=" on the first line.\n` +
        `  Get one at https://www.assemblyai.com/app/api-keys\n`,
    );
    process.exit(1);
  }

  return {
    key: key.trim(),
    url: (process.env.ASSEMBLYAI_WS_URL || 'wss://agents.assemblyai.com/v1/ws').trim(),
    voice: (process.env.ASSEMBLYAI_VOICE || 'michael').trim(),
    encoding: (process.env.AUDIO_ENCODING || 'audio/pcmu').trim(),
    sampleRate: Number(process.env.AUDIO_SAMPLE_RATE || 8000),
  };
}

// ---------------------------------------------------------------------------
// Logging — dump everything
// ---------------------------------------------------------------------------

export function makeLogger(name) {
  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
  const file = path.join(ROOT, 'logs', `${name}.jsonl`);
  const stream = fs.createWriteStream(file, { flags: 'a' });

  const rec = (tag, data) => {
    stream.write(JSON.stringify({ t: Date.now(), iso: new Date().toISOString(), tag, data }) + '\n');
  };

  rec('run_started', { name, node: process.version });
  return {
    file,
    rec,
    close: () =>
      new Promise((resolve) => {
        rec('run_ended', { name });
        stream.end(resolve);
      }),
  };
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/** Opens one socket. Resolves to the WebSocket, or null on failure/timeout. */
export function connect(url, key, log, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } });
    } catch (e) {
      log.rec('connect_throw', { url, message: e.message });
      return resolve(null);
    }

    const timer = setTimeout(() => {
      log.rec('connect_timeout', { url, timeoutMs });
      ws.terminate();
      resolve(null);
    }, timeoutMs);

    ws.on('open', () => {
      clearTimeout(timer);
      log.rec('connect_ok', { url });
      resolve(ws);
    });

    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      log.rec('connect_http_error', { url, status: res.statusCode, message: res.statusMessage });
      resolve(null);
    });

    ws.on('error', (e) => {
      clearTimeout(timer);
      log.rec('connect_error', { url, message: e.message });
      resolve(null);
    });
  });
}

/** Tries each candidate in order; returns { ws, url } for the first that opens. */
export async function connectFirst(urls, key, log) {
  for (const url of urls) {
    process.stdout.write(`  trying ${url} ... `);
    const ws = await connect(url, key, log);
    if (ws) {
      console.log('CONNECTED');
      log.rec('endpoint_selected', { url });
      return { ws, url };
    }
    console.log('failed');
  }
  return { ws: null, url: null };
}

// ---------------------------------------------------------------------------
// Message plumbing
// ---------------------------------------------------------------------------

export const send = (ws, log, payload) => {
  // reply.audio and input.audio carry large base64 blobs; log a summary, not the bytes.
  const summary =
    payload.type === 'input.audio'
      ? { type: payload.type, audioBytes: payload.audio?.length ?? 0 }
      : payload;
  log.rec('send', summary);
  ws.send(JSON.stringify(payload));
};

/**
 * Attaches the universal message handler. Every frame is logged before dispatch.
 * `onMessage(parsed, raw)` is called for each parsed message.
 */
export function listen(ws, log, onMessage) {
  ws.on('message', (raw) => {
    const text = raw.toString();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      log.rec('recv_unparseable', text.slice(0, 2000));
      return;
    }

    // Truncate the audio payload in the log but keep its size — the shape is what matters.
    if (parsed.type === 'reply.audio') {
      log.rec('recv', { type: parsed.type, dataBytes: parsed.data?.length ?? 0, keys: Object.keys(parsed) });
    } else {
      log.rec('recv', parsed);
    }

    if (parsed.type === 'session.error') {
      console.log(`  << session.error  code=${parsed.code}  ${parsed.message ?? ''}`);
    }

    try {
      onMessage(parsed, text);
    } catch (e) {
      log.rec('handler_throw', { message: e.message, stack: e.stack });
    }
  });

  ws.on('close', (code, reason) => log.rec('ws_close', { code, reason: reason?.toString() }));
  ws.on('error', (e) => log.rec('ws_error', { message: e.message }));
}

/** Waits for the first message satisfying `predicate`, or resolves null on timeout. */
export function waitFor(ws, predicate, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      resolve(null);
    }, timeoutMs);

    function handler(raw) {
      let parsed;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (predicate(parsed)) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(parsed);
      }
    }
    ws.on('message', handler);
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The close discipline (§20.2, §20.3)
// ---------------------------------------------------------------------------

/**
 * Runs `body(ws, log, env)` with a guaranteed session.end + socket close.
 *
 * The close path runs even when the body throws. That is the entire point:
 * `session.end` stops billing immediately, while a bare socket close leaves the
 * session resumable — and billable — for 30 seconds, and an abandoned one bills
 * for three hours.
 */
export async function withSession(name, body, { endpoints } = {}) {
  const env = loadEnv();
  const log = makeLogger(name);
  const urls = endpoints ?? [env.url];

  console.log(`\n=== ${name} ===`);
  console.log(`  log: ${log.file}`);

  const startedAt = Date.now();
  let ws = null;

  try {
    const picked = await connectFirst(urls, env.key, log);
    ws = picked.ws;
    if (!ws) throw new Error('no endpoint connected — see the log for status codes');

    await body(ws, log, env, picked.url);
  } catch (e) {
    console.error(`\n  FAILED: ${e.message}`);
    log.rec('fatal', { message: e.message, stack: e.stack });
    process.exitCode = 1;
  } finally {
    if (ws && ws.readyState === WebSocket.OPEN) {
      log.rec('send', { type: 'session.end' });
      ws.send(JSON.stringify({ type: 'session.end' }));
      // Give the server a moment to acknowledge with session.ended before closing.
      await Promise.race([waitFor(ws, (m) => m.type === 'session.ended', 3000), sleep(3000)]);
      ws.close();
    } else if (ws) {
      ws.terminate();
    }

    const elapsedMs = Date.now() - startedAt;
    log.rec('billable_estimate', { elapsedMs, minutes: +(elapsedMs / 60000).toFixed(2) });
    await log.close();

    console.log(`\n  socket time: ${(elapsedMs / 60000).toFixed(2)} min  (~$${((elapsedMs / 60000) * 0.075).toFixed(3)})`);
    console.log(`  log written: ${log.file}\n`);
  }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function report(label, values) {
  if (values.length === 0) {
    console.log(`  ${label}: no samples`);
    return { n: 0 };
  }
  const out = {
    n: values.length,
    min: Math.min(...values),
    median: percentile(values, 50),
    p90: percentile(values, 90),
    max: Math.max(...values),
  };
  console.log(
    `  ${label}: n=${out.n}  min=${out.min}ms  median=${out.median}ms  p90=${out.p90}ms  max=${out.max}ms`,
  );
  return out;
}
