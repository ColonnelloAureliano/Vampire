(() => {
  "use strict";

  // =============================
  // CONFIG
  // =============================
  const CALIBRATION_MS = 3000;
  const SESSION_MS = 10000;

  const DOT_MIN_MS = 150;
  const DOT_MAX_MS = 300;
  const MIN_LINE_ABS_MS = 350;

  const MIN_ON_MS = 45;
  const MIN_OFF_MS = 90;

  const BAND_LOW_HZ = 900;
  const BAND_HIGH_HZ = 4000;
  const PEAK_DOMINANCE_RATIO = 1.20;

  const ABS_MIN_THRESHOLD = 10;
  const THRESHOLD_MULTIPLIER = 2.0;

  const MAX_SEQUENCE_LEN = 28;
  const SECRET_SEQUENCE = "..--";

  const MORSE_UNIT = 0.16;
  const MORSE_FREQ = 880;
  const MORSE_GAIN = 0.07;

  // =============================
  // DOM
  // =============================
  const app = document.getElementById("app");
  const startBtn = document.getElementById("startBtn");
  const topPanel = document.getElementById("topPanel");

  const topLabel = document.getElementById("topLabel");
  const progressBar = document.getElementById("progressBar");
  const timeText = document.getElementById("timeText");

  const statusText = document.getElementById("statusText");
  const subText = document.getElementById("subText");
  const seqText = document.getElementById("seqText");

  const mouthInner = document.getElementById("mouthInner");
  const tongue = document.getElementById("tongue");
  const fangL = document.getElementById("fangL");
  const fangR = document.getElementById("fangR");

  // =============================
  // AUDIO STATE
  // =============================
  let audioContext = null;
  let stream = null;
  let source = null;
  let analyser = null;
  let keepAliveGain = null;
  let keepAliveNode = null;
  let freqData = null;

  // =============================
  // APP STATE
  // =============================
  let active = false;
  let phase = "idle"; // idle | calibrating | session | success
  let calibrationStart = 0;
  let sessionStart = 0;
  let sessionEnd = 0;

  let threshold = ABS_MIN_THRESHOLD;
  let calibrationSamples = [];
  let sequence = "";
  let rafId = 0;

  let firstDotMs = null;

  let soundState = "idle"; // idle | pendingOn | on | pendingOff
  let soundCandidateStart = 0;
  let soundStart = 0;
  let soundEndCandidate = 0;

  let successLocked = false;
  let nhLoopTimeout = null;

  // =============================
  // HELPERS
  // =============================
  function now() {
    return performance.now();
  }

  function setStatus(main, sub = "") {
    statusText.textContent = main;
    subText.textContent = sub;
  }

  function setTopMode(mode) {
    topPanel.classList.remove("idle", "calibrating", "session", "success");
    topPanel.classList.add(mode);
  }

  function resetUi() {
    setTopMode("idle");
    topLabel.textContent = "Tempo sessione";
    progressBar.style.width = "0%";
    timeText.textContent = "Pronto";
    seqText.textContent = "—";
    sequence = "";
    firstDotMs = null;
  }

  function appendSymbol(symbol) {
    if (sequence.length >= MAX_SEQUENCE_LEN) {
      sequence = sequence.slice(-(MAX_SEQUENCE_LEN - 1));
    }
    sequence += symbol;
    seqText.textContent = sequence;
  }

  function bandMetrics(data, sampleRate, fftSize, lowHz, highHz) {
    const binHz = sampleRate / fftSize;
    const start = Math.max(0, Math.floor(lowHz / binHz));
    const end = Math.min(data.length - 1, Math.ceil(highHz / binHz));

    let sum = 0;
    let count = 0;
    let peak = -1;
    let peakIdx = start;

    for (let i = start; i <= end; i++) {
      const v = data[i];
      sum += v;
      count++;
      if (v > peak) {
        peak = v;
        peakIdx = i;
      }
    }

    return {
      avg: count ? sum / count : 0,
      peak,
      peakHz: peakIdx * sampleRate / fftSize
    };
  }

  function getDynamicLineMinMs() {
    if (firstDotMs == null) return MIN_LINE_ABS_MS;
    return Math.max(MIN_LINE_ABS_MS, firstDotMs * 2);
  }

  function classifyDuration(ms) {
    if (ms >= DOT_MIN_MS && ms <= DOT_MAX_MS) {
      if (firstDotMs == null) firstDotMs = ms;
      return ".";
    }

    const dynamicLineMin = getDynamicLineMinMs();
    if (ms >= dynamicLineMin) {
      return "-";
    }

    return null;
  }

  function isSecretMatched() {
    return sequence.endsWith(SECRET_SEQUENCE);
  }

  // =============================
  // AUDIO INPUT SETUP / STOP
  // =============================
  async function setupAudio() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("BROWSER_NOT_SUPPORTED");
    }

    audioContext = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: "interactive"
    });

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.18;
    source.connect(analyser);

    // keep alive minimo per Safari
    keepAliveGain = audioContext.createGain();
    keepAliveGain.gain.value = 0.00001;
    keepAliveGain.connect(audioContext.destination);

    if (typeof audioContext.createConstantSource === "function") {
      keepAliveNode = audioContext.createConstantSource();
      keepAliveNode.offset.value = 1;
      keepAliveNode.connect(keepAliveGain);
      keepAliveNode.start();
    } else {
      keepAliveNode = audioContext.createOscillator();
      keepAliveNode.frequency.value = 1;
      keepAliveNode.connect(keepAliveGain);
      keepAliveNode.start();
    }

    freqData = new Uint8Array(analyser.frequencyBinCount);
  }

  async function stopInputOnly() {
    cancelAnimationFrame(rafId);
    rafId = 0;

    try {
      if (stream) {
        stream.getTracks().forEach(t => t.stop());
      }
    } catch (_) {}

    try { if (source) source.disconnect(); } catch (_) {}
    try { if (analyser) analyser.disconnect(); } catch (_) {}

    stream = null;
    source = null;
    analyser = null;
    freqData = null;
  }

  async function teardownAudio() {
    cancelAnimationFrame(rafId);
    rafId = 0;

    try {
      if (stream) stream.getTracks().forEach(t => t.stop());
    } catch (_) {}

    try { if (source) source.disconnect(); } catch (_) {}
    try { if (analyser) analyser.disconnect(); } catch (_) {}
    try { if (keepAliveNode) keepAliveNode.disconnect(); } catch (_) {}
    try { if (keepAliveGain) keepAliveGain.disconnect(); } catch (_) {}

    try {
      if (keepAliveNode && typeof keepAliveNode.stop === "function") {
        keepAliveNode.stop();
      }
    } catch (_) {}

    if (nhLoopTimeout) {
      clearTimeout(nhLoopTimeout);
      nhLoopTimeout = null;
    }

    try {
      if (audioContext && audioContext.state !== "closed") {
        await audioContext.close();
      }
    } catch (_) {}

    audioContext = null;
    stream = null;
    source = null;
    analyser = null;
    keepAliveGain = null;
    keepAliveNode = null;
    freqData = null;
  }

  // =============================
  // MORSE OUTPUT
  // =============================
  function scheduleTone(startTime, durationSec, freq = MORSE_FREQ, gainValue = MORSE_GAIN) {
    if (!audioContext) return;

    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, startTime);

    gain.gain.setValueAtTime(0.00001, startTime);
    gain.gain.linearRampToValueAtTime(gainValue, startTime + 0.01);
    gain.gain.setValueAtTime(gainValue, startTime + Math.max(0.01, durationSec - 0.02));
    gain.gain.linearRampToValueAtTime(0.00001, startTime + durationSec);

    osc.connect(gain);
    gain.connect(audioContext.destination);

    osc.start(startTime);
    osc.stop(startTime + durationSec + 0.02);
  }

  function scheduleNhCycle(startAt) {
    let t = startAt;
    const u = MORSE_UNIT;

    function addSymbol(symbol) {
      const dur = symbol === "-" ? 3 * u : 1 * u;
      scheduleTone(t, dur);
      t += dur + 1 * u;
    }

    // N = -.
    addSymbol("-");
    addSymbol(".");
    t += 2 * u;

    // H = ....
    addSymbol(".");
    addSymbol(".");
    addSymbol(".");
    addSymbol(".");
    t += 6 * u;

    return t - startAt;
  }

  function startNhLoop() {
    if (!audioContext) return;

    const loopOnce = async () => {
      if (!successLocked || !audioContext) return;

      if (audioContext.state === "suspended") {
        try { await audioContext.resume(); } catch (_) {}
      }

      const startTime = audioContext.currentTime + 0.05;
      const cycleDur = scheduleNhCycle(startTime);

      nhLoopTimeout = setTimeout(loopOnce, Math.max(50, cycleDur * 1000));
    };

    loopOnce();
  }

  // =============================
  // PHASES
  // =============================
  function beginCalibration() {
    phase = "calibrating";
    calibrationStart = now();
    calibrationSamples = [];
    threshold = ABS_MIN_THRESHOLD;

    setTopMode("calibrating");
    topLabel.textContent = "Calibrazione";
    progressBar.style.width = "0%";
    timeText.textContent = "3.0 s";

    setStatus("Fai silenzio", "Misuro il rumore di fondo...");
    startBtn.classList.add("calibrating");
  }

  function beginSession() {
    phase = "session";
    sessionStart = now();
    sessionEnd = sessionStart + SESSION_MS;

    setTopMode("session");
    topLabel.textContent = "Tempo sessione";
    progressBar.style.width = "0%";
    timeText.textContent = "10.0 s";

    setStatus("Ascolto attivo", "Punto 150–300 ms • Linea = doppio del primo punto (min 350 ms)");
    startBtn.classList.remove("calibrating");
  }

  async function enterSuccessMode() {
    if (successLocked) return;

    successLocked = true;
    active = false;
    phase = "success";

    cancelAnimationFrame(rafId);
    rafId = 0;

    await stopInputOnly();

    startBtn.disabled = true;
    startBtn.classList.remove("calibrating");
    startBtn.classList.add("active", "sounding", "mouth-live");

    app.classList.remove("listening");
    app.classList.add("success-mode");

    setTopMode("success");
    topLabel.textContent = "Risveglio";
    progressBar.style.width = "100%";
    timeText.textContent = "—";

    setStatus("Sequenza corretta", "Alza il volume e senti il mio grido");

    // forza bocca molto aperta e zanne lunghe
    if (mouthInner) mouthInner.style.transform = "scaleY(1.92)";
    if (tongue) tongue.style.transform = "translateY(12px) scaleY(1.14)";
    if (fangL) fangL.style.transform = "translateY(14px) scaleY(1.34)";
    if (fangR) fangR.style.transform = "translateY(14px) scaleY(1.34)";

    startNhLoop();
  }

  async function startApp() {
    if (active || successLocked) return;

    active = true;
    app.classList.add("listening");
    app.classList.remove("success-mode");

    startBtn.classList.add("active");
    startBtn.classList.remove("mouth-live");
    startBtn.disabled = true;

    // reset forzature finali
    if (mouthInner) mouthInner.style.transform = "";
    if (tongue) tongue.style.transform = "";
    if (fangL) fangL.style.transform = "";
    if (fangR) fangR.style.transform = "";

    resetUi();
    setStatus("Richiesta microfono...", "Consenti l’accesso se il browser lo chiede");

    try {
      await setupAudio();
      beginCalibration();
      rafId = requestAnimationFrame(loop);
    } catch (err) {
      console.error(err);

      let msg = "Errore accesso microfono";
      if (err && err.name === "NotAllowedError") msg = "Permesso microfono negato o bloccato";
      else if (err && err.name === "NotFoundError") msg = "Microfono non trovato";
      else if (err && err.message === "BROWSER_NOT_SUPPORTED") msg = "Browser non compatibile";

      setStatus(`❌ ${msg}`, "Apri la pagina in HTTPS e abilita il microfono");
      active = false;
      phase = "idle";
      startBtn.disabled = false;
      startBtn.classList.remove("active", "calibrating", "sounding", "mouth-live");
      app.classList.remove("listening");
      await teardownAudio();
    }
  }

  async function endApp(finalText) {
    if (successLocked) return;

    active = false;
    phase = "idle";

    startBtn.disabled = false;
    startBtn.classList.remove("active", "calibrating", "sounding", "mouth-live");
    app.classList.remove("listening");

    setTopMode("success");
    progressBar.style.width = "100%";
    timeText.textContent = "Fine";

    setStatus(
      "Fine ascolto",
      finalText || (sequence ? `Sequenza finale: ${sequence}` : "Nessun simbolo rilevato")
    );

    await teardownAudio();
  }

  // =============================
  // MAIN LOOP
  // =============================
  function loop(ts) {
    if (!active || !analyser || !freqData) return;

    analyser.getByteFrequencyData(freqData);

    const sampleRate = audioContext.sampleRate;
    const fftSize = analyser.fftSize;
    const band = bandMetrics(freqData, sampleRate, fftSize, BAND_LOW_HZ, BAND_HIGH_HZ);

    const level = band.avg;
    const peakHz = band.peakHz;
    const dominance = band.avg > 0 ? (band.peak / band.avg) : 0;

    // --- FASE CALIBRAZIONE ---
    if (phase === "calibrating") {
      const elapsed = ts - calibrationStart;
      const remain = Math.max(0, CALIBRATION_MS - elapsed);
      const progress = Math.min(1, elapsed / CALIBRATION_MS);

      progressBar.style.width = `${progress * 100}%`;
      timeText.textContent = `${(remain / 1000).toFixed(1)} s`;

      calibrationSamples.push(level);
      const avgNoise = calibrationSamples.reduce((a, b) => a + b, 0) / Math.max(1, calibrationSamples.length);
      threshold = Math.max(ABS_MIN_THRESHOLD, avgNoise * THRESHOLD_MULTIPLIER);

      if (elapsed >= CALIBRATION_MS) {
        beginSession();
      }

      rafId = requestAnimationFrame(loop);
      return;
    }

    // --- FASE SESSIONE ---
    if (phase === "session") {
      const elapsed = ts - sessionStart;
      const remain = Math.max(0, sessionEnd - ts);
      const progress = Math.min(1, elapsed / SESSION_MS);

      progressBar.style.width = `${progress * 100}%`;
      timeText.textContent = `${(remain / 1000).toFixed(1)} s`;

      const whistleLike =
        level >= threshold &&
        peakHz >= BAND_LOW_HZ &&
        peakHz <= BAND_HIGH_HZ &&
        dominance >= PEAK_DOMINANCE_RATIO;

      if (whistleLike) startBtn.classList.add("sounding");
      else startBtn.classList.remove("sounding");

      if (soundState === "idle") {
        if (whistleLike) {
          soundState = "pendingOn";
          soundCandidateStart = ts;
        }
      } else if (soundState === "pendingOn") {
        if (!whistleLike) {
          soundState = "idle";
        } else if ((ts - soundCandidateStart) >= MIN_ON_MS) {
          soundState = "on";
          soundStart = soundCandidateStart;
        }
      } else if (soundState === "on") {
        if (!whistleLike) {
          soundState = "pendingOff";
          soundEndCandidate = ts;
        }
      } else if (soundState === "pendingOff") {
        if (whistleLike) {
          soundState = "on";
        } else if ((ts - soundEndCandidate) >= MIN_OFF_MS) {
          const durationMs = soundEndCandidate - soundStart;
          const symbol = classifyDuration(durationMs);

          if (symbol) {
            appendSymbol(symbol);

            if (symbol === ".") {
              setStatus("Punto rilevato", "Continua...");
            } else {
              setStatus("Linea rilevata", "Continua...");
            }

            if (isSecretMatched()) {
              enterSuccessMode();
              return;
            }
          } else {
            setStatus("Suono ignorato", "Riprova");
          }

          soundState = "idle";
          startBtn.classList.remove("sounding");
        }
      }

      if (ts >= sessionEnd) {
        endApp();
        return;
      }
    }

    rafId = requestAnimationFrame(loop);
  }

  // =============================
  // EVENTI
  // =============================
  startBtn.addEventListener("click", async () => {
    if (active || successLocked) return;
    await startApp();
  }, { passive: true });

  document.addEventListener("visibilitychange", async () => {
    if (document.hidden && active && !successLocked) {
      await endApp("Sessione interrotta");
    }
  });

  window.addEventListener("pagehide", async () => {
    if (active || audioContext || successLocked) {
      await teardownAudio();
    }
  });

  resetUi();
})();
``
