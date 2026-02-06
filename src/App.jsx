import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Upload, Mic, Square, Download, RefreshCcw, StopCircle, Users, AudioLines, Settings } from "lucide-react";
import JSZip from "jszip";

// --- Utility helpers --------------------------------------------------------
const nowIso = () => new Date().toISOString();

const randomCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// local persistence helpers (per Code + per Script)
const LS_KEY_PREFIX = "tts_prompter_v1"; // namespace
function hashText(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i); return (h >>> 0).toString(16); }
function makeStorageKey(code) { return `${LS_KEY_PREFIX}::${code}`; }
function loadCodeState(code) { try { return JSON.parse(localStorage.getItem(makeStorageKey(code)) || "{}"); } catch { return {}; } }
function saveCodeState(code, data) { try { localStorage.setItem(makeStorageKey(code), JSON.stringify(data)); } catch {} }
function persistScriptSnapshot({ code, scriptId, snapshot }) {
  const state = loadCodeState(code);
  state.scripts = state.scripts || {};
  state.scripts[scriptId] = { ...(state.scripts[scriptId] || {}), ...snapshot, updatedAt: nowIso() };
  state.lastScriptId = scriptId;
  saveCodeState(code, state);
}
function persistIndex({ code, scriptId, index }) {
  const state = loadCodeState(code);
  state.indices = state.indices || {};
  state.indices[scriptId] = index;
  state.lastScriptId = scriptId;
  saveCodeState(code, state);
}
function getSavedIndex({ code, scriptId }) { const state = loadCodeState(code); return state?.indices?.[scriptId] ?? 0; }
function getLastScriptForCode(code) {
  const state = loadCodeState(code);
  if (!state.lastScriptId) return null;
  const s = state.scripts?.[state.lastScriptId];
  if (!s) return null;
  return { scriptId: state.lastScriptId, ...s, index: state.indices?.[state.lastScriptId] ?? 0 };
}
function listScriptsForCode(code) {
  const state = loadCodeState(code);
  const out = [];
  if (state?.scripts) {
    for (const [scriptId, snap] of Object.entries(state.scripts)) {
      out.push({ scriptId, ...(snap||{}), index: state.indices?.[scriptId] ?? 0 });
    }
  }
  out.sort((a,b) => new Date(b.updatedAt||0) - new Date(a.updatedAt||0));
  return out;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function arrayBufferToWavBlob(float32, sampleRate) {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + float32.length * bytesPerSample);
  const view = new DataView(buffer);
  function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i));
  }
  const write16 = (o, v) => view.setUint16(o, v, true);
  const write32 = (o, v) => view.setUint32(o, v, true);
  writeString(view, 0, "RIFF");
  write32(4, 36 + float32.length * bytesPerSample);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  write32(16, 16);
  write16(20, 1);
  write16(22, numChannels);
  write32(24, sampleRate);
  write32(28, sampleRate * blockAlign);
  write16(32, blockAlign);
  write16(34, 8 * bytesPerSample);
  writeString(view, 36, "data");
  write32(40, float32.length * bytesPerSample);
  let offset = 44;
  for (let i = 0; i < float32.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view], { type: "audio/wav" });
}

async function decodeToMono(blob, targetSampleRate = null) {
  const arrayBuf = await blob.arrayBuffer();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuf.slice(0));
  const chs = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const tmp = new Float32Array(length);
  for (let ch = 0; ch < chs; ch++) audioBuffer.getChannelData(ch).forEach((v, i) => (tmp[i] += v / chs));
  const currentRate = audioBuffer.sampleRate;
  if (!targetSampleRate || targetSampleRate === currentRate) return { pcm: tmp, sampleRate: currentRate };
  const duration = audioBuffer.duration;
  const off = new OfflineAudioContext(1, Math.ceil(duration * targetSampleRate), targetSampleRate);
  const src = off.createBufferSource();
  const monoBuf = off.createBuffer(1, length, currentRate);
  monoBuf.copyToChannel(tmp, 0);
  src.buffer = monoBuf;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return { pcm: rendered.getChannelData(0).slice(0), sampleRate: targetSampleRate };
}

function concatFloat32(arrays) {
  const total = arrays.reduce((acc, a) => acc + a.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const arr of arrays) { out.set(arr, offset); offset += arr.length; }
  return out;
}

