/* ============================================================
   calibration.js – body profiles + calibration wizard
   - Presets (Standard, Gentle) and personal profiles saved in localStorage
   - Wizard measures: neutral stance, arm range, twist range, sit/stand hip angles
   - Personal thresholds = a % of the person's own range, clamped to BOUNDS
   - Hands-free: raise a hand above your shoulder for 1 second to confirm / start each step
   ============================================================ */
(function () {
  'use strict';
  const { $, U, CFG, live, track, game } = GW;
  const { clamp } = U;

  const STORE_KEY = 'gw.profiles.v1';

  /* The standard thresholds (identical to the original game) */
  const STANDARD = { HIP_TARGET: 160, THIGH_TARGET: 22, SEATED_HIP: 135, ARM_UP: 140, ARM_DOWN: 60, TWIST_TARGET: 20, TWIST_OFFSET: 0 };
  const PRESETS = {
    standard: { label: 'Standard (fixed)', t: { ...STANDARD } },
    gentle:   { label: 'Gentle – limited mobility (fixed)', t: { HIP_TARGET: 150, THIGH_TARGET: 30, SEATED_HIP: 130, ARM_UP: 110, ARM_DOWN: 60, TWIST_TARGET: 12, TWIST_OFFSET: 0 } }
  };
  /* Safe limits [min, max] a personal threshold may reach.
     PLACEHOLDER VALUES: a physiotherapist should confirm or change these. */
  const BOUNDS = {
    HIP_TARGET: [130, 160], THIGH_TARGET: [22, 40], SEATED_HIP: [100, 150],
    ARM_UP: [80, 140], ARM_DOWN: [45, 70], TWIST_TARGET: [8, 20], TWIST_OFFSET: [-25, 25]
  };
  GW.PRESETS = PRESETS; GW.BOUNDS = BOUNDS;

  const calib = GW.calib = { active: false, good: false };
  GW.profile = { id: 'preset:standard', name: 'Standard', adaptive: false };

  /* ---------- storage ---------- */
  let store = { list: [], active: 'preset:standard', side: 'auto' };
  function loadStore() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && Array.isArray(s.list)) store = { list: s.list.filter(p => p && typeof p.name === 'string' && p.thresholds), active: s.active || 'preset:standard', side: s.side || 'auto' };
    } catch (e) {}
  }
  function saveStore() { try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) {} }
  const findProfile = name => store.list.find(p => p.name === name);

  function sanitize(t) {
    const o = { ...STANDARD };
    for (const k in STANDARD) {
      const v = t && t[k];
      if (typeof v === 'number' && isFinite(v)) { const b = BOUNDS[k]; o[k] = b ? clamp(v, b[0], b[1]) : v; }
    }
    o.SEATED_HIP = Math.min(o.SEATED_HIP, o.HIP_TARGET - 10);
    o.ARM_DOWN = Math.min(o.ARM_DOWN, o.ARM_UP - 25);
    return o;
  }

  /* ---------- profile selection ---------- */
  function useProfile(id) {
    let name, t, adaptive = false;
    if (id.indexOf('saved:') === 0) {
      const p = findProfile(id.slice(6));
      if (p) { name = p.name; t = p.thresholds; adaptive = true; }
    }
    if (!t) {
      const key = id.indexOf('preset:') === 0 && PRESETS[id.slice(7)] ? id.slice(7) : 'standard';
      id = 'preset:' + key; name = PRESETS[key].label; t = PRESETS[key].t;
    }
    Object.assign(CFG, sanitize(t));
    GW.profile = { id, name, adaptive };
    store.active = id; saveStore();
    refreshProfileUI();
    GW.setMode(game.mode);
  }

  function refreshProfileUI() {
    const sel = $('profSel'); sel.innerHTML = '';
    const add = (v, text) => { const o = document.createElement('option'); o.value = v; o.textContent = text; sel.appendChild(o); };
    add('preset:standard', PRESETS.standard.label);
    add('preset:gentle', PRESETS.gentle.label);
    store.list.forEach(p => add('saved:' + p.name, '★ ' + p.name + ' (calibrated)'));
    sel.value = GW.profile.id;
    $('sideSel').value = CFG.SIDE;
    $('profDel').disabled = !GW.profile.adaptive;
    const R = Math.round;
    $('profInfo').textContent = (GW.profile.adaptive ? 'Adaptive thresholds (personal calibration). ' : 'Fixed thresholds (preset). ') +
      'Hip > ' + R(CFG.HIP_TARGET) + '° · thigh < ' + R(CFG.THIGH_TARGET) + '° · arms > ' + R(CFG.ARM_UP) + '° · twist ± ' + R(CFG.TWIST_TARGET) + '°';
  }

  /* ============================================================
     HANDS-FREE CONFIRMATION
     Raise either hand above the same-side shoulder and hold it for HAND_HOLD_MS.
     The gesture only "arms" after both hands have been down for LOW_MS, so a hand that is
     still up from the previous step can never trigger the next one by accident.
     ============================================================ */
  const HAND_HOLD_MS = 1000, LOW_MS = 500, HAND_MARGIN = 0.05;   // margin = fraction of the picture height
  let gArmed = false, gLowSince = 0, gHandSince = 0, gProgress = 0, gStatus = 'wait';

  function handUp() {
    const lm = track.lm; if (!lm || performance.now() - track.t > 500) return false;
    return [[11, 15], [12, 16]].some(p => {
      const s = lm[p[0]], w = lm[p[1]];
      return s && w && (s.visibility ?? 0) >= 0.5 && (w.visibility ?? 0) >= 0.5 && w.y < s.y - HAND_MARGIN;
    });
  }
  function gestureReset() { gArmed = false; gLowSince = 0; gHandSince = 0; gProgress = 0; gStatus = 'wait'; }
  function gestureStep(now, enabled) {          // returns true once, when the gesture is completed
    if (!enabled) { gHandSince = 0; gProgress = 0; gStatus = 'off'; return false; }
    if (!handUp()) {
      if (!gLowSince) gLowSince = now;
      if (now - gLowSince >= LOW_MS) gArmed = true;
      gHandSince = 0; gProgress = 0; gStatus = 'wait';
      return false;
    }
    gLowSince = 0;
    if (!gArmed) { gHandSince = 0; gProgress = 0; gStatus = 'lower'; return false; }
    if (!gHandSince) gHandSince = now;
    gProgress = Math.min(1, (now - gHandSince) / HAND_HOLD_MS); gStatus = 'hold';
    if (gProgress >= 1) { gArmed = false; gHandSince = 0; gProgress = 0; gStatus = 'wait'; return true; }
    return false;
  }

  /* short beep so the person (standing far from the screen) knows it worked */
  let beepCtx = null;
  function beep(freq, dur) {
    if (GW.settings && GW.settings.sound === false) return;      // respects the Sound effects setting
    try {
      beepCtx = beepCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (beepCtx.state === 'suspended') beepCtx.resume();
      const o = beepCtx.createOscillator(), g = beepCtx.createGain(), t = beepCtx.currentTime;
      o.type = 'sine'; o.frequency.value = freq || 880;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + (dur || 0.25));
      o.connect(g).connect(beepCtx.destination); o.start(t); o.stop(t + (dur || 0.25) + 0.05);
    } catch (e) {}
  }

  /* the on-screen hint + progress bar are created here, so index.html needs no change */
  let gBox = null, gText = null, gFill = null;
  function buildGestureUI() {
    if (gBox || !$('calMsg')) return;
    const st = document.createElement('style');
    st.textContent =
      '#calGesture{margin-top:10px;padding:10px 14px;border-radius:12px;border:1px dashed var(--cyan);background:rgba(56,189,248,.08);font-size:18px;color:var(--cyan)}' +
      '#calGesture.hold{border-style:solid;background:rgba(56,189,248,.16)}' +
      '#calGesture.lower{border-color:var(--warn);color:#fed7aa;background:rgba(251,146,60,.1)}' +
      '#calGesture .gbar{height:8px;margin-top:8px;background:#0b1428;border-radius:5px;overflow:hidden}' +
      '#calGesture .gbar i{display:block;height:100%;width:0;background:var(--ok)}';
    document.head.appendChild(st);
    gBox = document.createElement('div'); gBox.id = 'calGesture'; gBox.hidden = true;
    gBox.innerHTML = '<span></span><div class="gbar"><i></i></div>';
    $('calMsg').parentNode.insertBefore(gBox, $('calMsg').nextSibling);
    gText = gBox.firstChild; gFill = gBox.querySelector('i');
  }
  function renderGesture(enabled, verb) {
    if (!gBox) return;
    gBox.hidden = !enabled;
    if (!enabled) return;
    gBox.className = gStatus === 'hold' ? 'hold' : gStatus === 'lower' ? 'lower' : '';
    gText.textContent = gStatus === 'lower' ? '✋ Lower both hands first, then raise one again'
                      : gStatus === 'hold'  ? '✋ Hold it…'
                      : '✋ Raise a hand above your shoulder for 1 second ' + verb;
    gFill.style.width = Math.round(gProgress * 100) + '%';
  }

  /* ============================================================
     WIZARD
     ============================================================ */
  const HOLD_MS = 3000, SETTLE_MS = 500, MAX_SPREAD = 14, COUNT_S = 3;
  const WIZ_VIS = 0.3;          // landmark confidence needed while calibrating (the game itself keeps its own value)
  const GOOD_RATIO = 0.5;       // share of frames that must be usable during a 3-second hold
  let savedVis = null, fails = 0, miss = {};
  const LABEL = { arm: 'Arm angle', twist: 'Twist', hip: 'Hip angle', thigh: 'Thigh angle' };

  const STEPS = [
    { id: 'frame', group: 'frame', title: 'Get in frame',
      text: 'Stand 2–3 steps back, facing the camera, so your head, arms and hips are visible. Good light in front helps. Stop if you feel pain or dizzy, and keep someone nearby.' },
    { id: 'neutral', group: 'neutral', need: ['arms', 'twist'], title: 'Stand relaxed',
      text: 'Face the camera with your arms relaxed at your sides. Look straight ahead and breathe normally. Raise a hand to start, then lower it – the 3-2-1 countdown gives you time.',
      read: () => ({ arm: Math.max(live.armL, live.armR), twist: live.twistRaw }) },
    { id: 'arms', group: 'arms', need: ['arms'], title: 'Raise both arms',
      text: 'Lift both arms up as high as is comfortable. Stop before any pain, then hold still.',
      read: () => ({ arm: Math.min(live.armL, live.armR) }) },
    { id: 'twistA', group: 'twist', need: ['twist'], title: 'Twist to one side',
      text: 'Keep your feet still and turn your upper body to ONE side as far as is comfortable, then hold.',
      read: () => ({ twist: live.twist }) },
    { id: 'twistB', group: 'twist', need: ['twist'], title: 'Twist to the other side',
      text: 'Now turn your upper body to the OTHER side as far as is comfortable, then hold.',
      read: () => ({ twist: live.twist }) },
    { id: 'sit', group: 'legs', need: ['leg'], title: 'Sit side-on',
      text: 'Put a sturdy chair side-on to the camera and sit down, so the camera sees your side (shoulder, hip, knee and ankle). Sit upright and hold. Skip this step if your legs are not visible.',
      read: () => ({ hip: live.hip, thigh: live.thigh }) },
    { id: 'stand', group: 'legs', need: ['leg'], title: 'Stand tall, side-on',
      text: 'Stand up as tall as is comfortable, still side-on to the camera, and hold. Use the chair or a support if needed.',
      read: () => ({ hip: live.hip, thigh: live.thigh }) }
  ];

  let idx = 0, state = 'idle', res = {}, snapshot = null, pending = null, retry = false;
  let t0 = 0, samples = [], frames = 0, goodFrames = 0, advTimer = 0;

  const median = a => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

  /* framing checklist from the latest landmarks */
  const GROUPS = { chkHead: [0, 11, 12], chkArms: [13, 14, 15, 16], chkHips: [23, 24], chkLegs: [25, 26, 27, 28] };
  function updateChecks() {
    const lm = track.lm, fresh = lm && performance.now() - track.t < 500;
    const ok = {};
    for (const id in GROUPS) {
      ok[id] = !!fresh && GROUPS[id].every(i => {
        const p = lm[i]; return p && (p.visibility ?? 0) >= 0.5 && p.x > 0.01 && p.x < 0.99 && p.y > 0.01 && p.y < 0.99;
      });
      const el = $(id); el.classList.toggle('on', ok[id]); el.classList.toggle('off', !ok[id]);
    }
    calib.good = ok.chkHead && ok.chkArms && ok.chkHips;
    return ok;
  }

  function showStep(i) {
    idx = i; state = 'idle'; retry = false; fails = 0; clearTimeout(advTimer); gestureReset();
    const s = STEPS[i];
    $('calStepNo').textContent = 'Step ' + (i + 1) + ' of ' + STEPS.length;
    $('calTitle').textContent = s.title; $('calText').textContent = s.text;
    $('calSummary').hidden = true; $('calSummary').innerHTML = '';
    $('calText').hidden = false; $('calLive').hidden = false;
    $('calCount').textContent = ''; $('calBar').firstElementChild.style.width = '0';
    setMsg('', '');
    $('calStart').textContent = s.id === 'frame' ? 'Continue' : 'Start (3-2-1)';
    $('calStart').disabled = false; $('calSkip').hidden = s.id === 'frame';
  }
  function setMsg(text, cls) { const m = $('calMsg'); m.textContent = text; m.className = cls || ''; }

  function next() {
    if (idx + 1 >= STEPS.length) showSummary(); else showStep(idx + 1);
  }
  function skipGroup() {
    const g = STEPS[idx].group; let j = idx + 1;
    while (j < STEPS.length && STEPS[j].group === g) j++;
    if (j >= STEPS.length) showSummary(); else showStep(j);
  }

  function startCount() {
    state = 'count'; t0 = performance.now();
    $('calStart').disabled = true; setMsg('Get ready…', '');
  }
  function stepReady(s) { return live.tracking && (s.need || []).every(k => live.ok[k]); }

  function finishCapture() {
    const s = STEPS[idx];
    const reliable = frames > 0 && goodFrames / frames >= GOOD_RATIO && samples.length >= 8;
    if (!reliable) { fail(explainMiss()); return; }
    const out = {}; let spread = 0;
    for (const k in samples[0]) {
      const vals = samples.map(v => v[k]);
      out[k] = median(vals); spread = Math.max(spread, pct(vals, 0.9) - pct(vals, 0.1));
    }
    if (spread > MAX_SPREAD) { fail('You were moving too much. Hold still for the full 3 seconds and try again.'); return; }
    res[s.id] = out;
    if (s.id === 'neutral') CFG.TWIST_OFFSET = clamp(out.twist, -25, 25);   // person's own neutral twist
    state = 'done'; setMsg('Got it ✔', 'good'); $('calCount').textContent = '✔';
    beep(1175, 0.3);
    advTimer = setTimeout(() => { if (calib.active && state === 'done') next(); }, 800);
  }
  const NEED_TEXT = { arms: 'both arms (shoulders, wrists and hips)', twist: 'both shoulders and both hips', leg: 'one whole side of your body (shoulder, hip, knee, ankle)' };
  const NEED_TIP = {
    arms: 'Step back a little so your hands stay inside the picture, also when raised.',
    twist: 'Turn only as far as keeps both shoulders visible, and wear clothes that show your hips.',
    leg: 'Turn fully side-on, and make sure the leg setting in "Body Profile" is Auto or the leg nearest the camera.'
  };
  function explainMiss() {
    const n = Math.max(1, frames), parts = [];
    let worst = null, wv = 0;
    for (const k in miss) if (miss[k] > wv) { wv = miss[k]; worst = k; }
    const pctMiss = Math.round(100 * wv / n);
    if (!worst || wv === 0) return 'Too few good frames were captured (' + goodFrames + ' of ' + frames + '). Hold still and try again.';
    if (worst === 'tracking') return 'I lost you for ' + pctMiss + '% of the hold. Check the picture, the lighting and that you stay in frame, then try again.';
    if (worst === 'value') return 'The wizard could not read the angle values. Make sure game.js and mediapipe.js are the latest versions (both were updated for calibration).' + (fails >= 1 ? '' : '');
    return 'I could not see ' + (NEED_TEXT[worst] || worst) + ' for ' + pctMiss + '% of the hold. ' + (NEED_TIP[worst] || '') + (fails >= 1 ? ' If it keeps failing, use "Skip this step".' : '');
  }
  function fail(msg) {
    fails++;
    state = 'idle'; retry = true; gestureReset(); setMsg(msg, 'bad'); $('calCount').textContent = '';
    $('calStart').disabled = false; $('calStart').textContent = 'Try again';
    beep(300, 0.3);
  }

  function liveText(s) {
    if (!s.read) return '';
    try {
      const v = s.read();
      return Object.keys(v).map(k => LABEL[k] + ': ' + (Number.isFinite(v[k]) ? Math.round(v[k]) + '°' : '--')).join('   ');
    } catch (e) { return ''; }
  }

  /* what pressing the main button does – also what the hand-raise gesture does */
  function pressStart() {
    if (state === 'summary') savePending();
    else if (STEPS[idx].id === 'frame') { if (calib.good) next(); }
    else if (state === 'idle') startCount();
  }

  function seeingText(s) {
    if (!live.tracking) return 'No body detected';
    const names = { arms: 'Arms', twist: 'Shoulders+hips', leg: 'Side leg' };
    return 'Seeing: ' + s.need.map(k => names[k] + (live.ok[k] ? ' ✓' : ' ✗')).join('  ');
  }
  let lastCountShown = 0;
  function tick(now) {
    if (!calib.active) return;
    requestAnimationFrame(tick);
    updateChecks();
    const s = STEPS[idx];

    if (state === 'summary') { renderGesture(false); return; }   // saving needs a typed name, so it stays a click

    const canGesture = state === 'idle' && (s.id !== 'frame' || calib.good);
    if (gestureStep(now, canGesture)) { beep(880, 0.2); pressStart(); }
    renderGesture(canGesture && state === 'idle', s.id === 'frame' ? 'to continue' : retry ? 'to try again' : 'to start');

    if (s.id === 'frame') {
      $('calStart').disabled = !calib.good;
      setMsg(calib.good ? 'Great – you are in frame.' : 'Move until the first three boxes turn green.', calib.good ? 'good' : 'bad');
      return;
    }
    $('calLive').textContent = liveText(s) + (s.need ? '   |   ' + seeingText(s) : '');

    if (state === 'count') {
      const left = COUNT_S - (now - t0) / 1000;
      if (left <= 0) { state = 'sampling'; t0 = now; samples = []; frames = 0; goodFrames = 0; miss = { tracking: 0, arms: 0, twist: 0, leg: 0, value: 0 }; $('calCount').textContent = 'Hold…'; setMsg('Hold still', ''); beep(1046, 0.15); }
      else {
        const n = Math.ceil(left); $('calCount').textContent = n;
        if (n !== lastCountShown) { lastCountShown = n; beep(660, 0.1); }
      }
    } else if (state === 'sampling') {
      const el = now - t0;
      $('calBar').firstElementChild.style.width = Math.min(100, el / HOLD_MS * 100) + '%';
      if (el > SETTLE_MS) {
        frames++;
        if (!live.tracking) miss.tracking++;
        else {
          const lost = (s.need || []).filter(k => !live.ok[k]);
          if (lost.length) lost.forEach(k => miss[k]++);
          else {
            const v = s.read();
            if (Object.keys(v).every(k => Number.isFinite(v[k]))) { samples.push(v); goodFrames++; }
            else miss.value++;
          }
        }
      }
      if (el >= HOLD_MS) finishCapture();
    }
  }

  /* ---------- turn measurements into personal thresholds ---------- */
  function compute() {
    const t = { ...STANDARD }, notes = [], r = res, B = BOUNDS, ab = Math.abs;
    t.TWIST_OFFSET = r.neutral ? CFG.TWIST_OFFSET : 0;

    if (r.arms) {
      const rest = r.neutral ? r.neutral.arm : 10, max = r.arms.arm;
      if (max - rest < 20) notes.push('Arm raise: the arms barely moved, so the standard arm thresholds were kept.');
      else {
        t.ARM_UP = clamp(0.85 * max, B.ARM_UP[0], B.ARM_UP[1]);
        t.ARM_DOWN = clamp(rest + 30, B.ARM_DOWN[0], B.ARM_DOWN[1]);
        if (0.85 * max < B.ARM_UP[0]) notes.push('Arm range is below the safe minimum – please have a therapist review.');
      }
    } else notes.push('Arm step skipped: standard arm thresholds used.');

    if (r.twistA && r.twistB) {
      const a = r.twistA.twist, b = r.twistB.twist, m = Math.min(ab(a), ab(b));
      if (a * b >= 0 || m < 4) notes.push('Twist: the two sides were not clearly different, so the standard twist target was kept.');
      else {
        t.TWIST_TARGET = clamp(0.8 * m, B.TWIST_TARGET[0], B.TWIST_TARGET[1]);
        if (0.8 * m < B.TWIST_TARGET[0]) notes.push('Twist range is below the safe minimum – please have a therapist review.');
        if (Math.max(ab(a), ab(b)) > 1.8 * m) notes.push('Twist is uneven between the two sides.');
      }
    } else notes.push('Twist step skipped: standard twist target used.');

    if (r.sit && r.stand) {
      const range = r.stand.hip - r.sit.hip;
      if (range < 25) notes.push('Sit-to-stand: the hip angle changed very little, so the standard values were kept.');
      else {
        t.HIP_TARGET = clamp(Math.min(r.sit.hip + 0.85 * range, r.stand.hip - 3), B.HIP_TARGET[0], B.HIP_TARGET[1]);
        t.SEATED_HIP = clamp(r.sit.hip + 0.4 * range, B.SEATED_HIP[0], B.SEATED_HIP[1]);
        t.SEATED_HIP = Math.min(t.SEATED_HIP, t.HIP_TARGET - 10);
        t.THIGH_TARGET = clamp(r.stand.thigh + 12, B.THIGH_TARGET[0], B.THIGH_TARGET[1]);
        if (t.HIP_TARGET > r.stand.hip - 1) notes.push('Hip target may be hard to reach – please have a therapist review.');
      }
    } else notes.push('Sit/stand steps skipped: standard hip and thigh thresholds used.');

    return { t: sanitize(t), notes };
  }

  const ROWS = [['HIP_TARGET', 'Hip angle to count as standing', '>'], ['THIGH_TARGET', 'Thigh upright within', '<'], ['SEATED_HIP', 'Counts as seated below', '<'],
                ['ARM_UP', 'Arms count as raised above', '>'], ['ARM_DOWN', 'Arms count as lowered below', '<'], ['TWIST_TARGET', 'Twist each side', '±'], ['TWIST_OFFSET', 'Your neutral twist', '']];

  function showSummary() {
    state = 'summary'; clearTimeout(advTimer);
    pending = compute();
    $('calStepNo').textContent = 'Done'; $('calTitle').textContent = 'Your personal targets';
    $('calText').hidden = true; $('calLive').hidden = true; $('calCount').textContent = ''; setMsg('', '');
    $('calBar').firstElementChild.style.width = '100%';
    let h = '<table><tr><th>Setting</th><th>Standard</th><th>You</th></tr>';
    ROWS.forEach(([k, label, sym]) => {
      const a = Math.round(STANDARD[k]), b = Math.round(pending.t[k]);
      h += '<tr><td>' + label + '</td><td>' + sym + ' ' + a + '°</td><td class="' + (a !== b ? 'diff' : '') + '">' + sym + ' ' + b + '°</td></tr>';
    });
    h += '</table>';
    if (pending.notes.length) h += '<ul>' + pending.notes.map(n => '<li>' + n + '</li>').join('') + '</ul>';
    h += '<label class="fld">Profile name (use a code, not a real name, for research)<input class="cal-name" id="calName" maxlength="30" value="Participant ' + (store.list.length + 1) + '"></label>';
    $('calSummary').innerHTML = h; $('calSummary').hidden = false;
    $('calStart').textContent = 'Save & use'; $('calStart').disabled = false;
    $('calSkip').hidden = false; $('calSkip').textContent = 'Redo';
    beep(1319, 0.35);
  }

  function savePending() {
    let name = ($('calName').value || '').trim().slice(0, 30) || 'Participant';
    const p = { name, created: new Date().toISOString(), thresholds: pending.t, measured: res, version: 1 };
    const i = store.list.findIndex(x => x.name === name);
    if (i >= 0) store.list[i] = p; else store.list.push(p);
    saveStore(); closeWizard(false); useProfile('saved:' + name);
  }

  function openWizard() {
    snapshot = {}; for (const k in STANDARD) snapshot[k] = CFG[k];
    CFG.TWIST_OFFSET = 0; res = {}; pending = null; $('calSkip').textContent = 'Skip this step';
    buildGestureUI(); lastCountShown = 0;
    if (savedVis == null) { savedVis = CFG.MIN_VIS; CFG.MIN_VIS = WIZ_VIS; }
    calib.active = true; $('calib').hidden = false; showStep(0);
    requestAnimationFrame(tick); $('calStart').focus();
  }
  function closeWizard(restore) {
    calib.active = false; clearTimeout(advTimer); $('calib').hidden = true; state = 'idle';
    if (savedVis != null) { CFG.MIN_VIS = savedVis; savedVis = null; }
    if (restore && snapshot) Object.assign(CFG, snapshot);
    GW.setMode(game.mode); refreshProfileUI();
  }

  /* ---------- session summary for research notes ---------- */
  function copySession() {
    const R = Math.round;
    const txt = JSON.stringify({
      time: new Date().toISOString(), profile: GW.profile.name, thresholdMode: GW.profile.adaptive ? 'adaptive' : 'fixed',
      side: CFG.SIDE,
      thresholds: { HIP_TARGET: R(CFG.HIP_TARGET), THIGH_TARGET: R(CFG.THIGH_TARGET), SEATED_HIP: R(CFG.SEATED_HIP), ARM_UP: R(CFG.ARM_UP), ARM_DOWN: R(CFG.ARM_DOWN), TWIST_TARGET: R(CFG.TWIST_TARGET), TWIST_OFFSET: R(CFG.TWIST_OFFSET) },
      reps: game.reps, score: game.score, coins: game.coins
    }, null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(() => GW.setBanner('Session summary copied', 'ok'), () => window.prompt('Copy this:', txt));
    else window.prompt('Copy this:', txt);
  }

  /* ---------- init ---------- */
  calib.init = function () {
    loadStore(); CFG.SIDE = ['auto', 'L', 'R'].indexOf(store.side) >= 0 ? store.side : 'auto';
    $('profSel').addEventListener('change', e => useProfile(e.target.value));
    $('sideSel').addEventListener('change', e => { CFG.SIDE = e.target.value; store.side = CFG.SIDE; saveStore(); });
    $('calBtn').addEventListener('click', openWizard);
    $('profCopy').addEventListener('click', copySession);
    $('profDel').addEventListener('click', () => {
      if (!GW.profile.adaptive) return;
      if (!window.confirm('Delete the profile "' + GW.profile.name + '"?')) return;
      store.list = store.list.filter(p => p.name !== GW.profile.name); useProfile('preset:standard');
    });
    $('calCancel').addEventListener('click', () => closeWizard(true));
    $('calSkip').addEventListener('click', () => { if (state === 'summary') { openWizard(); } else if (state !== 'count' && state !== 'sampling') skipGroup(); });
    $('calStart').addEventListener('click', pressStart);
    window.addEventListener('keydown', e => { if (e.key === 'Escape' && calib.active) closeWizard(true); });
    useProfile(store.active);
  };
})();
