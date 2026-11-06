/* ============================================================
   game.js – config, shared state, scoring rules, HUD, audio, UI
   Creates the global GW object used by the other files.
   ============================================================ */
(function () {
  'use strict';
  const GW = window.GW = {};
  const $ = id => document.getElementById(id);

  /* ---------- Math helpers (shared) ---------- */
  const U = {
    deg: r => r * 180 / Math.PI,
    rad: d => d * Math.PI / 180,
    lerp: (a, b, t) => a + (b - a) * t,
    clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
    clamp01: v => Math.max(0, Math.min(1, v)),
    ease: k => k * k * (3 - 2 * k),
    wrap180(d) { while (d > 180) d -= 360; while (d < -180) d += 360; return d; },
    angleAt(a, b, c) {                                   // angle at b of a-b-c, degrees
      const v1 = { x: a.x - b.x, y: a.y - b.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
      const m = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y);
      return m ? U.deg(Math.acos(U.clamp((v1.x * v2.x + v1.y * v2.y) / m, -1, 1))) : 0;
    },
    fromVertical(a, b) { return U.deg(Math.atan2(Math.abs(b.x - a.x), Math.abs(b.y - a.y))); },
    pulse(t, period) {                                   // 0→1, hold, 1→0, rest
      const p = (t % period) / period;
      return p < 0.3 ? U.ease(p / 0.3) : p < 0.5 ? 1 : p < 0.8 ? 1 - U.ease((p - 0.5) / 0.3) : 0;
    }
  };
  GW.$ = $; GW.U = U;
  const { clamp, clamp01 } = U;

  /* phones / tablets (incl. iPadOS, which reports itself as a Mac) */
  GW.IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
                 (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  /* ---------- Tunable configuration ----------
     The threshold values are overwritten by the active profile (see calibration.js). */
  const CFG = GW.CFG = {
    HIP_TARGET: 160,      // deg – hip angle must exceed
    THIGH_TARGET: 22,     // deg – thigh deviation from vertical must be below
    SEATED_HIP: 135,      // deg – below this = seated (arms the next rep)
    ARM_UP: 140,          // deg – both arms above this = raised
    ARM_DOWN: 60,         // deg – both arms below this = lowered (re-arms)
    TWIST_TARGET: 20,     // deg – shoulder-vs-hip rotation to count a side
    TWIST_OFFSET: 0,      // deg – the person's own "neutral" twist (from calibration)
    SIDE: 'auto',         // 'auto' | 'L' | 'R' – which leg is used for sit-to-stand
    COOLDOWN_MS: 600,     // debounce between reps
    MIN_VIS: 0.5,         // landmark visibility threshold
    EMA: 0.35,            // smoothing factor
    REWARD: { pts: 150, coins: 15 },
    TWIST_SCREEN_SIGN: 1  // flip to -1 if the avatar twists the opposite way to you
  };
  GW.MODES = {
    potato: { name: 'Sweet Potato Pull',  hint: 'Sit side-on to the camera, then stand tall to pull the potato!' },
    fruit:  { name: 'High Fruit Picking', hint: 'Face the camera and raise BOTH arms to pick the fruit!' },
    sort:   { name: 'Fruit Sorting',      hint: 'Face the camera and twist left, then right, into the baskets!' }
  };

  /* ---------- Shared state ---------- */
  const game = GW.game = { mode: 'potato', score: 0, coins: 0, reps: 0, armed: false, twistSide: 0, lastHarvestTime: 0, targetReached: false };
  const live = GW.live = { hip: null, thigh: null, knee: null, lean: null, armL: null, armR: null, twist: null, twistRaw: null, prog: 0,
                           ok: { leg: false, arms: false, twist: false }, tracking: false, lastSeen: 0 };
  GW.ui    = { gMode: 'coach', showCam: false, coachOpen: false };
  GW.track = { lm: null, t: 0 };
  GW.started = false;

  /* ---------- Settings (saved on this device) ---------- */
  const SKEY = 'gw.settings.v1';
  const settings = GW.settings = { goal: 20, weight: 60, quality: 'auto', sound: true };
  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(SKEY)); if (!s) return;
      if ([10, 20, 30, 50].indexOf(s.goal) >= 0) settings.goal = s.goal;
      if (isFinite(s.weight)) settings.weight = clamp(+s.weight, 30, 150);
      if (['auto', 'fast', 'accurate'].indexOf(s.quality) >= 0) settings.quality = s.quality;
      if (typeof s.sound === 'boolean') settings.sound = s.sound;
    } catch (e) {}
  }
  function saveSettings() { try { localStorage.setItem(SKEY, JSON.stringify(settings)); } catch (e) {} }
  GW.quality = () => settings.quality === 'auto' ? (GW.IS_MOBILE ? 'fast' : 'accurate') : settings.quality;

  /* ---------- Session stats ---------- */
  const stats = GW.stats = { kcal: 0, seconds: 0, goalHit: false };
  /* Rough energy estimate per rep = MET × body weight (kg) × seconds per rep ÷ 3600.
     PLACEHOLDER MET values for light exercise – have a professional confirm them before reporting calories. */
  const MET = { potato: 4.0, fruit: 2.5, sort: 3.0 };

  /* ---------- Audio (Web Audio API chime) ---------- */
  let audioCtx = null;
  function ensureAudio() {
    if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(ev => window.addEventListener(ev, ensureAudio, { passive: true }));
  function playChime() {
    if (!settings.sound) return;
    ensureAudio(); if (!audioCtx) return;
    const t0 = audioCtx.currentTime;
    [659.25, 880, 1318.5, 1760].forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain(), t = t0 + i * 0.08;
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.2, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      o.connect(g).connect(audioCtx.destination);
      o.start(t); o.stop(t + 0.65);
    });
  }

  /* ---------- HUD / banner / toast ---------- */
  const GARDEN = ['🌱', '🌿', '🌷', '🌻', '🌳', '🍎'];
  function bump(id) { const el = $(id); el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
  GW.updateHUD = function () {
    const p = clamp01(game.reps / settings.goal);
    $('reps').textContent = game.reps;
    $('goal').textContent = settings.goal;
    $('score').textContent = game.score.toLocaleString();
    $('coins').textContent = game.coins;
    $('kcal').textContent = stats.kcal.toFixed(1);
    $('ringFg').style.strokeDashoffset = (119.4 * (1 - p)).toFixed(1);
    $('garden').textContent = GARDEN[Math.min(5, Math.floor(p * 5 + 1e-9))];
    const s = Math.floor(stats.seconds);
    $('time').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };
  let bannerKey = '';
  GW.setBanner = function (text, kind = 'info') {
    const key = kind + text; if (key === bannerKey) return; bannerKey = key;
    const b = $('banner'); b.textContent = text; b.className = kind;
  };
  let toastTimer;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 1400);
  }

  /* ---------- Rep rules (all thresholds come from CFG) ---------- */
  GW.evaluateMode = function (now) {
    const L = live, setBanner = GW.setBanner; L.prog = 0;

    if (game.mode === 'potato') {                                   // Sit-to-Stand
      if (!L.ok.leg) { setBanner('Turn sideways so your hip, knee and ankle are visible', 'warn'); return false; }
      const seated = L.hip < CFG.SEATED_HIP;
      const target = L.hip > CFG.HIP_TARGET && L.thigh < CFG.THIGH_TARGET;
      L.prog = Math.min(clamp01((L.hip - 110) / (CFG.HIP_TARGET - 110)), clamp01((70 - L.thigh) / (70 - CFG.THIGH_TARGET)));
      if (seated) game.armed = true;
      if (target && game.armed && now - game.lastHarvestTime > CFG.COOLDOWN_MS) { harvest(now); return true; }
      if (target) setBanner(game.armed ? 'Great stand!' : 'Standing tall – sit down to go again', 'ok');
      else if (seated) setBanner('Seated – lean forward and push up! 🍠', 'info');
      else setBanner(L.hip <= CFG.HIP_TARGET ? 'Keep rising – straighten your hips' : 'Bring your thighs upright', 'info');
      return target;
    }

    if (game.mode === 'fruit') {                                    // Arm raises
      if (!L.ok.arms) { setBanner('Face the camera so both arms are visible', 'warn'); return false; }
      const mn = Math.min(L.armL, L.armR);
      const up = mn > CFG.ARM_UP, down = Math.max(L.armL, L.armR) < CFG.ARM_DOWN;
      L.prog = clamp01((mn - 30) / (CFG.ARM_UP - 30));
      if (down) game.armed = true;
      if (up && game.armed && now - game.lastHarvestTime > CFG.COOLDOWN_MS) { harvest(now); return true; }
      if (up) setBanner(game.armed ? 'Great reach!' : 'Arms up – lower them to go again', 'ok');
      else if (down) setBanner('Raise BOTH arms high to pick the fruit! 🍎', 'info');
      else setBanner('Keep lifting – reach higher!', 'info');
      return up;
    }

    if (!L.ok.twist) { setBanner('Face the camera so your shoulders and hips are visible', 'warn'); return false; }   // Torso twists
    L.prog = clamp(L.twist / CFG.TWIST_TARGET, -1, 1);
    const side = L.twist > CFG.TWIST_TARGET ? 1 : L.twist < -CFG.TWIST_TARGET ? -1 : 0;
    if (side !== 0) {
      if (game.twistSide !== 0 && side !== game.twistSide && now - game.lastHarvestTime > CFG.COOLDOWN_MS) {
        game.twistSide = side; harvest(now); return true;
      }
      if (game.twistSide === 0) game.twistSide = side;
      setBanner('Good twist – now swing to the glowing basket ↔', 'ok');
      return true;
    }
    setBanner('Twist your upper body left, then right 🧺', 'info');
    return false;
  };

  function harvest(now) {
    const secs = game.lastHarvestTime ? clamp((now - game.lastHarvestTime) / 1000, 1.5, 6) : 3;   // time this rep took
    stats.kcal += MET[game.mode] * settings.weight * secs / 3600;
    game.armed = false; game.lastHarvestTime = now; game.reps++;
    game.score += CFG.REWARD.pts; game.coins += CFG.REWARD.coins;
    GW.updateHUD(); bump('bdReps'); bump('bdScore'); bump('bdCoins');
    playChime();
    if (GW.three) GW.three.harvestFX();
    if (!stats.goalHit && game.reps >= settings.goal) {
      stats.goalHit = true; toast('🎉 Daily goal reached!');
      GW.setBanner('🎉 You reached today\'s goal – wonderful!', 'ok');
    } else {
      toast('+' + CFG.REWARD.pts + '  🪙 +' + CFG.REWARD.coins);
      GW.setBanner('🎉 Rep ' + game.reps + ' complete! Wonderful!', 'ok');
    }
  }

  /* ---------- Coach-sheet readouts (target labels follow the active profile) ---------- */
  function setRead(rowId, valId, text, hit) { $(valId).textContent = text; $(rowId).classList.toggle('hit', !!hit); }
  GW.updateReadouts = function (force) {
    if (!force && !GW.ui.coachOpen) return;                 // nothing to draw while the sheet is closed
    document.querySelectorAll('.read').forEach(r => r.classList.toggle('focus', r.dataset.modes === game.mode));
    const f = v => v == null ? '--' : Math.round(v) + '°', t = live.tracking, L = live, R = Math.round;
    $('tHip').textContent   = 'target > ' + R(CFG.HIP_TARGET) + '°';
    $('tThigh').textContent = 'target < ' + R(CFG.THIGH_TARGET) + '°';
    $('tArms').textContent  = 'target > ' + R(CFG.ARM_UP) + '° both';
    $('tTwist').textContent = 'target ± ' + R(CFG.TWIST_TARGET) + '° each side';
    setRead('rowHip',   'rHip',   t && L.ok.leg ? f(L.hip)   : '--', t && L.ok.leg && L.hip > CFG.HIP_TARGET);
    setRead('rowThigh', 'rThigh', t && L.ok.leg ? f(L.thigh) : '--', t && L.ok.leg && L.thigh < CFG.THIGH_TARGET);
    setRead('rowKnee',  'rKnee',  t && L.ok.leg ? f(L.knee)  : '--', false);
    setRead('rowLean',  'rLean',  t && L.ok.leg ? f(L.lean)  : '--', false);
    setRead('rowArms',  'rArms',  t && L.ok.arms ? f(L.armL) + ' / ' + f(L.armR) : '--', t && L.ok.arms && Math.min(L.armL, L.armR) > CFG.ARM_UP);
    setRead('rowTwist', 'rTwist', t && L.ok.twist ? (L.twist > 0 ? '+' : '') + f(L.twist) : '--', t && L.ok.twist && Math.abs(L.twist) > CFG.TWIST_TARGET);
  };

  /* ---------- Exercise selection ---------- */
  GW.setMode = function (mode) {
    game.mode = mode; game.armed = false; game.twistSide = 0; live.prog = 0;
    document.querySelectorAll('.mode').forEach(b => {
      const on = b.dataset.mode === mode; b.classList.toggle('active', on); b.setAttribute('aria-selected', on);
    });
    bannerKey = ''; GW.setBanner(GW.MODES[mode].hint, 'info'); GW.updateReadouts(true); ensureAudio();
  };
  function setGMode(m) {
    GW.ui.gMode = m;
    $('segCoach').classList.toggle('on', m === 'coach'); $('segMirror').classList.toggle('on', m === 'mirror'); ensureAudio();
  }

  /* ---------- Sheets ---------- */
  function closeSheets() {
    document.querySelectorAll('.sheet.open').forEach(s => s.classList.remove('open'));
    $('backdrop').classList.remove('show'); GW.ui.coachOpen = false;
  }
  function openSheet(id) {
    closeSheets(); $(id).classList.add('open'); $('backdrop').classList.add('show');
    if (id === 'coachSheet') { GW.ui.coachOpen = true; GW.updateReadouts(true); }
  }

  /* ---------- Start, wake lock, full screen ---------- */
  let wakeLock = null;
  function keepAwake() {
    try {
      if ('wakeLock' in navigator) navigator.wakeLock.request('screen').then(l => { wakeLock = l; l.addEventListener('release', () => { wakeLock = null; }); }, () => {});
    } catch (e) {}
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && GW.started && !wakeLock) keepAwake(); });

  function startGame(then) {
    ensureAudio();
    $('welcome').classList.add('hide');
    GW.started = true; GW.afterStart = then || null;
    const st = $('status'); st.className = ''; $('statusRetry').hidden = true;
    $('statusMsg').innerHTML = 'Starting camera and loading the pose model…<br>Please allow camera access.';
    keepAwake();
    if (GW.mp) GW.mp.start();
  }
  /* called by mediapipe.js when the first camera frame has been processed */
  GW.onFirstFrame = function () {
    $('status').classList.add('hidden');
    if (GW.afterStart === 'calibrate') { GW.afterStart = null; $('calBtn').click(); }
  };

  function fsSupported() { const d = document.documentElement; return !!(d.requestFullscreen || d.webkitRequestFullscreen); }
  function toggleFullscreen() {
    const d = document, el = d.documentElement;
    if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
    else (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
  }

  /* ---------- Boot ---------- */
  GW.boot = function () {
    loadSettings();
    $('goalSel').value = String(settings.goal); $('weightIn').value = settings.weight;
    $('qualSel').value = settings.quality; $('soundOn').checked = settings.sound;

    document.querySelectorAll('.mode').forEach(b => b.addEventListener('click', () => GW.setMode(b.dataset.mode)));
    $('segCoach').addEventListener('click', () => setGMode('coach'));
    $('segMirror').addEventListener('click', () => setGMode('mirror'));

    $('btnCoach').addEventListener('click', () => openSheet('coachSheet'));
    $('btnMenu').addEventListener('click', () => openSheet('menuSheet'));
    $('backdrop').addEventListener('click', closeSheets);
    document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeSheets));
    window.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheets(); });
    $('calBtn').addEventListener('click', closeSheets);              // calibration.js opens the wizard from the same button

    $('goalSel').addEventListener('change', e => { settings.goal = +e.target.value; stats.goalHit = game.reps >= settings.goal; saveSettings(); GW.updateHUD(); });
    $('weightIn').addEventListener('change', e => { settings.weight = clamp(+e.target.value || 60, 30, 150); e.target.value = settings.weight; saveSettings(); });
    $('qualSel').addEventListener('change', e => { settings.quality = e.target.value; saveSettings(); if (GW.mp && GW.mp.setQuality) GW.mp.setQuality(GW.quality()); });
    $('soundOn').addEventListener('change', e => { settings.sound = e.target.checked; saveSettings(); });
    $('showCam').addEventListener('change', e => {
      GW.ui.showCam = e.target.checked;
      $('camera-container').classList.toggle('cam-on', e.target.checked);
    });
    $('resetBtn').addEventListener('click', () => {
      game.score = game.coins = game.reps = 0; game.armed = false; game.twistSide = 0;
      stats.kcal = 0; stats.seconds = 0; stats.goalHit = false; GW.updateHUD(); closeSheets();
    });
    if (fsSupported()) $('fsBtn').addEventListener('click', toggleFullscreen); else $('fsBtn').hidden = true;

    $('startBtn').addEventListener('click', () => startGame(null));
    $('startCalBtn').addEventListener('click', () => startGame('calibrate'));
    $('statusRetry').addEventListener('click', () => location.reload());

    GW.updateHUD(); GW.setMode('potato');
    if (GW.calib && GW.calib.init) GW.calib.init();                  // loads the saved body profile

    /* active-time clock: counts only while a body is tracked and the wizard is closed */
    setInterval(() => {
      if (GW.started && live.tracking && !(GW.calib && GW.calib.active)) { stats.seconds += 0.5; GW.updateHUD(); }
    }, 500);
  };
})();