// Segment a single take into per-sentence clips based on navigation events in the log
function segmentTakeByLog({ take, pcm, sampleRate, allLogs, sentencesLen }) {
  const startMs = new Date(take.startedAt).getTime();
  const endMs = new Date(take.endedAt).getTime();
  const durMs = Math.max(1, endMs - startMs);
  const totalSamples = pcm.length;

  // events within take window
  const windowEvents = allLogs
    .filter(e => e.sessionId === take.sessionId && e.ts)
    .map(e => ({ ...e, t: new Date(e.ts).getTime() }))
    .filter(e => e.t >= startMs && e.t <= endMs)
    .sort((a,b) => a.t - b.t);

  // find initial index at record_start (or fall back to take.idx)
  let curIdx = take.idx ?? 0;
  const startEvt = windowEvents.find(e => e.action === 'record_start');
  if (startEvt && Number.isFinite(startEvt.index)) curIdx = startEvt.index;

  // Build boundaries: [ {tMs, idxAfter} ... ]
  const boundaries = [{ tMs: startMs, idx: Math.max(0, Math.min(sentencesLen - 1, curIdx)) }];
  for (const e of windowEvents) {
    if (e.action === 'nav_next') curIdx = Math.min(sentencesLen - 1, curIdx + 1);
    if (e.action === 'nav_prev') curIdx = Math.max(0, curIdx - 1);
    if (e.action === 'nav_next' || e.action === 'nav_prev') {
      boundaries.push({ tMs: e.t, idx: curIdx });
    }
  }
  boundaries.push({ tMs: endMs, idx: curIdx });

  // Convert time boundaries to sample boundaries and segments
  const tToSample = (tMs) => Math.round(((tMs - startMs) / durMs) * totalSamples);
  const segments = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const a = boundaries[i];
    const b = boundaries[i + 1];
    const s0 = Math.max(0, Math.min(totalSamples, tToSample(a.tMs)));
    const s1 = Math.max(0, Math.min(totalSamples, tToSample(b.tMs)));
    const len = s1 - s0;
    if (len <= 0) continue;
    segments.push({ sampleStart: s0, sampleEnd: s1, idx: a.idx, durationSec: len / sampleRate });
  }
  return segments;
}

function clsx(...args) { return args.filter(Boolean).join(" "); }

function getBestSupportedMime() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const type of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type)) return type;
  }
  return undefined;
}

// --- UI beep helper ----------------------------------------------------------
let BeepCtx = null;
async function playBeep(freq = 880, duration = 0.12, volume = 0.2) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!BeepCtx) BeepCtx = new Ctx();
    if (BeepCtx.state === "suspended") await BeepCtx.resume();
    const osc = BeepCtx.createOscillator();
    const gain = BeepCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, BeepCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, volume), BeepCtx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, BeepCtx.currentTime + duration);
    osc.connect(gain);
    gain.connect(BeepCtx.destination);
    osc.start();
    osc.stop(BeepCtx.currentTime + duration + 0.02);
  } catch (e) {
    // ignore beep errors (browser autoplay policies, etc.)
  }
}

// --- Parsing helpers (and tests) --------------------------------------------
// normalized line splitter supports Windows (CRLF) and Unix (LF)
const splitLines = (text) => text.split(/\r?\n/);

function parseTxt(txt) {
  return splitLines(txt).map((s) => s.trim()).filter(Boolean).map(text => ({ text, id: null }));
}

function parseCsv(txt, opts = {}) {
  const { columnIndex = 0, hasHeader = true } = opts;
  const rows = splitLines(txt).filter((l) => l.length > 0).map((line) => line.split(","));
  if (rows.length === 0) return [];
  const headers = hasHeader ? rows[0] : Array.from({ length: rows[0].length }, (_, i) => `col_${i}`);
  const start = hasHeader ? 1 : 0;
  const idx = Math.min(Math.max(0, columnIndex), headers.length - 1);
  const values = [];
  for (let i = start; i < rows.length; i++) {
    const v = (rows[i][idx] ?? "").trim();
    if (v) values.push({ text: v, id: null });
  }
  return { values, headers };
}

function parseJsonl(txt, opts = {}) {
  const { key = "text" } = opts;
  return splitLines(txt)
    .filter(Boolean)
    .map((line) => {
      try { 
        const obj = JSON.parse(line); 
        const text = obj?.[key]?.toString().trim() ?? null;
        if (!text) return null;
        // Return object with text and id (if present)
        return { text, id: obj?.id ?? null };
      } catch { return null; }
    })
    .filter(Boolean);
}

function assertEqual(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    console.error(`[TEST FAIL] ${name}`, { actual, expected });
    throw new Error(`Test failed: ${name}`);
  } else {
    console.log(`[TEST PASS] ${name}`);
  }
}

