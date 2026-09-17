# Omya Trade

Web trading terminal bergaya MetaTrader 5 — brand **OMYA TRADE**. Realtime market feed, chart candlestick multi-timeframe, eksekusi order (market / pending), SL/TP, margin & stop-out, riwayat deal — semuanya dalam satu aplikasi zero-dependency (Node.js murni + vanilla JS).

> Platform ini adalah **simulator / paper-trading** untuk keperluan belajar dan pengembangan. Seluruh harga dihasilkan oleh price-engine sintetis di server dan tidak terhubung ke pasar keuangan mana pun. Tidak ada uang riil yang dipertaruhkan.

## Akun & Login

| Akun | Password | Akses |
|------|----------|-------|
| `trader` | `trader123` | Terminal trading (saldo Rp 20.000.000) |
| `admin` | `admin123` | Terminal trading + **Market Control** |

**Market Control (rahasia):** klik logo OMYA TRADE **3×** di top bar. Khusus sesi admin — isi:
- **Treasury** — menambah/mengurangi saldo akun secara live
- **AutoPlay Bot (Flow Reader)** — bot yang "membaca arah grafik": membuka posisi sendiri dan selalu menang; saat aktif muncul **Control Orb** (tombol bulat emas yang bisa digeser) berisi semua cheat
- **Chart Flow Control** — mode BUY: grafik naik perlahan 20 detik → turun singkat 5 detik → naik lagi (looping); mode SELL kebalikannya

## Menjalankan

```bash
node server.js
# → http://0.0.0.0:8080  (PORT env untuk port lain)
```

Tanpa `npm install` — tidak ada dependency eksternal.

## Fitur

- **Login & sesi** — halaman sign-in bergaya portal broker, token sesi server-side, tombol logout
- **Live feed** — tick every 280ms via SSE, 19 simbol (forex, metals, energi, indeks, crypto & **USDIDR**), spread dinamis & regime volatilitas
- **Akun Rupiah** — saldo **Rp 20.000.000**, leverage 1:100; seluruh P/L, margin, dan riwayat terdenominasi IDR (konversi otomatis dari USD di kurs USDIDR live)
- **Toggle tampilan Rp / $** — klik tombol `Rp/$` di top bar untuk mengganti mata uang tampilan (kurs live)
- **Sparkline naik-turun** — mini-chart per simbol di Market Watch yang bergerak realtime
- **Chart engine custom** (canvas) — candlestick / hollow / line / area, volume tick, crosshair OHLC, zoom scroll & pinch, drag pan, countdown candle, overlay posisi (entry, SL, TP, pending order)
- **7 timeframe** — M1, M5, M15, M30, H1, H4, D1; riwayat sintetis berlapis (D1 → H1 → M1) yang konsisten lintas timeframe, ~16 bulan untuk D1
- **Eksekusi trading** — market order dengan slippage realistis, pending order (buy/sell limit & stop), modifikasi & partial close, one-click trading
- **Akun margin** — margin & P/L multi-mata-uang, margin level, **stop-out otomatis di 20%** (dieksekusi server-side meski browser tertutup)
- **Panel MT5-style** — Market Watch bergrup + flash harga, Market Depth, Toolbox (Trade / Orders / History), ticket order lengkap
- **Persistence** — status akun disimpan ke `data/account.json`
- **Responsif** — layout desktop penuh, tampilan mobile dengan bottom-nav (Quotes / Chart / Trade / History)
- Boot screen "connect to server", notifikasi toast + sound effect, jam server UTC, indikator latensi

## Arsitektur

```
server.js            HTTP + SSE + price engine + trading engine (tanpa dependency)
public/
  index.html         kerangka terminal
  css/style.css      tema dark-gold, responsive
  js/chart.js        chart engine canvas
  js/app.js          feed client, agregasi TF, UI trading
data/account.json    state akun (dibuat saat runtime, di-gitignore)
```

- **Price engine**: random-walk dengan momentum (OU drift), spike volatilitas, spread dinamis; riwayat digenerasi berlapis (brownian-bridge subdivision) sehingga harga kontinu antar timeframe.
- **Trading engine**: order dieksekusi & dipantau di server (SL/TP, trigger pending, stop-out) — tetap berjalan meski semua tab ditutup.
- **API**: `GET /api/bootstrap`, `GET /api/history?symbol&tf&limit`, `GET /api/deals`, `POST /api/order|pending|position/close|position/modify|order/cancel|positions/closeall`, stream `GET /api/stream` (SSE: `tick`, `account`, `bar`, `deal`).

## Catatan

Seluruh angka, harga, akun, dan "server" (OmyaTrade-Real03) bersifat simulasi. Proyek ini tidak berafiliasi dengan MetaQuotes / MetaTrader.
