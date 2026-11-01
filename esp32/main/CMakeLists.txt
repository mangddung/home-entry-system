set(srcs
    "main.c"
    "device_config.c"
    "led_indicator.c"
    "servo_motor.c"
    "ble_server.c"
)
set(reqs
    nvs_flash
    esp_event
    bt
    esp_driver_gpio
    esp_driver_ledc
    esp_timer
    led_strip
    espressif__cjson
    mbedtls
)

# 모델별 transport (Kconfig DOORLOCK_TRANSPORT_*)
if(CONFIG_DOORLOCK_TRANSPORT_ZIGBEE)
    list(APPEND srcs "transport_zigbee.c")
    list(APPEND reqs espressif__esp-zigbee-lib)
else()
    list(APPEND srcs "transport_wifi.c" "http_api.c")
    list(APPEND reqs esp_wifi esp_netif esp_http_client)
endif()

idf_component_register(
    SRCS ${srcs}
    INCLUDE_DIRS "."
    REQUIRES ${reqs}
)
