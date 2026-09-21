# Day-0 results — HoldHarmless

Dijalankan: 2026-09-21 · Host: mesin lokal (Windows 11) · Node v22.14.0
Total waktu socket: **26,2 menit** · Estimasi biaya: **~$1,96**

Empat dari lima eksperimen lulus. A-24 meleset 1,7 poin dari ambangnya, tapi karena alasan yang tidak menyentuh keputusan arsitektur yang diujinya — detail di bawah.

---

## E0 — session fields and endpoint ✅

| Temuan | Nilai | Tujuan |
|---|---|---|
| Endpoint | `wss://agents.assemblyai.com/v1/ws` | §7.1 — **sesuai dokumen** |
| Auth | `Authorization: Bearer <key>` pada upgrade | §7.1 |
| Voice | `michael` diterima | §7.1 |
| `input.format` `audio/pcmu` @ 8000 | **diterima** | §7.1 |
| `output.format` `audio/pcmu` @ 8000 | **diterima** | §7.1 |
| `session_id` | `sess_7f40266f…` dikembalikan di `session.ready` | §15 |

Probe field — **13 dari 13 mutable diterima, 2 dari 2 immutable ditolak**:

| Field | Hasil |
|---|---|
| `system_prompt`, `keyterms`, `transcription_prompt`, `tools`, `output.volume` | ACCEPTED |
| `transcription_mode` × 3 (`min_latency`/`balanced`/`max_accuracy`) | ACCEPTED |
| `turn_detection.interrupt_response`, `.interruption_delay`, `.vad_threshold` | ACCEPTED |
| `turn_detection.min_silence`, `.max_silence` | **ACCEPTED** |
| `output.voice` setelah `session.ready` | REJECTED `immutable_field` |
| `greeting` setelah `session.ready` | REJECTED `immutable_field` |

**Keputusan:** `ENABLE_INTERRUPTION_DELAY = true` → sudah ditulis ke `.env`. **A-18 PASS.**

**Catatan ADR-009.** `min_silence` dan `max_silence` benar-benar diterima. Larangan di ADR-009 karena itu adalah keputusan nyata, bukan kebetulan — dan sekarang terbukti, bukan diasumsikan.

**Catatan ADR-006.** Tabel mutabilitasnya benar. Pesan errornya persis: *"'output.voice' cannot be changed after the first session.update"* — perhatikan **first session.update**, bukan `session.ready`. Itu lebih ketat dari yang §7.1 tulis, dan layak dikoreksi di dokumen.

---

## E-REPLY — agent-initiated turns ✅ (A-25 PASS)

| Temuan | Nilai | Tujuan |
|---|---|---|
| Nama pesan | **`reply.create`** | **ADR-022 — sebelumnya tidak terkonfirmasi** |
| Payload | `{ "type": "reply.create", "instructions"?: string }` | ADR-022 |
| Latensi tanpa instruksi | median 239 ms · p90 244 ms | §16.3 `initiated_reply_latency_ms` |
| Latensi dengan instruksi satu-kali | median 236 ms · p90 243 ms | §16.3 |
| Instruksi dipatuhi? | **ya** — "Are you still on the line?" | §8.6 tier 1 |
| Byte lolos saat gate ditutup | **0** (3413 ms dibuang) | **A-25** |

**Temuan perilaku untuk ADR-022:** `reply.create` yang dikirim saat reply lain masih berjalan **diantrekan**, bukan ditolak dan bukan memotong. Server menyelesaikan reply pertama lalu langsung `reply.started` untuk yang kedua di milidetik berikutnya. Kode produksi harus tahu ini — `createReply` bukan operasi idempoten yang aman dipanggil berulang.

> Angka pertama yang diukur (median 40 ms) **tidak valid** dan sudah dibuang. Penyebabnya bug di perancah: `t0` distempel sebelum audio reply sebelumnya habis mengalir, jadi `firstAudioAt` menangkap ekor turn lama. Log yang terkontaminasi disimpan sebagai `logs/e-reply.CONTAMINATED.jsonl`. Ini persis kesalahan yang §16.1 larang — metrik yang tidak bisa gagal.

---

## E3 — latency baseline ✅ (A-33 bagian Day-0: on track)

Diukur di **mesin lokal Windows 11**. Kalau demo dijalankan dari host lain, angka ini batal (ADR-003).

| Ukuran | min | median | p90 | max |
|---|---|---|---|---|
| frame input terakhir → `reply.audio` pertama | 332 ms | **397 ms** | **437 ms** | 534 ms |
| frame input terakhir → `reply.started` | 292 ms | 364 ms | 400 ms | 484 ms |

n = 20, `TELEPHONY` tidak berlaku (belum ada transport — ini murni segmen API).

**§4.2 memperkirakan 500–1000 ms untuk segmen ini. Hasil nyatanya 397 ms.** Estimasi dokumen terlalu pesimistis dan bisa dikoreksi ke bawah.

