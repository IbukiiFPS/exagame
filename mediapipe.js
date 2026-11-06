/* ============================================================
   mediapipe.js – webcam, MediaPipe Pose, joint-angle maths,
   optional camera preview, calibration preview.
   Started by the Start button (game.js), so phones can ask for camera permission after a tap.
   ============================================================ */
(function () {
  'use strict';
  const { $, U, CFG, game, live, track } = GW;
  const { deg, lerp, angleAt, fromVertical, wrap180 } = U;

  const videoEl = $('input-video');
  const outCanvas = $('output-canvas');
  const octx = outCanvas.getContext('2d');
  const calibCanvas = $('calibView');
  const cctx = calibCanvas.getContext('2d');
  const statusEl = $('status');

  GW.mp = { canvas: outCanvas, started: false };

  /* ---------- Joint angles from landmarks ---------- */
  function extractMetrics(res, W, H) {
    const lm = res.poseLandmarks; if (!lm) return null;
    const P = i => ({ x: lm[i].x * W, y: lm[i].y * H, v: lm[i].visibility ?? 0 });
    const m = { hip: null, thigh: null, knee: null, lean: null, armL: null, armR: null, twistRaw: null };

    // Leg chain: the chosen side ('L' / 'R' = the person's own left / right) or the more visible one
    const chains = [[11, 23, 25, 27], [12, 24, 26, 28]].map(ix => {
      const p = ix.map(P); return { p, vis: Math.min(p[0].v, p[1].v, p[2].v, p[3].v) };
    });
    const best = CFG.SIDE === 'L' ? chains[0] : CFG.SIDE === 'R' ? chains[1] : (chains[0].vis >= chains[1].vis ? chains[0] : chains[1]);
    if (best.vis >= CFG.MIN_VIS) {
      const [sh, hip, kn, an] = best.p;
      m.hip = angleAt(sh, hip, kn); m.knee = angleAt(hip, kn, an);
      m.thigh = fromVertical(hip, kn); m.lean = fromVertical(hip, sh);
    }
    // Arms: angle at the shoulder between hip and wrist (~0 hanging, ~180 overhead)
    const arm = (s, h, w) => { const a = P(s), b = P(h), c = P(w); return Math.min(a.v, b.v, c.v) >= CFG.MIN_VIS ? angleAt(b, a, c) : null; };
    m.armL = arm(11, 23, 15); m.armR = arm(12, 24, 16);

    // Torso twist (raw): shoulder-line rotation relative to hip-line (world landmarks).
    // The person's own neutral offset is subtracted later, in smoothInto().
    const wl = res.poseWorldLandmarks;
    if (wl && Math.min(lm[11].visibility ?? 0, lm[12].visibility ?? 0, lm[23].visibility ?? 0, lm[24].visibility ?? 0) >= CFG.MIN_VIS) {
      const ang = (a, b) => deg(Math.atan2(b.z - a.z, b.x - a.x));
      m.twistRaw = wrap180(ang(wl[11], wl[12]) - ang(wl[23], wl[24]));
    }
    return m;
  }
  function smoothInto(m) {
    for (const k of ['hip', 'thigh', 'knee', 'lean', 'armL', 'armR', 'twistRaw']) {
      if (m[k] == null) continue;
      live[k] = live[k] == null ? m[k] : lerp(live[k], m[k], CFG.EMA);
    }
    if (live.twistRaw != null) live.twist = wrap180(live.twistRaw - CFG.TWIST_OFFSET);
    live.ok.leg = m.hip != null;
    live.ok.arms = m.armL != null && m.armR != null;
    live.ok.twist = m.twistRaw != null;
  }

  /* ---------- Preview drawing (canvases are mirrored by CSS scaleX(-1)) ---------- */
  const CONNECTIONS = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
    [23, 25], [25, 27], [24, 26], [26, 28], [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32]];
  const KEY_JOINTS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

  function drawFrame(cv, ctx, results, targetReached) {
    const img = results.image;
    if (img && img.width && (cv.width !== img.width || cv.height !== img.height)) { cv.width = img.width; cv.height = img.height; }
    const W = cv.width, H = cv.height;
    ctx.save(); ctx.clearRect(0, 0, W, H);
    ctx.drawImage(img, 0, 0, W, H);
    const lm = results.poseLandmarks;
    if (lm) {
      const col = targetReached ? '#22c55e' : '#38bdf8';
      ctx.lineCap = 'round'; ctx.lineWidth = Math.max(4, W / 160);
      ctx.strokeStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 10;
      CONNECTIONS.forEach(([a, b]) => {
        if ((lm[a].visibility ?? 1) < 0.4 || (lm[b].visibility ?? 1) < 0.4) return;
        ctx.beginPath(); ctx.moveTo(lm[a].x * W, lm[a].y * H); ctx.lineTo(lm[b].x * W, lm[b].y * H); ctx.stroke();
      });
      ctx.shadowBlur = 0;
      KEY_JOINTS.forEach(i => {
        if ((lm[i].visibility ?? 1) < 0.4) return;
        ctx.fillStyle = targetReached ? '#bbf7d0' : '#f59e0b';
        ctx.beginPath(); ctx.arc(lm[i].x * W, lm[i].y * H, Math.max(5, W / 110), 0, Math.PI * 2); ctx.fill();
      });
    }
    ctx.restore();
  }

  function showError(msg) {
    GW.mp.started = false;
    statusEl.className = 'err'; $('statusMsg').innerHTML = msg; $('statusRetry').hidden = false;
    GW.setBanner('Camera unavailable', 'warn');
  }

  /* ---------- Start pose tracking + camera ---------- */
  let pose = null, cam = null, firstFrame = false;
  GW.mp.setQuality = function (q) { if (pose) pose.setOptions({ modelComplexity: q === 'fast' ? 0 : 1 }); };

  GW.mp.start = function () {
    if (GW.mp.started) return;
    GW.mp.started = true;
    if (typeof Pose === 'undefined' || typeof Camera === 'undefined') {
      showError('Could not load MediaPipe.<br>Check your internet connection and reload.'); return;
    }
    if (!window.isSecureContext) {
      showError('Camera access needs a secure page.<br>Open this game through <b>https://</b> (or http://localhost on a computer).'); return;
    }
    const fast = GW.quality() === 'fast';                         // phones use the lighter model and a smaller picture
    pose = new Pose({ locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}` });
    pose.setOptions({ modelComplexity: fast ? 0 : 1, smoothLandmarks: true, enableSegmentation: false,
                      minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });

    pose.onResults(results => {
      if (!firstFrame) { firstFrame = true; if (GW.onFirstFrame) GW.onFirstFrame(); }
      const now = performance.now();
      const calibOn = !!(GW.calib && GW.calib.active);
      const iw = (results.image && results.image.width) || 1280, ih = (results.image && results.image.height) || 720;
      const m = extractMetrics(results, iw, ih);                  // angles must use the real picture shape
      let target = false;
      if (results.poseLandmarks) { track.lm = results.poseLandmarks; track.t = now; }
      if (m) {
        smoothInto(m); live.tracking = true; live.lastSeen = now;
        target = calibOn ? false : GW.evaluateMode(now);          // scoring is paused during calibration
      } else if (now - live.lastSeen > 700) {
        live.tracking = false; live.prog = 0;
        if (!calibOn) GW.setBanner('I cannot see you – step back so your whole body is in view', 'warn');
      }
      game.targetReached = target;
      if (GW.ui.showCam) drawFrame(outCanvas, octx, results, target);   // only drawn when switched on
      if (calibOn) drawFrame(calibCanvas, cctx, results, GW.calib.good);
      GW.updateReadouts();
    });

    cam = new Camera(videoEl, {
      onFrame: async () => { await pose.send({ image: videoEl }); },
      facingMode: 'user',                                         // front camera on phones and tablets
      width: fast ? 640 : 1280, height: fast ? 480 : 720
    });
    cam.start().catch(err => {
      const n = err && err.name;
      showError(n === 'NotAllowedError' ? 'Camera permission was denied.<br>Allow camera access for this site in your browser settings, then try again.'
              : n === 'NotFoundError'   ? 'No camera was found on this device.'
              : n === 'NotReadableError' ? 'The camera is being used by another app.<br>Close it and try again.'
              : 'Camera error: ' + (err && err.message ? err.message : err));
    });
  };
})();
