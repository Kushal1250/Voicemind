/*
esp32/ESP32.ino - VoiceMind ESP32 Firmware
*/

/*
  VoiceMind ESP32 Firmware - Stable Version v2.8

  Main fixes in this version:
  - ADDED: remote command polling from backend
  - ADDED: website can start ESP32 hardware recording
  - ADDED: website can stop ESP32 hardware recording
  - FIXED: stop button during recording uploads partial chunk
  - FIXED: endMeeting() is called correctly
  - FIXED: recording no longer gets stuck in "recording" state on backend
  - IMPROVED: safer stop flow and backend sync
*/

#include <driver/i2s.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <SPIFFS.h>
#include <ArduinoJson.h>

// ==================== CONFIGURATION ====================
// IMPORTANT: use ONLY 2.4 GHz Wi-Fi with ESP32
const char* ssid = "C_40_2.5";
const char* password = "10110809";
const char* apiBaseUrl = "http://192.168.1.11:5000/api";
const char* deviceId = "vm_esp32_001";
const char* firmwareVersion = "2.8.0";

// I2S pins
#define I2S_WS   25
#define I2S_SD   32
#define I2S_SCK  33
#define I2S_PORT I2S_NUM_0

// Controls
#define BUTTON_PIN 4
#define LED_PIN 2

// Audio settings
#define I2S_SAMPLE_RATE 16000
#define I2S_SAMPLE_BITS 16
#define I2S_READ_LEN 1024
#define I2S_CHANNEL_NUM 1

// Chunk duration
#define MAX_CHUNK_DURATION_SEC 5
#define MIN_CHUNK_DURATION_SEC 3
int currentChunkDuration = MAX_CHUNK_DURATION_SEC;

// Safety margins
#define SPIFFS_MIN_FREE_BYTES 50000
#define MAX_CHUNK_RETRIES 3
#define MAX_TOTAL_CHUNKS 100
#define UPLOAD_TIMEOUT_MS 30000
#define MIN_FREE_HEAP_BYTES 50000
#define BUFFER_HEADROOM_BYTES 10000

// WiFi reconnection timing
#define WIFI_RECONNECT_INTERVAL 15000UL
#define WIFI_CONNECT_TIMEOUT 20000UL
#define INITIAL_WIFI_WAIT_MS 15000UL

// ==================== GLOBAL STATE ====================

bool isRecording = false;
bool buttonPressed = false;
bool stopRequestedDuringChunk = false;
bool recordingChunkInProgress = false;

unsigned long lastDebounceTime = 0;
const unsigned long debounceDelay = 200;

unsigned long lastHeartbeatTime = 0;
const unsigned long heartbeatInterval = 10000;

// NEW: remote command polling
unsigned long lastCommandPollTime = 0;
const unsigned long commandPollInterval = 1000;

String currentMeetingId = "";
String pendingRemoteMeetingId = "";
String pendingRemoteTitle = "";
String pendingRemoteLanguage = "en";

int chunkIndex = 0;
int chunkRetryCount = 0;
bool criticalError = false;
bool psramAvailable = false;

volatile bool wifiConnected = false;
volatile bool wifiConnecting = false;
bool wifiEverConnected = false;
unsigned long lastReconnectAttempt = 0;
unsigned long connectStartTime = 0;
unsigned long lastWiFiLog = 0;

uint8_t* audioBuffer = NULL;
size_t audioBufferSize = 0;
size_t maxAudioDataSize = 0;

// ==================== FORWARD DECLARATIONS ====================

void sendHeartbeat();
bool createMeeting();
void startRecording();
void stopRecording();
bool endMeeting();
bool checkBackendHealth();
void printSystemSummary();
void printMeetingStartSummary();
bool sendHeartbeatWithStatus();
bool uploadChunkFromBuffer(uint8_t* buffer, size_t bufferSize, int idx, int durationSec);
void recordAndUploadChunk();
void handleChunkFailure();
void cleanupAllChunks();

// NEW: remote command handlers
bool pollDeviceCommand();
bool ackDeviceCommand(const String& command, const String& status, const String& meetingId, const String& message);
void startRecordingRemote(const String& meetingId, const String& title, const String& language);
bool pollDeviceCommandIfDue(bool force = false);

// ==================== HELPERS ====================

const char* disconnectReasonToText(uint8_t reason) {
  switch (reason) {
    case 2: return "AUTH_EXPIRE";
    case 4: return "ASSOC_TIMEOUT / INACTIVITY";
    case 8: return "ASSOC_LEAVE";
    case 15: return "4-WAY HANDSHAKE TIMEOUT";
    case 200: return "BEACON_TIMEOUT";
    case 201: return "NO_AP_FOUND";
    case 202: return "AUTH_FAIL";
    case 204: return "HANDSHAKE_TIMEOUT";
    default: return "UNKNOWN";
  }
}

bool isWiFiReady() {
  return wifiConnected &&
         WiFi.status() == WL_CONNECTED &&
         WiFi.localIP() != IPAddress(0, 0, 0, 0);
}

