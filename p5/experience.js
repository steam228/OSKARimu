// Experience sketch — fork of pose.js with two imaginary "sensor-body" dots
// and an integrated serial input from the base ESP.
//
// Body model (unchanged from pose.js): planar cutout rotating about its
// vertical centerline. yaw from shoulder-span foreshortening, globalZ from
// eye spacing, per-joint Z lifted by (X - cx) * sin(yaw) + globalZ.
//
// Extra markers (this file's additions):
//   - IMU dot      — placed BEHIND the neck (midpoint of shoulders), offset
//                    along the body's back-normal. Represents the sensor node.
//   - Distance dot — placed at the right shoulder keypoint. Represents the
//                    VL53L3CX position.
//
// Serial input:
//   The CSV from the base ESP (t_ms, dist_mm, tof_status, ax, ay, az, gx, gy, gz)
//   is parsed and held in globals. Nothing is rendered from it yet — this is
//   pure plumbing for future behaviour.
//
// Keys:  c → index.html   |   r → recalibrate frontal pose   |   o → orbit cam
//        m → toggle mirror (front-projection ↔ back-projection)
//        f → toggle fullscreen kiosk mode

// ---------------- Tunables ----------------
const CUBE          = 10;     // per-keypoint cube edge length (WEBGL units)
const SENSOR_CUBE   = 18;     // size for the IMU / distance-sensor dots
const LINE_W        = 1.5;    // skeleton line stroke weight
const DEPTH_SCALE   = 8;      // (px eye-spacing change) → WEBGL z units
const SMOOTH        = 0.2;    // lerp factor for yaw + globalZ (per frame)
const CONF          = 0.3;    // min keypoint confidence to draw / use
const SIGN          = 1;      // flip if the body turns the wrong way (+1 / -1)
const UNFORESHORTEN = false;  // divide horizontal offset by cos(yaw) before rotating
const BEHIND_OFFSET = 40;     // how far behind the neck the IMU sits (WEBGL units)

// ---------------- Video + model (unchanged) ----------------
const VIDEO_W = 640;
const VIDEO_H = 480;

let bodyPose;
let video;
let poses = [];
let connections = [];

// ---------------- Derived pose state ----------------
let yaw          = 0;
let globalZ      = 0;
let maxShoulderW = 0;
let eyeBaseline  = null;

let orbiting = false;
let mirrored = true;

// ---------------- Serial input (from base ESP) ----------------
// Parsed but unused for rendering yet — just integrated.
let sensor = {
    t: 0,
    distance: -1,
    tofStatus: 255,
    ax: 0, ay: 0, az: 1,
    gx: 0, gy: 0, gz: 0,
};
let serialBusy = false;

async function autoConnect() {
    if (serialBusy || !('serial' in navigator)) return;
    const ports = await navigator.serial.getPorts();
    if (!ports.length) return;
    serialBusy = true;
    try {
        const port = ports[0];
        await port.open({ baudRate: 115200 });
        readLoop(port);
    } catch (e) {
        serialBusy = false;
    }
}

async function readLoop(port) {
    const decoder = new TextDecoderStream();
    port.readable.pipeTo(decoder.writable).catch(() => {});
    const reader = decoder.readable.getReader();
    let buf = '';
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) parseSensor(line);
        }
    }
    serialBusy = false;
}

function parseSensor(line) {
    const p = line.split(',');
    if (p.length < 9) return;
    sensor.t         = parseFloat(p[0]);
    sensor.distance  = parseFloat(p[1]);
    sensor.tofStatus = parseInt(p[2]);
    sensor.ax        = parseFloat(p[3]);
    sensor.ay        = parseFloat(p[4]);
    sensor.az        = parseFloat(p[5]);
    sensor.gx        = parseFloat(p[6]);
    sensor.gy        = parseFloat(p[7]);
    sensor.gz        = parseFloat(p[8]);
}

// ---------------- p5 lifecycle ----------------
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

    connections = (typeof bodyPose.getConnections === 'function')
        ? bodyPose.getConnections()
        : bodyPose.getSkeleton();

    autoConnect();
}

function windowResized() {
    resizeCanvas(windowWidth, windowHeight);
}

function mousePressed() { autoConnect(); }   // invisible serial-reconnect retry

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

