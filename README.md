# OskarToF

Wearable / installation prototype: a sensor node on the body streams distance
+ inertial data over **ESP-NOW** to a base station, which forwards the data
over USB to a browser. The browser runs a small family of **p5.js** sketches
that consume the stream (and webcam pose) and render four different
visualizations.

```
┌──────────────────────────┐    ┌────────────────────┐    ┌─────────────────┐
│  SENSOR NODE             │    │  BASE NODE         │    │  BROWSER        │
│  Xiao ESP32-S3           │    │  Xiao ESP32-S3     │    │  Chrome / Edge  │
│  + VL53L3CX (ToF)        │ →  │  USB-CDC bridge    │ →  │  Web Serial +   │
│  + BMI088   (6-axis IMU) │    │  ESP-NOW receiver  │    │  ml5.js / p5.js │
│  ESP-NOW transmitter     │    │                    │    │                 │
└──────────────────────────┘    └────────────────────┘    └─────────────────┘
        ▲                              │                          │
        │ I²C (D4 / D5)                │ /dev/cu.usbmodem…        │ http://localhost:8000
        │ XSHUT D2                     │ 115200 baud              │
        │                              │                          │
   3.7 V LiPo or USB             USB to computer             5 sketches
```

---

## Repository layout

```
OskarToF/
├── platformio.ini          # two PlatformIO envs: sensor + base
├── src/
│   ├── sensor_main.cpp     # sensor firmware (ToF + IMU + ESP-NOW tx)
│   └── base_main.cpp       # base firmware (ESP-NOW rx + USB serial bridge)
└── p5/
    ├── index.html          # menu + main "cube" visualizer
    ├── sketch.js
    ├── sticks.html         # 20-slot stick field driven by distance
    ├── sticks.js
    ├── pose.html           # pseudo-3D body skeleton (ml5 bodyPose)
    ├── pose.js
    ├── experience.html     # fork of pose with IMU + ToF markers
    └── experience.js
```

---

## Hardware

| Role   | Board                      | Sensors / shield                                     |
|--------|----------------------------|------------------------------------------------------|
| Sensor | Seeed Xiao ESP32-S3        | Grove Shield for XIAO + DFRobot SEN0378 (VL53L3CX) + Seeed Grove BMI088 |
| Base   | Seeed Xiao ESP32-S3        | none — plugged into computer's USB only              |

### Wiring (sensor side)

All three I²C peripherals share the same bus.

| Pin on Xiao | Goes to                                       |
|-------------|-----------------------------------------------|
| D4 (GPIO 5) | SDA — VL53L3CX + BMI088                       |
| D5 (GPIO 6) | SCL — VL53L3CX + BMI088                       |
| D2 (GPIO 3) | XSHUT on VL53L3CX (software reset on boot)    |
| 3V3         | VCC on both modules                           |
| GND         | GND on both modules                           |
| BAT+ / BAT- | Optional LiPo for untethered operation        |

