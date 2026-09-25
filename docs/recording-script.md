# Naskah rekaman suara — set kalibrasi §6.6

**Untuk:** modul 2.6 (set kalibrasi), dan modul 4.1 (`HUMAN_REP`).
**Perkiraan waktu:** 25–35 menit untuk Blok A–D. Blok E butuh orang kedua (+10 menit). Blok F opsional (+5 menit).
**Bahasa yang dibaca:** Inggris. Payer-nya rencana kesehatan AS, dan kosakata classifier (`IVR_MARKERS`, `FIRST_PERSON`, `HOLD_CUE_PHRASES`) semuanya bahasa Inggris. Aksen Indonesia **tidak perlu disembunyikan** — justru itu sebagian dari yang diukur.

---

## Kenapa rekaman ini ada

Ambang classifier akustik di `packages/classifier/src/acoustic.ts` seluruhnya diukur dari audio **rendered** (edge-tts):

| sumber | pause ratio | flatness | autocorrelation |
|---|---|---|---|
| hold music | 0,000 | 0,0015 | 0,60 |
| IVR menu | 0,430 | 0,1447 | 0,01 |
| baris representatif (rendered) | 0,40–0,46 | 0,008–0,043 | 0,02–0,05 |
| **manusia asli** | **belum pernah diukur** | **—** | **—** |

Di mode `BOT_REP`, IVR dan representatif sama-sama suara sintetis, jadi classifier belajar memisahkan suara sintetis dari suara sintetis. §6.6 menyebut risikonya dengan jelas: *`HUMAN_REP` di panggung adalah orang hidup yang akustiknya tidak ada di set kalibrasi.*

Kegagalan konkretnya: kalau suara manusia asli lewat telepon jatuh lebih dekat ke musik hold daripada ke suara rendered, layer akustik menyimpulkan `PERIODIC` saat representatif sedang bicara → `holdSuspected` → gerbang menutup → **agen membisu di tengah percakapan.** Baris kosong di tabel itu yang diisi rekaman ini.

Rekamanmu akan lewat **rantai ffmpeg yang persis sama** dengan aset rendered (`loudnorm=I=-19:TP=-2:LRA=11`, lalu 8 kHz mono μ-law). Jadi kalau angkanya berbeda dari baris "rendered", perbedaan itu adalah **suaranya**, bukan encoding-nya. Itulah yang membuat perbandingannya sah.

---

## Cara merekam

**Format.** WAV, mono, 16-bit, 44,1 atau 48 kHz. Perekam apa pun boleh (Audacity, Voice Recorder bawaan Windows, ponsel).

> **Jangan turunkan sendiri ke 8 kHz.** Saya butuh headroom untuk resample yang bersih; menurunkan dua kali menambah artefak yang bukan milik suaramu.

**Jangan diproses.** Tanpa normalisasi, tanpa noise reduction, tanpa kompresor, tanpa EQ, tanpa auto-gain kalau bisa dimatikan. Derau ruangan itu **data**. Suara yang sudah dibersihkan justru membuat kalibrasi ini bohong.

**Mikrofon.** 15–25 cm dari mulut. Headset, mikrofon laptop, atau ponsel — semuanya sah; catat saja pakai apa (ada kolomnya di bawah).

**Ruangan.** Ruangan biasa yang tenang. Jangan kejar senyap total, dan jangan juga rekam di dekat kipas angin atau di dalam mobil berjalan.

**Cara membaca — ini yang paling penting.**

Baca seperti orang yang sedang **bekerja**, bukan seperti pembaca berita. Kamu berperan sebagai petugas layanan provider di sebuah perusahaan asuransi, yang sudah menangani panggilan sejak pagi.

