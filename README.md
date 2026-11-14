# HoldHarmless — Autonomous Outbound Voice Agent for Healthcare Telephony

[![Test Suite](https://img.shields.io/badge/Tests-795%2F795%20Passed-brightgreen)](file:///tests)
[![Invariants](https://img.shields.io/badge/Invariants-21%2F21%20Verified-blue)](file:///packages/invariants)
[![Audio Transport](https://img.shields.io/badge/Audio-G.711%20μ--law%208kHz-orange)](file:///packages/transport)
[![LLM Bridge](https://img.shields.io/badge/Voice%20API-AssemblyAI%20v2-purple)](file:///apps/core)
[![License](https://img.shields.io/badge/License-MIT-gray)](file:///LICENSE)

> **"The hard part is not understanding speech; it is deciding when to be silent."**  
> HoldHarmless is an enterprise-grade autonomous outbound telephony agent designed to navigate health insurance switchboards, handle prolonged hold queues, engage representatives under strict privacy constraints, and securely capture prior authorization approvals without audio leakage or hallucination.

---

## 🌟 Executive Summary

Medical clinics spend thousands of hours on the phone submitting and tracking prior authorizations. Existing conversational AI fails in this environment because telephony IVRs are adversarial: they present multi-level DTMF menus, hold music interleaved with promotional interruptions, sudden transfers between departments, and strict HIPAA/ethical disclosure requirements.

HoldHarmless solves the hardest challenges of outbound voice telephony:
1. **Asymmetric Call Dynamic**: The agent places the call rather than receiving it. What answers is an impatient interactive voice response (IVR), followed by indefinite hold audio, followed by a human who interrupts.
2. **Derived Audio Gate (ADR-007)**: The agent's microphone/audio output is mechanically gated based on *who is listening*, never on business progress. It closes instantly on **suspicion** (<15 ms) and only opens on dual-tier acoustic or semantic **confirmation**.
3. **Zero Audio Leakage**: When the gate closes, active playout queues are purged with sequence marks to ensure not a single millisecond of background or internal speech reaches the payer.
4. **Guaranteed Ethical AI Disclosure (INV-14, INV-15)**: The agent announces its AI identity to *every unique human party* that answers, surviving multi-party announced and unannounced transfers (`disclosuresDelivered >= parties_used`).
5. **Exact Readback & Zero Hallucination (INV-8, INV-10)**: Approval authorization numbers must be phonetically read back and explicitly confirmed by the representative before closing.
6. **Minimum Necessary Disclosure (A-31)**: Patient and provider information is retrieved strictly on-demand per representative question via localized tool calls, preventing over-disclosure.

---

## 🏗 System Architecture

```
                          +-------------------------------------------------------+
                          |             HoldHarmless Telephony Bridge             |
                          +-------------------------------------------------------+
                                                     |
               +-------------------------------------+-------------------------------------+
               |                                                                           |
               v                                                                           v
+-----------------------------+                                             +-----------------------------+
|    Far-End Telephony Link   |                                             |    AssemblyAI Voice API     |
|   (Simulated Switchboard)   |                                             |   (Real-time LLM Session)   |
+-----------------------------+                                             +-----------------------------+
     | G.711 μ-law (8 kHz)                                                       ^ 16 kHz Linear PCM
     | 20 ms frames                                                              | Full Duplex WebSocket
     v                                                                           v
+---------------------------------------------------------------------------------------------------------+
|                                           APPS / CORE CALL LOOP                                         |
|                                                                                                         |
|  [ Inbound Audio ] ──────> [ Dual Classifiers ] ─────> [ Suspicion Engine ] ─────> [ Derived Gate ]     |
|                               • Goertzel DTMF             • Hold cues                  closed /         |
|                               • Spectral Flatness         • Periodic audio             dtmf_only /      |
|                               • Harmonic / Pitch          • Transfer cues              open             |
|                                                                                          │              |
|  [ Outbound Audio ] <────── [ Audio Bridge / Playout Queue ] <───────────────────────────+              |
|                               • Purge on Close                                           │              |
|                               • Frame Pacing (20ms)                                      v              |
|                                                                             [ Dynamic Session Guard ]   |
|                                                                               • Interruption Config     |
|                                                                               • Dynamic Tool Injection  |
|                                                                               • Prompt Switching        |
+---------------------------------------------------------------------------------------------------------+
```

---

## ⚙️ State Machines: Channel vs. Phase

HoldHarmless enforces strict separation between **Channel** (who is on the line) and **Phase** (what business step is being performed).

```
CHANNEL STATE MACHINE (Who is listening?)

   [DIALING]
       │ (Link established)
       ▼
     [IVR] ◄────────────────────────────────────────┐
       │                                            │
       ├──────────────┐ (Acoustic Hold)             │
       │              ▼                             │
       │           [HOLD]                           │
       │              │                             │
       │ (Human)      │ (Human answered)            │
       ▼              ▼                             │
    [HUMAN] ──────────────────────┐                 │
       │                          │ (notify_transfer)
       │ (Agent/Far-end hangup)   ▼                 │
       │                      [TRANSFER] ───────────┘
       ▼
    [CLOSED]
```

```
PHASE STATE MACHINE (Business Progress)

   [NOT_STARTED]
       │ (First Human Contact)
       ▼
   [EXCHANGE] ──(capture_auth_number)──► [READBACK]
                                             │
                                             │ (confirm_readback: matched)
                                             ▼
                                         [CLOSING]
                                             │
                                             │ (record_outcome & agent farewell)
                                             ▼
                                          [DONE]
```

### The Derived Audio Gate Formula (ADR-007)

The audio gate is never set manually by the application code. It is a pure derivation:

| Channel | Suspicion / NavMode | Derived Gate State | Far-End Output Permitted |
| :--- | :--- | :--- | :--- |
| `DIALING` | *any* | `closed` | Complete silence |
| `IVR` | `navMode: 'dtmf'` | `dtmf_only` | Goertzel synthesized dual-tone frequencies only |
| `IVR` | `navMode: 'speech'` | `open` | Spoken menu choices |
| `HOLD` | *any* | `closed` | Complete silence (purge active audio buffer) |
| `HUMAN` | `holdSuspected: true` | `closed` | Instant silence upon cue phrase detection |
| `HUMAN` | `holdSuspected: false`| `open` | Agent conversational voice |
| `TRANSFER`| *any* | `closed` | Complete silence |
| `CLOSED` | *any* | `closed` | Complete silence |

---

## 🔒 Formally Verified Invariants (SSOT §17.1)

Every call session produces an append-only JSONL event log that acts as the audit record. 21 formal runtime invariants are mechanically audited on every call:

| ID | Category | Formal Guarantee | Verification Status |
| :--- | :--- | :--- | :--- |
| **INV-1** | Safety | Outbound audio packet stream strictly matches derived gate admission. | ✅ Audited & Replayed |
| **INV-2** | Gate | Gate admission table accurately blocks speech during DTMF and HOLD. | ✅ 100% Pass Rate |
| **INV-3** | Safety | Every gate constriction immediately issues an audio buffer purge (`clear`). | ✅ Verified <300ms |
| **INV-4** | Audio | Zero milliseconds of agent speech audible during HOLD or TRANSFER. | ✅ 0.00 ms measured |
| **INV-7** | Ethics | Ethical AI disclosure delivered to every unique human party (`disclosuresDelivered >= parties_used`). | ✅ A-12 Multi-Party Pass |
| **INV-8** | Transfer | `notify_transfer` resets disclosure obligation and shifts channel to `TRANSFER`. | ✅ Cleanly Handled |
| **INV-10**| Outcome | Authorization outcome is recorded before closing; no outcomes after final status. | ✅ Enforced at Handler |
| **INV-12**| Privacy | All patient data is strictly synthetic (non-validating NPI check digits, 555-numbers, SYN prefixes). | ✅ 0 Non-Synthetic Leaks |
| **INV-14**| Ethics | Mandatory AI identity disclosure spoken within the first agent conversational turn. | ✅ Verified Party 1 & 2 |
| **INV-15**| Integrity| No authorization number recorded without passing phonetic readback. | ✅ Exact String Match |
| **INV-16**| Telemetry| No test or benchmark figure produced under non-telephony network conditions. | ✅ Profile Enforced |

---

## 📊 Benchmark & Test Results

```
======================================================================
  HOLDHARMLESS TEST & VERIFICATION SUITE
======================================================================
  Unit & Integration Suites:     188 / 188 passed (795 tests, 0 failures)
  Static Invariant Proofs:       5 / 5 passed (INV-11, INV-21, INV-17, INV-16, §18)
  Document & Claim Audits:       12 / 12 passed
  Degraded Network Robustness:   PASSED (60ms delay, 25ms jitter, 1% loss)
  Multi-Party Transfer (A-12):   PASSED (100% disclosure rate across transfers)
  Data Over-disclosure (A-31):   0 over-disclosures (Minimum necessary policy)
======================================================================
```

---

## 🚀 Quickstart Guide

### 1. Prerequisites
- **Node.js**: `v22.0.0` or higher
- **pnpm**: `v9.0.0` or higher
- **AssemblyAI API Key**: Obtain a key from [AssemblyAI](https://www.assemblyai.com)

### 2. Installation & Setup
```bash
# Clone the repository
git clone https://github.com/your-username/HoldHarmless.git
cd HoldHarmless

# Install dependencies across all monorepo workspaces
pnpm install

# Set your AssemblyAI API key
# On Linux / macOS:
export ASSEMBLYAI_API_KEY="your_api_key_here"
# On Windows PowerShell:
$env:ASSEMBLYAI_API_KEY="your_api_key_here"
```

### 3. Running Verification Suites
```bash
# Run all 795 unit and integration tests across 188 suites
pnpm test

# Run static invariant proofs (state reachability, dead-end analysis)
pnpm check:invariants

# Run documentation consistency and claims verification
pnpm check:doc

# Run full project typecheck and dashboard build
pnpm check
```

### 4. Running a Live Call Session
HoldHarmless features an integrated, high-fidelity local IVR switchboard emulator and real-time dashboard API.

```bash
# Run a live approval call over synthetic telephony transport
pnpm call:live

# Run an announced multi-party transfer call (A-12 verification)
# PowerShell:
$env:IVR_SCENARIO='transfer'; pnpm call:live

# Run under a degraded network profile (60ms delay, 25ms jitter, 1% loss)
# PowerShell:
$env:NETWORK_PROFILE='DEGRADED'; pnpm call:live
```

> [!TIP]
> **Real-Time Speaker Monitoring**: When `ffplay` (ffmpeg) is available on the machine, `pnpm call:live` automatically routes the live telephony audio (IVR voice, DTMF tones, hold music, human representative voices, and the AI voice agent) directly to your PC speakers or headphones in real-time. To run in silent/headless mode, set `$env:AUDIO_SPEAKER='false'`.

### 5. Verifying Live Call Event Logs
Every call run writes a detailed JSONL log to the `logs/` directory. You can verify all 21 invariants against any live log using the verification tool:

```bash
pnpm exec tsx scripts/verify-live-log.ts logs/CALL-LIVE-<timestamp>.jsonl
```

### 6. Launching the Web Dashboard
HoldHarmless includes an interactive web dashboard for monitoring calls in real time:

```bash
# Start the Vite dashboard development server
pnpm --filter @holdharmless/dashboard dev
```
Open [http://localhost:5173](http://localhost:5173) in your browser to view real-time state transitions, audio gate status, and audio waveforms.

---

## 📂 Monorepo Structure

```
HoldHarmless/
├── apps/
│   ├── core/                  # Core call loop, audio bridge, and tool handlers
│   ├── ivr-harness/           # High-fidelity telephony switchboard & IVR simulator
│   └── dashboard/             # React 19 + Vite real-time visual monitor
├── packages/
│   ├── agent/                 # AssemblyAI Voice Agent API link and session management
│   ├── audio/                 # G.711 μ-law codec, audio utilities, and playout buffering
│   ├── callmodel/             # Channel/phase state machines and derived gate rules
│   ├── classifier/            # Dual acoustic (spectral/periodic) and semantic classifiers
│   ├── detectors/             # Goertzel DTMF and cue-phrase detectors
│   ├── events/                # TypeScript event schemas and domain models
│   ├── fixtures/              # Synthetic prior auth request test datasets
│   ├── invariants/            # 21 formal runtime & static invariant auditors
│   ├── prompts/               # Position-tailored system prompt files
│   ├── transport/             # Abstract bidirectional audio transport interface
│   └── transport-loopback/    # Network simulation transport (jitter, latency, packet loss)
├── scripts/
│   ├── run-live-call.ts       # Orchestrator for full end-to-end live calls
│   ├── verify-live-log.ts     # Invariant auditing tool for call logs
│   ├── check-invariants.ts    # Static model checker
│   └── check-doc-claims.ts    # Documentation consistency checker
├── logs/                      # Live call JSONL execution traces
└── holdharmless-ssot-v1.2.md  # Single Source of Truth specification
```

---

## 🛡️ License

This project is licensed under the MIT License — see the [LICENSE](file:///LICENSE) file for details.
All patient health information (PHI), clinical codes, and payer phone numbers used in this project are 100% synthetic in compliance with HIPAA and `INV-12`.
