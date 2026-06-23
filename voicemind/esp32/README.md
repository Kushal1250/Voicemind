# VoiceMind ESP32 Firmware

Arduino firmware for ESP32-based audio recording device.

## Hardware Requirements

- **ESP32 DevKit** (ESP32-WROOM-32 recommended)
- **INMP441 I2S Microphone**
- **Push Button** (optional, can use BOOT button)
- **LED** (optional, can use built-in LED)

## Wiring

```
ESP32          INMP441
------------------------
3.3V    ->     VDD
GND     ->     GND
GPIO2   ->     SCK  (BCLK)
GPIO15  ->     WS   (LRCK)
GPIO13  ->     SD   (DATA)

Button: GPIO0 (BOOT button)
LED:    GPIO2 (Built-in LED)
```

## Configuration

Edit `voicemind_esp32.ino`:

```cpp
// WiFi Credentials
const char* ssid = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";

// Backend API
const char* apiBaseUrl = "http://192.168.1.100:5000/api";
const char* deviceId = "vm_esp32_001";
```

## Features

- **20-Second Chunks**: Efficient upload strategy
- **WAV Format**: 16-bit, 16kHz, mono
- **Auto-Upload**: HTTP POST to backend
- **Heartbeat**: 10-second keepalive
- **LED Indicator**: Solid when recording
- **Start/Stop Button**: Toggle recording

## Setup

1. Install Arduino IDE
2. Add ESP32 board support:
   - File -> Preferences -> Additional Board URLs
   - Add: `https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json`
   - Tools -> Board -> Board Manager -> Search "ESP32" -> Install

3. Select board: `Tools -> Board -> ESP32 Arduino -> ESP32 Dev Module`

4. Upload sketch

## Serial Monitor

Baud rate: 115200

Output:
```
=== VoiceMind ESP32 Starting ===
SPIFFS initialized
Connecting to WiFi..... Connected!
IP: 192.168.1.XXX
I2S initialized
=== Setup Complete ===
Press BOOT button to start/stop recording
```

## Operation

1. **Power on**: Connects to WiFi, starts heartbeat
2. **Press BOOT**: LED turns on, recording starts
3. **Recording**: 20-second chunks uploaded automatically
4. **Press BOOT again**: LED turns off, recording stops

## Troubleshooting

**Won't connect to WiFi:**
- Check credentials
- Ensure 2.4GHz network (ESP32 doesn't support 5GHz)

**Upload fails:**
- Check backend URL is accessible
- Verify backend is running
- Check Serial Monitor for HTTP error codes

**No audio:**
- Check I2S wiring
- Verify INMP441 is getting 3.3V
- Try different GPIO pins

## Power Consumption

- Idle: ~80mA
- Recording: ~120mA
- WiFi transmit: ~200mA peak

Use a 500mA+ power supply for stable operation.