- **Tersendat itu bagus. Jangan diulang.** "uh", "hmm", salah ucap lalu dibetulkan, napas di tengah kalimat — semua itu persis yang tidak pernah dipunyai suara sintetis. §6.2 mencatat bahwa sinyal disfluency mendekati nol di kedua mode yang berjalan sekarang; rekaman ini kesempatan satu-satunya memberinya sesuatu yang nyata.
- Ulang take **hanya** kalau kalimatnya tidak bisa dimengerti, atau kalau kamu salah baca sampai maknanya berubah.
- Jangan pelan-pelan dan jangan terlalu jelas. Kecepatan bicara normal.

**Jeda antar-take.** Diam **±3 detik** di antara take. Jangan menyebut nomor take. Jeda itu yang saya pakai untuk memotong file.

**Nama file.** Satu file per blok, di `packages/fixtures/data/human/`:

```
packages/fixtures/data/human/A.wav
packages/fixtures/data/human/B.wav
packages/fixtures/data/human/C.wav
packages/fixtures/data/human/D.wav
packages/fixtures/data/human/E.wav   (kalau ada orang kedua)
packages/fixtures/data/human/F.wav   (opsional)
```

Folder `packages/fixtures/data/` sudah di-gitignore dan ada tes yang gagal kalau isinya selain kode ikut ter-track (§6.6). **Tidak ada suaramu yang masuk repositori publik.**

Kalau perekammu lebih enak per-take, boleh juga: `A01.wav`, `A02.wav`, … Saya terima dua-duanya.

**Setelah selesai:** bilang saja, saya jalankan pemotong + ffmpeg, lalu saya laporkan berapa take yang terdeteksi per blok. Kalau jumlahnya tidak cocok dengan tabel, kita tahu sebelum angkanya dipakai.

---

## Persetujuan (§6.6)

§6.6 mewajibkan persetujuan karena fixture berisi suara asli. Isi ini sebelum mulai — cukup tulis di chat, saya yang simpan ke `packages/fixtures/data/human/CONSENT.md`.

| | |
|---|---|
| Nama | |
| Tanggal | |
| Mikrofon / perangkat | |
| Ruangan | |
| Setuju suaranya dipakai sebagai fixture kalibrasi, disimpan lokal, di luar repositori publik | ya / tidak |
| Setuju suaranya diputar saat demo hackathon | ya / tidak |

Kalau ada orang kedua untuk Blok E, dia mengisi baris yang sama.

---

# BLOK A — 26 giliran manusia

*§6.6 butir 1: "20–30 genuine human turns". Ini inti dari seluruh rekaman.*

Semua baris ini adalah **representatif pertama** (`rep1`). Sembilan belas di antaranya sudah ada versi rendered-nya di `apps/ivr-harness/src/lines.ts`, jadi tiap take punya pasangan langsung untuk dibandingkan — suara manusia lawan suara sintetis yang mengucapkan kalimat **identik**. Itu perbandingan yang paling bersih yang bisa didapat.

> **A20, A21 dan A22 adalah take terpenting di seluruh dokumen ini.** Jendela autocorrelation panjangnya **20 detik**. Tanpa satu pun giliran manusia yang bicara terus-menerus selama 20 detik, sinyal yang paling menentukan itu tidak pernah punya jendela penuh dari suara manusia — dan kebetulan sinyal itulah yang memisahkan "musik berulang" dari "orang bicara". Baca ketiganya tanpa berhenti lama di tengah.

