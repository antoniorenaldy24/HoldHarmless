/**
 * Acceptance criteria for module 1.10 (§21 week 1):
 *   "All IVR and BOT_REP lines rendered to μ-law files with distinct voices per
 *    role; a 3-level menu navigable in both nav modes; playout queue honors
 *    clear and mark; control channel live"
 *
 * The integration tests use SYNTHETIC assets: every line is a few frames filled
 * with one byte unique to that line. CI has no TTS, and a byte-tagged line lets
 * the core side say exactly which line it heard — over the real transport,
 * through the real Goertzel decoder and the real playout queue. The rendered
 * assets are checked separately, where they exist.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dtmf, BYTES_PER_FRAME, SAMPLE_RATE, muLaw } from '@holdharmless/audio';
import { PROFILES } from '@holdharmless/transport';
import { LoopbackTransport } from '@holdharmless/transport-loopback';
import WebSocket from 'ws';
import {
  ASSET_DIR,
  HOLD_MUSIC_FILE,
  LINES,
  LINE_IDS,
  LOOP_SECONDS,
  MANIFEST,
  MAX_REPEATS,
  MENU,
  MenuNavigator,
  ROLE_VOICES,
  HarnessServer,
  Pacer,
  checkAssets,
  connectControl,
  fileAssets,
  holdMusicPcm,
  lineFile,
  parseSpokenChoice,
  renderKey,
  holdMusicKey,
  type AssetSource,
  type LineId,
  type SpeechRecognizer,
  type TelemetryMessage,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Lines and voices
// ---------------------------------------------------------------------------

describe('lines and voices', () => {
  test('each role has its own voice (§6.6, §10.5)', () => {
    const voices = Object.values(ROLE_VOICES).map((v) => v.voice);
    assert.equal(new Set(voices).size, voices.length);
  });

  test('every menu prompt is an IVR line', () => {
    for (const level of MENU) assert.equal(LINES[level.prompt].role, 'ivr', level.prompt);
  });

  test('every role speaks at least one line, and every line has text', () => {
    for (const role of Object.keys(ROLE_VOICES)) assert.ok(LINE_IDS.some((id) => LINES[id].role === role), role);
    for (const id of LINE_IDS) assert.ok(LINES[id].text.trim().length > 0, id);
  });

  test('the render key changes with the text, and only the text/voice/rate', () => {
    assert.notEqual(renderKey('rep1_greeting'), renderKey('rep1_goodbye'));
    assert.equal(renderKey('rep1_greeting'), renderKey('rep1_greeting'));
  });
});

// ---------------------------------------------------------------------------
// Menu logic
// ---------------------------------------------------------------------------

describe('menu navigator', () => {
  test('the path main 3 -> 1 -> 1 reaches a representative, first try at every level', () => {
    const nav = new MenuNavigator();
    assert.deepEqual(nav.start(), { kind: 'play', lines: ['ivr_main_menu'], level: 'main', firstTry: true });
    assert.deepEqual(nav.choose('3'), { kind: 'play', lines: ['ivr_priorauth_menu'], level: 'priorauth', firstTry: true });
    assert.deepEqual(nav.choose('1'), { kind: 'play', lines: ['ivr_service_menu'], level: 'service', firstTry: true });
    assert.deepEqual(nav.choose('1'), { kind: 'representative', lines: ['ivr_connecting'], path: ['3', '1', '1'], firstTry: true });
  });

  test('an unavailable option is announced and the level repeats; leaving it later is not first try', () => {
    const nav = new MenuNavigator();
    nav.start();
    assert.deepEqual(nav.choose('9'), { kind: 'play', lines: ['ivr_invalid', 'ivr_main_menu'], level: 'main', firstTry: false });
    assert.equal((nav.choose('3') as { firstTry: boolean }).firstTry, false);
  });

  test('no input repeats the menu, and gives up after the repeat limit', () => {
    const nav = new MenuNavigator();
    nav.start();
    for (let i = 0; i < MAX_REPEATS; i++) assert.deepEqual(nav.timeout().lines, ['ivr_no_input', 'ivr_main_menu']);
    assert.deepEqual(nav.timeout(), { kind: 'goodbye', lines: ['ivr_goodbye_no_input'] });
  });

  test('the repeat count resets on reaching a new level', () => {
    const nav = new MenuNavigator();
    nav.start();
    for (let i = 0; i < MAX_REPEATS; i++) nav.timeout();
    nav.choose('3');
    assert.equal(nav.timeout().kind, 'play');
  });

  describe('spoken choices', () => {
    const main = MENU[0]!;
    const cases: [string, string | null][] = [
      ['three', '3'],
      ['3', '3'],
      ['Prior authorization.', '3'],
      ["I'd like prior authorization, please.", '3'],
      ['prior authorization, three', '3'],
      ['Claims.', '2'],
      ['one or two', null], // two options named: ambiguous, not a guess
      ['claims, or maybe prior authorization', null],
      ['', null],
      ['Hello, this is an AI assistant calling on behalf of a clinic.', null],
    ];
    for (const [text, expected] of cases) test(JSON.stringify(text), () => assert.equal(parseSpokenChoice(text, main), expected));

    test('an unparseable reply counts as an invalid choice', () => {
      const nav = new MenuNavigator();
      nav.start();
      assert.deepEqual(nav.say('um, representative?').lines, ['ivr_invalid', 'ivr_main_menu']);
    });
  });
});

// ---------------------------------------------------------------------------
// Hold music
// ---------------------------------------------------------------------------

describe('hold music', () => {
  const pcm = holdMusicPcm();

  test('exactly one loop long, and deterministic', () => {
    assert.equal(pcm.length, LOOP_SECONDS * SAMPLE_RATE);
    assert.deepEqual(holdMusicPcm(), pcm);
  });

  test('audible, below full scale, and quiet at the loop point (no click)', () => {
    const rms = Math.sqrt(pcm.reduce((a, v) => a + v * v, 0) / pcm.length);
    assert.ok(rms > 500, `rms ${rms.toFixed(0)}`);
    const peak = pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    assert.ok(peak < 32767, `peak ${peak}`);
    // A click is a jump at the join: the step from the last sample back to the
    // first must be no larger than steps the music takes anywhere else.
    let maxStep = 0;
    for (let i = 1; i < pcm.length; i++) maxStep = Math.max(maxStep, Math.abs(pcm[i]! - pcm[i - 1]!));
    const join = Math.abs(pcm[0]! - pcm[pcm.length - 1]!);
    assert.ok(join <= maxStep / 10, `loop join step ${join} vs largest step ${maxStep}`);
    assert.ok(Math.abs(pcm[0]!) < 100 && Math.abs(pcm.at(-1)!) < 100, 'the loop starts and ends near silence');
  });
});

describe('pacer', () => {
  test('sends one frame per 20 ms, not a burst', async () => {
    const at: number[] = [];
    const p = new Pacer(() => at.push(performance.now()));
    const t0 = performance.now();
    await p.play(Array.from({ length: 25 }, () => new Uint8Array(BYTES_PER_FRAME)));
    const span = at.at(-1)! - t0;
    // 25 frames: the last is due at 24 x 20 = 480 ms. A burst would take ~0 ms.
    // The lower bound is the property; the upper one only catches a pacer that
    // stalls, and is loose because a shared CI machine may stall on its own.
    assert.ok(span >= 440 && span < 1500, `25 frames took ${span.toFixed(0)} ms`);
    assert.equal(at.length, 25);
  });

  test('stop() discards what is unsent and resolves the pending play', async () => {
    let sent = 0;
    const p = new Pacer(() => sent++);
    const done = p.play(Array.from({ length: 100 }, () => new Uint8Array(BYTES_PER_FRAME)));
    await sleep(60);
    p.stop();
    await done;
    await sleep(60);
    assert.ok(sent < 10, `${sent} frames sent`);
    assert.equal(p.playing, false);
  });
});

// ---------------------------------------------------------------------------
// Rendered assets
// ---------------------------------------------------------------------------

describe('asset checking', () => {
  function fakeAssets(mutate?: (m: { lines: Record<string, { file: string; key: string; bytes: number }> }, dir: string) => void): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-assets-'));
    const lines: Record<string, { file: string; key: string; bytes: number }> = {};
    for (const id of LINE_IDS) {
      const file = lineFile(id);
      fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), Buffer.alloc(800, 0x7f));
      lines[id] = { file, key: renderKey(id), bytes: 800 };
    }
    fs.mkdirSync(path.join(dir, 'hold'), { recursive: true });
    const music = muLaw.encode(holdMusicPcm());
    fs.writeFileSync(path.join(dir, HOLD_MUSIC_FILE), music);
    const manifest = { lines, holdMusic: { file: HOLD_MUSIC_FILE, key: holdMusicKey(), bytes: music.length } };
    mutate?.(manifest, dir);
    fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest));
    return dir;
  }

  test('a complete, current set passes', () => assert.deepEqual(checkAssets(fakeAssets()), []));

  test('a missing manifest, a stale line, a missing file and a wrong size are each reported', () => {
    assert.match(checkAssets(fs.mkdtempSync(path.join(os.tmpdir(), 'hh-empty-')))[0]!, /manifest\.json is missing/);
    assert.match(checkAssets(fakeAssets((m) => { m.lines['rep1_greeting']!.key = 'old'; })).join('\n'), /rep1_greeting: stale/);
    assert.match(checkAssets(fakeAssets((_m, dir) => fs.rmSync(path.join(dir, lineFile('rep2_goodbye'))))).join('\n'), /rep2_goodbye: .* is missing/);
    assert.match(checkAssets(fakeAssets((m) => { m.lines['ivr_invalid']!.bytes = 1; })).join('\n'), /ivr_invalid: .* manifest says 1/);
    assert.match(checkAssets(fakeAssets((m) => { delete m.lines['rep1_approved']; })).join('\n'), /rep1_approved: not rendered/);
  });

  test('fileAssets refuses to serve an incomplete set', () => {
    assert.throws(() => fileAssets(fakeAssets((m) => { m.lines['rep1_greeting']!.key = 'old'; })), /not ready/);
  });

  const rendered = fs.existsSync(path.join(ASSET_DIR, MANIFEST));
  test('the rendered assets are complete and current', { skip: rendered ? false : 'not rendered on this machine (pnpm render-assets); CI has no TTS' }, () => {
    assert.deepEqual(checkAssets(), []);
    const assets = fileAssets();
    for (const id of LINE_IDS) assert.ok(assets.line(id).length > 25, `${id} is under half a second`);
  });
});

// ---------------------------------------------------------------------------
// The harness, end to end over the real transport
// ---------------------------------------------------------------------------

const TAG_BASE = 0x20;
const tagOf = (id: LineId) => TAG_BASE + LINE_IDS.indexOf(id);
const MUSIC_TAG = 0x10;

function taggedAssets(framesPerLine: Partial<Record<LineId, number>> = {}): AssetSource {
  const frame = (tag: number) => new Uint8Array(BYTES_PER_FRAME).fill(tag);
  return {
    line: (id) => Array.from({ length: framesPerLine[id] ?? 5 }, () => frame(tagOf(id))),
    holdMusic: () => Array.from({ length: 10 }, () => frame(MUSIC_TAG)),
  };
}

const lineOfTag = new Map(LINE_IDS.map((id) => [tagOf(id), id]));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const until = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

class ScriptedRecognizer implements SpeechRecognizer {
  static last: ScriptedRecognizer | null = null;
  private handler: ((t: string) => void) | null = null;
  heard = 0;
  constructor() { ScriptedRecognizer.last = this; }
  feed(): void { this.heard++; }
  onUtterance(h: (t: string) => void): void { this.handler = h; }
  /** What a real recognizer would produce from the agent's speech. */
  utter(text: string): void { this.handler?.(text); }
}