function runParsingTests() {
  try {
    // TXT
    assertEqual(
      "parseTxt() trims & drops empties",
      parseTxt("a\n\nb\r\n c \n\n"),
      [{text: "a", id: null}, {text: "b", id: null}, {text: "c", id: null}]
    );

    // CSV default: header present, first column
    const csv1 = "h1,h2\nhello,meta\nworld,foo\n";
    const { values: csvVals1, headers: csvHdr1 } = parseCsv(csv1, { columnIndex: 0, hasHeader: true });
    assertEqual("parseCsv() default first column with header", csvVals1, [{text: "hello", id: null}, {text: "world", id: null}]);
    assertEqual("parseCsv() header parsed", csvHdr1, ["h1", "h2"]);

    // CSV choose other column
    const { values: csvVals2 } = parseCsv(csv1, { columnIndex: 1, hasHeader: true });
    assertEqual("parseCsv() select second column", csvVals2, [{text: "meta", id: null}, {text: "foo", id: null}]);

    // CSV without header
    const csv2 = "a,b\nc,d\n";
    const { values: csvVals3, headers: csvHdr3 } = parseCsv(csv2, { columnIndex: 1, hasHeader: false });
    assertEqual("parseCsv() no header second column", csvVals3, [{text: "b", id: null}, {text: "d", id: null}]);
    assertEqual("parseCsv() synthetic headers when no header", csvHdr3, ["col_0", "col_1"]);

    // CSV clamp excessive column index to last column
    const csv3 = "h1,h2\n1,2\n3,4\n";
    const { values: csvVals4 } = parseCsv(csv3, { columnIndex: 99, hasHeader: true });
    assertEqual("parseCsv() clamps out-of-range column index", csvVals4, [{text: "2", id: null}, {text: "4", id: null}]);

    // JSONL default key
    const jsonl1 = '{"text":"hi"}\n{"text":"there"}\n{"nottext":"x"}\n';
    assertEqual("parseJsonl() default key", parseJsonl(jsonl1), [{text: "hi", id: null}, {text: "there", id: null}]);

    // JSONL custom key
    const jsonl2 = '{"sentence":"one"}\n{"sentence":"two"}\n{"text":"ignored"}\n';
    assertEqual("parseJsonl() custom key", parseJsonl(jsonl2, { key: "sentence" }), [{text: "one", id: null}, {text: "two", id: null}]);

    // JSONL with id field
    const jsonl3 = '{"text":"hello","id":"abc123"}\n{"text":"world","id":"def456"}\n';
    assertEqual("parseJsonl() preserves id field", parseJsonl(jsonl3), [{text: "hello", id: "abc123"}, {text: "world", id: "def456"}]);

    // EXTRA tests
    assertEqual("splitLines handles trailing newline", splitLines("x\n"), ["x", ""]);
    const badJsonl = '{"text":"ok"}\nnot-json\n{"text":"fine"}\n';
    assertEqual("parseJsonl() skips invalid lines", parseJsonl(badJsonl), [{text: "ok", id: null}, {text: "fine", id: null}]);

    // NEW: segmentation by nav events
    const t0 = Date.now();
    const take = { startedAt: new Date(t0).toISOString(), endedAt: new Date(t0 + 3000).toISOString(), sessionId: "S", idx: 5 };
    const logs = [
      { ts: new Date(t0).toISOString(), action: "record_start", sessionId: "S", index: 5 },
      { ts: new Date(t0 + 1000).toISOString(), action: "nav_next", sessionId: "S" },
      { ts: new Date(t0 + 2000).toISOString(), action: "nav_prev", sessionId: "S" },
    ];
    const segs = segmentTakeByLog({ take, pcm: new Float32Array(3000), sampleRate: 1000, allLogs: logs, sentencesLen: 100 });
    assertEqual("segmentTakeByLog idx sequence", segs.map(s => s.idx), [5, 6, 5]);

    return true;
  } catch (e) {
    return false;
  }
}