| # | LineId | Yang dibaca |
|---|---|---|
| A01 | `rep1_greeting` | Thank you for holding, provider services, this is Jordan. How can I help you today? |
| A02 | `rep1_ask_npi` | Okay. Can I get the provider's NPI, please? |
| A03 | `rep1_ask_member_id` | And the member's ID number? |
| A04 | `rep1_ask_dob` | What is the member's date of birth? |
| A05 | `rep1_ask_cpt` | Which procedure code are you requesting? |
| A06 | `rep1_ask_icd` | And the diagnosis code? |
| A07 | `rep1_ask_service_date` | What is the date of service? |
| A08 | `rep1_ask_clinical` | Can you give me the clinical reason for the request? |
| A09 | `rep1_repeat_member_id` | Sorry, can you repeat the member ID? |
| A10 | `rep1_backchannel` | Mm-hmm. |
| A11 | `rep1_clinical_question` | Was conservative therapy tried for at least six weeks before this request? |
| A12 | `rep1_approved` | Okay, that's approved. Your authorization number is P, as in Papa, A, as in alpha, seven, seven, eight, one, Q, as in Quebec, X, as in X-ray. |
| A13 | `rep1_readback_correct` | Yes, that's correct. |
| A14 | `rep1_readback_wrong` | No, the last letter is X, as in X-ray, not S. |
| A15 | `rep1_reference` | Your call reference number is R, as in Romeo, one, four, two, zero, nine. |
| A16 | `rep1_denied_boilerplate` | That request is denied. It's not medically necessary. |
| A17 | `rep1_pending_info` | We'll need the clinical notes faxed over before we can make a determination. |
| A18 | `rep1_one_more_thing` | Oh wait, one more thing before you go. |
| A19 | `rep1_goodbye` | You're welcome. Have a good day. |

**Tiga take panjang — baca terus, jangan berhenti:**

| # | LineId (baru) | Yang dibaca |
|---|---|---|
| A20 | `rep1_policy_explanation` | Okay, so for this code the plan does require prior authorization, and the way it works on our side is that it goes to a nurse reviewer first, and then if the clinical criteria are met it gets approved the same day, but if there's anything missing — usually it's the conservative therapy documentation — then it goes to a second level review, and that one can take up to five business days, so what I'd suggest is that you send over the office notes and the imaging report at the same time as the request, because otherwise we'll just call you back asking for them and you've lost a day. |
| A21 | `rep1_long_hold_explanation` | I'm sorry about the wait, we've been slammed all morning, there's been some kind of issue with the system since about eight o'clock and it's been kicking people out in the middle of cases, so if I go quiet on you for a second that's what's happening, I'm not ignoring you, I'm just waiting for it to load back up, and if it drops the call entirely you'll have to call back in, but ask for extension four one two zero and it'll come straight to me. |
| A22 | `rep1_long_clinical_probe` | Let me just go through the criteria with you, because I want to make sure we get this right the first time. So for this one, we need documentation that the patient has been on the first line agent for at least eight weeks, we need the most recent labs, and we need a statement from the prescribing physician about why the alternative isn't appropriate — and that last one is the one that trips people up, because a note saying the patient prefers this drug isn't going to be enough, it has to be a clinical reason. |

**Empat take sedang, untuk variasi panjang giliran:**

| # | LineId (baru) | Yang dibaca |
|---|---|---|
| A23 | `rep1_ask_ordering_provider` | And is the ordering provider the same as the servicing provider, or are those different? |
| A24 | `rep1_verify_facility` | I'm showing the facility on Oak Street — is that where the procedure is being done? |
| A25 | `rep1_partial_approval` | So I can approve the first four cycles, but not the full course. You'll need to come back to us for the rest. |
| A26 | `rep1_apology_repeat` | Sorry, I missed that, my headset cut out. Can you say the member ID one more time? |

---

# BLOK B — 20 frasa hold, lalu diam

*§6.6 butir 4: "20 hold transitions preceded by a `HOLD_CUE` phrase, five followed by silence rather than music".*

**Cara:** ucapkan kalimatnya, lalu **berhenti total** dan diam ±3 detik. Diamnya penting — di situlah transisi ke hold terjadi.

Musik hold-nya **tidak perlu kamu rekam.** Saya sambungkan audio hold milik harness sesudah frasamu, dan lima di antaranya saya sambung dengan senyap, bukan musik — itu pilihan penyambungan, bukan perbedaan cara merekam. Transisinya tetap sah untuk kalibrasi karena yang diukur adalah frasa manusianya; metadata fixture akan mencatat bahwa transisi ini dirakit, bukan direkam utuh.

