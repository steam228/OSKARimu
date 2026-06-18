// Third visualizer: pseudo-3D body skeleton from ml5.bodyPose (MoveNet).
//
// The model + detection are unchanged — we still consume MoveNet 2D keypoints
// from ml5 v1. We treat the body as an approximately *planar* cutout that
// rotates about its vertical centreline. Each frame, three globals are
// derived from the 2D keypoints:
//
//   1. centerline cx — mean x of shoulders (+ hips if confident), in the
//      same mirrored coordinate space the skeleton is drawn in.
//   2. yaw — rotation about vertical Y. Magnitude from foreshortening of
//      the projected shoulder span (acos of span/maxShoulderSpan, the latter
//      a slowly-decaying running max that calibrates a frontal pose).
//      Sign from nose-x vs centerline (ear x as fallback).
//   3. globalZ — distance to camera, inverse-scaled from eye spacing
//      (closer face = wider eyes), relative to a captured baseline.
//
// Per-joint Z is synthesized by rotating each joint's horizontal offset
// from the centerline around the vertical axis:
//   zJoint = (X_joint - cx) * sin(yaw) + globalZ
// (Optional UNFORESHORTEN: undo perspective foreshortening by dividing the
// horizontal offset by cos(yaw) first; guarded for cos→0.)
//
// Keys:  c → index.html   |   r → recalibrate frontal pose   |   o → orbit cam
//        m → toggle mirror (front-projection ↔ back-projection)
//        f → toggle fullscreen kiosk mode

// ---------------- Tunables ----------------
const CUBE          = 10;     // per-keypoint cube edge length (WEBGL units)
const LINE_W        = 1.5;    // skeleton line stroke weight
const DEPTH_SCALE   = 8;      // (px eye-spacing change) → WEBGL z units
const SMOOTH        = 0.2;    // lerp factor for yaw + globalZ (per frame)
const CONF          = 0.3;    // min keypoint confidence to draw / use
const SIGN          = 1;      // flip if the body turns the wrong way (+1 / -1)
const UNFORESHORTEN = false;  // divide horizontal offset by cos(yaw) before rotating

// ---------------- Video + model (unchanged) ----------------
const VIDEO_W = 640;
const VIDEO_H = 480;

let bodyPose;
let video;
let poses = [];
let connections = [];

// ---------------- Derived pose state ----------------
let yaw          = 0;     // smoothed
let globalZ      = 0;     // smoothed
let maxShoulderW = 0;     // running max of shoulder span (decays * 0.999)
let eyeBaseline  = null;  // captured first time both eyes are confident

let orbiting = false;
let mirrored = true;          // true = selfie / front-projection. Toggle with 'm'.

function preload() {
    bodyPose = ml5.bodyPose();
}

function setup() {
    createCanvas(windowWidth, windowHeight, WEBGL);
    pixelDensity(1);

    video = createCapture(VIDEO);
    video.size(VIDEO_W, VIDEO_H);
    video.hide();

    bodyPose.detectStart(video, (r) => { poses = r; });

    // ml5 v1 connection list: prefer getConnections(), fall back to getSkeleton().
    connections = (typeof bodyPose.getConnections === 'function')
        ? bodyPose.getConnections()
        : bodyPose.getSkeleton();
}

function windowResized() {
    resizeCanvas(windowWidth, windowHeight);
}

function keyPressed() {
    if (key === 'c' || key === 'C') window.location.href = 'index.html';
    if (key === 'o' || key === 'O') orbiting = !orbiting;
    if (key === 'm' || key === 'M') mirrored = !mirrored;
    if (key === 'f' || key === 'F') fullscreen(!fullscreen());
    if (key === 'r' || key === 'R') {
        maxShoulderW = 0;
        eyeBaseline  = null;
        yaw = 0;
        globalZ = 0;
    }
}