// --- Main component ----------------------------------------------------------
export default function App() {
  const [userCode, setUserCode] = useState("");
  const [projectName, setProjectName] = useState("Untitled Project");
  const [sentences, setSentences] = useState([]);
  const [index, setIndex] = useState(0);
  const [stream, setStream] = useState(null);
  const [devices, setDevices] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [recorder, setRecorder] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [micError, setMicError] = useState("");
  const [recordedIndices, setRecordedIndices] = useState(new Set());
  const [sessions, setSessions] = useState([]); // {id, start, end?, takes:[]}
  const currentSessionId = useRef(null);
  const chunksRef = useRef([]);
  const [log, setLog] = useState([]);
  const [testsPassed, setTestsPassed] = useState(null);

  // file parsing state
  const [fileType, setFileType] = useState(null); // 'txt' | 'csv' | 'jsonl'
  const [rawFileText, setRawFileText] = useState("");
  const [csvHasHeader, setCsvHasHeader] = useState(true);
  const [csvHeaders, setCsvHeaders] = useState([]);
  const [csvColumnIndex, setCsvColumnIndex] = useState(0);
  const [jsonlKey, setJsonlKey] = useState("text");

  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMsg, setProgressMsg] = useState("");
  const [zipBlob, setZipBlob] = useState(null);

  // UI state
  const [showSettings, setShowSettings] = useState(false);
  const [showResume, setShowResume] = useState(false);

  // Init user code + run lightweight tests once
  useEffect(() => {
    const saved = localStorage.getItem("tts_user_code");
    let code = saved;
    if (!code) { code = randomCode(); localStorage.setItem("tts_user_code", code); }
    setUserCode(code);
    setTestsPassed(runParsingTests());
    // restore last script for this code (if any)
    const last = getLastScriptForCode(code);
    if (last) {
      setProjectName(last.projectName || "Untitled Project");
      setFileType(last.fileType || null);
      setRawFileText(last.rawText || "");
      if (last.fileType === 'csv') { setCsvHasHeader(last.options?.csvHasHeader ?? true); setCsvColumnIndex(last.options?.csvColumnIndex ?? 0); }
      if (last.fileType === 'jsonl') { setJsonlKey(last.options?.jsonlKey ?? 'text'); }
      setSentences(Array.isArray(last.sentences) ? last.sentences : []);
      const idx = Math.min(Math.max(0, last.index ?? 0), Math.max(0, (last.sentences?.length || 1) - 1));
      setIndex(idx);
    }
  }, []);

  async function requestMic() {
    if (!navigator.mediaDevices?.getUserMedia) { setMicError("Your browser does not support getUserMedia. Try Chrome, Edge, or Firefox."); return; }
    try {
      const constraints = { audio: selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : {} };
      const s = await navigator.mediaDevices.getUserMedia(constraints);
      setStream((prev) => { prev && prev.getTracks().forEach((t) => t.stop()); return s; });
      setMicError("");
      await refreshDevices();
    } catch (e) {
      console.error("Mic permission denied", e);
      setMicError("Microphone access denied or unavailable. Allow mic access in site settings and ensure you're on localhost or HTTPS.");
    }
  }

  async function refreshDevices() {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const mics = list.filter((d) => d.kind === "audioinput");
      setDevices(mics);
      if (!selectedDeviceId && mics[0]) setSelectedDeviceId(mics[0].deviceId || "");
    } catch (e) {}
  }

  // Request mic stream once & track device list
  useEffect(() => { requestMic(); }, []);
  useEffect(() => { navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices); refreshDevices(); return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refreshDevices); }, []);

  // Keyboard navigation
  useEffect(() => {
    function onKey(e) {
      if (isProcessing) return;
      if (e.key === "ArrowRight") { e.preventDefault(); next(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); prev(); }
      else if (e.code === "Space") { e.preventDefault(); toggleRecord(); }
      else if (e.key === "Escape" && showSettings) { e.preventDefault(); setShowSettings(false); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, isRecording, isProcessing, sentences.length, showSettings]);

  // While recording, any sentence that becomes visible counts as recorded
  useEffect(() => {
    if (!isRecording) return;
    if (!sentences.length) return;
    setRecordedIndices((prev) => {
      if (prev.has(index)) return prev;
      const next = new Set(prev);
      next.add(index);
      return next;
    });
    addLog("auto_mark_recorded", { reason: "displayed_while_recording", index });
  }, [index, isRecording, sentences.length]);

  function addLog(action, details = {}) {
    const entry = { ts: nowIso(), userCode, sessionId: currentSessionId.current, index, action, ...details };
    setLog((l) => [...l, entry]);
  }

  const prev = () => { if (isProcessing) return; const newIdx = Math.max(0, index - 1); setIndex(newIdx); addLog("nav_prev"); if (sentences.length && rawFileText) persistIndex({ code: userCode, scriptId: hashText(rawFileText), index: newIdx }); };
  const next = () => { if (isProcessing) return; const newIdx = Math.min(sentences.length - 1, index + 1); setIndex(newIdx); addLog("nav_next"); if (sentences.length && rawFileText) persistIndex({ code: userCode, scriptId: hashText(rawFileText), index: newIdx }); };

  function resetAll() {
    if (isRecording || isProcessing) return;
    setProjectName("Untitled Project");
    setSentences([]);
    setIndex(0);
    setRecorder(null);
    setRecordedIndices(new Set());
    setSessions([]);
    currentSessionId.current = null;
    setLog([]);
    setZipBlob(null);
  }

  function ensureSession() {
    if (!currentSessionId.current) {
      const id = `${userCode}-${Date.now()}`;
      currentSessionId.current = id;
      setSessions((s) => [...s, { id, start: nowIso(), takes: [] }]);
      addLog("session_started", { sessionId: id });
    }
  }

  const startedAtRef = useRef(null);

  async function toggleRecord() {
    if (isProcessing) return;
    if (!isRecording) {
      if (!stream) { setMicError("No microphone stream. Click 'Request Mic' in the header and allow access."); return; }
      if (typeof MediaRecorder === "undefined") { setMicError("MediaRecorder not supported in this browser."); return; }
      ensureSession();
      const mediaRecorder = new MediaRecorder(stream, { mimeType: getBestSupportedMime() });
      chunksRef.current = [];
      mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
      mediaRecorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const take = { idx: index, blob, startedAt: startedAtRef.current, endedAt: nowIso(), sessionId: currentSessionId.current };
        setSessions((ss) => ss.map((s) => (s.id === currentSessionId.current ? { ...s, takes: [...s.takes, take] } : s)));
        setRecordedIndices((prev) => new Set([...prev, index]));
        addLog("record_stop", { size: blob.size });
      };
      setRecorder(mediaRecorder);
      startedAtRef.current = nowIso();
      mediaRecorder.start();
      setIsRecording(true);
      playBeep(880);
      addLog("record_start");
    } else {
      playBeep(440);
      recorder?.stop();
      setIsRecording(false);
    }
  }

  async function handleFile(file) {
    const name = file.name.replace(/\.[^.]+$/, "");
    setProjectName(name);
    const txt = await file.text();
    setRawFileText(txt);
    const lower = file.name.toLowerCase();
    let lines = [];
    let detectedType = null;
    try {
      if (lower.endsWith(".txt")) { detectedType = 'txt'; setFileType('txt'); lines = parseTxt(txt); }
      else if (lower.endsWith(".csv")) { detectedType = 'csv'; setFileType('csv'); const { values, headers } = parseCsv(txt, { columnIndex: 0, hasHeader: csvHasHeader }); setCsvHeaders(headers); setCsvColumnIndex(0); lines = values; }
      else if (lower.endsWith(".jsonl") || lower.endsWith(".jsonlines")) { detectedType = 'jsonl'; setFileType('jsonl'); setJsonlKey('text'); lines = parseJsonl(txt, { key: 'text' }); }
      else { alert("Unsupported file type. Please upload .txt, .csv, or .jsonl"); return; }
      setSentences(lines);
      const scriptId = hashText(txt);
      const savedIdx = getSavedIndex({ code: userCode, scriptId });
      setIndex(Math.min(Math.max(0, savedIdx), Math.max(0, lines.length - 1)));
      setRecordedIndices(new Set());
      setLog((l) => [...l, { ts: nowIso(), userCode, action: "project_loaded", filename: file.name, count: lines.length }]);
      // persist snapshot of script
      persistScriptSnapshot({ code: userCode, scriptId, snapshot: { projectName: name, rawText: txt, fileType: detectedType, options: { csvHasHeader, csvColumnIndex: 0, jsonlKey: 'text' }, sentences: lines } });
    } catch (e) {
      console.error(e);
      alert("Failed to parse file. Make sure it is valid.");
    }
  }

  // Re-parse when CSV/JSONL options change
  useEffect(() => {
    if (!rawFileText) return;
    if (fileType === 'csv') {
      const { values, headers } = parseCsv(rawFileText, { columnIndex: csvColumnIndex, hasHeader: csvHasHeader });
      setCsvHeaders(headers);
      setSentences(values);
    } else if (fileType === 'jsonl') {
      setSentences(parseJsonl(rawFileText, { key: jsonlKey || 'text' }));
    }
  }, [csvColumnIndex, csvHasHeader, jsonlKey]);

  // persist snapshot whenever relevant state changes
  useEffect(() => {
    if (!rawFileText) return;
    const scriptId = hashText(rawFileText);
    persistScriptSnapshot({ code: userCode, scriptId, snapshot: { projectName, rawText: rawFileText, fileType, options: { csvHasHeader, csvColumnIndex, jsonlKey }, sentences } });
  }, [projectName, rawFileText, fileType, csvHasHeader, csvColumnIndex, jsonlKey, JSON.stringify(sentences), userCode]);

  const disableUi = isProcessing;
  const allRecorded = useMemo(() => sentences.length > 0 && recordedIndices.size === sentences.length, [sentences, recordedIndices]);
  const hasAnyRecording = useMemo(() => sessions.some((s) => s.takes.length > 0), [sessions]);

  async function buildDatasetZip() {
    if (isProcessing) return;
    if (!hasAnyRecording) { alert("No recordings yet - record at least one take to build a dataset."); return; }
    setIsProcessing(true);
    setProgress(2);
    setProgressMsg("Preparing audio...");
    addLog("dataset_processing_started");

    // Flatten and decode all takes in chronological order
    const takes = sessions.flatMap((s) => s.takes.map((t) => ({ ...t, sessionId: s.id })))
      .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));

    const targetRate = 48000;
    const decoded = [];
    for (let i = 0; i < takes.length; i++) {
      setProgressMsg(`Decoding take ${i + 1}/${takes.length}...`);
      const { pcm } = await decodeToMono(takes[i].blob, targetRate);
      decoded.push({ take: takes[i], pcm });
      setProgress(Math.round((10 * (i + 1)) / Math.max(1, takes.length)));
    }

    // Build per-sentence segments from logs
    setProgressMsg("Segmenting by navigation events...");
    const allSegments = [];
    for (let i = 0; i < decoded.length; i++) {
      const d = decoded[i];
      const segs = segmentTakeByLog({ take: d.take, pcm: d.pcm, sampleRate: targetRate, allLogs: log, sentencesLen: sentences.length });
      for (const s of segs) {
        const slice = d.pcm.slice(s.sampleStart, s.sampleEnd);
        allSegments.push({ pcm: slice, idx: s.idx, sessionId: d.take.sessionId, durationSec: s.durationSec });
      }
      setProgress(20 + Math.round((20 * (i + 1)) / Math.max(1, decoded.length)));
    }

    // Master concatenation
    setProgressMsg("Concatenating master audio...");
    const master = concatFloat32(allSegments.map((x) => x.pcm));
    const masterBlob = arrayBufferToWavBlob(master, targetRate);
    await sleep(50);

    const zip = new JSZip();
    const metaRows = [["file","sentence_index","text","id","session_id","user_code","duration_sec","offset_start_sec","offset_end_sec"].join(",")];
    const eventsRows = [["ts","action","index","session_id","user_code"].join(",")];

    // events: include only navigation and recording markers
    log.forEach(e => {
      if (["nav_next","nav_prev","record_start","record_stop","session_started"].includes(e.action)) {
        eventsRows.push([e.ts, e.action, e.index ?? "", e.sessionId ?? "", userCode].join(","));
      }
    });

    zip.folder("audio");
    zip.folder("audio/clips");
    zip.file("audio/all_sessions.wav", masterBlob);

    // Write clips and metadata
    let offsetSamples = 0;
    for (let i = 0; i < allSegments.length; i++) {
      const seg = allSegments[i];
      const clipBlob = arrayBufferToWavBlob(seg.pcm, targetRate);
      const fname = `audio/clips/${String(i + 1).padStart(4, "0")}_sent${String(seg.idx + 1).padStart(4, "0")}.wav`;
      zip.file(fname, clipBlob);
      const durationSec = seg.pcm.length / targetRate;
      const startSec = offsetSamples / targetRate;
      const endSec = (offsetSamples + seg.pcm.length) / targetRate;
      const sentenceObj = sentences[seg.idx] ?? { text: "", id: null };
      const sentenceText = sentenceObj.text ?? "";
      const sentenceId = sentenceObj.id ?? "";
      metaRows.push([fname, seg.idx, JSON.stringify(sentenceText), JSON.stringify(sentenceId), seg.sessionId, userCode, durationSec.toFixed(3), startSec.toFixed(3), endSec.toFixed(3)].join(","));
      offsetSamples += seg.pcm.length;
      setProgress(40 + Math.round((40 * (i + 1)) / Math.max(1, allSegments.length)));
      setProgressMsg(`Packaging clips ${i + 1}/${allSegments.length}...`);
    }

    // Add log + events + metadata
    const jsonl = log.map((e) => JSON.stringify(e)).join("\n");
    zip.file("log.jsonl", jsonl);
    zip.file("metadata.csv", metaRows.join("\n"));
    zip.file("events.csv", eventsRows.join("\n"));

    setProgressMsg("Creating ZIP archive...");
    const zipped = await zip.generateAsync({ type: "blob" }, (meta) => setProgress(90 + Math.round(meta.percent / 10)));

    setZipBlob(zipped);
    setProgress(100);
    setProgressMsg("Done. Your dataset is ready to download.");
    setIsProcessing(false);
    addLog("dataset_processing_finished", { size: zipped.size });
  }

  function downloadLogFile() {
    const jsonl = log.map((e) => JSON.stringify(e)).join("\n");
    const blob = new Blob([jsonl], { type: "application/jsonl" });
    downloadBlob(blob, `${projectName || "project"}_${userCode}_log.jsonl`);
  }

  const prevText = sentences[index - 1]?.text || "";
  const currText = sentences[index]?.text || "Upload a script to get started.";
  const nextText = sentences[index + 1]?.text || "";

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 selection:bg-indigo-500/50">
      <header className="sticky top-0 z-20 border-b border-zinc-800/80 bg-zinc-950/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-xl bg-gradient-to-br from-indigo-400 to-sky-400" />
            <div className="text-xl font-semibold tracking-tight">NB-TTS Prompter</div>
            <div className="hidden text-sm text-zinc-400 sm:block">- minimal voice dataset recorder</div>
          </div>

          <div className="flex items-center gap-2">
            <div className="hidden items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 sm:flex">
              <Users className="mr-1 h-4 w-4 text-zinc-400" />
              <span className="text-xs text-zinc-400">Code</span>
              <input
                value={userCode}
                onChange={(e) => {
                  const val = e.target.value.toUpperCase();
                  setUserCode(val);
                  localStorage.setItem("tts_user_code", val);
                  addLog("user_code_updated", { userCode: val });
                  const last = getLastScriptForCode(val);
                  if (last) {
                    setProjectName(last.projectName || "Untitled Project");
                    setFileType(last.fileType || null);
                    setRawFileText(last.rawText || "");
                    if (last.fileType === 'csv') { setCsvHasHeader(last.options?.csvHasHeader ?? true); setCsvColumnIndex(last.options?.csvColumnIndex ?? 0); }
                    if (last.fileType === 'jsonl') { setJsonlKey(last.options?.jsonlKey ?? 'text'); }
                    setSentences(Array.isArray(last.sentences) ? last.sentences : []);
                    const idx = Math.min(Math.max(0, last.index ?? 0), Math.max(0, (last.sentences?.length || 1) - 1));
                    setIndex(idx);
                  } else {
                    setProjectName("Untitled Project");
                    setSentences([]);
                    setIndex(0);
                  }
                }}
                className="w-24 bg-transparent text-sm outline-none placeholder:text-zinc-600"
                spellCheck={false}
              />
              <button onClick={() => setShowResume(true)} className="rounded-lg border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800">Resume…</button>
            </div>

            <label className={clsx("inline-flex cursor-pointer items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm hover:bg-zinc-800/70")}>
              <Upload className="h-4 w-4" />
              <span>Upload Script</span>
              <input type="file" accept=".txt,.csv,.jsonl,.jsonlines" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
            </label>

            {/* Format-specific parsing controls */}
            {fileType === 'csv' && (
              <div className="hidden items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 sm:flex">
                <label className="text-xs text-zinc-400 flex items-center gap-1">
                  <input type="checkbox" checked={csvHasHeader} onChange={(e) => setCsvHasHeader(e.target.checked)} />
                  Header row
                </label>
                <span className="text-xs text-zinc-400">Column</span>
                <select value={csvColumnIndex} onChange={(e) => setCsvColumnIndex(Number(e.target.value))} className="bg-transparent text-sm outline-none">
                  {csvHeaders.map((h, i) => (
                    <option key={i} value={i}>{i}: {h}</option>
                  ))}
                </select>
              </div>
            )}

            {fileType === 'jsonl' && (
              <div className="hidden items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 sm:flex">
                <span className="text-xs text-zinc-400">Key</span>
                <input value={jsonlKey} onChange={(e) => setJsonlKey(e.target.value)} className="bg-transparent text-sm outline-none w-28" placeholder="text" />
              </div>
            )}

            {/* Settings trigger */}
            <button onClick={() => setShowSettings((v) => !v)} className="inline-flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm hover:bg-zinc-800/70">
              <Settings className="h-4 w-4" /> Settings
            </button>

            <button onClick={resetAll} disabled={isProcessing} className="inline-flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm hover:bg-zinc-800/70 disabled:opacity-50">
              <RefreshCcw className="h-4 w-4" /> Reset
            </button>
          </div>
        </div>

        {/* Settings panel */}
        {showSettings && (
          <div className="mx-auto max-w-6xl px-4 pb-3">
            <div className="mt-2 rounded-2xl border border-zinc-800 bg-zinc-900 p-4 shadow-xl">
              <div className="mb-3 flex items-center justify-between">
                <div className="text-sm font-medium text-zinc-200">Settings</div>
                {testsPassed !== null && (
                  <div className="mx-auto max-w-6xl px-4 pb-3 text-xs text-zinc-400">Parsing tests: {testsPassed ? "all passed" : "failure (see console)"}</div>
                )}
                <button onClick={() => setShowSettings(false)} className="text-xs text-zinc-400 hover:text-zinc-200">Close</button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                  <div className="mb-2 text-xs uppercase tracking-wider text-zinc-400">Microphone</div>
                  <button
                    onClick={requestMic}
                    className="mb-2 inline-flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm hover:bg-zinc-800/70"
                    title="If blocked, allow mic access in site settings"
                  >
                    <Mic className="h-4 w-4" /> Request Mic
                  </button>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-400">Input</span>
                    <select value={selectedDeviceId} onChange={(e) => setSelectedDeviceId(e.target.value)} className="bg-transparent text-sm outline-none">
                      {devices.length === 0 && <option value="">Default</option>}
                      {devices.map((d) => (
                        <option key={d.deviceId || d.label} value={d.deviceId || ""}>{d.label || "Microphone"}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                  <div className="mb-2 text-xs uppercase tracking-wider text-zinc-400">Data</div>
                  <button onClick={downloadLogFile} className="inline-flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm hover:bg-zinc-800/70">
                    <Download className="h-4 w-4" /> Download Log
                  </button>
                  {micError && <div className="mt-2 text-xs text-red-400">{micError}</div>}
                </div>
              </div>
            </div>
          </div>
        )}
        {micError && (
          <div className="mx-auto max-w-6xl px-4 pb-3 text-sm text-red-400">{micError}</div>
        )}
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-2">
          <div className="text-lg font-semibold text-zinc-200">
            {projectName}
            <span className="ml-3 text-sm font-normal text-zinc-400">{sentences.length} sentences</span>
          </div>

          <div className="flex items-center gap-3 text-sm text-zinc-400">
            <div className="rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1">{recordedIndices.size}/{sentences.length} recorded</div>
            {currentSessionId.current ? (
              <div className="rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1">Session: {currentSessionId.current.split("-")[1]}</div>
            ) : (
              <div className="rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1">No active session</div>
            )}
          </div>
        </div>

        <div className="relative overflow-hidden rounded-3xl border border-zinc-800 bg-gradient-to-br from-zinc-950 to-zinc-900 p-6 shadow-xl">
          <div className="mb-3 text-center text-xs uppercase tracking-widest text-zinc-500">Sentence {Math.min(index + 1, sentences.length)} of {sentences.length}</div>
          <div className="mb-2 line-clamp-1 text-center text-3xl text-zinc-500">{prevText}</div>
          <div className="mx-auto mb-2 max-w-3xl text-center text-3xl font-semibold leading-relaxed text-cyan-200">{currText}</div>
          <div className="mt-2 line-clamp-1 text-center text-3xl text-zinc-500">{nextText}</div>
          <div className="pointer-events-none absolute right-4 top-4 flex items-center gap-2 text-sm">
            <span className={clsx("inline-flex h-2.5 w-2.5 rounded-full", isRecording ? "bg-red-500 animate-pulse" : "bg-zinc-600")}></span>
            <span className={clsx(isRecording ? "text-red-400" : "text-zinc-400")}>{isRecording ? "Recording" : "Idle"}</span>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button onClick={prev} disabled={disableUi} className="inline-flex items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-900/90 px-4 py-2 text-sm text-zinc-100 shadow hover:bg-zinc-800/80 disabled:opacity-50">
              <ArrowLeft className="h-4 w-4" /> Previous (Left)
            </button>
            <button onClick={next} disabled={disableUi} className="inline-flex items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-900/90 px-4 py-2 text-sm text-zinc-100 shadow hover:bg-zinc-800/80 disabled:opacity-50">
              Next (Right) <ArrowRight className="h-4 w-4" />
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button onClick={() => { if (isProcessing) return; if (!currentSessionId.current) { ensureSession(); } else { const id = `${userCode}-${Date.now()}`; currentSessionId.current = id; setSessions((s) => [...s, { id, start: nowIso(), takes: [] }]); addLog("session_started", { sessionId: id }); } }} disabled={isProcessing} className="inline-flex items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-900/90 px-4 py-2 text-sm text-zinc-100 shadow hover:bg-zinc-800/80 disabled:opacity-50">
              <AudioLines className="h-4 w-4" /> New Session
            </button>

            <button onClick={toggleRecord} disabled={!sentences.length || isProcessing} className={clsx("inline-flex items-center gap-2 rounded-2xl border px-4 py-2 text-sm shadow", isRecording ? "border-red-600 bg-red-600/10 text-red-200 hover:bg-red-600/20" : "border-emerald-600 bg-emerald-600/10 text-emerald-200 hover:bg-emerald-600/20")} title="Spacebar toggles recording">
              {isRecording ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              {isRecording ? "Stop" : "Record"} (Space)
            </button>

            <button onClick={buildDatasetZip} disabled={!hasAnyRecording || isProcessing || !sentences.length} className="inline-flex items-center gap-2 rounded-2xl border border-indigo-600 bg-indigo-600/10 px-4 py-2 text-sm text-indigo-200 shadow hover:bg-indigo-600/20 disabled:opacity-50">
              <Download className="h-4 w-4" /> Build Dataset
            </button>

            {zipBlob && !isProcessing && (
              <button onClick={() => downloadBlob(zipBlob, `${projectName || "project"}_${userCode}_dataset.zip`)} className="inline-flex items-center gap-2 rounded-2xl border border-sky-600 bg-sky-600/10 px-4 py-2 text-sm text-sky-200 shadow hover:bg-sky-600/20">
                <Download className="h-4 w-4" /> Download Dataset
              </button>
            )}
          </div>
        </div>

        {isProcessing && (
          <div className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <div className="mb-2 flex items-center justify-between text-sm text-zinc-300">
              <div className="flex items-center gap-2"><StopCircle className="h-4 w-4 text-zinc-400" />Processing...</div>
              <div className="text-zinc-400">This cannot be stopped</div>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
              <div className="h-full bg-gradient-to-r from-indigo-400 to-sky-400" style={{ width: `${progress}%` }} />
            </div>
            <div className="mt-2 text-xs text-zinc-400">{progressMsg}</div>
          </div>
        )}

        {sessions.length > 0 && (
          <div className="mt-8">
            <div className="mb-2 text-sm font-medium text-zinc-300">Recording Sessions</div>
            <div className="grid gap-2 sm:grid-cols-2">
              {sessions.map((s) => (
                <div key={s.id} className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                  <div className="mb-1 text-sm text-zinc-300">{s.id}</div>
                  <div className="text-xs text-zinc-500">{s.takes.length} takes • started {new Date(s.start).toLocaleString()}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-10 text-center text-xs text-zinc-500">
          Use Left / Right arrows to navigate. Press Space to start/stop recording. A pulsating dot indicates recording. All actions are captured in a timestamped log.
        </div>

        {/* Resume modal */}
        {showResume && (
          <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
            <div className="w-full max-w-xl rounded-2xl border border-zinc-800 bg-zinc-950 p-4 shadow-2xl">
              <div className="mb-3 flex items-center justify-between">
                <div className="text-sm font-medium text-zinc-200">Resume a saved script for code "{userCode}"</div>
                <button onClick={() => setShowResume(false)} className="text-xs text-zinc-400 hover:text-zinc-200">Close</button>
              </div>
              <SavedScriptsList
                userCode={userCode}
                onLoad={(snap) => {
                  setProjectName(snap.projectName || "Untitled Project");
                  setFileType(snap.fileType || null);
                  setRawFileText(snap.rawText || "");
                  if (snap.fileType === 'csv') { setCsvHasHeader(snap.options?.csvHasHeader ?? true); setCsvColumnIndex(snap.options?.csvColumnIndex ?? 0); }
                  if (snap.fileType === 'jsonl') { setJsonlKey(snap.options?.jsonlKey ?? 'text'); }
                  setSentences(Array.isArray(snap.sentences) ? snap.sentences : []);
                  const idx = Math.min(Math.max(0, snap.index ?? 0), Math.max(0, (snap.sentences?.length || 1) - 1));
                  setIndex(idx);
                  setShowResume(false);
                }}
              />
            </div>
          </div>
        )}
      </main>

      <style>{`
        .line-clamp-1{display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
      `}</style>
    </div>
  );
}

// Saved scripts list
function SavedScriptsList({ userCode, onLoad }) {
  const [items, setItems] = React.useState(() => listScriptsForCode(userCode));
  useEffect(() => { setItems(listScriptsForCode(userCode)); }, [userCode]);
  if (!items.length) return <div className="text-sm text-zinc-400">No saved scripts for this code.</div>;
  return (
    <div className="max-h-80 overflow-auto rounded-xl border border-zinc-800">
      <table className="w-full text-left text-sm text-zinc-300">
        <thead className="bg-zinc-900/80 text-zinc-400">
          <tr>
            <th className="px-3 py-2">Project</th>
            <th className="px-3 py-2">Updated</th>
            <th className="px-3 py-2">Sentences</th>
            <th className="px-3 py-2">Index</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {items.map((s) => (
            <tr key={s.scriptId} className="border-t border-zinc-800">
              <td className="px-3 py-2">{s.projectName || s.scriptId.slice(0,8)}</td>
              <td className="px-3 py-2 text-zinc-400">{s.updatedAt ? new Date(s.updatedAt).toLocaleString() : ""}</td>
              <td className="px-3 py-2">{Array.isArray(s.sentences) ? s.sentences.length : (s.rawText ? (s.rawText.match(/\n/g)||[]).length+1 : 0)}</td>
              <td className="px-3 py-2">{s.index ?? 0}</td>
              <td className="px-3 py-2 text-right">
                <button onClick={() => onLoad(s)} className="rounded-lg border border-indigo-600 bg-indigo-600/10 px-2 py-1 text-xs text-indigo-200 hover:bg-indigo-600/20">Load</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}