Ke-20 take ini menghabiskan seluruh 16 frasa di `HOLD_CUE_PHRASES` (§6.3), termasuk keempat yang membawa `transfer: yes`.

| # | Frasa inti | Yang dibaca |
|---|---|---|
| B01 | one moment | One moment. |
| B02 | one moment | One moment please, let me look that up. |
| B03 | let me put you on hold | Okay, let me put you on hold for just a second. |
| B04 | can you hold | Can you hold for me? |
| B05 | bear with me | Bear with me. |
| B06 | hold on | Hold on. |
| B07 | hang on | Hang on, I need to check something. |
| B08 | let me check | Let me check. |
| B09 | give me a second | Give me a second. |
| B10 | just a moment | Just a moment. |
| B11 | let me pull that up | Let me pull that up. |
| B12 | i'll be right back | I'll be right back. |
| B13 | stay on the line | Stay on the line, I'm going to look into this. |
| B14 | **let me transfer** | Let me transfer you. |
| B15 | **i'm going to transfer** | I'm going to transfer you to utilization management. Please hold. |
| B16 | **connecting you** | Connecting you now. |
| B17 | **let me get someone else** | Let me get someone else who can help with that. |
| B18 | one moment | Okay… one moment. |
| B19 | let me check | Alright, let me check on that. |
| B20 | hold on | Oh, hold on, let me get that for you. |

*B15 = `rep1_transfer`, B20 = `rep1_hold_during_closing`, B02 = `rep1_hold_cue`.*

---

# BLOK C — 20 frasa hold yang TIDAK diikuti hold

*§6.6 butir 6: "20 `HOLD_CUE` phrases spoken without a hold following, to measure false gate closure".*

Ini blok yang mengukur **harga** dari daftar §6.3. "Let me check" dan "one moment" adalah pengisi percakapan yang diucapkan petugas sambil terus bicara — dan tiap kali diucapkan, gerbang menutup pada N=1 dan agen membisu. §6.3 menyebutnya sendiri: biasnya sengaja dan arahnya benar, tapi tidak gratis. `gate_false_close_count` dan `agent_mute_during_conversation_ms` ada supaya harganya jadi angka sebelum demo, bukan kejutan di panggung.

**Cara:** setelah frasa hold, **langsung lanjut bicara tanpa jeda.** Kalau kamu berhenti sebentar di situ, take-nya jadi Blok B dan pengukurannya rusak. Ini kebalikan persis dari Blok B.

| # | Yang dibaca |
|---|---|
| C01 | Let me check — okay, I see it right here. |
| C02 | One moment, yeah, it's showing as approved already. |
| C03 | Hold on, that's not what I'm seeing. |
| C04 | Let me pull that up, and while I do, can you give me the date of service again? |
| C05 | Give me a second, okay, got it. |
| C06 | Just a moment, alright, the member is active. |
| C07 | Bear with me, I'm still in the other system. |
| C08 | Hang on, I think I typed that wrong. |
| C09 | Let me check the plan on this one, it's a commercial plan, not Medicare. |
| C10 | One moment, sorry, my screen froze for a second. |
| C11 | Let me pull that up, so this needs a medical review. |
| C12 | Hold on — no, wait, that's a different member. |
| C13 | Let me check the notes here, and it says conservative therapy was tried. |
| C14 | Can you hold — actually, never mind, I have it. |
| C15 | I'll be right back — actually, I don't need to step away, here it is. |
| C16 | Let me pull that up, so the CPT is nine six four one three, is that right? |
| C17 | Stay on the line, I'm just reading the clinical notes. |
| C18 | Let me get someone else, or actually, I can do this myself. |
| C19 | One moment while I document this, okay, done. |
| C20 | Let me check, and I'll need the NPI again while I'm here. |

*C01 = `rep1_cue_no_hold`.*

---

# BLOK D — 20 hold tanpa frasa apa pun

*§6.6 butir 5: "20 hold transitions with **no** cue phrase, to exercise acoustic-only confirmation".*

