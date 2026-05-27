#include <Arduino.h>
#include "WiFi.h"
#include "esp_now.h"

// Base ESP: receives ESP-NOW packets from the sensor and forwards the bytes
// verbatim to USB Serial. p5.js reads from this port over Web Serial.

#define ESPNOW_WIFI_CHANNEL  1   // must match sensor
#define NO_PMK_KEY           false

// Sensor's MAC (printed by sensor on boot). Not strictly required for the
// recv-side, but adding the peer is cheap and matches the wiki pattern.
// Update after first sensor flash if needed.
static uint8_t senderMac[6] = {0xCC, 0x8D, 0xA2, 0x0C, 0x57, 0x5C};   // placeholder

static esp_now_peer_info_t peerInfo;
static volatile uint32_t rx_count = 0;

// Recv callback — Arduino-ESP32 3.x signature
static void onRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
    (void)info;
    rx_count++;
    Serial.write(data, len);   // sensor already adds '\n'
}

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

void setup() {
    Serial.begin(115200);
    uint32_t t0 = millis();
    while (!Serial && millis() - t0 < 3000) delay(10);
    delay(200);
    Serial.println();
    Serial.println("=== base boot ===");
    Serial.flush();

    wifi_init_sta();

    if (esp_now_init() == ESP_OK) {
        Serial.println("ESP-NOW init OK");
    } else {
        Serial.println("ESP-NOW init FAILED");
        while (true) {
            Serial.println("...alive, ESP-NOW init failed");
            delay(1000);
        }
    }

    esp_now_register_recv_cb(onRecv);

    // Add the sender as a peer (wiki pattern). Optional for recv-only.
    Serial.println("Adding sender peer...");
    peerInfo.channel = ESPNOW_WIFI_CHANNEL;
    peerInfo.encrypt = NO_PMK_KEY;
    memcpy(peerInfo.peer_addr, senderMac, 6);
    esp_err_t r = esp_now_add_peer(&peerInfo);
    Serial.printf("Add peer: %s\n", r == ESP_OK ? "OK" : "FAIL");

    Serial.println("Listening for sensor packets...");
    Serial.flush();
}

void loop() {
    static uint32_t last = 0, beats = 0;
    if (millis() - last >= 1000) {
        last = millis();
        Serial.printf("base alive #%lu  rx_count=%lu\n",
                      (unsigned long)beats++, (unsigned long)rx_count);
        Serial.flush();
    }
    delay(10);
}