void blinkLED(int times, int delayMs) {
  for (int i = 0; i < times; i++) {
    digitalWrite(LED_PIN, HIGH);
    delay(delayMs);
    digitalWrite(LED_PIN, LOW);
    delay(delayMs);
  }
}

void fatalError(int code) {
  Serial.printf("FATAL ERROR %d - Halting\n", code);
  while (true) {
    blinkLED(code, 200);
    delay(1000);
  }
}

// ==================== STATUS / SUMMARY ====================

void printDivider() {
  Serial.println("--------------------------------------------------");
}

void printSystemSummary() {
  printDivider();
  Serial.println("VOICE MIND SYSTEM STATUS");
  printDivider();
  Serial.printf("Firmware Version    : %s\n", firmwareVersion);
  Serial.printf("Device ID           : %s\n", deviceId);
  Serial.printf("WiFi Name (SSID)    : %s\n", ssid);
  Serial.printf("WiFi Connected      : %s\n", isWiFiReady() ? "YES" : "NO");
  Serial.printf("IP Address          : %s\n", isWiFiReady() ? WiFi.localIP().toString().c_str() : "Not connected");
  Serial.printf("Signal RSSI         : %s\n", isWiFiReady() ? String(WiFi.RSSI()).c_str() : "N/A");
  Serial.printf("API Base URL        : %s\n", apiBaseUrl);
  Serial.printf("Chunk Duration      : %d sec\n", currentChunkDuration);
  Serial.printf("PSRAM Available     : %s\n", psramAvailable ? "YES" : "NO");
  Serial.printf("Free Heap           : %u bytes\n", (unsigned int)ESP.getFreeHeap());
  Serial.printf("Min Free Heap       : %u bytes\n", (unsigned int)ESP.getMinFreeHeap());
  Serial.printf("Free SPIFFS         : %u bytes\n", (unsigned int)(SPIFFS.totalBytes() - SPIFFS.usedBytes()));
  Serial.printf("Audio Buffer Size   : %u bytes\n", (unsigned int)audioBufferSize);
  printDivider();
}

void printMeetingStartSummary() {
  printDivider();
  Serial.println("MEETING START STATUS");
  printDivider();
  Serial.printf("Meeting Created     : %s\n", currentMeetingId.length() > 0 ? "YES" : "NO");
  Serial.printf("Meeting ID          : %s\n", currentMeetingId.length() > 0 ? currentMeetingId.c_str() : "N/A");
  Serial.printf("Device ID           : %s\n", deviceId);
  Serial.printf("Firmware            : %s\n", firmwareVersion);
  Serial.printf("WiFi Connected      : %s\n", isWiFiReady() ? "YES" : "NO");
  Serial.printf("SSID                : %s\n", ssid);
  Serial.printf("IP Address          : %s\n", isWiFiReady() ? WiFi.localIP().toString().c_str() : "Not connected");
  Serial.printf("RSSI                : %s\n", isWiFiReady() ? String(WiFi.RSSI()).c_str() : "N/A");
  Serial.printf("API Server          : %s\n", apiBaseUrl);
  Serial.printf("Chunk Duration      : %d sec\n", currentChunkDuration);
  Serial.printf("Free Heap           : %u bytes\n", (unsigned int)ESP.getFreeHeap());
  Serial.printf("Free SPIFFS         : %u bytes\n", (unsigned int)(SPIFFS.totalBytes() - SPIFFS.usedBytes()));
  Serial.printf("PSRAM               : %s\n", psramAvailable ? "YES" : "NO");
  printDivider();
}

// ==================== STORAGE ====================

void printStorageInfo() {
  size_t total = SPIFFS.totalBytes();
  size_t used = SPIFFS.usedBytes();
  size_t freeBytes = total - used;

  Serial.printf("SPIFFS: %u/%u used (%u free, %u%% available)\n",
                (unsigned int)used,
                (unsigned int)total,
                (unsigned int)freeBytes,
                total > 0 ? (unsigned int)((freeBytes * 100) / total) : 0);

  if (psramAvailable) {
    Serial.printf("PSRAM: %u free\n", (unsigned int)ESP.getFreePsram());
  }

  Serial.printf("Heap: %u free (min: %u)\n",
                (unsigned int)ESP.getFreeHeap(),
                (unsigned int)ESP.getMinFreeHeap());

  if (audioBuffer) {
    Serial.printf("Audio buffer: %u bytes\n", (unsigned int)audioBufferSize);
  }
}

void cleanupAllChunks() {
  Serial.println("Cleaning up chunks...");

  File root = SPIFFS.open("/");
  if (!root) return;

  int removed = 0;
  File file = root.openNextFile();

  while (file) {
    String filename = file.name();
    file.close();

    if (filename.startsWith("/chunk_") && filename.endsWith(".wav")) {
      if (SPIFFS.remove(filename)) {
        removed++;
      }
    }

    file = root.openNextFile();
  }

  if (removed > 0) {
    Serial.printf("Removed %d chunk files\n", removed);
  }
}

// ==================== MEMORY ====================