// ---------------- Draw ----------------
function draw() {
    background(0);
    if (orbiting) orbitControl();

    ambientLight(80);
    directionalLight(255, 255, 255, 0.3, 0.5, -1);

    if (!poses.length) return;
    const pose = poses[0];

    const S = Math.min(width / VIDEO_W, height / VIDEO_H);
    const X = mirrored
        ? (x_img) => (VIDEO_W / 2 - x_img) * S
        : (x_img) => (x_img - VIDEO_W / 2) * S;
    const Y = (y_img) => (y_img - VIDEO_H / 2) * S;

    const ls   = pose.left_shoulder,  rs   = pose.right_shoulder;
    const lh   = pose.left_hip,       rh   = pose.right_hip;
    const nose = pose.nose;
    const le   = pose.left_eye,       re   = pose.right_eye;
    const lear = pose.left_ear,       rear = pose.right_ear;

    // --- Centerline ---
    let xs = [];
    if (ls && ls.confidence > CONF) xs.push(ls.x);
    if (rs && rs.confidence > CONF) xs.push(rs.x);
    if (lh && lh.confidence > CONF) xs.push(lh.x);
    if (rh && rh.confidence > CONF) xs.push(rh.x);
    const cx_img = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : VIDEO_W / 2;
    const cx_X   = X(cx_img);

    // --- Yaw ---
    if (ls && rs && ls.confidence > CONF && rs.confidence > CONF) {
        const span = Math.abs(ls.x - rs.x);
        maxShoulderW = Math.max(maxShoulderW * 0.999, span);
        if (maxShoulderW > 1) {
            const ratio  = Math.min(1, Math.max(0, span / maxShoulderW));
            const yawMag = Math.acos(ratio);
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

    // --- Global depth ---
    if (le && re && le.confidence > CONF && re.confidence > CONF) {
        const eyeSpan = Math.abs(le.x - re.x);
        if (eyeBaseline === null) eyeBaseline = eyeSpan;
        const globalZ_target = (eyeSpan - eyeBaseline) * DEPTH_SCALE;
        globalZ = lerp(globalZ, globalZ_target, SMOOTH);
    }

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

    // --- Skeleton lines ---
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

    // --- Keypoint cubes ---
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

    // -------- Tilt comparison (IMU vs pose) --------
    // IMU tilts from gravity, same formula as the cube in the index sketch:
    //   pitch (nose up/down) = atan2(ay, sqrt(ax² + az²))
    //   roll  (side bank)    = atan2(-ax, az)
    // Pose-derived shoulder roll = angle of the (left→right shoulder) line
    // relative to horizontal. Positive when the body's right shoulder is lower.
    // These two roll measures should track each other if the sensor is rigidly
    // mounted behind the neck and oriented with the body's axes.
    const imuPitch = Math.atan2(sensor.ay, Math.sqrt(sensor.ax * sensor.ax + sensor.az * sensor.az));
    const imuRoll  = Math.atan2(-sensor.ax, sensor.az);

    let poseShoulderRoll = null;
    if (ls && rs && ls.confidence > CONF && rs.confidence > CONF) {
        const dxImg = rs.x - ls.x;
        const dyImg = rs.y - ls.y;
        poseShoulderRoll = Math.atan2(dyImg, Math.abs(dxImg));
    }

    // Log every ~0.5s (30 frames @ 60fps) so the console stays readable.
    if (frameCount % 30 === 0) {
        const deg = (r) => (r === null ? '  —  ' : (r * 180 / Math.PI).toFixed(1).padStart(6));
        console.log(
            `imu pitch=${deg(imuPitch)}°  roll=${deg(imuRoll)}°  | ` +
            `pose yaw=${deg(yaw)}°  shoulder_roll=${deg(poseShoulderRoll)}°  | ` +
            `dist=${sensor.distance}mm  tofStatus=${sensor.tofStatus}`
        );
    }

    // -------- Imaginary sensor-body dots --------
    // Both need confident shoulders to anchor.
    if (!(ls && rs && ls.confidence > CONF && rs.confidence > CONF)) return;

    // 1. IMU dot — behind the neck.
    // Neck position = midpoint of shoulders, lifted into 3D via liftZ.
    // "Behind" = along the body plane's back-normal, which after yaw rotation
    // about Y points in (-sin(yaw), 0, -cos(yaw)) world coords.
    const neckX_img = (ls.x + rs.x) / 2;
    const neckY_img = (ls.y + rs.y) / 2;
    const neckX = X(neckX_img);
    const neckY = Y(neckY_img);
    const neckZ = liftZ(neckX);

    const imuX = neckX + BEHIND_OFFSET * (-sinY);
    const imuY = neckY;
    const imuZ = neckZ + BEHIND_OFFSET * (-cosY);

    push();
    translate(imuX, imuY, imuZ);
    fill(255);
    noStroke();
    box(SENSOR_CUBE);
    pop();

    // 2. Distance-sensor dot — at the right shoulder keypoint.
    const dsX = X(rs.x);
    const dsY = Y(rs.y);
    const dsZ = liftZ(dsX);

    push();
    translate(dsX, dsY, dsZ);
    fill(255);
    noStroke();
    box(SENSOR_CUBE);
    pop();
}