function draw() {
    background(0);
    if (orbiting) orbitControl();

    // subtle lighting so cube faces read as 3D; lines aren't affected.
    ambientLight(80);
    directionalLight(255, 255, 255, 0.3, 0.5, -1);

    if (!poses.length) return;
    const pose = poses[0];

    // Uniform fit-scale: same S for x, y and z keeps proportions consistent.
    // Image (640×480) → centered WEBGL coords:
    //   mirrored: X = (320 - x_img) * S  (replace x_img with 640-x_img, then centre, scale)
    //   raw:      X = (x_img - 320) * S
    //   Y       = (y_img - 240) * S
    // Toggling `mirrored` flips both the displayed skeleton AND the basis in
    // which cx / yaw are computed, which is exactly what front-vs-back
    // projection requires (the SIGN constant may need to flip too if the
    // sense of yaw feels inverted in the new mode).
    const S = Math.min(width / VIDEO_W, height / VIDEO_H);
    const X = mirrored
        ? (x_img) => (VIDEO_W / 2 - x_img) * S
        : (x_img) => (x_img - VIDEO_W / 2) * S;
    const Y = (y_img) => (y_img - VIDEO_H / 2) * S;

    // --- Pull the named keypoints we need for the geometry. ---
    const ls   = pose.left_shoulder,  rs   = pose.right_shoulder;
    const lh   = pose.left_hip,       rh   = pose.right_hip;
    const nose = pose.nose;
    const le   = pose.left_eye,       re   = pose.right_eye;
    const lear = pose.left_ear,       rear = pose.right_ear;

    // --- 1. Centerline cx (in mirrored WEBGL X). Use shoulders (+ hips). ---
    let xs = [];
    if (ls && ls.confidence > CONF) xs.push(ls.x);
    if (rs && rs.confidence > CONF) xs.push(rs.x);
    if (lh && lh.confidence > CONF) xs.push(lh.x);
    if (rh && rh.confidence > CONF) xs.push(rh.x);
    const cx_img = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : VIDEO_W / 2;
    const cx_X   = X(cx_img);

    // --- 2. Yaw — magnitude from shoulder-span foreshortening. ---
    // Span is invariant to mirroring (absolute value), so use image-space x.
    if (ls && rs && ls.confidence > CONF && rs.confidence > CONF) {
        const span = Math.abs(ls.x - rs.x);
        maxShoulderW = Math.max(maxShoulderW * 0.999, span);

        if (maxShoulderW > 1) {
            const ratio  = Math.min(1, Math.max(0, span / maxShoulderW));
            const yawMag = Math.acos(ratio);                    // 0 frontal → π/2 sideways

            // Sign from nose offset relative to centerline (mirrored space).
            // Fallback chain: nose → most-confident ear.
            let dx = 0;
            if (nose && nose.confidence > CONF) {
                dx = X(nose.x) - cx_X;
            } else if (lear && rear && lear.confidence > rear.confidence && lear.confidence > 0.1) {
                dx = X(lear.x) - cx_X;
            } else if (rear && rear.confidence > 0.1) {
                dx = X(rear.x) - cx_X;
            }

            const yaw_target = SIGN * Math.sign(dx || 0) * yawMag;
            yaw = lerp(yaw, yaw_target, SMOOTH);
        }
    }

    // --- 3. Global depth — inverse-scale from eye spacing. ---
    if (le && re && le.confidence > CONF && re.confidence > CONF) {
        const eyeSpan = Math.abs(le.x - re.x);
        if (eyeBaseline === null) eyeBaseline = eyeSpan;
        const globalZ_target = (eyeSpan - eyeBaseline) * DEPTH_SCALE;
        globalZ = lerp(globalZ, globalZ_target, SMOOTH);
    }

    // --- Lift a horizontal WEBGL X into 3D Z via the planar-rotation model. ---
    const sinY = Math.sin(yaw);
    const cosY = Math.cos(yaw);
    const liftZ = (x_webgl) => {
        let dx = x_webgl - cx_X;
        if (UNFORESHORTEN) {
            const c = Math.abs(cosY) > 0.15 ? cosY : Math.sign(cosY || 1) * 0.15;
            dx = dx / c;
        }
        return dx * sinY + globalZ;
    };

    // --- Skeleton lines (drawn first so cubes sit on top). ---
    stroke(255);
    strokeWeight(LINE_W);
    noFill();
    for (const c of connections) {
        const a = pose.keypoints[c[0]];
        const b = pose.keypoints[c[1]];
        if (!a || !b) continue;
        if (a.confidence > CONF && b.confidence > CONF) {
            const Xa = X(a.x), Ya = Y(a.y), Za = liftZ(Xa);
            const Xb = X(b.x), Yb = Y(b.y), Zb = liftZ(Xb);
            line(Xa, Ya, Za, Xb, Yb, Zb);
        }
    }

    // --- Keypoint cubes. ---
    fill(255);
    noStroke();
    for (const kp of pose.keypoints) {
        if (kp.confidence > CONF) {
            const Xk = X(kp.x), Yk = Y(kp.y), Zk = liftZ(Xk);
            push();
            translate(Xk, Yk, Zk);
            box(CUBE);
            pop();
        }
    }
}
