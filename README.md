# NB-TTS Prompter

Minimal, keyboard-friendly web app to **prompt readers and record speech** for building TTS datasets. It supports **TXT / CSV / JSONL** scripts, logs **every action with timestamps**, and can **package recordings into a ready-to-use dataset**.

---

## ✨ Features

* **Script ingestion**

  * Upload `.txt`, `.csv`, or `.jsonl`/`.jsonlines`
  * CSV: choose **column index** (default 0) and **header row** on/off
  * JSONL: choose **custom key** (default `"text"`)
* **Lightweight identity**

  * Users type a short **Code** (e.g., `AB12CD`) — no auth
  * All progress and scripts are stored **locally in the browser** per Code
* **Prompting UX**

  * Shows **previous / current / next** sentence
  * **Left / Right** arrows to navigate (always available)
  * **Space** to start/stop recording
  * **Beep** on start (880 Hz) and stop (440 Hz)
  * **Recording indicator** (pulsing dot)
* **Accurate logging** (source of truth)

  * Every action is logged: `nav_prev`, `nav_next`, `record_start`, `record_stop`, `session_started`, and auto marks text as recorded when **displayed while recording**
* **Sessions & takes**

  * Multiple sessions per Code; each session aggregates multiple takes
* **Dataset builder**

  * Concatenates takes, then **splits by sentence** using the navigation log
  * Produces a **ZIP** with: `audio/all_sessions.wav`, `audio/clips/*.wav`, `metadata.csv`, `events.csv`, `log.jsonl`
  * Progress bar; processing **cannot be stopped**; UI is locked until done
* **Persistence + resume**

  * Remembers last sentence index per script & code
  * **Resume…** modal to pick from multiple saved scripts for the same Code
* **Minimal, appealing UI** (Tailwind-based)

---

## 🧱 Folder structure (suggested)

```
nb-tts-prompter/
├─ public/
│  └─ favicon.svg
├─ src/
│  ├─ main.tsx               # Vite + React entry
│  ├─ index.css              # Tailwind entry
│  ├─ App.tsx                # <— paste contents of "Tts Prompter (react)"
│  ├─ nb-tts-utils.ts        # shared utilities (already provided)
│  └─ vite-env.d.ts
├─ index.html
├─ package.json
├─ postcss.config.js
├─ tailwind.config.js
├─ tsconfig.json
└─ vite.config.ts
```

> If you’re using the canvas files directly, place `nb-tts-utils.ts` and `App.tsx` together under `src/` and import `./nb-tts-utils` from the React file.

---

## 🚀 Quick start (Vite + Tailwind)

**Requirements**: Node.js ≥ 18, npm or pnpm or yarn.

```bash
# 1) Create a Vite+React+TS app (or use your existing one)
npm create vite@latest nb-tts-prompter -- --template react-ts
cd nb-tts-prompter

# 2) Install deps
npm i

# 3) Tailwind setup
npm i -D tailwindcss postcss autoprefixer
npx tailwindcss init -p

# 4) Configure Tailwind
# tailwind.config.js →
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: { extend: {} },
  plugins: [],
};

# src/index.css →
@tailwind base;
@tailwind components;
@tailwind utilities;

# 5) Add the app files
# - Replace src/App.tsx with the canvas file "Tts Prompter (react)"
# - Add src/nb-tts-utils.ts from the canvas

# 6) Run in dev
npm run dev
```

Open the printed **local URL** (e.g., `http://localhost:5173`). Browsers treat `localhost` as a secure context, so microphone should work without HTTPS.

### Using HTTPS locally (optional)

If your setup or browser policy requires HTTPS:

```bash
# mkcert (macOS/Linux/WSL; see mkcert docs for Windows installer)
brew install mkcert nss # or use your package manager
mkcert -install
mkcert localhost 127.0.0.1 ::1

# Then configure Vite (vite.config.ts):
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'

export default defineConfig({
  plugins: [react()],
  server: {
    https: {
      key: fs.readFileSync('localhost-key.pem'),
      cert: fs.readFileSync('localhost.pem')
    },
    host: true
  }
})
```