Ini kasus terburuk untuk layer semantik: tidak ada yang mengumumkan apa-apa, musik tiba-tiba mulai. Satu-satunya yang bisa menangkapnya adalah layer akustik — dan §6.2 mencatat celah strukturalnya: sinyal `HUMAN` terkuat (responsiveness) tidak tersedia selama hold, karena agennya memang dirancang diam.

**Cara:** ucapkan kalimatnya, **berhenti mendadak**, diam ±3 detik. Jangan ada nada "mau ditinggal sebentar" di suaramu — justru ketiadaan aba-aba itu yang sedang diuji. Kalimat-kalimat ini sengaja pendek dan biasa; tidak satu pun mengandung frasa dari §6.3.

| # | Yang dibaca |
|---|---|
| D01 | Okay. |
| D02 | Alright, got it. |
| D03 | That's on file. |
| D04 | The member is active as of January first. |
| D05 | Yes, that code requires prior authorization. |
| D06 | I have the request open now. |
| D07 | Thank you. |
| D08 | The diagnosis code is on the referral. |
| D09 | That's a different department. |
| D10 | I see the notes from the ordering physician. |
| D11 | Okay, and the NPI matches. |
| D12 | We have the fax from Tuesday. |
| D13 | The service date is within the window. |
| D14 | That's approved through the end of the month. |
| D15 | I've added your note to the case. |
| D16 | The plan requires a medical review for that code. |
| D17 | Yes, I can see the member. |
| D18 | That's correct. |
| D19 | I'll document that on the case. |
| D20 | Okay, so that's submitted. |

---

# BLOK E — representatif kedua (butuh orang lain)

*§6.6 butir 2: "a transfer scenario with two distinct personas".*
*§6.6 butir 3: "party swaps on short holds (20–40 s) from both `EXCHANGE` and `READBACK`, with no transfer phrase spoken".*

Ini yang membuat **A-12** dan **A-20** bisa diuji — dua asumsi yang §20 tandai **"Fatal to ethical credibility"**, karena menyangkut satu janji produk ini: setiap orang di ujung sana diberi tahu bahwa mereka bicara dengan AI.

**Orangnya harus berbeda dari Blok A.** Kalau kamu merekam Blok E dengan suaramu sendiri yang dibuat berbeda, deteksi pergantian pihak diuji melawan lawan yang terlalu mudah, dan angkanya akan terlihat lebih baik daripada kenyataannya. Idealnya berbeda gender atau aksen — persis seperti `ROLE_VOICES` yang sudah memisahkan `rep2` dari `rep1` di dua dimensi sekaligus.

**Kalau tidak ada orang kedua:** pakai suara rendered `en-GB-SoniaNeural` yang sudah ada untuk `rep2`. Itu tetap lebih baik daripada keadaan sekarang — satu pihak manusia asli, satu pihak sintetis, dan pergantiannya nyata secara akustik. Saya akan catat di metadata fixture bahwa persona kedua rendered, supaya hasilnya tidak dibaca lebih kuat dari yang pantas.

| # | LineId | Yang dibaca |
|---|---|---|
| E01 | `rep2_greeting_um` | Utilization management, this is Priya speaking. Who am I speaking with? |
| E02 | `rep2_greeting_swap` | Hi, thanks for waiting. I'm picking this one up. What can I do for you? |
| E03 | `rep2_ask_member_id` | Can I get the member ID to pull up the case? |
| E04 | `rep2_approved` | Alright, I can approve that. The authorization number is K, as in kilo, nine, three, zero, two, M, as in Mike. |
| E05 | `rep2_goodbye` | Thanks, take care. |
| E06 | `rep2_long_case_review` | Okay, I've got the case up now, and I can see where my colleague left off — so the request came in this morning, the clinical looks complete to me, the only thing I'm not seeing is the treatment history, and without that I can't close it out on this call, so what I'll do is approve everything I can and leave a note on the case for the missing piece, and then whoever picks it up next won't have to start over. |