bool allocateAudioBuffer() {
  size_t requiredSize = I2S_SAMPLE_RATE * (I2S_SAMPLE_BITS / 8) * currentChunkDuration + 44;
  size_t allocSize = requiredSize + BUFFER_HEADROOM_BYTES;

  Serial.printf("Attempting to allocate %u bytes (duration: %ds)...\n",
                (unsigned int)allocSize, currentChunkDuration);

  if (psramAvailable) {
    audioBuffer = (uint8_t*)ps_malloc(allocSize);
    if (audioBuffer) {
      Serial.println("✅ Buffer allocated in PSRAM");
      audioBufferSize = allocSize;
      maxAudioDataSize = allocSize - 44;
      return true;
    }
    Serial.println("⚠️ PSRAM allocation failed, trying RAM...");
  }

  size_t freeHeap = ESP.getFreeHeap();
  Serial.printf("Free heap: %u bytes\n", (unsigned int)freeHeap);

  if (freeHeap < (allocSize + MIN_FREE_HEAP_BYTES)) {
    Serial.println("⚠️ Not enough heap for default chunk size, reducing duration...");

    for (int tryDuration = currentChunkDuration - 1; tryDuration >= MIN_CHUNK_DURATION_SEC; tryDuration--) {
      size_t trySize = I2S_SAMPLE_RATE * (I2S_SAMPLE_BITS / 8) * tryDuration + 44 + BUFFER_HEADROOM_BYTES;
      if (freeHeap >= (trySize + MIN_FREE_HEAP_BYTES)) {
        currentChunkDuration = tryDuration;
        allocSize = trySize;
        Serial.printf("Adjusted chunk duration to %ds (%u bytes)\n",
                      currentChunkDuration, (unsigned int)allocSize);
        break;
      }
    }
  }

  audioBuffer = (uint8_t*)malloc(allocSize);

  if (!audioBuffer) {
    allocSize = I2S_SAMPLE_RATE * (I2S_SAMPLE_BITS / 8) * MIN_CHUNK_DURATION_SEC + 44 + BUFFER_HEADROOM_BYTES;
    Serial.printf("Emergency allocation attempt: %u bytes\n", (unsigned int)allocSize);
    audioBuffer = (uint8_t*)malloc(allocSize);
    currentChunkDuration = MIN_CHUNK_DURATION_SEC;
  }

  if (!audioBuffer) return false;

  audioBufferSize = allocSize;
  maxAudioDataSize = allocSize - 44;
  Serial.printf("✅ Audio buffer allocated: %u bytes at %p\n",
                (unsigned int)audioBufferSize, audioBuffer);
  return true;
}

// ==================== WIFI ====================

void WiFiStationConnected(WiFiEvent_t event, WiFiEventInfo_t info) {
  Serial.println("✅ Connected to WiFi access point successfully");
}

void WiFiGotIP(WiFiEvent_t event, WiFiEventInfo_t info) {
  wifiConnected = true;
  wifiConnecting = false;
  wifiEverConnected = true;

  Serial.println("\n✅ WiFi connection successful");
  Serial.printf("WiFi Name (SSID)    : %s\n", ssid);
  Serial.printf("IP Address          : %s\n", WiFi.localIP().toString().c_str());
  Serial.printf("Signal RSSI         : %d dBm\n", WiFi.RSSI());
  Serial.printf("Device ID           : %s\n", deviceId);
  Serial.printf("API Base URL        : %s\n", apiBaseUrl);

  bool backendOk = checkBackendHealth();
  Serial.printf("Backend/API Check   : %s\n", backendOk ? "SUCCESS" : "FAILED");

  bool hbOk = sendHeartbeatWithStatus();
  Serial.printf("Heartbeat Status    : %s\n", hbOk ? "SUCCESS" : "FAILED");

  lastHeartbeatTime = millis();
  blinkLED(3, 100);
  printDivider();
}

void WiFiStationDisconnected(WiFiEvent_t event, WiFiEventInfo_t info) {
  wifiConnected = false;
  wifiConnecting = false;

  uint8_t reason = info.wifi_sta_disconnected.reason;
  Serial.println("❌ Disconnected from WiFi access point");
  Serial.printf("Reason: %u (%s)\n", reason, disconnectReasonToText(reason));

  if (reason == 15 || reason == 204) {
    Serial.println("👉 Check password, hotspot security mode, signal strength, and use 2.4 GHz.");
  }

  if (reason == 8) {
    Serial.println("👉 AP or station ended association. Often due to reconnects or unstable Wi-Fi.");
  }
}

void setupWiFiEvents() {
  WiFi.onEvent(WiFiStationConnected, WiFiEvent_t::ARDUINO_EVENT_WIFI_STA_CONNECTED);
  WiFi.onEvent(WiFiGotIP, WiFiEvent_t::ARDUINO_EVENT_WIFI_STA_GOT_IP);
  WiFi.onEvent(WiFiStationDisconnected, WiFiEvent_t::ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
}

void startWiFiConnection(bool forceRestart = false) {
  if (wifiConnecting) return;

  if (forceRestart) {
    WiFi.disconnect(false, false);
    delay(300);
  }

  Serial.printf("Connecting to WiFi SSID: %s\n", ssid);
  wifiConnecting = true;
  connectStartTime = millis();
  WiFi.begin(ssid, password);
}

void initWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);

  if (String(ssid).indexOf("5GHz") >= 0 || String(ssid).indexOf("5GHZ") >= 0) {
    Serial.println("⚠️ WARNING: SSID name suggests 5 GHz. Standard ESP32 supports only 2.4 GHz.");
  }

  startWiFiConnection(false);
}