Sebaran sempit (202 ms antara min dan max) menunjukkan koneksi stabil. Dengan ~50 ms loopback, 40–60 ms jitter buffer, dan ≤200 ms playout queue di atasnya, plafon A-33 sebesar p90 2500 ms punya kelonggaran besar. **Demo dari host ini layak.**

---

## E2 — μ-law pass-through ✅ (A-2 PASS, dengan satu catatan)

| | Transkrip |
|---|---|
| **A** μ-law 8 kHz | "…M as in Mike, 4420917. The date of birth is March 14th, **The procedure code is** 96413 and the diagnosis code is C50.911…" |
| **B** PCM16 24 kHz | "…M as in Mike, 4420917. The date of birth is March 14th, **1980. 1968.** The procedure code is 96413 and the diagnosis code is C50.911…" |

Member ID, huruf yang dieja, CPT `96413`, dan ICD `C50.911` **lolos identik di kedua jalur**. `audio/pcmu` @ 8000 diterima di kedua arah, audio balasan kembali sebagai μ-law.

**Catatan yang harus ditindaklanjuti:** pada jalur 8 kHz, **tahun kelahiran hilang sepenuhnya**. Pada 24 kHz ia muncul tapi dengan awalan palsu ("1980. 1968."). Keduanya gagal pada tanggal lahir, dengan cara berbeda.

Ini satu sampel pada `transcription_mode` default, jadi bukan pengukuran — tapi `patient_dob` adalah salah satu field di `get_auth_request` (§8.1), dan tahun yang hilang adalah kegagalan senyap. Layak jadi eksperimen kecil sendiri di minggu 1: DOB dengan `max_accuracy` plus `keyterms`, bukan default.

---

## E-AUTH — capture and comparison ⚠️ A-24 MASIH TERBUKA (93,3%)

**Kondisi rig:** `en-US-AndrewNeural` · rate `-20%` · tiap digit dipisah koma · `transcription_mode: max_accuracy` · satu nomor per turn

| Ukuran | Pilot (10) | Penuh (30) |
|---|---|---|
| Cocok persis | 10/10 (100%) | **28/30 (93,3%)** |
| — diucapkan biasa | 5/5 | 14/15 |
| — dieja | 5/5 | 14/15 |
| Tidak tertangkap sama sekali | 0 | 0 |
| **Kegagalan perbandingan** | **0** | **0** |
| Fidelitas model → tool | 10/10 | **30/30** |

**A-24: FAIL** terhadap ambang 95%, meleset satu nomor.

### Tapi ADR-020 tervalidasi penuh

Nol kegagalan perbandingan. Nol normalisasi dibutuhkan. Dan argumen tool yang dihasilkan model **cocok dengan transkrip ASR di 30 dari 30 kasus** — jalur model→tool tidak punya satu pun error teramati.

### Kedua kegagalannya terjadi di hulu model

| Diucapkan | Transkrip ASR | Ditangkap |
|---|---|---|
| "zero, zero, seven, one, two, four, four" | `PA00071244` | `PA00071244` |
| "three, three, nine, zero" | `… dash, 331. 9, 0, dash …` | `AUTH-33190-E` |

Keduanya **digit yang disisipkan**, bukan disubstitusi, dan di keduanya tool merekam dengan setia transkrip yang sudah salah. Tuasnya adalah pengenalan suara — `keyterms`, `transcription_mode`, dan audionya sendiri — bukan ADR-020.

### Kegagalan kedua disebabkan rig-nya sendiri

Pemisahan koma per digit yang dipakai untuk menghentikan pengucapan menempel justru menciptakan ambiguitas pengelompokan: "three, three, nine" dikenali sebagai "331" lalu "9". Rep manusia menjeda secara berbeda, jadi error spesifik ini mungkin tidak bertahan saat bertemu suara manusia — satu alasan lagi kenapa §6.6 menaruh giliran manusia asli di calibration set minggu 2.

### Dan inilah gunanya READBACK

Penyisipan digit oleh ASR persis kegagalan yang fase read-back ada untuk menangkapnya: agent membacakan nilai tersimpan, rep mendengar nomor yang bukan miliknya, dan `confirm_readback(matched: false, corrected_value)` menggantinya. A-24 mengukur capture secara terisolasi; alur kerjanya tidak bergantung pada capture saja.

### Untuk menutup A-24 hijau

**Koreksi: `keyterms` bukan tuasnya.** Nomor otorisasi tidak diketahui sebelum panggilan — justru menemukannya itu tujuannya — jadi ia tidak bisa disemai ke `keyterms` seperti kode CPT atau nama payer (§7.2).

Yang tersisa:

| Tuas | Alasan |
|---|---|
| `transcription_prompt` | Mutable per posisi, dan memang untuk ini: membiaskan pengenal ke satu domain. Satu kalimat yang memberi tahu bahwa rep akan membacakan identifier alfanumerik digit demi digit adalah penggunaan yang dimaksudkan |
| `pattern` pada `capture_auth_number.value` | ADR-020 sudah bersandar pada entity-aware waiting, yang API turunkan dari `description`, `examples`, **dan `pattern`**. Skema §8.1 sekarang memberi dua yang pertama dan menghilangkan yang ketiga |

