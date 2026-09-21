# HoldHarmless — Day 0

Perancah sekali pakai. Isinya bukan kode yang akan dipakai lagi — **hasilnya adalah catatan yang kamu tulis kembali ke `holdharmless-ssot-v1.2.md`.** Setelah kelima eksperimen selesai dan dokumen diperbarui, folder ini boleh dihapus.

SSOT §21 Day 0: *"Nothing is built before these run."*

---

## Persiapan (15 menit)

```bash
cd hh-day0 && npm install
```

Lalu isi API key di `../.env` — satu baris, `ASSEMBLYAI_API_KEY=`. Tidak perlu `export`; skrip membacanya sendiri lewat `process.loadEnvFile`.

Dua alat luar dibutuhkan untuk E2, E3, dan E-AUTH:

```bash
winget install --id Gyan.FFmpeg -e
```

```bash
pip install edge-tts
```

Setelah keduanya terpasang, **buka terminal baru** (PATH baru terbaca di sesi baru), lalu render semua audionya sekali jalan:

```bash
node scripts/make-audio.mjs
```

Tidak perlu mikrofon. Ini menghasilkan `audio/test8k.ul`, `audio/test24k.raw`, `audio/turn.ul`, dan `audio/auth-numbers.ul` — teksnya ada di skrip itu dan di `ground-truth.json`.

Ini konsisten dengan dokumen, bukan jalan pintas: §10.2 memang merender semua audio harness dari TTS offline. **Batasnya**: suara sintetis lebih bersih daripada rep yang mengeja nomor lewat telepon, jadi E-AUTH di atas TTS memberi pembacaan A-24 yang optimistis. Catat itu bersama hasilnya. Pembacaan pesimistisnya datang di minggu 2, saat §6.6 memasukkan 20–30 giliran manusia asli ke calibration set.

---

## Dua prinsip yang menentukan keberhasilan sore ini

**1. Setiap pesan masuk ditulis ke disk.** Sebagian protokol ditandai di SSOT sebagai perlu dikonfirmasi. Cara menemukannya bukan menebak, tapi membuang seluruh aliran pesan ke `logs/*.jsonl` lalu membacanya. Ini sudah dipasang di `lib/session.mjs` — semua skrip mewarisinya.

**2. Penutupan sesi ada di `finally`, bukan di jalur sukses.** Skrip yang crash di tengah meninggalkan socket menggantung, dan satu sesi yang tidak tertutup ditagih tiga jam penuh (§20.2). `withSession()` menjamin `session.end` terkirim walau body-nya melempar exception.

---

## Urutan menjalankan

### E0 — 20 menit, jalankan pertama

```bash
node e0.mjs
```

Tidak butuh audio. Membuka sisanya: mengonfirmasi endpoint, lalu memeriksa satu per satu field mana yang diterima `session.update`.

Yang ditulis kembali: endpoint ke **§7.1**, `ENABLE_INTERRUPTION_DELAY` ke **§13**, hasil field immutable ke **ADR-006**.

Catatan: E0 juga sengaja memeriksa `min_silence` dan `max_silence` yang dilarang ADR-009. Keputusan untuk tidak pernah menyetelnya baru bermakna kalau kita tahu keduanya sebenarnya diterima.

### E-REPLY — 30 menit

```bash
node e-reply.mjs
```

Tidak butuh audio. Menutup **A-25** dan nama pesan yang ADR-022 tandai belum terkonfirmasi.

Dokumentasi menyebut `reply.create` dengan field `instructions` — skrip tetap mencoba tiga kandidat berurutan supaya hasilnya empiris, bukan kutipan.

Kalau tidak ada mekanisme ini sama sekali, seluruh §5.7 kehilangan permukaannya. Rencana cadangan (mengirim keheningan singkat untuk memancing batas giliran) harus dicatat sebagai keputusan di ADR-022, bukan dibiarkan jadi detail implementasi.

### E3 — 30 menit, **di host tempat demo akan dijalankan**

```bash
node e3.mjs
```

Versi hari nol hanya mengukur bagian API, karena harness belum ada. Angka `perceived_response_ms` lengkap menunggu minggu 1.

Yang ditulis kembali: median dan p90 ke **§4.2**.

Kalau median bagian API saja sudah di atas 1500 ms, itu sinyal memindahkan demo ke host yang lebih dekat — dan kamu tahu itu hari ini, bukan di minggu keempat (**A-33**).

### E2 — 45 menit

```bash
node e2.mjs
```

Dua sesi, file sumber sama, bandingkan transkripnya. Lalu dengarkan audio balasannya:

```bash
ffmpeg -f mulaw -ar 8000 -ac 1 -i audio/e2-reply-8k.raw audio/e2-reply-8k.wav
```

Kalau suaranya melengking, `output.format` tertinggal di default — itu kesalahan §7.1 item 2, dan lebih baik terlihat sekarang.

Yang ditulis kembali: **A-2** ke §22; kalau μ-law ditolak, `AUDIO_ENCODING` di **§13** berubah dan §4.1 harus mengakui ada tahap resampling.

### E-AUTH — 90 menit, yang terpanjang

```bash
node e-auth.mjs
```

Audionya sudah dirender oleh `make-audio.mjs`: lima belas nomor diucapkan biasa, lima belas dieja gaya *"A as in alpha, four, seven, two, dash, nine"*, masing-masing di dalam kalimat pembawa yang wajar, dengan jeda dua detik.

Yang diukur bukan apakah transkripnya sempurna, tapi apakah nilai yang masuk ke `value` cocok dengan yang kamu ucapkan, ≥95%. **Dan setiap kegagalan harus bisa ditelusuri ke penangkapan, bukan ke perbandingan** — skrip memisahkan keduanya dan akan bilang `FORMATTING` kalau yang gagal adalah perbandingannya. Kalau itu terjadi, ADR-020 salah dan kamu perlu tahu sekarang, karena §8.2 membuat mismatch tidak bisa diulang.

Skrip ini juga memverifikasi §8.8 secara empiris: `tool.result` dikumpulkan saat `tool.call` datang dan baru dikirim di handler `reply.done`, tidak seketika.

---

## Setelah selesai

Tulis hasilnya kembali ke dokumen **hari itu juga**. `results/DAY0-RESULTS.md` adalah formulirnya — isi, lalu pindahkan tiap barisnya ke §7.1, §13, ADR-022, §4.2, dan §22.

Dokumen yang menyimpan placeholder alih-alih fakta akan membuat siapa pun yang membangun dari situ bekerja dari tebakan.

**Cek saldo AssemblyAI setelah selesai.** Kelima eksperimen totalnya sekitar satu sampai dua jam waktu sesi — sekitar $5–9 pada tarif §20.1 ($0,075/menit). Setiap skrip mencetak estimasi waktu socket-nya sendiri saat keluar. Kalau yang terpotong jauh lebih besar, ada socket yang tidak tertutup, dan jalur penutupan itu harus diperbaiki sebelum baris kode produksi pertama ditulis.