type Call = {
  transport: LoopbackTransport;
  heard: LineId[];
  /** Consecutive frames heard per line segment, in order. */
  segments: { id: LineId | 'music'; frames: number }[];
  telemetry: TelemetryMessage[];
  pressDigit(d: string): Promise<void>;
  close(): Promise<void>;
};

async function startCall(harness: HarnessServer, callId: string): Promise<Call> {
  const transport = new LoopbackTransport();
  const telemetry: TelemetryMessage[] = [];
  const control = await connectControl(harness.controlUrl(), (m) => { if (m.callId === callId) telemetry.push(m); });
  const heard: LineId[] = [];
  const segments: Call['segments'] = [];
  transport.onAudio((frame) => {
    const tag = frame[0]!;
    const id = tag === MUSIC_TAG ? 'music' : lineOfTag.get(tag);
    if (!id) return;
    const lastSeg = segments.at(-1);
    if (lastSeg?.id === id) lastSeg.frames++;
    else {
      segments.push({ id, frames: 1 });
      if (id !== 'music') heard.push(id);
    }
  });
  await transport.dial(harness.callUrl(callId), PROFILES.TELEPHONY);
  transport.applyGate('dtmf_only');
  return {
    transport,
    heard,
    segments,
    telemetry,
    async pressDigit(d) {
      // Paced at the frame cadence, as the core's DTMF path will be: a burst
      // would overflow the 200 ms playout queue and lose the tone.
      for (const frame of dtmf.generate(d)) {
        transport.sendAudio(frame, 'dtmf');
        await sleep(20);
      }
    },
    async close() {
      control.close();
      await transport.hangup();
    },
  };
}

