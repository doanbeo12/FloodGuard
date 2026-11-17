#pragma once
// Fill locally; never commit real credentials.
#define WIFI_SSID_1 "YOUR_WIFI_1"
#define WIFI_PASS_1 "YOUR_PASSWORD_1"
#define WIFI_SSID_2 "YOUR_WIFI_2"
#define WIFI_PASS_2 "YOUR_PASSWORD_2"
#define NODE_AI_KEY "SET_PRIVATE_LOCAL_AI_KEY"
#define NODE_UPLOAD_KEY "SET_SAME_AS_RENDER_NODE1_UPLOAD_KEY"
#define NODE_UPLOAD_URL "https://floodguard-backend-4dua.onrender.com/api/node1/telemetry"
#define NODE_APN "m9-wintel" // From working Central v1.6.2; change if SIM is not Wintel
#define ENABLE_PUMPS 0
#define ENABLE_4G_UPLOAD 0 // Enable only after AT/HTTPS tests succeed
#define MOSFET_ACTIVE_HIGH 1
#define SIM_BAUD 9600 // MKE-M21 SIM7680C factory baud
#define SIM_RX 18
#define SIM_TX 19
#define I2C_SDA 21
#define I2C_SCL 22
#define BUCKET_PIN 27
#define WIND_PIN 26
#define RAIN_PLATE_PIN 25
#define JSN_TRIG 33
#define JSN_ECHO 34
#define PUMP_IN_PIN 23
#define PUMP_OUT_PIN 32
#define JSN_SENSOR_HEIGHT_CM 39.0f
#define MAX_WATER_CM 9.0f
#define MIN_WATER_CM 0.8f
#define AI_MIN_CONFIDENCE 0.60f
#define RAIN_STOP_MS 30000UL
#define AI_TIMEOUT_MS 10000UL
#define MAX_FILL_MS 60000UL
#define MAX_DRAIN_MS 90000UL
#define PUMP_DEADTIME_MS 1500UL

// Secure HTTPS: TLS 1.2, enable SNI for Render domain on SSL context 0.
#define SIM_SSL_CONTEXT 0
#define SIM_NETWORK_CHECK_MS 30000UL
#define SIM_REGISTER_WAIT_MS 20000UL
