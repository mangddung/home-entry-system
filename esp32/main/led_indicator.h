#pragma once
#include <stdint.h>

void led_indicator_init(void);
void led_set_color(uint8_t r, uint8_t g, uint8_t b);
void led_off(void);

// Convenience helpers matching ESPHome script names
void led_idle_blink_start(void);   // blue 0.3 blink indefinitely
void led_notify_success(void);     // green 0.3 for 2 s then idle
void led_notify_fail(void);        // red 0.3 blink 2 s then idle

// IoT init result indicators
void led_init_ok(void);            // stop blink, LED off
void led_init_fail(void);          // stop blink, solid red (persistent)

// BLE connected (setup mode)
void led_ble_connected(void);      // stop blink, solid blue

// WiFi connecting (normal mode, before IP acquired)
void led_wifi_connecting(void);    // yellow 0.5 s blink indefinitely

// Reset flow helpers (called before factory reset – no need to clean up)
void led_reset_ok(void);           // stop blink, solid green (reset proceeds)