const metric = (c: Call, name: string) => c.telemetry.filter((t) => t.metric === name);

describe('the harness over the loopback transport', () => {
  const servers: HarnessServer[] = [];
  after(async () => { for (const s of servers) await s.close(); });

  const start = async (opts: Partial<Parameters<typeof HarnessServer.start>[0]> = {}) => {
    const h = await HarnessServer.start({ port: 0, profile: PROFILES.TELEPHONY, assets: taggedAssets(), navMode: 'dtmf', ...opts });
    servers.push(h);
    return h;
  };

  test('DTMF: a 3-level menu is navigated to the representative', async () => {
    const h = await start();
    const c = await startCall(h, 'SYN-CALL-dtmf');
    await waitFor('main menu', () => c.heard.includes('ivr_main_menu'));
    await c.pressDigit('3');
    await waitFor('prior-auth menu', () => c.heard.includes('ivr_priorauth_menu'));
    await c.pressDigit('1');
    await waitFor('service menu', () => c.heard.includes('ivr_service_menu'));
    await c.pressDigit('1');
    await waitFor('representative', () => c.heard.includes('rep1_greeting'));

    assert.deepEqual(c.heard, ['ivr_main_menu', 'ivr_priorauth_menu', 'ivr_service_menu', 'ivr_connecting', 'rep1_greeting']);
    await waitFor('telemetry', () => metric(c, 'menu_completed').length === 1);
    assert.equal(metric(c, 'menu_completed')[0]!.detail, '3>1>1');
    assert.deepEqual(metric(c, 'dtmf_decode_first_try').map((m) => [m.detail, m.value]), [['main', 1], ['priorauth', 1], ['service', 1]]);
    await c.close();
  });

  test('DTMF: a wrong digit is announced, the menu repeats, and first-try is reported as 0', async () => {
    const h = await start();
    const c = await startCall(h, 'SYN-CALL-wrong');
    await waitFor('main menu', () => c.heard.includes('ivr_main_menu'));
    await c.pressDigit('9');
    await waitFor('invalid + repeat', () => c.heard.filter((l) => l === 'ivr_main_menu').length === 2);
    assert.deepEqual(c.heard.slice(0, 3), ['ivr_main_menu', 'ivr_invalid', 'ivr_main_menu']);
    await c.pressDigit('3');
    await waitFor('telemetry', () => metric(c, 'dtmf_decode_first_try').length === 1);
    assert.deepEqual(metric(c, 'dtmf_decode_first_try').map((m) => [m.detail, m.value]), [['main', 0]]);
    await c.close();
  });

  test('an interrupted action does not go on to its next line', async () => {
    // A wrong digit queues [ivr_invalid, ivr_main_menu]. Pressing the right digit
    // during ivr_invalid must lead to the next level — not to the main menu the
    // interrupted action still had queued.
    const h = await start({ assets: taggedAssets({ ivr_invalid: 100 }) });
    const c = await startCall(h, 'SYN-CALL-supersede');
    await waitFor('main menu', () => c.heard.includes('ivr_main_menu'));
    await c.pressDigit('9');
    await waitFor('invalid', () => c.heard.includes('ivr_invalid'));
    await c.pressDigit('3');
    await waitFor('next level', () => c.heard.includes('ivr_priorauth_menu'));
    await sleep(300);
    assert.deepEqual(c.heard, ['ivr_main_menu', 'ivr_invalid', 'ivr_priorauth_menu']);
    await c.close();
  });

  test('a digit pressed during a prompt interrupts it (barge-in)', async () => {
    const h = await start({ assets: taggedAssets({ ivr_main_menu: 150 }) }); // a 3-second prompt
    const c = await startCall(h, 'SYN-CALL-barge');
    await waitFor('prompt started', () => c.heard.includes('ivr_main_menu'));
    await c.pressDigit('3');
    await waitFor('next level', () => c.heard.includes('ivr_priorauth_menu'));
    const main = c.segments.find((s) => s.id === 'ivr_main_menu')!;
    assert.ok(main.frames < 150, `the prompt played all ${main.frames} frames`);
    await c.close();
  });

  test('a tone cleared from the playout queue before it played is not decoded', async () => {
    // DTMF is decoded from what reaches the harness speaker. A tone the core
    // clear()ed (a gate narrowing, ADR-007) was never heard, so it selects nothing.
    const h = await start();
    const c = await startCall(h, 'SYN-CALL-cleared');
    await waitFor('main menu', () => c.heard.includes('ivr_main_menu'));
    for (const frame of dtmf.generate('3')) c.transport.sendAudio(frame, 'dtmf'); // a burst: queued, not yet played
    await c.transport.clear();
    await sleep(500);
    assert.ok(!c.heard.includes('ivr_priorauth_menu'), 'a cleared tone navigated the menu');
    await c.close();
  });

  test('a tone broken by an underflow hole is heard broken, not as one press', async () => {
    // Two 40 ms fragments of "3" with ~80 ms of empty queue between them. A
    // listener hears tone, silence, tone: two fragments, each too short to be a
    // key press. Decoding from played frames only would join them into 80 ms.
    const h = await start();
    const c = await startCall(h, 'SYN-CALL-hole');
    await waitFor('main menu', () => c.heard.includes('ivr_main_menu'));
    const tone = dtmf.generate('3', 100, 0);
    for (const part of [tone.slice(0, 2), tone.slice(2, 4)]) {
      for (const f of part) { c.transport.sendAudio(f, 'dtmf'); await sleep(20); }
      await sleep(80);
    }
    await sleep(300);
    assert.ok(!c.heard.includes('ivr_priorauth_menu'), 'the broken tone navigated the menu');
    await c.close();
  });

  test('no input for the timeout repeats the menu', async () => {
    const h = await start({ noInputTimeoutMs: 300 });
    const c = await startCall(h, 'SYN-CALL-timeout');
    await waitFor('repeat', () => c.heard.length >= 3);
    assert.deepEqual(c.heard.slice(0, 3), ['ivr_main_menu', 'ivr_no_input', 'ivr_main_menu']);
    await c.close();
  });

  test('the queue hold plays hold music before the representative', async () => {
    const h = await start({ queueHoldMs: 200 });
    const c = await startCall(h, 'SYN-CALL-hold');
    await waitFor('main', () => c.heard.includes('ivr_main_menu'));
    for (const [d, next] of [['3', 'ivr_priorauth_menu'], ['1', 'ivr_service_menu'], ['1', 'rep1_greeting']] as const) {
      await c.pressDigit(d);
      await waitFor(next, () => c.heard.includes(next));
    }
    const ids = c.segments.map((s) => s.id);
    assert.ok(ids.indexOf('music') > ids.indexOf('ivr_connecting') && ids.indexOf('music') < ids.indexOf('rep1_greeting'), ids.join(' '));
    await c.close();
  });

  test('speech: the same menu is navigated by spoken choices', async () => {
    const h = await start({ navMode: 'speech', recognizer: () => new ScriptedRecognizer() });
    const c = await startCall(h, 'SYN-CALL-speech');
    c.transport.applyGate('open');
    await waitFor('main menu', () => c.heard.includes('ivr_main_menu'));
    const rec = ScriptedRecognizer.last!;
    for (const [said, next] of [['prior authorization', 'ivr_priorauth_menu'], ['a new request', 'ivr_service_menu'], ['one', 'rep1_greeting']] as const) {
      rec.utter(said);
      await waitFor(next, () => c.heard.includes(next));
    }
    await waitFor('telemetry', () => metric(c, 'speech_choice_first_try').length === 3);
    assert.ok(metric(c, 'speech_choice_first_try').every((m) => m.value === 1));
    await c.close();
  });

  test('speech: the recognizer is fed what reaches the harness speaker', async () => {
    const h = await start({ navMode: 'speech', recognizer: () => new ScriptedRecognizer() });
    const c = await startCall(h, 'SYN-CALL-feed');
    c.transport.applyGate('open');
    await waitFor('main menu', () => c.heard.includes('ivr_main_menu'));
    for (let i = 0; i < 5; i++) { c.transport.sendAudio(new Uint8Array(BYTES_PER_FRAME).fill(0x55), 'agent'); await sleep(20); }
    await waitFor('fed', () => ScriptedRecognizer.last!.heard >= 5);
    await c.close();
  });

  test('speech mode without a recognizer is refused at start, not at the first menu', async () => {
    await assert.rejects(HarnessServer.start({ port: 0, profile: PROFILES.CLEAN, assets: taggedAssets(), navMode: 'speech' }), /needs a speech recognizer/);
  });

  test('DTMF mode ignores speech, and speech mode ignores DTMF', async () => {
    const h = await start({ navMode: 'speech', recognizer: () => new ScriptedRecognizer() });
    const c = await startCall(h, 'SYN-CALL-modes');
    await waitFor('main menu', () => c.heard.includes('ivr_main_menu'));
    await c.pressDigit('3');
    await sleep(300);
    assert.ok(!c.heard.includes('ivr_priorauth_menu'));
    await c.close();
  });

  test('the playout queue honors mark and clear through the harness', async () => {
    const h = await start({ assets: taggedAssets({ ivr_main_menu: 500 }) });
    const c = await startCall(h, 'SYN-CALL-queue');
    c.transport.applyGate('open');
    const marks: string[] = [];
    c.transport.onMark((m) => marks.push(m));

    // A mark after two frames is acknowledged once they are played.
    for (let i = 0; i < 2; i++) c.transport.sendAudio(new Uint8Array(BYTES_PER_FRAME).fill(0x60), 'agent');
    await c.transport.mark('played-mark');
    await waitFor('mark acknowledged', () => marks.includes('played-mark'));

    // Load the queue faster than it drains, mark it, and clear it: the mark is
    // returned by clear as discarded, never acknowledged as played.
    for (let i = 0; i < 8; i++) c.transport.sendAudio(new Uint8Array(BYTES_PER_FRAME).fill(0x61), 'agent');
    await c.transport.mark('discarded-mark');
    const discarded = await c.transport.clear();
    assert.deepEqual(discarded, ['discarded-mark']);
    await sleep(200);
    assert.ok(!marks.includes('discarded-mark'));
    await c.close();
  });

  test('control channel: a core that connects late still receives earlier telemetry', async () => {
    const h = await start();
    const c = await startCall(h, 'SYN-CALL-late');
    await waitFor('main', () => c.heard.includes('ivr_main_menu'));
    await c.pressDigit('3');
    await waitFor('reported', () => metric(c, 'dtmf_decode_first_try').length === 1);
    const late: TelemetryMessage[] = [];
    const ws = await connectControl(h.controlUrl(), (m) => late.push(m));
    await waitFor('backlog', () => late.some((m) => m.callId === 'SYN-CALL-late' && m.metric === 'dtmf_decode_first_try'));
    assert.ok(late.every((m) => typeof m.atMs === 'number' && !('seq' in m)), 'the harness never assigns seq (§10.4)');
    ws.close();
    await c.close();
  });

  test('a link that drops without a hangup message ends the call at the harness', async () => {
    // Before this was handled, the harness went on running the menu of a call
    // nobody was on: three no-input repeats, then a false menu_abandoned.
    const h = await start({ noInputTimeoutMs: 100 });
    const telemetry: TelemetryMessage[] = [];
    const control = await connectControl(h.controlUrl(), (m) => telemetry.push(m));
    const raw = new WebSocket(h.callUrl('SYN-CALL-drop'));
    await new Promise((r) => raw.once('open', r));
    await waitFor('session', () => h.sessions.has('SYN-CALL-drop'));
    raw.terminate();
    await waitFor('closed at the harness', () => h.sessions.get('SYN-CALL-drop')!.isClosed);
    await sleep(100 * (MAX_REPEATS + 2) + 300);
    assert.deepEqual(telemetry.filter((m) => m.callId === 'SYN-CALL-drop' && m.metric === 'menu_abandoned'), []);
    control.close();
  });

  test('a line can only be spoken by the persona whose voice rendered it', async () => {
    const h = await start();
    const c = await startCall(h, 'SYN-CALL-persona');
    await waitFor('session', () => h.sessions.has('SYN-CALL-persona'));
    const s = h.sessions.get('SYN-CALL-persona')!;
    await assert.rejects(s.speakAs(1, 'ivr_main_menu'), /is a ivr line; persona 1 is rep1/);
    await assert.rejects(s.speakAs(2, 'rep1_greeting'), /is a rep1 line; persona 2 is rep2/);
    await assert.rejects(s.streamMicrophone(1), /not built yet/);
    await c.close();
  });
});
