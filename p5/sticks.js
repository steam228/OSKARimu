// Minimal alternative visualizer.
//   - black background
//   - white full-height bar; width = distance mapped against the wall, covering
//     from the left. The wall auto-calibrates "full width" (running max).
//   - the width is split into 20 slots on the vertical centre line. A slot
//     covered by white has no stick; uncovered slots show a stick.
//   - as white recedes (move back) sticks reveal right->left, one per slot.
//     The newest-revealed stick (at the white edge) rotates live with the
//     accelerometer; the instant the next one appears, the previous freezes.
//   - as white advances (move forward) sticks are covered/deleted left-first.
//   - press 'c' to return to index.html.
//
// Auto-reuses the serial port authorized in index.html (needs a stable origin
// like http://localhost, not file://).

const N_SLOTS = 20;

let distance = 0, tofStatus = 255;
let ax = 0, ay = 0, az = 1;
let maxDist = 1;          // running max == wall == full width
let serialBusy = false;

let slots = [];           // { visible, pitch, roll }
let liveIndex = -1;       // slot currently rotating live (the newest revealed)
let prevBarW = 0;

// ---------------- Serial ----------------
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
            if (line) parseLine(line);
        }
    }
    serialBusy = false;
}

function parseLine(line) {
    const p = line.split(',');
    if (p.length < 9) return;
    const d = parseFloat(p[1]);
    tofStatus = parseInt(p[2]);
    ax = parseFloat(p[3]);
    ay = parseFloat(p[4]);
    az = parseFloat(p[5]);
    if (tofStatus === 0 && d > 0) {
        distance = d;
        if (d > maxDist) maxDist = d;   // wall sets full-width reference
    }
}

// ---------------- p5 ----------------
function setup() {
    createCanvas(windowWidth, windowHeight, WEBGL);
    for (let i = 0; i < N_SLOTS; i++) slots.push({ visible: false, pitch: 0, roll: 0 });
    autoConnect();
}

function windowResized() { resizeCanvas(windowWidth, windowHeight); }

function mousePressed() { autoConnect(); }   // invisible reconnect retry

function keyPressed() {
    if (key === 'c' || key === 'C') window.location.href = 'index.html';
}

function draw() {
    background(0);

    const slotW = width / N_SLOTS;
    const frac  = constrain(distance / maxDist, 0, 1);
    const barW  = frac * width;                 // white covers [0, barW] from left

    // Live rotation from current accelerometer (pitch/roll, like the cube).
    const pitch = Math.atan2(ay, Math.sqrt(ax * ax + az * az));
    const roll  = Math.atan2(-ax, az);

    // Update slot visibility; snapshot rotation the moment a slot is revealed.
    for (let i = 0; i < N_SLOTS; i++) {
        const xc = (i + 0.5) * slotW;           // slot centre, screen space [0,width]
        const uncovered = xc >= barW;
        const s = slots[i];
        if (uncovered && !s.visible) {
            s.visible = true;
            s.pitch = pitch; s.roll = roll;      // pose at reveal
        } else if (!uncovered && s.visible) {
            s.visible = false;                   // covered -> deleted
            if (liveIndex === i) liveIndex = -1;
        }
    }

    // While receding (moving back), the live stick is the leftmost uncovered
    // (nearest the white edge = newest revealed). Switching it here freezes
    // whatever was live before, at the pose it had this instant.
    if (barW < prevBarW) {
        let lm = -1;
        for (let i = 0; i < N_SLOTS; i++) {
            if ((i + 0.5) * slotW >= barW) { lm = i; break; }
        }
        liveIndex = lm;
    }
    prevBarW = barW;

    // Live-update only the active stick; all other visible sticks stay frozen.
    if (liveIndex >= 0 && slots[liveIndex].visible) {
        slots[liveIndex].pitch = pitch;
        slots[liveIndex].roll  = roll;
    }

    // White distance bar (full height, left-anchored, z=0 fills the screen).
    push();
    noStroke();
    fill(255);
    translate(-width / 2 + barW / 2, 0, 0);
    plane(Math.max(barW, 0.0001), height);
    pop();

    // Sticks: parallelepipeds on the centre line, tilting with their pose.
    const base = height / 40;
    const tall = height / 7;
    for (let i = 0; i < N_SLOTS; i++) {
        const s = slots[i];
        if (!s.visible) continue;
        const xc = (i + 0.5) * slotW - width / 2;   // centred coords
        push();
        translate(xc, 0, 10);
        rotateX(s.pitch);
        rotateZ(s.roll);
        fill(255);
        stroke(0);
        strokeWeight(1.5);
        box(base, tall, base);
        pop();
    }
}
