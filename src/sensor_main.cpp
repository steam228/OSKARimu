#include <Arduino.h>
#include <Wire.h>
#include "WiFi.h"
#include "esp_now.h"
#include <vl53lx_class.h>
#include "BMI088.h"

// ---------------- Config ----------------
#define ESPNOW_WIFI_CHANNEL  1     // wiki uses 0; we use 1 to be explicit. Both ends must match.
#define NO_PMK_KEY           false

// Base receiver's MAC (printed by base on boot — "My MAC: ..."). Update if it differs.
static uint8_t baseMac[6] = {0x1C, 0xDB, 0xD4, 0x75, 0x36, 0xEC};

// ---------------- Sensors ----------------
// Xiao ESP32S3 + Grove Shield: I2C on D4/D5 (GPIO 5/6).
//   VL53L3CX: VCC->3V3, GND->GND, SDA->D4, SCL->D5, XSHUT->D2 (GPIO 3)
//   BMI088:   paralleled on the same I2C bus.
#define XSHUT_PIN 3
VL53LX tof(&Wire, XSHUT_PIN);
BMI088 imu(BMI088_ACC_ADDRESS, BMI088_GYRO_ADDRESS);
static bool tof_ok = false, imu_ok = false;

// ---------------- ESP-NOW state ----------------
static esp_now_peer_info_t peerInfo;
static volatile uint32_t tx_ok = 0, tx_fail = 0;

// ---------------- ESP-NOW callbacks ----------------
// Send status callback. The send callback kept the old (uint8_t *mac_addr)
// signature in Arduino-ESP32 3.x — only the recv callback got the new
// esp_now_recv_info_t form.
static void onSent(const uint8_t *mac_addr, esp_now_send_status_t status) {
    (void)mac_addr;
    if (status == ESP_NOW_SEND_SUCCESS) tx_ok++; else tx_fail++;
}