I²C addresses (read at boot via the firmware's scan):

```
0x19  BMI088 accelerometer
0x29  VL53L3CX time-of-flight
0x69  BMI088 gyroscope
```

If the boot scan shows fewer than three devices, one of the modules has come
loose; the "Troubleshooting" section below covers what to look at.

---

## Firmware

Two firmwares live in one project; PlatformIO selects between them with `-e`.

### Build / flash

```sh
cd ~/Documents/OskarToF

# pick whichever node is plugged in
ls /dev/cu.usbmodem*

pio run -e sensor -t upload --upload-port /dev/cu.usbmodemXXXX
pio run -e base   -t upload --upload-port /dev/cu.usbmodemYYYY
```

The two boards are physically identical Xiao ESP32-S3s — the firmware is what
makes one the sensor and the other the base. Mark them with tape so you don't
mix them up. If a board refuses to enter upload mode, do the **B + R dance**:
hold the BOOT button, tap RESET, release BOOT — the board now appears as a
bootloader port and `pio run … -t upload` will land.

### Sensor firmware ([src/sensor_main.cpp](src/sensor_main.cpp))

- Initializes the VL53L3CX (with `Wire.setBufferSize(256)` before `Wire.begin()`
  — required on Arduino-ESP32 or the >128 B calibration upload silently
  truncates and the laser never fires).
- Initializes the BMI088, with a verify-and-retry loop on the accel chip ID
  (`0x1E`) to survive battery-only brown-outs that drop the wake command.
- Sends a CSV line every 50 ms over ESP-NOW **unicast** to the base:
  ```
  t_ms, dist_mm, tof_status, ax, ay, az, gx, gy, gz
  ```
- Prints the same line to its own USB serial (useful for local debugging when
  the base isn't connected).
- ESP-NOW health prints every 2 s: `tx_ok / tx_fail / last_send_err`.

### Base firmware ([src/base_main.cpp](src/base_main.cpp))

- Receives ESP-NOW packets and writes their bytes verbatim to USB serial at
  115 200 baud.
- Prints a heartbeat `base alive #N rx_count=…` every second so you can see
  it's alive even when no packets are arriving.

### The Arduino-ESP32 3.x requirement

Both firmwares depend on **Arduino-ESP32 3.x APIs** (`WiFi.setChannel`,
`WiFi.STA.started`, the new `esp_now_recv_info_t *` callback signature) which
match the official Seeed XIAO ESP-NOW wiki. The standard PlatformIO
`espressif32` platform is stuck on Arduino-ESP32 2.0.x. We use the
community-maintained **pioarduino** fork — already configured in
`platformio.ini`:

```ini
platform = https://github.com/pioarduino/platform-espressif32/releases/download/53.03.13/platform-espressif32.zip
```

### ESP-NOW pairing

The sensor sends **unicast** to a hard-coded base MAC address in
[`sensor_main.cpp`](src/sensor_main.cpp). If you swap base boards, look for
`My MAC:` in the base's boot output, then update the `baseMac` array at the
top of `sensor_main.cpp` and re-flash the sensor.

Both nodes pin themselves to **WiFi channel 1** via `WiFi.setChannel(1)`. Both
sides must agree on the channel — that's a single constant in each sketch.

---

## Browser side (p5.js)

### Run the local server

Web Serial port permissions are bound to the page's **origin**, and they only
persist across page navigations if the origin is stable. `file://` is not — it
treats every file as a fresh origin. The visualizers are designed so
`pose.html`, `sticks.html`, and `experience.html` silently reuse the serial
port you authorized once on `index.html`, which only works if you serve the
folder over a real `http(s)` URL.

Easiest is Python's built-in server:

```sh
cd ~/Documents/OskarToF/p5
python3 -m http.server 8000
```

Then open Chrome or Edge at:

```
http://localhost:8000/index.html
```

Firefox and Safari do **not** support Web Serial.

### Connection flow

1. Plug the base into your Mac's USB. Close any `pio device monitor` that has
   the port open — only one program at a time can hold a serial port.
2. Open `http://localhost:8000/index.html` in Chrome.
3. Click **Connect to base** in the sidebar; a native picker appears; choose
   the `/dev/cu.usbmodemXXXX` entry. The status flips to `connected`, the
   distance bar starts moving, and the 3D cube starts tilting.
4. Click any other sketch link in the sidebar — they auto-reconnect to the
   same port via `navigator.serial.getPorts()`. No second click required.

If the sensor node isn't powered, the base will still appear connected — you
just won't see any sensor data flowing. Power the sensor too (USB or LiPo).

---

## The four visualizers (the "experiences")

Each page starts with a black background and is keyboard-navigable. `c` always
sends you back to `index.html`.

### 1. `index.html` — Distance + 3D cube ([sketch.js](p5/sketch.js))

The main / debug view. Sidebar shows:
- a **Connect to base** button and connection status
- a **distance bar** (0 – 2000 mm) that lights up red→yellow→green
- a **monospace readout** of accel and gyro raw values
- links to the other sketches

The main canvas holds a **3D cube** (`normalMaterial`, so each face is
colour-coded by its surface normal) that tilts with the accelerometer's
pitch/roll. This is the proof-of-life view — if data flows here, the rest of
the pipeline is healthy.

### 2. `sticks.html` — Stick field ([sticks.js](p5/sticks.js))

A purely-distance interaction. Black background. A white full-height bar grows
**from the left as the measured distance decreases** (white = "covered by
your hand"). The screen width is divided into **20 fixed slots** on the
vertical centre line.

- When white **covers** a slot → the stick at that slot is deleted.
- When white **recedes** past a slot → a thin white parallelepiped stick is
  planted there. Each stick has base `height/40 × height/40` and height
  `height/7`.
- Only the **newest-revealed** stick (the one at the white edge) tilts live
  with the accelerometer; the moment the next one is revealed, the previous
  one freezes at the pose it had then.

Auto-calibrates: the running max of valid distance readings becomes the "wall"
that defines full white.

### 3. `pose.html` — 3D body skeleton ([pose.js](p5/pose.js))

ml5.js bodyPose (MoveNet) running on the webcam, drawn as a **pseudo-3D
skeleton** in WEBGL. Keypoints are white cubes, connections are thin white
lines. The trick: each frame, three globals are derived from the 2D
keypoints so the figure rotates believably in depth without a depth camera.

- **`cx`** centerline: mean x of shoulders (+ hips when confident)
- **`yaw`**: from foreshortening of the projected shoulder span (`acos` of
  `span / maxShoulderSpan`); sign from nose-x vs `cx` with ears as fallback
- **`globalZ`**: closer face = wider eye spacing; relative to a baseline
  captured on first detection

Per-joint Z is then `(x_joint - cx) * sin(yaw) + globalZ`, with an optional
`UNFORESHORTEN` flag (off by default) that divides by `cos(yaw)` first.

Keys:

| Key | Action                                                           |
|-----|------------------------------------------------------------------|
| `c` | Return to index                                                  |
| `r` | Recalibrate the frontal pose (clear `maxShoulderW` + eye baseline)|
| `o` | Toggle `orbitControl()` to inspect the reconstructed depth        |
| `m` | Toggle mirror (front-projection ↔ back-projection)               |
| `f` | Toggle fullscreen kiosk mode                                     |

Tunables at the top of `pose.js`: `CUBE`, `LINE_W`, `DEPTH_SCALE`, `SMOOTH`,
`CONF`, `SIGN`, `UNFORESHORTEN`.

### 4. `experience.html` — Pose + IMU + ToF ([experience.js](p5/experience.js))

A **fork of `pose.html`** that brings in the sensor stream and starts
integrating the two worlds.

In addition to everything `pose.html` does:

- **Auto-reconnects** to the serial port (assumes you already authorized it
  via `index.html`).
- Parses the same CSV into a `sensor` object: `{ t, distance, tofStatus, ax,
  ay, az, gx, gy, gz }`. **Not yet used to drive visuals** — just plumbed in.
- Renders **two extra "imaginary" dots** on the body, slightly bigger than
  the keypoint cubes:
  - **IMU dot** — placed *behind* the neck (midpoint of shoulders, offset
    along the body-plane back-normal `(-sin(yaw), 0, -cos(yaw))` by
    `BEHIND_OFFSET` WEBGL units).
  - **Distance-sensor dot** — placed at the right shoulder keypoint.
- Every 30 frames, **logs a tilt comparison to the browser console** so we
  can check whether the IMU's measured pitch/roll agrees with the pose-derived
  shoulder roll:
  ```
  imu pitch=  -2.3°  roll=  87.1°  | pose yaw=  12.4°  shoulder_roll=   1.8°  | dist=215mm  tofStatus=0
  ```

Same keys as `pose.html` (`c r o m f`). Tunable list adds `SENSOR_CUBE` and
`BEHIND_OFFSET`.

---

## Troubleshooting

We hit pretty much all of these during development; symptoms and fixes:

| Symptom                                                                | Cause                                                                                          | Fix                                                                                                                  |
|------------------------------------------------------------------------|------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------|
| Browser sees `/dev/cu.usbmodem…` in picker but the sensor data is zero  | Base is connected but sensor node isn't powered or out of range                                | Power the sensor (USB or LiPo). Watch `tx_ok`/`tx_fail` in the sensor monitor.                                       |
| Picker doesn't list any port                                            | Power-only USB cable, base not plugged in, or `pio device monitor` is holding the port         | Swap cable. Plug base in. `Ctrl+C` any open monitor session.                                                          |
| `imu pitch=0 roll=0` always, but distance reads fine                    | BMI088 accel chip ACKs at `0x19` but is stuck in suspend — happens on battery brown-outs       | The firmware now verifies `getAccID() == 0x1E` after init and retries up to 5×. If still failing, see below.         |
| I²C scan shows only `0x29` (or only `0x19 / 0x69`)                      | One module physically off the bus                                                              | Reseat the Grove / Dupont connections. Check VCC and GND continuity on the missing module.                            |
| Base monitor shows only heartbeats, no CSV                              | Channel mismatch or sender not transmitting                                                    | Both nodes pin channel 1; check `My MAC` printed by base matches `baseMac` in `sensor_main.cpp`.                      |
| Serial monitor shows nothing after reset                                | macOS USB-CDC re-enumerates slowly; boot prints fired before host reattached                   | Both firmwares wait up to 3 s for `Serial` to come up before printing. If still nothing, press R **with monitor open**. |
| Web Serial shows blocklist warnings about a Bluetooth mouse             | Unrelated Chrome security filter                                                                | Ignore. Your ESP `/dev/cu.usbmodem…` is unaffected.                                                                  |
| Other sketches don't auto-reconnect to the serial port                  | Opened via `file://` instead of `http://localhost:8000`                                        | Serve via `python3 -m http.server 8000`. Serial permissions only persist per-origin.                                  |
| `pio run` reports `package-postinstall.py` not found                    | One-off pioarduino install glitch                                                              | Re-run the command; it usually completes the second time.                                                            |

### Hardware-side fix for stubborn battery brown-outs

If the firmware retry isn't enough on a tired LiPo, solder a **10–100 µF
ceramic cap across the BMI088 module's VCC and GND** right at the module.
This buffers the brief voltage dip when WiFi TX fires and is usually the
final piece for reliable battery operation.

---

## Project history (one-paragraph)

This started as a single PlatformIO project to talk to a VL53L3CX over I²C
from a Xiao ESP32-S3. Along the way: we discovered the
`Wire.setBufferSize(256)` requirement (otherwise the sensor's calibration
upload truncates silently), worked out the right Grove pin mapping on the
Xiao shield, added the BMI088 IMU in parallel on the same bus, replaced a
dead VL53L3CX module, set up a second Xiao as an ESP-NOW base instead of an
Arduino UNO R4 (which can't speak ESP-NOW), spent a debugging afternoon on a
channel mismatch that only resolved when we switched from the standard
PlatformIO `espressif32` platform to the pioarduino fork (which gives us
Arduino-ESP32 3.x and lets us match the Seeed wiki examples verbatim), built
the four browser sketches above with Web Serial auto-reconnect, and finally
hardened the BMI088 init against battery brown-outs. Everything that hurt
the first time is captured in either firmware retries or a row of the
troubleshooting table above.