void waitForInitialWiFi(unsigned long timeoutMs) {
  unsigned long start = millis();
  while (!isWiFiReady() && (millis() - start < timeoutMs)) {
    if (wifiConnecting && millis() - connectStartTime > WIFI_CONNECT_TIMEOUT) {
      Serial.println("Initial WiFi connection timeout, retrying...");
      wifiConnecting = false;
      startWiFiConnection(true);
    }
    delay(100);
  }
}

void manageWiFiConnection() {
  if (isWiFiReady()) return;

  if (wifiConnecting) {
    if (millis() - connectStartTime > WIFI_CONNECT_TIMEOUT) {
      Serial.println("❌ WiFi connection timeout");
      wifiConnecting = false;
      lastReconnectAttempt = millis();
      WiFi.disconnect(false, false);
    }
    return;
  }

  unsigned long now = millis();
  if (now - lastReconnectAttempt >= WIFI_RECONNECT_INTERVAL) {
    lastReconnectAttempt = now;
    Serial.println("Attempting WiFi reconnect...");
    startWiFiConnection(true);
  }

  if (now - lastWiFiLog > 5000) {
    lastWiFiLog = now;
    Serial.printf("WiFi status: %d, connected=%s, connecting=%s\n",
                  WiFi.status(),
                  wifiConnected ? "true" : "false",
                  wifiConnecting ? "true" : "false");
  }
}

// ==================== I2S ====================

void i2sInit() {
  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = I2S_SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_I2S_MSB,
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 4,
    .dma_buf_len = 512,
    .use_apll = false,
    .tx_desc_auto_clear = false,
    .fixed_mclk = 0
  };

  esp_err_t err = i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL);
  if (err != ESP_OK) {
    Serial.printf("❌ I2S driver install failed: %d\n", err);
    fatalError(2);
  }

  const i2s_pin_config_t pin_config = {
    .bck_io_num = I2S_SCK,
    .ws_io_num = I2S_WS,
    .data_out_num = I2S_PIN_NO_CHANGE,
    .data_in_num = I2S_SD
  };

  err = i2s_set_pin(I2S_PORT, &pin_config);
  if (err != ESP_OK) {
    Serial.printf("❌ I2S set pin failed: %d\n", err);
    fatalError(3);
  }

  i2s_zero_dma_buffer(I2S_PORT);
  Serial.println("✅ I2S initialized");
}

// ==================== WAV ====================

void writeWavHeaderToBuffer(uint8_t* header, size_t wavDataSize) {
  uint32_t fileSize = wavDataSize + 36;
  uint32_t byteRate = I2S_SAMPLE_RATE * I2S_CHANNEL_NUM * (I2S_SAMPLE_BITS / 8);
  uint16_t blockAlign = I2S_CHANNEL_NUM * (I2S_SAMPLE_BITS / 8);

  memcpy(header, "RIFF", 4);
  header[4]  = (uint8_t)(fileSize & 0xFF);
  header[5]  = (uint8_t)((fileSize >> 8) & 0xFF);
  header[6]  = (uint8_t)((fileSize >> 16) & 0xFF);
  header[7]  = (uint8_t)((fileSize >> 24) & 0xFF);
  memcpy(header + 8, "WAVEfmt ", 8);
  header[16] = 16; header[17] = 0; header[18] = 0; header[19] = 0;
  header[20] = 1;  header[21] = 0;
  header[22] = I2S_CHANNEL_NUM; header[23] = 0;
  header[24] = (uint8_t)(I2S_SAMPLE_RATE & 0xFF);
  header[25] = (uint8_t)((I2S_SAMPLE_RATE >> 8) & 0xFF);
  header[26] = (uint8_t)((I2S_SAMPLE_RATE >> 16) & 0xFF);
  header[27] = (uint8_t)((I2S_SAMPLE_RATE >> 24) & 0xFF);
  header[28] = (uint8_t)(byteRate & 0xFF);
  header[29] = (uint8_t)((byteRate >> 8) & 0xFF);
  header[30] = (uint8_t)((byteRate >> 16) & 0xFF);
  header[31] = (uint8_t)((byteRate >> 24) & 0xFF);
  header[32] = (uint8_t)(blockAlign & 0xFF);
  header[33] = 0;
  header[34] = I2S_SAMPLE_BITS;
  header[35] = 0;
  memcpy(header + 36, "data", 4);
  header[40] = (uint8_t)(wavDataSize & 0xFF);
  header[41] = (uint8_t)((wavDataSize >> 8) & 0xFF);
  header[42] = (uint8_t)((wavDataSize >> 16) & 0xFF);
  header[43] = (uint8_t)((wavDataSize >> 24) & 0xFF);
}

// ==================== BUTTON ====================