Run `npm run dev` again and open `https://localhost:<port>`.

---

## 🗂️ Supported formats

### TXT

* One sentence per line. Blank lines are ignored.

### CSV

* Select **Column** (0-based) and whether there’s a **Header row**.
* Only the selected column is used as sentence text.

### JSON Lines (`.jsonl` / `.jsonlines`)

* One JSON object per line.
* Uses key **`text`** by default; change in the header control (e.g., `sentence`).

---

## 🎛️ Controls & shortcuts

* **Upload Script**: `.txt`, `.csv`, `.jsonl`
* **Code**: short user id; switching code auto-loads the last script+index for that code
* **Left / Right**: previous / next sentence (always allowed)
* **Space**: start/stop recording (beeps on start/stop)
* **Settings → Request Mic**: prompt the browser for mic access and select input device
* **Build Dataset**: creates a ZIP with audio & metadata (UI locked during processing)
* **Resume…**: pick from saved scripts for the current Code

> Counter rule: **while recording is ON**, any sentence that becomes visible is marked as recorded.

---

## 🧪 Built-in tests

The app runs lightweight parsing/segmentation tests at startup and prints results to the console:

* TXT, CSV (header/no-header, column selection, out-of-range clamp)
* JSONL (default and custom key)
* Segmentation sanity: indexes follow `nav_next`/`nav_prev`

You’ll see: `Parsing tests: all passed` (or “failure”).

---

## 🧩 Logs, metadata, and dataset structure

### `log.jsonl`

Each line is a JSON object with timestamp (`ts`), `userCode`, `sessionId`, current `index`, and `action`:

* `session_started`
* `record_start` / `record_stop`
* `nav_next` / `nav_prev`
* `user_code_updated`
* `project_loaded`
* `auto_mark_recorded` (when a sentence becomes visible while recording)

### `events.csv`

Subset of the log for quick analysis:

```
ts,action,index,session_id,user_code
```

### `metadata.csv`

One row per exported clip:

```
file,sentence_index,text,session_id,user_code,duration_sec,offset_start_sec,offset_end_sec
```

* `file`: path under `audio/clips/`
* `offset_*`: position inside `audio/all_sessions.wav`

### Audio outputs

* `audio/all_sessions.wav`: full concatenation of all takes (mono)
* `audio/clips/*.wav`: per-sentence clips derived from navigation boundaries

---

## 🔒 Persistence model

Everything is stored **locally in the browser** `localStorage` under a namespaced key per **Code**:

* Latest **script snapshot** (raw text, parsing options, parsed sentences)
* Last **sentence index** for each script (keyed by script hash)
* `lastScriptId` for quick resume

> Remove data by clearing browser storage for the site.

---

## 🛠️ Troubleshooting

* **Mic permission denied**

  * Ensure you’re on `http://localhost` **or** HTTPS with a valid cert
  * Allow microphone in the browser’s site settings
  * Verify your input device in **Settings → Input**
* **No beep**

  * Some browsers block audio until user interaction; click somewhere first
* **CSV column looks wrong**

  * Toggle **Header row** and re-select **Column**
* **JSONL key**

  * Change the key from the header control (default `text`)
* **Processing stuck**

  * Large audio can take time. The progress bar shows status; UI is intentionally locked until complete

---

## 🧭 Development notes

* The app separates concerns into:

  * `nb-tts-utils.ts`: pure helpers (parsing, audio conversions, segmentation, storage)
  * `App.tsx`: UI logic and MediaRecorder wiring
* `segmentTakeByLog(...)` is the source of truth for splitting audio based on **navigation** while recording. Make sure consumers of the dataset rely on `events.csv`/`log.jsonl` semantics if they post-process.

---

## 📦 Build & deploy

```bash
# Build
npm run build

# Preview production build
npm run preview
```

You can deploy the `dist/` folder to any static host (Netlify, Vercel static, GitHub Pages). If deploying under HTTPS, the microphone will work once the user grants permission.

---

## 📝 License

MIT.