Keduanya murah diuji dan masuk minggu 1, bersama tindak lanjut `patient_dob` dari A-2. **Tuas ketiga adalah `READBACK`, dan itu sudah ada di desain.**

---

## Temuan lintas-eksperimen yang mengubah dokumen

**1. `transcript.agent` final tidak pernah dikirim.** Di E2: 56 `transcript.agent.delta`, **0** final. Di E-AUTH: 10 delta, 1 final. Sementara `transcript.user` final datang normal.

Ini menghantam **§7.6** langsung. Detektor disclosure bekerja pada `turn.transcribed` dengan `speaker = 'agent'` dan `partial = false`. Tanpa transkrip agent final, detektor itu tidak punya input — `disclosedToCurrentParty` tidak pernah jadi `true`, dan **INV-7 gagal di setiap panggilan**. Itu menjatuhkan seluruh ADR-017.

Perbaikannya di `packages/agent` (§12.6): akumulasi `transcript.agent.delta` sendiri dan finalkan saat `reply.done`, lalu itulah yang diumpankan ke `onTurn`. Harus ditulis ke §12.6 dan §7.6.

**2. Audio adalah base64 di dalam JSON, bukan frame biner.** `input.audio` memakai field `audio`, `reply.audio` memakai field **`data`**. §4.1 menggambarkan aliran frame; Audio Bridge butuh tahap base64 dan itu menambah ~33% per frame.

**3. `tool.result.result` adalah string JSON, bukan objek.** §12.6 `queueToolResult(callId, result: unknown)` butuh `JSON.stringify`.

**4. Pesan yang benar-benar teramati** — daftar ini menggantikan tebakan mana pun:

`session.ready` · `session.updated` · `session.error` · `session.ended` · `input.speech.started` · `input.speech.stopped` · `transcript.user.delta` · `transcript.user` · `transcript.agent.delta` · `transcript.agent` (jarang) · `reply.started` · `reply.audio` · `reply.done` · `tool.call`

---

## Biaya

| Eksperimen | Waktu socket | Biaya |
|---|---|---|
| E0 | 0,62 mnt | $0,046 |
| E-REPLY (terkontaminasi, dibuang) | 0,73 mnt | $0,055 |
| E-REPLY (valid) | 0,89 mnt | $0,067 |
| E3 | 3,67 mnt | $0,275 |
| E2 run A + B | 1,61 mnt | $0,120 |
| E-AUTH v1 (desain cacat, dibuang) | 6,01 mnt | $0,451 |
| E-AUTH v2 pilot (10) | 3,17 mnt | $0,238 |
| E-AUTH v2 penuh (30) | 9,49 mnt | $0,712 |
| **Total** | **26,2 mnt** | **~$1,96** |

Sekitar $0,51 dari itu terbuang pada dua run yang desainnya cacat. Itu harga yang murah untuk menemukannya di hari nol.

Masih jauh di bawah perkiraan awal $5–9. Penyebabnya: skripnya otomatis dan `withSession` menutup socket di `finally`, jadi tidak ada sesi yang menggantung. **Cek saldo AssemblyAI dan bandingkan dengan $1,96.** Kalau potongannya jauh lebih besar, ada sesi yang tidak tertutup.

---

## Perubahan SSOT yang dihasilkan

- [x] §7.1 — endpoint, voice `michael`, `audio/pcmu` @ 8000 dikonfirmasi
- [x] §7.1 — koreksi: field immutable terkunci sejak **`session.update` pertama**, bukan sejak `session.ready`
- [x] §7.1 — tambahkan: audio adalah base64 dalam JSON; `reply.audio` memakai field `data`
- [x] §13 — `ENABLE_INTERRUPTION_DELAY = true`
- [x] ADR-006 — tabel mutabilitas dikonfirmasi terhadap 15 probe nyata
- [x] ADR-009 — catat bahwa `min_silence`/`max_silence` **diterima**, jadi larangannya keputusan
- [x] ADR-022 — `createReply` → `reply.create`; tambahkan bahwa panggilan saat reply aktif **diantrekan**
- [x] §4.2 — segmen API: median 397 ms, p90 437 ms, di host lokal; turunkan estimasi 500–1000 ms
- [x] **§7.6 + §12.6 — transkrip agent hanya datang sebagai delta; `packages/agent` harus memfinalkan sendiri atau ADR-017 runtuh**
- [x] §12.6 — `tool.result.result` adalah string JSON
- [x] §22 — A-2 PASS · A-18 PASS · A-25 PASS · A-33 (Day-0) on track · **A-24 93,3%, masih terbuka**
- [x] ADR-020 — hasil A-24 dan diagnosisnya ditulis; keputusannya tervalidasi
- [x] §8.2 — batas sanity check ditulis: ia buta terhadap error pengenalan
- [x] Naikkan versi dokumen ke 1.3