bool checkStopButton() {
  int reading = digitalRead(BUTTON_PIN);

  if (reading == LOW && !buttonPressed && (millis() - lastDebounceTime > debounceDelay)) {
    buttonPressed = true;
    lastDebounceTime = millis();
    Serial.println("Stop button pressed during chunk, finalizing current chunk...");
    stopRequestedDuringChunk = true;
    return true;
  } else if (reading == HIGH) {
    buttonPressed = false;
  }

  return false;
}

void checkButton() {
  int reading = digitalRead(BUTTON_PIN);

  if (reading == LOW && !buttonPressed) {
    if (millis() - lastDebounceTime > debounceDelay) {
      buttonPressed = true;
      lastDebounceTime = millis();

      if (isRecording) {
        if (!recordingChunkInProgress) {
          stopRecording();
        } else {
          stopRequestedDuringChunk = true;
          Serial.println("Stop requested. Waiting for current chunk to finish...");
        }
      } else {
        startRecording();
      }
    }
  } else if (reading == HIGH) {
    buttonPressed = false;
  }
}

// ==================== AUDIO ====================

int recordAudioToBuffer(uint8_t* buffer, size_t bufferSize, int recordTimeSec) {
  if (!buffer || bufferSize == 0) {
    Serial.println("❌ Invalid buffer");
    return 0;
  }

  size_t wavDataSize = I2S_SAMPLE_RATE * (I2S_SAMPLE_BITS / 8) * recordTimeSec;

  if (wavDataSize > maxAudioDataSize) {
    wavDataSize = maxAudioDataSize;
    Serial.printf("⚠️ Limited data size to %u bytes\n", (unsigned int)wavDataSize);
  }

  size_t totalSize = wavDataSize + 44;
  if (totalSize > bufferSize) {
    Serial.printf("❌ Buffer too small: need %u, have %u\n",
                  (unsigned int)totalSize, (unsigned int)bufferSize);
    return 0;
  }

  writeWavHeaderToBuffer(buffer, wavDataSize);

  uint8_t tempBuffer[I2S_READ_LEN];
  size_t bytesRead = 0;
  size_t totalBytes = 0;
  size_t targetBytes = wavDataSize;
  unsigned long startMillis = millis();
  unsigned long lastButtonCheck = millis();

  i2s_zero_dma_buffer(I2S_PORT);
  delay(10);

  while (totalBytes < targetBytes && isRecording) {
    size_t spaceAvailable = targetBytes - totalBytes;
    size_t toRead = (spaceAvailable < I2S_READ_LEN) ? spaceAvailable : I2S_READ_LEN;
    if (toRead == 0) break;

    esp_err_t err = i2s_read(I2S_PORT, tempBuffer, toRead, &bytesRead, pdMS_TO_TICKS(100));
    if (err != ESP_OK) {
      Serial.printf("I2S read error: %d\n", err);
      delay(10);
      continue;
    }

    if (bytesRead > 0) {
      if ((44 + totalBytes + bytesRead) > bufferSize) {
        Serial.println("⚠️ Buffer overflow prevented");
        break;
      }

      memcpy(buffer + 44 + totalBytes, tempBuffer, bytesRead);
      totalBytes += bytesRead;
    }

    if (millis() - lastButtonCheck > 100) {
      checkStopButton();
      pollDeviceCommandIfDue();
      if (stopRequestedDuringChunk || !isRecording) {
        Serial.println("Stop requested detected. Recording partial chunk...");
        break;
      }
      lastButtonCheck = millis();
    }

    if (totalBytes % 4096 == 0) {
      yield();
    }
  }

  writeWavHeaderToBuffer(buffer, totalBytes);

  unsigned long duration = (millis() - startMillis) / 1000;
  Serial.printf("Recorded: %u bytes in %lus\n",
                (unsigned int)(totalBytes + 44), duration);
  return totalBytes + 44;
}

// ==================== HTTP / BACKEND ====================

bool checkBackendHealth() {
  if (!isWiFiReady()) return false;

  HTTPClient http;

  String healthUrl = String(apiBaseUrl) + "/health";
  http.begin(healthUrl);
  http.setTimeout(10000);

  int httpCode = http.GET();
  String response = http.getString();
  http.end();

  Serial.printf("Health check URL     : %s\n", healthUrl.c_str());
  Serial.printf("Health check code    : %d\n", httpCode);

  if (response.length()) {
    Serial.println("Health response      : " + response);
  }

  return (httpCode >= 200 && httpCode < 300);
}

bool sendHeartbeatWithStatus() {
  if (!isWiFiReady()) return false;

  HTTPClient http;
  String url = String(apiBaseUrl) + "/devices/" + deviceId + "/heartbeat";

  http.begin(url);
  http.setTimeout(10000);
  http.addHeader("Content-Type", "application/json");

  StaticJsonDocument<512> doc;
  doc["ip"] = WiFi.localIP().toString();
  doc["rssi"] = WiFi.RSSI();
  doc["firmware"] = firmwareVersion;
  doc["uptimeSec"] = millis() / 1000;
  doc["freeHeap"] = ESP.getFreeHeap();
  doc["freeSPIFFS"] = SPIFFS.totalBytes() - SPIFFS.usedBytes();
  doc["chunkDuration"] = currentChunkDuration;
  doc["psram"] = psramAvailable;

  String requestBody;
  serializeJson(doc, requestBody);

  int httpCode = http.POST(requestBody);
  String response = http.getString();
  http.end();

  Serial.printf("Heartbeat URL        : %s\n", url.c_str());
  Serial.printf("Heartbeat code       : %d\n", httpCode);
  if (response.length()) {
    Serial.println("Heartbeat response   : " + response);
  }

  return (httpCode == 200);
}