**Perhatikan E02.** Itu baris terpenting di blok ini. Orang yang berbeda kembali setelah hold 20–40 detik dan **tidak satu pun kata di kalimat itu yang menyebut transfer.** Aturan reset disclosure baru berlaku untuk hold di atas 120 detik, jadi hold 20–40 detik tidak memicunya. Yang menangkap kasus ini adalah jalur lain: tiap kembali ke `HUMAN` dari `HOLD` tanpa kontinuitas terjamin (di atas 5 detik) memuat `PARTY_HEDGE.txt` (INV-6). **A-20 menguji jalur hedge itu**, bukan aturan 120 detik — dan E02 adalah umpannya.

---

# BLOK F — nomor yang dieja (opsional, 5 menit)

*Di luar tujuh butir §6.6. Nilainya: menjalankan ulang A-24 pada suara manusia.*

A-24 mengukur akurasi capture nomor yang dieja, dan seluruh angkanya berasal dari audio rendered. A-13 menemukan bahwa **jeda 900 ms di tengah pengejaan mematikan capture di kedua mode transkripsi, 28 dari 28** — giliran terpotong di jeda itu. Pertanyaan yang belum terjawab: seberapa sering manusia asli benar-benar berhenti selama itu di tengah membacakan nomor? Blok ini yang menjawabnya.

**F01–F05: baca lancar, tanpa berhenti.**

| # | Yang dibaca |
|---|---|
| F01 | The authorization number is A, as in alpha, four, seven, two, dash, nine, one. |
| F02 | Authorization number: seven, seven, three, zero, one, nine, four, two. |
| F03 | It's B, as in bravo, B, as in bravo, six, six, zero, four. |
| F04 | The number is one, eight, zero, zero, five, five, five, zero, one, nine, nine. |
| F05 | M, as in Mike, K, as in kilo, two, two, eight, five, three. |

**F06–F10: berhenti sekitar satu detik di tempat yang ditandai `[jeda]`** — seperti petugas yang matanya berpindah ke layar di tengah membacakan. Jangan ucapkan kata "jeda", cukup diam.

| # | Yang dibaca |
|---|---|
| F06 | The authorization number is A, as in alpha, four, seven, `[jeda]` two, dash, nine, one. |
| F07 | It's seven, seven, three, `[jeda]` zero, one, nine, four, two. |
| F08 | Reference number R, as in Romeo, one, four, `[jeda]` two, zero, nine. |
| F09 | The number is K, as in kilo, nine, `[jeda]` three, zero, two, M, as in Mike. |
| F10 | Okay it's — `[jeda]` — P, as in Papa, A, as in alpha, seven, seven, eight, one. |

---

## Ringkasan

| Blok | Take | Menutup | Wajib? |
|---|---|---|---|
| A | 26 | §6.6 butir 1 (20–30 giliran manusia) | **ya** |
| B | 20 | §6.6 butir 4 (transisi hold dengan frasa) | **ya** |
| C | 20 | §6.6 butir 6 (frasa tanpa hold) | **ya** |
| D | 20 | §6.6 butir 5 (transisi hold tanpa frasa) | **ya** |
| E | 6 | §6.6 butir 2 & 3 (dua persona, tukar pihak) | ya, butuh orang kedua |
| F | 10 | A-24 pada suara manusia | opsional |
| — | — | §6.6 butir 7 (suara rendered berbeda per peran) | sudah selesai (`ROLE_VOICES`) |

**Total wajib: 86 take.** Butir 7 sudah dipenuhi `ROLE_VOICES` di `apps/ivr-harness/src/lines.ts`, jadi tidak ada yang perlu direkam untuknya.

Kalau waktunya terbatas dan harus memilih: **A20, A21, A22** (tiga take panjang) lalu sisa Blok A. Ketiganya sendirian sudah mengisi baris kosong di tabel ambang akustik, dan itulah kegagalan yang paling mahal.
