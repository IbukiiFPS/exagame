/* ============================================================
   three-scene.js – everything 3D
     A) Figure builder + forward kinematics (Grandpa coach + fallback avatar)
     B) Y Bot (Mixamo) rig driver – the player's 3D model
     C) The garden: floating island, trees, player avatar, game objects, star burst
     D) Sidebar 3D Grandpa coach
   ============================================================ */
(function () {
  'use strict';
  const { $, U, CFG, game, live, ui } = GW;
  const { rad, lerp, clamp, clamp01, ease, pulse } = U;

  if (typeof THREE === 'undefined') {
    GW.three = { harvestFX() {} };
    GW.setBanner('Could not load Three.js from the CDN', 'warn');
    return;
  }

  /* ---- Player model file (put it in the same folder as index.html) ---- */
  const MODEL_URL = 'y_bot_from_mixamo.glb';
  const FOOT_LIFT = 0.026;     // lifts the model so its soles rest on the grass (measured for this model)
  const IS_MOBILE = GW.IS_MOBILE;
  const PR_MAX = IS_MOBILE ? 1.5 : 2;   // lower pixel ratio on phones = smoother and cooler

  /* ==========================================================
     A) FIGURE BUILDER + FORWARD KINEMATICS
     The figure faces +z; its left side (+x) appears on screen-right when viewed from the front.
     ========================================================== */
  const _d = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _qy = new THREE.Quaternion();
  const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

  function setBone(m, a, b, yaw = 0) {
    _d.subVectors(b, a); const L = _d.length(); if (L < 1e-5) return;
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(_up, _d.divideScalar(L));
    if (yaw) { _qy.setFromAxisAngle(_up, yaw); m.quaternion.multiply(_qy); }
    const u = m.userData; m.scale.set(u.R * u.sx, L, u.R * u.sz);
  }

  function makeFigure(M, opts = {}) {
    const glasses = opts.glasses !== false, stache = opts.moustache !== false;
    const g = new THREE.Group(), B = {}, S = {};
    const bone = (n, mat, rt, rb, R, sx = 1, sz = 1) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, 1, 14), mat); m.userData = { R, sx, sz }; g.add(m); B[n] = m;
    };
    const ball = (n, mat, r, sx = 1, sy = 1, sz = 1) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), mat); m.scale.set(r * sx, r * sy, r * sz); g.add(m); S[n] = m;
    };
    bone('chest', M.shirt, 1, .82, .17, 1.12, .72);
    bone('neckB', M.skin, 1, 1, .045);
    ['L', 'R'].forEach(s => {
      bone('thigh' + s, M.pants, .82, 1, .078); bone('shin' + s, M.pants, .78, 1, .058);
      bone('uarm' + s, M.shirt, .85, 1, .052);  bone('farm' + s, M.skin, .8, 1, .042);
      ball('hip' + s, M.pants, .08); ball('knee' + s, M.pants, .062); ball('sh' + s, M.shirt, .066);
      ball('elb' + s, M.skin, .047); ball('wr' + s, M.skin, .052);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.27), M.shoe); g.add(foot); S['foot' + s] = foot;
    });
    ball('pelvis', M.pants, .16, 1.05, .72, .78);

    const head = new THREE.Group(); g.add(head);
    const sk = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 16), M.skin); sk.scale.set(.105, .12, .11); head.add(sk);
    const hair = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12, 0, Math.PI * 2, 0, Math.PI * .55), M.hair);
    hair.scale.set(.113, .125, .118); hair.position.set(0, .012, -.012); hair.rotation.x = -.25; head.add(hair);
    const add = (geo, mat, x, y, z, sc) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); if (sc) m.scale.set(sc[0], sc[1], sc[2]); head.add(m); return m; };
    const sph = new THREE.SphereGeometry(1, 10, 8);
    [-1, 1].forEach(s => {
      add(sph, M.skin, s * .108, 0, 0, [.022, .03, .02]);                                          // ears
      add(sph, M.dark, s * .04, .02, .1, [.013, .013, .013]);                                      // eyes
      if (glasses) add(new THREE.TorusGeometry(.028, .004, 8, 16), M.dark, s * .04, .02, .105);    // glasses
    });
    if (glasses) add(new THREE.BoxGeometry(.03, .004, .004), M.dark, 0, .025, .11);                // glasses bridge
    add(sph, M.skin, 0, -.01, .112, [.018, .018, .018]);                                           // nose
    if (stache) add(sph, M.hair, 0, -.04, .104, [.05, .013, .02]);                                 // moustache
    const sm = add(new THREE.TorusGeometry(.03, .004, 6, 14, Math.PI), M.dark, 0, -.05, .1); sm.rotation.z = Math.PI; // smile

    return {
      g, head,
      apply(J) {
        setBone(B.chest, J.pelvis, J.neck, J.tw);
        const tdir = J.neck.clone().sub(J.pelvis).normalize();
        const hd = tdir.clone().add(_up).normalize();
        const headPos = J.neck.clone().addScaledVector(hd, .17);
        setBone(B.neckB, J.neck.clone().addScaledVector(tdir, -.03), headPos);
        head.position.copy(headPos); head.rotation.set(0, J.tw * .6, 0);
        S.pelvis.position.copy(J.pelvis);
        ['L', 'R'].forEach(s => {
          setBone(B['thigh' + s], J['hip' + s], J['knee' + s]); setBone(B['shin' + s], J['knee' + s], J['ankle' + s]);
          setBone(B['uarm' + s], J['sh' + s], J['elb' + s]);    setBone(B['farm' + s], J['elb' + s], J['wr' + s]);
          S['hip' + s].position.copy(J['hip' + s]); S['knee' + s].position.copy(J['knee' + s]);
          S['sh' + s].position.copy(J['sh' + s]);   S['elb' + s].position.copy(J['elb' + s]); S['wr' + s].position.copy(J['wr' + s]);
          S['foot' + s].position.set(J['ankle' + s].x, J['ankle' + s].y - .035, J['ankle' + s].z + .07);
        });
      }
    };
  }

  function buildChair() {
    const chair = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({ color: 0x8b5e34, roughness: .8 });
    const box = (w, h, d, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wood); m.position.set(x, y, z); chair.add(m); };
    box(0.5, 0.04, 0.5, 0, 0.415, -0.42);                                  // seat
    box(0.5, 0.62, 0.04, 0, 0.72, -0.66);                                  // back
    [[-.22, -.2], [.22, -.2], [-.22, -.64], [.22, -.64]].forEach(p => box(0.04, 0.4, 0.04, p[0], 0.2, p[1]));
    return chair;
  }

  /* pose parameters (degrees) → joint positions */
  const DEF = { thigh: 2, knee: 178, lean: 3, armL: 10, armR: 10, fz: 0.1, dA2: 0, fz2: 0.25, twist: 0 };
  function computeJoints(P) {
    const Ls = .44, Lt = .45, Lb = .55, Lu = .28, Lf = .26, AY = .08, HW = .1, SW = .2;
    const th = rad(P.thigh), shank = th - rad(180 - P.knee), ln = rad(P.lean), tw = rad(P.twist);
    const kY = AY + Math.cos(shank) * Ls, kZ = -Math.sin(shank) * Ls;
    const hY = kY + Math.cos(th) * Lt,    hZ = kZ - Math.sin(th) * Lt;
    const J = { tw };
    J.pelvis = V3(0, hY, hZ);
    J.hipL = V3(HW, hY, hZ);       J.hipR = V3(-HW, hY, hZ);
    J.kneeL = V3(HW + .015, kY, kZ); J.kneeR = V3(-HW - .015, kY, kZ);
    J.ankleL = V3(HW + .03, AY, 0);  J.ankleR = V3(-HW - .03, AY, 0);
    const td = V3(0, Math.cos(ln), Math.sin(ln));
    J.neck = J.pelvis.clone().addScaledVector(td, Lb);
    const sc = J.neck.clone().addScaledVector(td, -.06);
    J.shL = sc.clone().add(V3(SW * Math.cos(tw), 0, -SW * Math.sin(tw)));
    J.shR = sc.clone().add(V3(-SW * Math.cos(tw), 0, SW * Math.sin(tw)));
    const arm = (s, A) => {
      const a = rad(A), a2 = rad(A + P.dA2);
      const u = V3(s * Math.sin(a), -Math.cos(a), P.fz).normalize().applyAxisAngle(_up, tw);
      const f = V3(s * Math.sin(a2), -Math.cos(a2), P.fz2).normalize().applyAxisAngle(_up, tw);
      const root = s > 0 ? J.shL : J.shR, e = root.clone().addScaledVector(u, Lu), w = e.clone().addScaledVector(f, Lf);
      return [e, w];
    };
    const l = arm(1, P.armL), r = arm(-1, P.armR);
    J.elbL = l[0]; J.wrL = l[1]; J.elbR = r[0]; J.wrR = r[1];
    return J;
  }

  /* demo poses (Grandpa coach), the green target ghost, and live "copy the player" poses */
  function coachParams(mode, t) {
    if (mode === 'potato') {
      const k = pulse(t, 5.5);
      return { P: { ...DEF, thigh: lerp(88, 2, k), knee: lerp(90, 178, k), lean: Math.sin(k * Math.PI) * 24 + 4, armL: 12, armR: 12, fz: .55 + .3 * Math.sin(k * Math.PI), dA2: -6, fz2: 1.1 },
               hit: k > 0.9, phase: k < 0.12 ? 0 : (k < 0.9 ? 1 : 2) };
    }
    if (mode === 'fruit') {
      const a = lerp(8, 172, pulse(t, 5.5));
      return { P: { ...DEF, armL: a, armR: a, fz: 0, dA2: 0, fz2: 0 }, hit: a > CFG.ARM_UP, phase: a < 30 ? 0 : (a < 150 ? 1 : 2) };
    }
    const tw = 36 * Math.sin(2 * Math.PI * t / 5);
    return { P: { ...DEF, armL: 30, armR: 30, fz: .35, dA2: -60, fz2: 1, twist: tw }, hit: Math.abs(tw) > CFG.TWIST_TARGET, phase: Math.abs(tw) < 10 ? 0 : (tw > 0 ? 1 : 2) };
  }
  let ghostTwist = 24;
  function ghostParams(mode, t) {
    if (mode === 'potato') return { ...DEF, thigh: 3, knee: 176, lean: 4, armL: 12, armR: 12, fz: .5, dA2: -6, fz2: 1.1 };
    if (mode === 'fruit')  return { ...DEF, armL: 172, armR: 172, fz: 0, dA2: 0, fz2: 0 };
    const target = Math.sin(2 * Math.PI * t / 5) > 0 ? 26 : -26; ghostTwist = lerp(ghostTwist, target, 0.08);
    return { ...DEF, armL: 30, armR: 30, fz: .35, dA2: -60, fz2: 1, twist: ghostTwist };
  }
  function liveParams(mode) {
    if (mode === 'potato') return { ...DEF, thigh: live.thigh ?? 2, knee: live.knee ?? 178, lean: clamp(live.lean ?? 3, 0, 60), armL: 12, armR: 12, fz: .5, dA2: -6, fz2: 1.1 };
    if (mode === 'fruit')  return { ...DEF, armL: live.armR ?? 10, armR: live.armL ?? 10, fz: 0, dA2: 0, fz2: 0 };
    return { ...DEF, armL: 30, armR: 30, fz: .35, dA2: -60, fz2: 1, twist: clamp((live.twist ?? 0) * CFG.TWIST_SCREEN_SIGN, -50, 50) };
  }
  function idleParams(mode) {                    // avatar's pose before a body is detected
    if (mode === 'potato') return { ...DEF, thigh: 88, knee: 90, lean: 6, armL: 12, armR: 12, fz: .55, dA2: -6, fz2: 1.1 };
    if (mode === 'sort')   return { ...DEF, armL: 30, armR: 30, fz: .35, dA2: -60, fz2: 1, twist: 0 };
    return { ...DEF };
  }
  function livePhase(mode) {
    if (mode === 'potato') return live.hip < CFG.SEATED_HIP ? 0 : (game.targetReached ? 2 : 1);
    if (mode === 'fruit') { const mn = Math.min(live.armL ?? 0, live.armR ?? 0); return mn < CFG.ARM_DOWN ? 0 : (mn >= CFG.ARM_UP ? 2 : 1); }
    const tw = live.twist ?? 0; return Math.abs(tw) < 10 ? 0 : (tw > 0 ? 1 : 2);
  }
  const PHASES = {
    potato: ['① Sit tall', '② Lean & push', '③ Stand tall ✔'],
    fruit:  ['① Arms down', '② Lift up', '③ Reach high ✔'],
    sort:   ['① Face front', '② Twist to one side', '③ Twist to the other ✔']
  };
  const CAPTION = {
    get potato() { return 'Correct pose: hips open past ' + Math.round(CFG.HIP_TARGET) + '° and thighs upright (under ' + Math.round(CFG.THIGH_TARGET) + '°).'; },
    get fruit()  { return 'Correct pose: both arms above ' + Math.round(CFG.ARM_UP) + '° – reach high!'; },
    get sort()   { return 'Correct pose: twist ' + Math.round(CFG.TWIST_TARGET) + '° or more to each side.'; }
  };
  let chipKey = '';
  function setChips(mode, idx, hit) {
    const key = mode + idx + hit; if (key === chipKey) return; chipKey = key;
    $('chips').innerHTML = PHASES[mode].map((p, i) => '<span class="chip' + (i === idx ? (hit && i === 2 ? ' hit' : ' on') : '') + '">' + p + '</span>').join('');
  }

  /* ==========================================================
     B) Y BOT RIG DRIVER
     Mixamo Y Bot (T-pose, +Z forward, Y up, left = +X). Every frame each bone is turned so that it
     points at the joint positions produced by computeJoints() – the same pose data that drives the
     primitive figures. Animations stored in the file are NOT played.
     ========================================================== */
  function makeYBotRig(model, toWorld) {
    const bones = {};
    model.traverse(o => {      // names look like "mixamorigHips_01": drop the prefix and the numeric suffix
      if (o.isBone) bones[o.name.replace(/^mixamorig:?/, '').replace(/_\d+$/, '')] = o;
    });
    const CHILD = {
      Hips: 'Spine', Spine: 'Spine1', Spine1: 'Spine2', Spine2: 'Neck', Neck: 'Head', Head: 'HeadTop_End',
      LeftShoulder: 'LeftArm', LeftArm: 'LeftForeArm', LeftForeArm: 'LeftHand', LeftHand: 'LeftHandMiddle1',
      LeftUpLeg: 'LeftLeg', LeftLeg: 'LeftFoot', LeftFoot: 'LeftToeBase',
      RightShoulder: 'RightArm', RightArm: 'RightForeArm', RightForeArm: 'RightHand', RightHand: 'RightHandMiddle1',
      RightUpLeg: 'RightLeg', RightLeg: 'RightFoot', RightFoot: 'RightToeBase'
    };
    const missing = Object.keys(CHILD).concat(Object.values(CHILD)).filter(k => !bones[k]);
    if (missing.length) throw new Error('model is missing bones: ' + Array.from(new Set(missing)).join(', '));

    const restQ = {}, restDir = {};
    for (const k in CHILD) { restQ[k] = bones[k].quaternion.clone(); restDir[k] = bones[CHILD[k]].position.clone().normalize(); }

    model.updateMatrixWorld(true);
    const footRest = {}, a = new THREE.Vector3(), b = new THREE.Vector3();
    ['Left', 'Right'].forEach(s => {          // keeps the feet flat on the ground
      footRest[s] = b.setFromMatrixPosition(bones[s + 'ToeBase'].matrixWorld).sub(a.setFromMatrixPosition(bones[s + 'Foot'].matrixWorld)).clone();
    });

    const qp = new THREE.Quaternion(), qw = new THREE.Quaternion(), qd = new THREE.Quaternion(), gq = new THREE.Quaternion();
    const cur = new THREE.Vector3(), pos = new THREE.Vector3(), tgt = new THREE.Vector3();
    const P = new THREE.Vector3(), N = new THREE.Vector3(), T1 = new THREE.Vector3(), T2 = new THREE.Vector3();
    const D = new THREE.Vector3(), HD = new THREE.Vector3(), FD = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);

    function aimDir(key, dir) {               // turn the bone so its child direction equals dir (world space)
      const bn = bones[key];
      bn.parent.updateWorldMatrix(true, false);
      bn.parent.getWorldQuaternion(qp);
      qw.copy(qp).multiply(restQ[key]);
      cur.copy(restDir[key]).applyQuaternion(qw);
      qd.setFromUnitVectors(cur, dir);
      qw.premultiply(qd);
      bn.quaternion.copy(qp).invert().multiply(qw);
      bn.updateMatrix();
      return dir;
    }
    function aimTo(key, point) {              // aim the bone from where it is now to a world point
      const bn = bones[key];
      bn.updateWorldMatrix(true, false);
      pos.setFromMatrixPosition(bn.matrixWorld);
      tgt.copy(point).sub(pos);
      if (tgt.lengthSq() < 1e-8) return aimDir(key, UP.clone());
      return aimDir(key, tgt.normalize().clone());
    }
    function twist(key, axis, angle) {        // extra roll about a world axis
      const bn = bones[key];
      bn.parent.updateWorldMatrix(true, false);
      bn.parent.getWorldQuaternion(qp);
      qw.copy(qp).multiply(bn.quaternion);
      qd.setFromAxisAngle(axis, angle);
      qw.premultiply(qd);
      bn.quaternion.copy(qp).invert().multiply(qw);
      bn.updateMatrix();
    }

    return {
      bones,
      apply(J, host) {                        // host = the group the model lives in
        host.getWorldQuaternion(gq);
        toWorld(J.pelvis, P);                 // pelvis position
        const hips = bones.Hips; hips.parent.updateWorldMatrix(true, false);
        hips.position.copy(P); hips.parent.worldToLocal(hips.position); hips.updateMatrix();

        toWorld(J.neck, N);                   // torso: one straight line pelvis -> neck, twist shared by 3 spine bones
        D.copy(N).sub(P).normalize();
        aimDir('Hips', D.clone());
        ['Spine', 'Spine1', 'Spine2'].forEach(k => { aimDir(k, D.clone()); twist(k, D, J.tw / 3); });
        HD.copy(D).add(UP).normalize();
        aimDir('Neck', HD.clone());
        aimDir('Head', UP.clone()); twist('Head', UP, -0.4 * J.tw);

        ['L', 'R'].forEach(s => {
          const S = s === 'L' ? 'Left' : 'Right';
          aimTo(S + 'Shoulder', toWorld(J['sh' + s], T1));        // arms
          aimTo(S + 'Arm', toWorld(J['elb' + s], T1));
          FD.copy(aimTo(S + 'ForeArm', toWorld(J['wr' + s], T2)));
          aimDir(S + 'Hand', FD.clone());
          aimTo(S + 'UpLeg', toWorld(J['knee' + s], T1));         // legs
          aimTo(S + 'Leg', toWorld(J['ankle' + s], T2));
          aimDir(S + 'Foot', footRest[S].clone().applyQuaternion(gq).normalize());
        });
      }
    };
  }

  /* ==========================================================
     C) THE GARDEN (transparent canvas over a CSS sky gradient)
     ========================================================== */
  const container = $('camera-container');
  const renderer = new THREE.WebGLRenderer({ canvas: $('three-canvas'), alpha: true, antialias: true });
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera3 = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 120);
  camera3.position.set(0, 2.2, 8.4); camera3.lookAt(0, 1.5, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xcfe6d8, 0.8));
  const sun = new THREE.DirectionalLight(0xffffff, 0.7); sun.position.set(4, 8, 6); scene.add(sun);

  /* The camera is placed so the important part of the garden always fits the screen,
     from a tall phone in portrait (narrow) to a wide desktop window. */
  const layout = { hw: 5.4, bx: 2.2, px: 1.8, bs: 1 };      // half-width shown, basket x, sweet-potato-bed x
  const TAN_HALF = Math.tan(rad(40 / 2));
  function fitCamera(aspect) {
    const hw = clamp(2.2 + (aspect - 0.5) * (5.4 - 2.2) / (1.78 - 0.5), 2.2, 5.4);
    const d = Math.max(9, hw / (TAN_HALF * aspect));
    layout.hw = hw; layout.bx = clamp(hw - 1.1, 1.3, 2.2); layout.px = clamp(hw - 1.1, 1.15, 1.8); layout.bs = clamp(hw / 3.6, 0.78, 1);
    camera3.position.set(0, 1.5 + d * 0.083, d); camera3.lookAt(0, 1.5, 0);
  }
  function resize3D() {
    const w = container.clientWidth, h = container.clientHeight; if (!w || !h) return;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, PR_MAX));
    renderer.setSize(w, h, false);
    camera3.aspect = w / h; fitCamera(w / h);
    /* slide the picture up by half the height of the bottom controls, so the player's feet stay clear of them */
    const bottomEl = $('bottom'), shift = bottomEl ? Math.round(bottomEl.offsetHeight / 2) : 0;
    camera3.setViewOffset(w, h, 0, shift, w, h);
  }
  new ResizeObserver(resize3D).observe(container);
  if ($('bottom')) new ResizeObserver(resize3D).observe($('bottom'));      // the prompt can grow to two lines
  window.addEventListener('resize', resize3D);
  resize3D();

  const M3 = (c, o = {}) => new THREE.MeshStandardMaterial(Object.assign({ color: c, roughness: 0.7, metalness: 0.02 }, o));

  /* ---------- Floating island on a white sky ---------- */
  const AV = 1.45;                                   // player scale
  const platform = new THREE.Group(); scene.add(platform);
  {
    const grass = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.2, 0.25, 64), M3(0x86d19a, { roughness: 1 })); grass.position.y = -0.125;
    const soil = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 3.4, 0.9, 64), M3(0xe3c9a3, { roughness: 1 })); soil.position.y = -0.7;
    const path = new THREE.Mesh(new THREE.CircleGeometry(1.7, 48), M3(0xf3ead0, { roughness: 1 })); path.rotation.x = -Math.PI / 2; path.position.y = 0.004;
    const rimRing = new THREE.Mesh(new THREE.TorusGeometry(4.2, 0.08, 8, 64), M3(0x6cc08a)); rimRing.rotation.x = Math.PI / 2;
    platform.add(grass, soil, path, rimRing);
  }
  {   // soft shadow far below the island
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const x = c.getContext('2d'), g = x.createRadialGradient(64, 64, 4, 64, 64, 64);
    g.addColorStop(0, 'rgba(15,23,42,.20)'); g.addColorStop(1, 'rgba(15,23,42,0)');
    x.fillStyle = g; x.fillRect(0, 0, 128, 128);
    const sh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
    sh.rotation.x = -Math.PI / 2; sh.position.y = -2.6; sh.scale.set(10, 10, 1); scene.add(sh);
  }

  const clouds = [];
  [[-7, 5.4, -10, 1.1], [4, 6.4, -13, 1.4], [9, 4.4, -9, 0.9], [-3, 7.2, -15, 1.2]].forEach(c => {
    const g = new THREE.Group(), mat = new THREE.MeshBasicMaterial({ color: 0xe6f1fb });
    [[0, 0, 0, 1], [1, -.1, 0, .8], [-1, -.1, 0, .75], [.4, .35, 0, .7]].forEach(p => {
      const s = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), mat); s.position.set(p[0], p[1], p[2]); s.scale.set(p[3], p[3] * .75, p[3] * .8); g.add(s);
    });
    g.position.set(c[0], c[1], c[2]); g.scale.setScalar(c[3]); scene.add(g); clouds.push(g);
  });

  /* ---------- Trees, bushes, flowers ---------- */
  const trees = [];
  function makeTree(x, z, sc, shade) {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.22, 1.7, 8), M3(0xc9a074, { roughness: 1 })); trunk.position.y = 0.85; g.add(trunk);
    const fol = new THREE.Group(); fol.position.y = 1.6; g.add(fol);
    const lm = M3(shade, { roughness: .85 });
    [[0, .55, 0, .95], [-.6, .15, .1, .7], [.6, .2, -.1, .72]].forEach(p => {
      const s = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), lm); s.position.set(p[0], p[1], p[2]); s.scale.setScalar(p[3]); fol.add(s);
    });
    g.userData.fol = fol; g.position.set(x, 0, z); g.scale.setScalar(sc); scene.add(g); trees.push(g);
  }
  [[-3.6, -2.4, 0.8, 0x9be3ae], [-2.0, -3.6, 1.0, 0x86d89d], [-0.3, -4.1, 0.9, 0x9be3ae], [1.6, -3.7, 1.05, 0xb2ebc0], [3.3, -2.6, 0.85, 0x9be3ae], [3.9, 0.0, 0.7, 0xb2ebc0], [-3.9, 0.2, 0.7, 0xb2ebc0]]
    .forEach(a => makeTree(a[0], a[1], a[2], a[3]));
  [[-3.4, 1.4, .4], [3.3, 1.6, .45]].forEach(b => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), M3(0x9be3ae, { roughness: .9 })); m.position.set(b[0], b[2] * .6, b[1]); m.scale.set(b[2], b[2] * .75, b[2]); scene.add(m);
  });
  {
    const blocked = (x, z) => [[-2.2, 0.6, 1.0], [2.2, 0.6, 1.0], [-1.8, 0.1, 1.1], [-1.75, -0.35, 0.7], [0, 0, 1.6]].some(c => Math.hypot(x - c[0], z - c[1]) < c[2]);
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const stemG = new THREE.CylinderGeometry(0.012, 0.015, 0.2, 5), headG = new THREE.SphereGeometry(0.06, 8, 6);
    const stemM = M3(0x2f9e4f), cols = [0xf472b6, 0xfbbf24, 0xf87171, 0xc084fc, 0xffffff].map(c => M3(c, { roughness: .6 }));
    let n = 0;
    while (n < 34) {
      const a = rnd() * Math.PI * 2, r = 1.8 + rnd() * 2.1, x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (blocked(x, z)) continue;
      const st = new THREE.Mesh(stemG, stemM), fl = new THREE.Mesh(headG, cols[n % cols.length]);
      st.position.set(x, 0.1, z); fl.position.set(x, 0.22, z); scene.add(st, fl); n++;
    }
  }

  /* ---------- Player avatar: Y Bot (Mixamo). A simple farmer figure is shown only if the model cannot load. ---------- */
  const mkM = (c, r) => new THREE.MeshStandardMaterial({ color: c, roughness: r });
  const playerM = { skin: mkM(0xf1c27d, .7), shirt: mkM(0x22c55e, .65), pants: mkM(0x1e3a8a, .8),
                    hair: mkM(0xc9ced6, .9), shoe: mkM(0x78350f, .6), dark: mkM(0x1e293b, .5) };
  const strawM = mkM(0xe8c36a, .9);
  const fallback = makeFigure(playerM, { glasses: false, moustache: false });
  {   // straw farmer hat (fallback figure only)
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(.075, .085, .07, 20), strawM); crown.position.y = .115;
    const brim  = new THREE.Mesh(new THREE.CylinderGeometry(.19, .19, .012, 28), strawM);  brim.position.y = .085;
    fallback.head.add(crown, brim);
  }
  fallback.g.visible = false;                         // hidden unless the Y Bot fails to load

  const avRig = new THREE.Group(), avYaw = new THREE.Group(), avBody = new THREE.Group();
  avRig.scale.setScalar(AV); scene.add(avRig); avRig.add(avYaw);
  avBody.add(fallback.g);
  const avatar = {
    g: avBody, ybot: null,
    apply(J) { if (this.ybot) this.ybot.apply(J, avBody); else fallback.apply(J); }
  };
  const bodyMats = [];                                // materials that glow when the target pose is reached

  function useFallback(why) {
    console.warn('[Garden of Wellbeing] Y Bot not used – ' + why + '. Showing the basic avatar instead.');
    fallback.g.visible = true;
    GW.setBanner('Could not load ' + MODEL_URL + ' – showing the basic avatar', 'warn');
  }
  if (THREE.GLTFLoader) {
    new THREE.GLTFLoader().load(MODEL_URL, gltf => {
      try {
        const model = gltf.scene;                     // gltf.animations (a one-frame T-pose) is deliberately not played
        model.traverse(o => {
          if (!o.isMesh) return;
          o.frustumCulled = false;                    // skinned meshes move far from their bind-pose bounds
          (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
            if (m.metalness > 0.5) m.metalness = 0.15;  // the file's body material is fully metallic and renders black without an environment map
            if (m.emissive) bodyMats.push(m);
          });
        });
        const rig = makeYBotRig(model, (v, out) => { out.copy(v); out.y += FOOT_LIFT; return avBody.localToWorld(out); });
        avBody.add(model); avatar.ybot = rig; fallback.g.visible = false;
        console.info('[Garden of Wellbeing] Y Bot loaded.');
      } catch (e) { useFallback(e.message); }
    }, undefined, () => useFallback('could not load "' + MODEL_URL + '" (is it in the same folder as index.html?)'));
  } else useFallback('GLTFLoader script is missing from index.html');

  const avChair = buildChair();
  const avShadow = new THREE.Mesh(new THREE.CircleGeometry(0.5, 32), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: .22, depthWrite: false }));
  avShadow.rotation.x = -Math.PI / 2; avShadow.position.y = 0.006;
  avYaw.add(avShadow, avChair, avBody);

  let ap = { ...DEF }, avJ = computeJoints(DEF), avYawNow = 0;
  function updateAvatar() {
    const mode = game.mode;
    avYawNow = lerp(avYawNow, mode === 'potato' ? rad(-80) : 0, 0.08);
    avYaw.rotation.y = avYawNow;
    avChair.visible = mode === 'potato';
    avRig.updateMatrixWorld(true);                    // the Y Bot targets are converted with this matrix
    const P = live.tracking ? liveParams(mode) : idleParams(mode);
    for (const k in DEF) ap[k] = lerp(ap[k], P[k], 0.3);
    avJ = computeJoints(ap); avatar.apply(avJ);
    const glow = game.targetReached ? 0x0f6a0f : 0x000000;
    playerM.shirt.emissive.setHex(glow);
    bodyMats.forEach(m => m.emissive.setHex(glow));
    avRig.updateMatrixWorld(true);                    // hands are read by the sorting mode right after this
  }

  /* ---------- Extruded gold star burst ---------- */
  function makeStarShape(outer = 1, inner = 0.45, pts = 5) {
    const s = new THREE.Shape();
    for (let i = 0; i < pts * 2; i++) {
      const r = i % 2 === 0 ? outer : inner, a = i * Math.PI / pts - Math.PI / 2;
      i ? s.lineTo(Math.cos(a) * r, Math.sin(a) * r) : s.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    s.closePath(); return s;
  }
  const starGeo = new THREE.ExtrudeGeometry(makeStarShape(), { depth: 0.28, bevelEnabled: true, bevelThickness: 0.07, bevelSize: 0.06, bevelSegments: 2 });
  starGeo.center();
  const starMat = new THREE.MeshStandardMaterial({ color: 0xffc83d, metalness: 0.85, roughness: 0.28, emissive: 0x6b3f00, emissiveIntensity: 0.6 });
  let stars = [];
  function launchStarBurst(o) {
    o = o || { x: 0, y: 1.5 };
    for (let i = 0; i < 60; i++) {
      const m = new THREE.Mesh(starGeo, starMat);
      const s0 = 0.08 + Math.random() * 0.14;
      m.scale.setScalar(s0);
      m.position.set(o.x + (Math.random() - 0.5) * 0.4, o.y + (Math.random() - 0.5) * 0.3, 1.8);
      const a = Math.random() * Math.PI * 2, el = (Math.random() - 0.25) * Math.PI * 0.8, sp = 2 + Math.random() * 3.5;
      m.userData = {
        v: new THREE.Vector3(Math.cos(a) * Math.cos(el) * sp, Math.sin(el) * sp + 1.6, Math.sin(a) * Math.cos(el) * sp * 0.6),
        spin: new THREE.Vector3((Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9),
        life: 0, max: 1.3 + Math.random() * 0.9, s0
      };
      scene.add(m); stars.push(m);
    }
  }
  function updateStars(dt) {
    stars = stars.filter(m => {
      const u = m.userData; u.life += dt; u.v.y -= 5 * dt;
      m.position.addScaledVector(u.v, dt);
      m.rotation.x += u.spin.x * dt; m.rotation.y += u.spin.y * dt; m.rotation.z += u.spin.z * dt;
      const k = u.life / u.max;
      m.scale.setScalar(u.s0 * (k < 0.7 ? 1 : Math.max(0.001, 1 - (k - 0.7) / 0.3)));
      if (u.life >= u.max) { scene.remove(m); return false; }
      return true;
    });
  }

  /* ============ Mode 1: Sweet-potato bed (in front of the player) ============ */
  const potatoRig = new THREE.Group(); scene.add(potatoRig);
  potatoRig.position.set(-1.8, 0, 0.1); potatoRig.scale.setScalar(0.55);
  {
    const mound = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.45, 0.4, 28), M3(0x6b4423, { roughness: .95 }));
    mound.position.y = 0.2; potatoRig.add(mound);
    const top = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), M3(0x7c5230, { roughness: 1 }));
    top.scale.set(1.05, 0.35, 1.05); top.position.y = 0.38; potatoRig.add(top);
  }
  const potato = new THREE.Group(); potatoRig.add(potato);
  {
    const spud = new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 16), M3(0xc0507a, { roughness: .55, emissive: 0x3b0a1e, emissiveIntensity: .4 }));
    spud.scale.set(1.35, 0.8, 0.85); spud.rotation.z = 0.3; potato.add(spud);
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.45, 8), M3(0x9d3f63));
    tail.rotation.z = Math.PI / 2 + 0.3; tail.position.set(-0.78, -0.12, 0); potato.add(tail);
    const tail2 = tail.clone(); tail2.rotation.z = -Math.PI / 2 + 0.2; tail2.position.set(0.74, -0.1, 0); tail2.scale.setScalar(.7); potato.add(tail2);
  }
  const vine = new THREE.Group(); vine.position.set(0.15, 0.35, 0); potatoRig.add(vine);
  {
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.055, 1.6, 8), M3(0x15803d));
    stem.position.y = 0.8; vine.add(stem);
    for (let i = 0; i < 4; i++) {
      const leaf = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), M3(0x22c55e, { roughness: .7 }));
      leaf.scale.set(0.42, 0.09, 0.27);
      const s = i % 2 ? 1 : -1;
      leaf.position.set(s * 0.38, 0.45 + i * 0.38, 0); leaf.rotation.z = s * 0.5; vine.add(leaf);
    }
  }
  const pt = { rise: 0, fly: 0, vy: 0, grow: 1 };
  function updatePotato(dt, t) {
    potatoRig.position.x = -layout.px;
    const prog = live.tracking ? live.prog : 0;
    if (pt.fly > 0) {
      pt.fly -= dt; pt.vy -= 14 * dt; potato.position.y += pt.vy * dt;
      potato.rotation.z += dt * 9; potato.rotation.y += dt * 6;
      potato.scale.setScalar(Math.max(0.01, Math.min(1, pt.fly / 0.3)));
      if (pt.fly <= 0) { pt.rise = 0; pt.grow = 0; potato.rotation.set(0, 0, 0); potato.position.set(0, 0.05, 0); potato.scale.setScalar(0.01); }
    } else {
      if (pt.grow < 1) { pt.grow = Math.min(1, pt.grow + dt / 0.5); potato.scale.setScalar(Math.max(0.01, ease(pt.grow))); }
      pt.rise = lerp(pt.rise, prog, Math.min(1, dt * 6));
      potato.position.y = lerp(0.05, 1.2, pt.rise);
      potato.position.x = Math.sin(t * 48) * 0.035 * clamp01((pt.rise - 0.55) * 3);
    }
    vine.rotation.z = Math.sin(t * 2) * 0.05 + Math.sin(t * 40) * 0.03 * clamp01((pt.rise - 0.55) * 3);
  }

  /* ============ Mode 2: Fruit tree with a branch overhead ============ */
  const fruitTree = new THREE.Group(); scene.add(fruitTree);
  {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.28, 3.7, 10), M3(0xc9a074, { roughness: 1 })); trunk.position.set(-1.75, 1.85, -0.35); fruitTree.add(trunk);
    const lm = M3(0x8fdba2, { roughness: .85 });
    [[-1.8, 3.9, -0.35, 1.0], [-2.5, 3.5, -0.3, 0.75], [-1.1, 4.0, -0.4, 0.7]].forEach(p => {
      const s = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), lm); s.position.set(p[0], p[1], p[2]); s.scale.setScalar(p[3]); fruitTree.add(s);
    });
  }
  const treeRig = new THREE.Group(); scene.add(treeRig);
  treeRig.position.set(0, 3.55, -0.35); treeRig.scale.setScalar(0.5);
  {
    const br = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.15, 6.8, 10), M3(0xb58a5a, { roughness: .9 }));
    br.rotation.z = Math.PI / 2; treeRig.add(br);
    for (let i = 0; i < 6; i++) {
      const f = new THREE.Mesh(new THREE.SphereGeometry(0.55, 14, 10), M3(0x6fcf8a, { roughness: .8 }));
      f.scale.set(1, 0.7, 0.8); f.position.set(-2.9 + i * 1.16, 0.38 + (i % 2) * 0.12, 0); treeRig.add(f);
    }
  }
  const apples = [];
  [-2.2, -0.75, 0.75, 2.2].forEach(x => {
    const g = new THREE.Group(); g.position.set(x, 0, 0);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.55, 6), M3(0x5b3a1a)); stem.position.y = -0.27; g.add(stem);
    const mat = M3(0xe11d48, { roughness: .35, emissive: 0x7f1d1d, emissiveIntensity: .25 });
    const fruit = new THREE.Mesh(new THREE.SphereGeometry(0.4, 20, 14), mat); fruit.position.y = -0.92; g.add(fruit);
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), M3(0x22c55e)); leaf.scale.set(.2, .05, .1); leaf.position.set(.14, -0.52, 0); leaf.rotation.z = .5; g.add(leaf);
    treeRig.add(g);
    apples.push({ g, mat, st: 'hang', t: 0, vy: 0, spin: 0 });
  });
  const tr = { p: 0 };
  function updateTree(dt, t) {
    tr.p = lerp(tr.p, live.tracking ? live.prog : 0, Math.min(1, dt * 6));
    apples.forEach((a, i) => {
      if (a.st === 'hang') {
        a.g.rotation.z = Math.sin(t * 1.6 + i * 1.3) * (0.04 + 0.12 * tr.p);
        a.g.scale.setScalar(1 + 0.22 * tr.p);
        a.mat.emissiveIntensity = 0.25 + 0.9 * tr.p;
      } else if (a.st === 'fall') {
        a.t += dt;
        if (a.t > 0) { a.vy -= 16 * dt; a.g.position.y += a.vy * dt; a.g.rotation.z += a.spin * dt; }
        if (a.t > 1.1) { a.st = 'regrow'; a.t = 0; a.g.position.y = 0; a.g.rotation.set(0, 0, 0); a.g.scale.setScalar(0.01); a.mat.emissiveIntensity = 0.25; }
      } else if (a.st === 'regrow') {
        a.t += dt; a.g.scale.setScalar(Math.max(0.01, ease(Math.min(1, a.t / 0.6))));
        if (a.t >= 0.6) a.st = 'hang';
      }
    });
  }

  /* ============ Mode 3: Fixed baskets + a fruit held in the hands ============ */
  const sortRig = new THREE.Group(); scene.add(sortRig);
  const SIDE_COL = { L: 0xf43f5e, R: 0xfb923c };
  const FRUIT_S = 0.38, BASKET_S = 0.62;
  function makeFruit(color) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.42, 20, 14), M3(color, { roughness: .35, emissive: color, emissiveIntensity: .25 }));
    g.add(body);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.2, 6), M3(0x5b3a1a)); stem.position.y = 0.44; g.add(stem);
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), M3(0x22c55e)); leaf.scale.set(.2, .05, .1); leaf.position.set(.14, .5, 0); leaf.rotation.z = .5; g.add(leaf);
    g.userData.body = body; return g;
  }
  function makeBasket(color) {
    const g = new THREE.Group();
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(1, 0.7, 0.9, 28, 1, true), M3(0xb7791f, { roughness: .9, side: THREE.DoubleSide }));
    g.add(wall);
    const bottom = new THREE.Mesh(new THREE.CircleGeometry(0.7, 24), M3(0x8a5a14, { side: THREE.DoubleSide })); bottom.rotation.x = -Math.PI / 2; bottom.position.y = -0.45; g.add(bottom);
    const rimM = new THREE.Mesh(new THREE.TorusGeometry(1, 0.08, 8, 32), M3(color, { emissive: color, emissiveIntensity: .3 })); rimM.rotation.x = Math.PI / 2; rimM.position.y = 0.45; g.add(rimM);
    [0.12, -0.2].forEach(y => { const b = new THREE.Mesh(new THREE.TorusGeometry(0.86 + (y < 0 ? -0.08 : 0.0), 0.03, 6, 28), M3(0x8a5a14)); b.rotation.x = Math.PI / 2; b.position.y = y; g.add(b); });
    const spots = [[-.4, .0, .1], [.4, .0, .1], [0, .0, .4], [-.2, .3, .1], [.25, .3, -.1], [0, .55, .1]];
    const fruits = spots.map(p => { const f = new THREE.Mesh(new THREE.SphereGeometry(0.3, 14, 10), M3(color, { roughness: .35, emissive: color, emissiveIntensity: .2 }));
      f.position.set(p[0], p[1], p[2]); f.visible = false; g.add(f); return f; });
    g.rotation.x = 0.35;
    const holder = new THREE.Group(); holder.add(g);
    holder.userData = { fruits, rim: rimM, count: 0, bounce: 0 };
    return holder;
  }
  const basketL = makeBasket(SIDE_COL.L), basketR = makeBasket(SIDE_COL.R);
  basketL.position.set(-2.2, 0.3, 0.6); basketR.position.set(2.2, 0.3, 0.6);     // stationary
  sortRig.add(basketL, basketR);
  const sfruit = makeFruit(SIDE_COL.R); sortRig.add(sfruit);
  const sf = { st: 'grow', t: 0, scale: 0, side: 'R', from: new THREE.Vector3(), col: -1 };
  const _hand = new THREE.Vector3();
  function handWorld(out) {                         // midpoint of both hands, slightly in front
    _hand.copy(avJ.wrL).add(avJ.wrR).multiplyScalar(0.5); _hand.y += 0.05 + (avatar.ybot ? FOOT_LIFT : 0); _hand.z += 0.1;
    return avatar.g.localToWorld(out.copy(_hand));
  }
  function setFruitColor(hex) {
    if (sf.col === hex) return; sf.col = hex;
    const b = sfruit.userData.body; b.material.color.setHex(hex); b.material.emissive.setHex(hex);
  }
  function updateSort(dt, t) {
    basketL.position.x = -layout.bx; basketR.position.x = layout.bx;
    const ts = game.twistSide * CFG.TWIST_SCREEN_SIGN;
    const target = live.tracking && ts !== 0 ? (ts > 0 ? 'L' : 'R') : null;    // the basket to twist toward next
    [['L', basketL], ['R', basketR]].forEach(([side, b]) => {
      const u = b.userData; u.bounce = Math.max(0, u.bounce - dt * 3);
      const glow = target === side ? 0.6 + 0.4 * Math.sin(t * 5) : 0;
      b.scale.setScalar(BASKET_S * layout.bs * (1 + 0.2 * Math.sin(u.bounce * Math.PI) + 0.05 * glow));
      u.rim.material.emissiveIntensity = 0.25 + glow;
    });
    if (target) setFruitColor(SIDE_COL[target]);

    if (sf.st === 'grow' || sf.st === 'held') {
      if (sf.st === 'grow') { sf.t += dt; sf.scale = ease(clamp01(sf.t / 0.45)); if (sf.t >= 0.45) { sf.st = 'held'; sf.scale = 1; } }
      handWorld(sfruit.position); sfruit.rotation.y = t * 1.2;
    } else if (sf.st === 'fly') {
      sf.t += dt / 0.6; const k = Math.min(1, sf.t), b = sf.side === 'L' ? basketL : basketR;
      const tx = b.position.x, ty = b.position.y + 0.5, tz = b.position.z;
      sfruit.position.set(lerp(sf.from.x, tx, ease(k)), lerp(sf.from.y, ty, ease(k)) + Math.sin(Math.PI * k) * 1.3, lerp(sf.from.z, tz, ease(k)));
      sf.scale = 1 - 0.3 * k; sfruit.rotation.y += dt * 8;
      if (k >= 1) {
        const u = b.userData; u.count++; u.bounce = 1;
        u.fruits.forEach((f, i) => f.visible = i < Math.min(u.count, 6));
        setFruitColor(sf.side === 'L' ? SIDE_COL.R : SIDE_COL.L);
        sf.st = 'grow'; sf.t = 0; sf.scale = 0;
      }
    }
    sfruit.scale.setScalar(Math.max(0.001, FRUIT_S * sf.scale));
  }
  function dropFruit() {                            // called on a completed rep
    const sgn = Math.sign(live.twist || 0) * CFG.TWIST_SCREEN_SIGN;
    sf.side = sgn > 0 ? 'R' : sgn < 0 ? 'L' : (sf.side === 'L' ? 'R' : 'L');
    sf.st = 'fly'; sf.t = 0; sf.scale = 1; sf.from.copy(sfruit.position);
    setFruitColor(SIDE_COL[sf.side]);
    const b = sf.side === 'L' ? basketL : basketR;
    return { x: b.position.x, y: b.position.y + 0.5 };
  }

  /* ---------- Per-frame garden update ---------- */
  function updateGarden(dt, t) {
    const mode = game.mode;
    potatoRig.visible = mode === 'potato';
    treeRig.visible = fruitTree.visible = mode === 'fruit';
    sortRig.visible = mode === 'sort';
    if (mode === 'potato') updatePotato(dt, t);
    else if (mode === 'fruit') updateTree(dt, t);
    else updateSort(dt, t);
    trees.forEach((g, i) => { g.userData.fol.rotation.z = Math.sin(t * 0.8 + i * 1.7) * 0.025; });
    clouds.forEach(c => { c.position.x += dt * 0.25; if (c.position.x > 14) c.position.x = -14; });
  }

  /* called by game.js whenever a rep is completed */
  GW.three = {
    harvestFX() {
      let o;
      if (game.mode === 'potato') {
        pt.fly = 1.0; pt.vy = 9;
        o = { x: potatoRig.position.x, y: 0.9 };
      } else if (game.mode === 'fruit') {
        apples.forEach((a, i) => { a.st = 'fall'; a.t = -i * 0.07; a.vy = 0; a.spin = (Math.random() - 0.5) * 6; });
        o = { x: 0, y: 3.0 };
      } else {
        o = dropFruit();
      }
      launchStarBurst(o);
    }
  };

  /* ==========================================================
     D) 3D GRANDPA COACH (inside the Coach panel)
     ========================================================== */
  const solidM = {
    skin:  new THREE.MeshStandardMaterial({ color: 0xfcd5b0, roughness: .7 }),
    shirt: new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: .65 }),
    pants: new THREE.MeshStandardMaterial({ color: 0x475569, roughness: .8 }),
    hair:  new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: .9 }),
    shoe:  new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: .6 }),
    dark:  new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: .5 })
  };
  const ghostMat = new THREE.MeshBasicMaterial({ color: 0x39ff14, transparent: true, opacity: .2, depthWrite: false });
  const ghostM = { skin: ghostMat, shirt: ghostMat, pants: ghostMat, hair: ghostMat, shoe: ghostMat, dark: ghostMat };

  const gCanvas = $('grandpa3d');
  const gRenderer = new THREE.WebGLRenderer({ canvas: gCanvas, alpha: true, antialias: true });
  gRenderer.setClearColor(0x000000, 0);
  const gScene = new THREE.Scene();
  const gCam = new THREE.PerspectiveCamera(32, 1.2, 0.1, 50);
  gScene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const gSun = new THREE.DirectionalLight(0xffffff, 0.95); gSun.position.set(2, 4, 3); gScene.add(gSun);
  function resizeG() {
    const w = gCanvas.clientWidth, h = gCanvas.clientHeight; if (!w || !h) return;
    gRenderer.setPixelRatio(Math.min(devicePixelRatio || 1, PR_MAX));
    gRenderer.setSize(w, h, false); gCam.aspect = w / h; gCam.updateProjectionMatrix();
  }
  new ResizeObserver(resizeG).observe(gCanvas); resizeG();

  {
    const lawn = new THREE.Mesh(new THREE.CircleGeometry(2.1, 48), new THREE.MeshStandardMaterial({ color: 0x1d5a42, roughness: 1 }));
    lawn.rotation.x = -Math.PI / 2; gScene.add(lawn);
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.42, 32), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: .3, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.003; gScene.add(shadow);
    const cols = [0xf472b6, 0xfbbf24, 0xf87171, 0xc084fc];
    for (let i = 0; i < 9; i++) {
      const a = i / 9 * Math.PI * 2 + 0.3, r = 1.35 + ((i * 37) % 5) * 0.1, g = new THREE.Group();
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.012, 0.22, 5), new THREE.MeshStandardMaterial({ color: 0x15803d })); st.position.y = 0.11; g.add(st);
      const fl = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), new THREE.MeshStandardMaterial({ color: cols[i % 4] })); fl.position.y = 0.24; g.add(fl);
      g.position.set(Math.cos(a) * r, 0, Math.sin(a) * r); gScene.add(g);
    }
  }
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: .8, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.54, 48), ringMat); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.006; gScene.add(ring);
  const chair = buildChair(); gScene.add(chair);

  const grandpa = makeFigure(solidM), ghost = makeFigure(ghostM);
  ghost.g.scale.setScalar(1.03);
  gScene.add(grandpa.g); gScene.add(ghost.g);

  let gp = { ...DEF }, gCamReady = false;
  const gCamTarget = new THREE.Vector3(), gLook = new THREE.Vector3(0, 0.92, 0);
  function updateGrandpa(t) {
    const mode = game.mode;
    let P, hit, phase;
    if (ui.gMode === 'mirror' && live.tracking) {
      P = liveParams(mode); hit = game.targetReached; phase = livePhase(mode);
      $('gCap').textContent = 'Mirroring you – match the green ghost!';
    } else {
      const c = coachParams(mode, t); P = c.P; hit = c.hit; phase = c.phase;
      $('gCap').textContent = (ui.gMode === 'mirror' && !live.tracking ? 'No body seen yet – showing the coach. ' : '') + CAPTION[mode];
    }
    for (const k in DEF) gp[k] = lerp(gp[k], P[k], 0.25);
    grandpa.apply(computeJoints(gp));
    ghost.apply(computeJoints(ghostParams(mode, t)));
    solidM.shirt.emissive.setHex(hit ? 0x0f6a0f : 0x000000);
    ringMat.color.setHex(hit ? 0x39ff14 : 0x38bdf8);
    chair.visible = mode === 'potato';
    setChips(mode, phase, hit);
    if (mode === 'potato') gCamTarget.set(3.7, 1.15, 1.9); else gCamTarget.set(0.9, 1.2, 4.1);
    if (!gCamReady) { gCam.position.copy(gCamTarget); gCamReady = true; }   // first time the panel opens: no fly-in from the origin
    gCam.position.lerp(gCamTarget, 0.06); gCam.lookAt(gLook);
  }

  /* ---------- Render loop ---------- */
  let lastFrame = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - lastFrame) / 1000); lastFrame = now;
    const t = now / 1000;
    updateAvatar();                       // first: hand position is needed by the sorting fruit
    updateGarden(dt, t); updateStars(dt);
    renderer.render(scene, camera3);
    if (ui.coachOpen) { updateGrandpa(t); gRenderer.render(gScene, gCam); }   // the coach is only drawn while its panel is open
  }
  requestAnimationFrame(frame);
})();