void sendHeartbeat() {
  bool ok = sendHeartbeatWithStatus();
  if (ok) {
    Serial.println("Heartbeat sent");
  } else {
    Serial.println("Heartbeat failed");
  }
}

// NEW: command acknowledgement
bool ackDeviceCommand(const String& command, const String& status, const String& meetingId, const String& message) {
  if (!isWiFiReady()) return false;

  HTTPClient http;
  String url = String(apiBaseUrl) + "/devices/" + deviceId + "/command/ack";

  http.begin(url);
  http.setTimeout(10000);
  http.addHeader("Content-Type", "application/json");

  StaticJsonDocument<384> doc;
  doc["command"] = command;
  doc["status"] = status;
  doc["meetingId"] = meetingId;
  doc["message"] = message;

  String body;
  serializeJson(doc, body);

  int httpCode = http.POST(body);
  String response = http.getString();
  http.end();

  Serial.printf("ACK command code     : %d\n", httpCode);
  if (response.length()) {
    Serial.println("ACK response         : " + response);
  }

  return httpCode == 200;
}

// NEW: remote start
void startRecordingRemote(const String& meetingId, const String& title, const String& language) {
  Serial.println("\n>>> REMOTE START REQUEST RECEIVED <<<");

  if (isRecording) {
    Serial.println("Already recording, ignoring remote start");
    ackDeviceCommand("start", "failed", meetingId, "Device is already recording");
    return;
  }

  if (!isWiFiReady()) {
    Serial.println("WiFi not ready for remote start");
    ackDeviceCommand("start", "failed", meetingId, "WiFi not connected");
    return;
  }

  if (!audioBuffer) {
    if (!allocateAudioBuffer()) {
      ackDeviceCommand("start", "failed", meetingId, "Audio buffer allocation failed");
      criticalError = true;
      return;
    }
  }

  cleanupAllChunks();
  printStorageInfo();

  currentMeetingId = meetingId;
  pendingRemoteMeetingId = meetingId;
  pendingRemoteTitle = title;
  pendingRemoteLanguage = language;

  isRecording = true;
  stopRequestedDuringChunk = false;
  chunkIndex = 0;
  chunkRetryCount = 0;
  recordingChunkInProgress = false;
  digitalWrite(LED_PIN, HIGH);

  ackDeviceCommand("start", "started", currentMeetingId, "ESP32 hardware recording started");

  Serial.printf("✅ Remote recording started! Meeting: %s\n", currentMeetingId.c_str());
  printMeetingStartSummary();
}

// NEW: poll backend for commands
bool pollDeviceCommand() {
  if (!isWiFiReady()) return false;

  HTTPClient http;
  String url = String(apiBaseUrl) + "/devices/" + deviceId + "/command";

  http.begin(url);
  http.setTimeout(8000);

  int httpCode = http.GET();
  String response = http.getString();
  http.end();

  if (httpCode != 200) {
    Serial.printf("Command poll failed  : %d\n", httpCode);
    return false;
  }

  if (response.length() == 0) {
    return false;
  }

  StaticJsonDocument<1024> doc;
  DeserializationError err = deserializeJson(doc, response);

  if (err) {
    Serial.println("Command poll JSON parse failed");
    return false;
  }

  if (!doc["success"]) {
    return false;
  }

  String command = doc["data"]["command"] | "none";

  if (command == "none") {
    return true;
  }

  String meetingId = doc["data"]["meetingId"] | "";
  String title = doc["data"]["title"] | "";
  String language = doc["data"]["language"] | "en";

  Serial.printf("Remote command       : %s\n", command.c_str());

  if (command == "start") {
    startRecordingRemote(meetingId, title, language);
    return true;
  }

  if (command == "stop") {
    if (isRecording) {
      ackDeviceCommand("stop", "stopping", currentMeetingId, "Stop requested by website");

      if (!recordingChunkInProgress) {
        stopRecording();
      } else {
        stopRequestedDuringChunk = true;
      }
    } else {
      ackDeviceCommand("stop", "stopped", meetingId, "Device already stopped");
    }
    return true;
  }

  return true;
}

bool pollDeviceCommandIfDue(bool force) {
  if (!isWiFiReady()) return false;

  unsigned long now = millis();
  if (!force && (now - lastCommandPollTime < commandPollInterval)) {
    return false;
  }

  lastCommandPollTime = now;
  return pollDeviceCommand();
}

