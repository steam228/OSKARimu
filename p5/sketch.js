// Reads CSV lines from the base ESP over Web Serial and visualizes:
//   - left sidebar: distance bar + raw IMU readouts
//   - main canvas: a 3D cube whose orientation tracks the accelerometer tilt
//
// CSV columns (from sensor_main.cpp):
//   t_ms, dist_mm, tof_status, ax, ay, az, gx, gy, gz

const MAX_DISTANCE_MM = 2000;

let distance = -1;
let tofStatus = 255;
let ax = 0, ay = 0, az = 1;
let gx = 0, gy = 0, gz = 0;

// --- Web Serial ---

const connectBtn = document.getElementById('connect');
const statusEl   = document.getElementById('status');
const barLabel   = document.getElementById('bar-label');
const barFill    = document.getElementById('bar-fill');
const imuReadout = document.getElementById('imu-readout');

async function usePort(port, label) {
    await port.open({ baudRate: 115200 });
    connectBtn.disabled = true;
    statusEl.textContent = label;
    readLoop(port).catch(err => {
        statusEl.textContent = 'lost: ' + err.message;
        connectBtn.disabled = false;
    });
}

connectBtn.addEventListener('click', async () => {
    if (!('serial' in navigator)) {
        statusEl.textContent = 'Web Serial not supported (use Chrome/Edge)';
        return;
    }
    try {
        const port = await navigator.serial.requestPort();
        await usePort(port, 'connected');
    } catch (err) {
        statusEl.textContent = 'error: ' + err.message;
    }
});

// Auto-reconnect to an already-authorized port (e.g. after returning from the
// sticks page). Needs a stable origin — serve over http://localhost.
async function tryAutoConnect() {
    if (!('serial' in navigator)) return;
    const ports = await navigator.serial.getPorts();
    if (ports.length) {
        try { await usePort(ports[0], 'connected (auto)'); } catch (e) {}
    }
}

async function readLoop(port) {
    const decoder = new TextDecoderStream();
    port.readable.pipeTo(decoder.writable).catch(() => {});
    const reader = decoder.readable.getReader();
    let buffer = '';
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line) parseLine(line);
        }
    }
}

function parseLine(line) {
    const p = line.split(',');
    if (p.length < 9) return;
    distance  = parseFloat(p[1]);
    tofStatus = parseInt(p[2]);
    ax = parseFloat(p[3]);
    ay = parseFloat(p[4]);
    az = parseFloat(p[5]);
    gx = parseFloat(p[6]);
    gy = parseFloat(p[7]);
    gz = parseFloat(p[8]);

    updateSidebar();
}

function updateSidebar() {
    const validDist = distance > 0 && tofStatus === 0;
    if (validDist) {
        const pct = Math.max(0, Math.min(1, distance / MAX_DISTANCE_MM));
        barFill.style.width = (pct * 100) + '%';
        barLabel.textContent = `Distance: ${distance} mm`;
    } else {
        barFill.style.width = '0%';
        barLabel.textContent = `Distance: — (status ${tofStatus})`;
    }
    imuReadout.textContent =
        `acc: ${ax.toFixed(2).padStart(6)} ${ay.toFixed(2).padStart(6)} ${az.toFixed(2).padStart(6)} g\n` +
        `gyr: ${gx.toFixed(1).padStart(6)} ${gy.toFixed(1).padStart(6)} ${gz.toFixed(1).padStart(6)} dps`;
}

// --- p5.js ---

function setup() {
    const c = createCanvas(600, 600, WEBGL);
    c.parent('canvas-container');
    tryAutoConnect();
}

function draw() {
    background(20);

    // Accelerometer-derived tilt (ignores yaw — no magnetometer).
    // pitch = nose up/down, roll = left/right bank
    const pitch = Math.atan2(ay, Math.sqrt(ax * ax + az * az));
    const roll  = Math.atan2(-ax, az);

    rotateX(pitch);
    rotateZ(roll);

    // normalMaterial colours each face by its surface normal — perfect for
    // making cube orientation obvious without setting up lights manually.
    noStroke();
    normalMaterial();
    box(150);
}