// ---------------- Setup helpers (wiki-style) ----------------
static void wifi_init_sta() {
    WiFi.mode(WIFI_STA);
    WiFi.setChannel(ESPNOW_WIFI_CHANNEL);
    uint8_t mac[6];
    while (!WiFi.STA.started()) {
        Serial.print(".");
        delay(100);
    }
    WiFi.macAddress(mac);
    Serial.println();
    Serial.printf("My MAC: %02x:%02x:%02x:%02x:%02x:%02x\n",
                  mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    Serial.printf("WiFi channel: %d\n", ESPNOW_WIFI_CHANNEL);
}

static void espnow_init_or_die() {
    if (esp_now_init() == ESP_OK) {
        Serial.println("ESP-NOW init OK");
    } else {
        Serial.println("ESP-NOW init FAILED");
        while (true) { delay(1000); }
    }
}

static void add_base_peer() {
    Serial.println("Adding base peer...");
    peerInfo.channel = ESPNOW_WIFI_CHANNEL;
    peerInfo.encrypt = NO_PMK_KEY;
    memcpy(peerInfo.peer_addr, baseMac, 6);
    esp_err_t r = esp_now_add_peer(&peerInfo);
    if (r != ESP_OK) {
        Serial.printf("Failed to add peer: %d\n", (int)r);
    } else {
        Serial.println("Peer added OK");
    }
}

// ---------------- I2C scan ----------------
static void scanI2C() {
    Serial.println("Scanning I2C bus...");
    int found = 0;
    for (uint8_t addr = 1; addr < 127; addr++) {
        Wire.beginTransmission(addr);
        if (Wire.endTransmission() == 0) {
            Serial.printf("  found 0x%02X\n", addr);
            found++;
        }
    }
    Serial.printf("Scan done, devices: %d\n", found);
}

// ---------------- Setup ----------------
void setup() {
    Serial.begin(115200);
    // Wait up to 3s for host to open the USB CDC port (otherwise prints fired
    // during the post-reset re-enumeration window get silently dropped).
    uint32_t t0 = millis();
    while (!Serial && millis() - t0 < 3000) delay(10);
    delay(200);
    Serial.println();
    Serial.println("=== sensor boot ===");

    // I2C + sensors
    Wire.setBufferSize(256);
    Wire.begin();
    Wire.setClock(400000);
    scanI2C();

    tof.begin();
    tof.VL53LX_Off();
    int s = tof.InitSensor(0x52);
    if (s == 0) {
        tof.VL53LX_StartMeasurement();
        tof_ok = true;
        Serial.println("VL53L3CX ready");
    } else {
        Serial.printf("VL53L3CX init failed (status=%d)\n", s);
    }

    // BMI088 — under battery power the accel chip's wake-from-suspend can
    // miss its initialize() command (slow LDO ramp / brief brown-out). Verify
    // by reading the accel chip ID (expected 0x1E) and retry if wrong.
    delay(100);                                         // let the rail settle on battery
    if (imu.isConnection()) {
        int tries = 0;
        uint8_t accId = 0;
        while (tries < 5) {
            imu.initialize();
            delay(60);                                  // accel needs ~50ms after power mode change
            accId = imu.getAccID();
            if (accId == 0x1E) break;
            Serial.printf("BMI088 accel wake retry %d (got id=0x%02X)\n", tries + 1, accId);
            tries++;
            delay(100);
        }
        if (accId == 0x1E) {
            imu_ok = true;
            Serial.println("BMI088 ready");
        } else {
            Serial.printf("BMI088 accel failed to wake (id=0x%02X) — gyro may still work\n", accId);
            imu_ok = true;   // keep going; gyro side is independent
        }
    } else {
        Serial.println("BMI088 not detected");
    }

    // ESP-NOW (wiki-style)
    wifi_init_sta();
    espnow_init_or_die();
    esp_now_register_send_cb(onSent);
    add_base_peer();
}

// ---------------- Loop ----------------
void loop() {
    int tof_status = 255;
    int tof_dist   = -1;
    if (tof_ok) {
        VL53LX_MultiRangingData_t ranging;
        uint8_t ready = 0;
        uint32_t t0 = millis();
        while (!ready) {
            tof.VL53LX_GetMeasurementDataReady(&ready);
            if (millis() - t0 > 500) break;
            delay(2);
        }
        if (ready && tof.VL53LX_GetMultiRangingData(&ranging) == 0
            && ranging.NumberOfObjectsFound > 0) {
            tof_status = ranging.RangeData[0].RangeStatus;
            tof_dist   = ranging.RangeData[0].RangeMilliMeter;
        }
        tof.VL53LX_ClearInterruptAndStartMeasurement();
    }

    float ax = 0, ay = 0, az = 0;
    float gx = 0, gy = 0, gz = 0;
    if (imu_ok) {
        imu.getAcceleration(&ax, &ay, &az);
        imu.getGyroscope(&gx, &gy, &gz);
    }

    // CSV: t_ms, dist_mm, tof_status, ax, ay, az, gx, gy, gz
    char line[160];
    int n = snprintf(line, sizeof(line),
        "%lu,%d,%d,%.3f,%.3f,%.3f,%.2f,%.2f,%.2f\n",
        (unsigned long)millis(),
        tof_dist, tof_status,
        ax, ay, az, gx, gy, gz);
    if (n < 0 || n >= (int)sizeof(line)) n = (int)sizeof(line) - 1;

    Serial.print(line);
    esp_err_t err = esp_now_send(baseMac, (const uint8_t*)line, (size_t)n);

    static uint32_t last_stat = 0;
    if (millis() - last_stat >= 2000) {
        last_stat = millis();
        Serial.printf("[esp-now] tx_ok=%lu tx_fail=%lu last_send_err=%d\n",
                      (unsigned long)tx_ok, (unsigned long)tx_fail, (int)err);
    }

    delay(50);
}