bool createMeeting() {
  if (!isWiFiReady()) return false;

  HTTPClient http;
  String url = String(apiBaseUrl) + "/meetings/start";

  http.begin(url);
  http.setTimeout(15000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Id", deviceId);

  StaticJsonDocument<256> doc;
  doc["source"] = "esp32";
  doc["deviceId"] = deviceId;
  doc["language"] = "en";
  doc["title"] = "ESP32 Recording " + String(millis() / 1000);

  String requestBody;
  serializeJson(doc, requestBody);

  Serial.println("POST " + url);

  int httpCode = http.POST(requestBody);
  String response = http.getString();
  http.end();

  Serial.printf("Response code        : %d\n", httpCode);
  if (response.length()) {
    Serial.println("Response body        : " + response);
  }

  if (httpCode == 404) {
    Serial.println("Device not found on backend, sending heartbeat and retrying once...");
    sendHeartbeat();
    delay(500);

    HTTPClient retryHttp;
    retryHttp.begin(url);
    retryHttp.setTimeout(15000);
    retryHttp.addHeader("Content-Type", "application/json");
    retryHttp.addHeader("X-Device-Id", deviceId);

    httpCode = retryHttp.POST(requestBody);
    response = retryHttp.getString();
    retryHttp.end();

    Serial.printf("Retry response code  : %d\n", httpCode);
    if (response.length()) {
      Serial.println("Retry response body  : " + response);
    }
  }

  if (httpCode == 201) {
    StaticJsonDocument<1024> responseDoc;
    DeserializationError err = deserializeJson(responseDoc, response);

    if (!err && responseDoc["success"]) {
      currentMeetingId = responseDoc["data"]["meetingId"].as<String>();
      return currentMeetingId.length() > 0;
    }
  }

  Serial.println("Error creating meeting");
  return false;
}

bool endMeeting() {
  if (currentMeetingId == "" || !isWiFiReady()) return false;

  HTTPClient http;
  String url = String(apiBaseUrl) + "/meetings/" + currentMeetingId + "/end?source=esp32";

  http.begin(url);
  http.setTimeout(15000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Id", deviceId);

  int httpCode = http.POST("{}");
  String response = http.getString();
  http.end();

  Serial.printf("End meeting code     : %d\n", httpCode);
  if (response.length()) {
    Serial.println("End meeting response : " + response);
  }

  return (httpCode == 200);
}

bool uploadChunkFromBuffer(uint8_t* buffer, size_t bufferSize, int idx, int durationSec) {
  if (currentMeetingId == "") return false;

  if (!isWiFiReady()) {
    Serial.println("❌ WiFi disconnected before upload");
    return false;
  }

  if (bufferSize <= 44) {
    Serial.printf("❌ Buffer too small: %u\n", (unsigned int)bufferSize);
    return false;
  }

  HTTPClient http;
  String url = String(apiBaseUrl) + "/meetings/" + currentMeetingId + "/chunks?source=esp32";

  http.begin(url);
  http.setTimeout(UPLOAD_TIMEOUT_MS);
  http.addHeader("Content-Type", "audio/wav");
  http.addHeader("X-Device-Id", deviceId);
  http.addHeader("X-Chunk-Index", String(idx));
  http.addHeader("X-Duration-Sec", String(durationSec));
  http.addHeader("X-File-Name", String("chunk_") + String(idx) + String(".wav"));

  int httpCode = http.sendRequest("POST", buffer, bufferSize);
  String response = http.getString();
  http.end();

  Serial.printf("Upload chunk code    : %d\n", httpCode);
  if (response.length()) {
    Serial.println("Upload response      : " + response);
  }

  return (httpCode == 200 || httpCode == 201);
}

// ==================== RECORDING ====================

void handleChunkFailure() {
  chunkRetryCount++;

  if (chunkRetryCount >= MAX_CHUNK_RETRIES) {
    Serial.printf("⚠️ Max retries reached, skipping chunk %d\n", chunkIndex);
    chunkIndex++;
    chunkRetryCount = 0;

    if (chunkIndex > 10) {
      Serial.println("⚠️ Too many failures, stopping recording");
      stopRecording();
    }
  } else {
    Serial.printf("Retrying chunk %d (%d/%d)\n",
                  chunkIndex, chunkRetryCount, MAX_CHUNK_RETRIES);
    delay(1000);
  }
}

void recordAndUploadChunk() {
  if (!isRecording || currentMeetingId.length() == 0) return;

  if (chunkIndex >= MAX_TOTAL_CHUNKS) {
    Serial.println("⚠️ Max chunks reached, stopping");
    stopRecording();
    return;
  }

  recordingChunkInProgress = true;

  Serial.printf("\n--- Recording chunk %d (retry: %d, duration: %ds) ---\n",
                chunkIndex, chunkRetryCount, currentChunkDuration);

  int recordedBytes = recordAudioToBuffer(audioBuffer, audioBufferSize, currentChunkDuration);

  recordingChunkInProgress = false;

  if (!isRecording && !stopRequestedDuringChunk) {
    Serial.println("Recording already stopped");
    return;
  }

  if (recordedBytes <= 44) {
    Serial.printf("❌ Invalid recording size: %d\n", recordedBytes);

    if (stopRequestedDuringChunk) {
      Serial.println("No useful audio in final chunk. Ending meeting now...");
      stopRecording();
      return;
    }

    handleChunkFailure();
    return;
  }

  bool uploadSuccess = uploadChunkFromBuffer(audioBuffer, recordedBytes, chunkIndex, currentChunkDuration);

  if (uploadSuccess) {
    Serial.printf("✅ Chunk %d uploaded successfully\n", chunkIndex);
    chunkIndex++;
    chunkRetryCount = 0;
    blinkLED(1, 100);

    if (chunkIndex % 5 == 0) {
      cleanupAllChunks();
    }

    if (stopRequestedDuringChunk) {
      Serial.println("Final chunk uploaded. Ending meeting...");
      stopRecording();
      return;
    }
  } else {
    Serial.printf("❌ Chunk %d upload failed\n", chunkIndex);

    if (stopRequestedDuringChunk) {
      Serial.println("Final chunk upload failed, but stopping meeting to avoid stuck recording...");
      stopRecording();
      return;
    }

    handleChunkFailure();
  }
}

void startRecording() {
  Serial.println("\n>>> STARTING RECORDING <<<");

  if (!isWiFiReady()) {
    Serial.println("❌ WiFi not connected! Cannot start recording.");
    Serial.println("Attempting WiFi reconnect...");
    manageWiFiConnection();
    blinkLED(5, 100);
    return;
  }

  if (!audioBuffer) {
    Serial.println("❌ Audio buffer not allocated!");
    if (!allocateAudioBuffer()) {
      criticalError = true;
      return;
    }
  }

  cleanupAllChunks();
  printStorageInfo();

  Serial.println("Checking backend before meeting start...");
  bool backendOk = checkBackendHealth();
  Serial.printf("Backend/API Check   : %s\n", backendOk ? "SUCCESS" : "FAILED");

  if (!createMeeting()) {
    Serial.println("❌ Failed to create meeting");
    blinkLED(3, 200);
    return;
  }

  isRecording = true;
  stopRequestedDuringChunk = false;
  chunkIndex = 0;
  chunkRetryCount = 0;
  recordingChunkInProgress = false;
  digitalWrite(LED_PIN, HIGH);

  Serial.printf("✅ Recording started! Meeting: %s, Chunk: %ds\n",
                currentMeetingId.c_str(), currentChunkDuration);

  printMeetingStartSummary();
}

void stopRecording() {
  Serial.println("\n>>> STOPPING RECORDING <<<");

  bool hadMeeting = currentMeetingId.length() > 0;
  String meetingToClose = currentMeetingId;

  isRecording = false;
  stopRequestedDuringChunk = false;
  recordingChunkInProgress = false;
  digitalWrite(LED_PIN, LOW);
  delay(100);

  if (hadMeeting) {
    bool ended = endMeeting();
    Serial.printf("Meeting %s end status: %s\n", meetingToClose.c_str(), ended ? "SUCCESS" : "FAILED");
    ackDeviceCommand("stop", "stopped", meetingToClose, ended ? "ESP32 recording stopped" : "ESP32 stop attempted but backend end failed");
  }

  cleanupAllChunks();
  currentMeetingId = "";
  pendingRemoteMeetingId = "";
  pendingRemoteTitle = "";
  pendingRemoteLanguage = "en";
  chunkIndex = 0;
  chunkRetryCount = 0;

  Serial.println("✅ Recording stopped");
  printStorageInfo();
}

// ==================== SETUP / LOOP ====================

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n==================================================");
  Serial.println("        VoiceMind ESP32 Starting v2.8");
  Serial.println("==================================================");

  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  psramAvailable = psramFound() && (ESP.getFreePsram() > 0);
  Serial.printf("PSRAM Available: %s\n", psramAvailable ? "YES" : "NO");

  if (psramAvailable) {
    Serial.printf("PSRAM Size: %u bytes\n", (unsigned int)ESP.getFreePsram());
  }

  if (!SPIFFS.begin(true)) {
    Serial.println("❌ SPIFFS initialization failed!");
    fatalError(1);
  }

  Serial.println("✅ SPIFFS initialized");
  printStorageInfo();
  cleanupAllChunks();

  if (!allocateAudioBuffer()) {
    Serial.println("❌ Failed to allocate audio buffer!");
    fatalError(5);
  }

  setupWiFiEvents();
  initWiFi();
  waitForInitialWiFi(INITIAL_WIFI_WAIT_MS);
  i2sInit();
  printSystemSummary();

  Serial.println("\n==================================================");
  Serial.printf("Setup Complete - Chunk duration: %ds\n", currentChunkDuration);
  Serial.println("Press BOOT button to record");
  Serial.println("Website remote start/stop enabled");
  Serial.println("==================================================");
}

void loop() {
  if (criticalError) {
    delay(1000);
    return;
  }

  manageWiFiConnection();

  if (millis() - lastHeartbeatTime >= heartbeatInterval) {
    lastHeartbeatTime = millis();
    sendHeartbeat();
  }

  pollDeviceCommandIfDue();

  checkButton();

  if (isRecording) {
    if (currentMeetingId == "") {
      Serial.println("⚠️ No meeting ID, stopping recording");
      stopRecording();
    } else if (!isWiFiReady()) {
      Serial.println("⚠️ WiFi lost during recording, stopping...");
      stopRecording();
    } else {
      recordAndUploadChunk();
    }
  }

  delay(20);
}