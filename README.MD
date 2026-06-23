# VoiceMind - Complete Meeting Intelligence System

A production-grade MERN stack + Python + ESP32 system for recording, transcribing, and analyzing meetings with real-time monitoring.

## Architecture

```
┌─────────────┐      HTTP/REST       ┌──────────────┐      SSE/Polling      ┌─────────────┐
│   ESP32     │ ───────────────────> │ Node/Express │ <───────────────────> │   React     │
│  Hardware   │    (Audio Chunks)    │   Backend    │    (Live Updates)     │  Frontend   │
└─────────────┘                      └──────────────┘                       └─────────────┘
                                            │                                      │
                                            │ MongoDB                              │ Redux
                                            ▼                                      ▼
                                     ┌──────────────┐                       ┌─────────────┐
                                     │   MongoDB    │                       │  UI State   │
                                     │   (Data)     │                       │  Management │
                                     └──────────────┘                       └─────────────┘
                                            │
                                            │ HTTP
                                            ▼
                              ┌─────────────────────────┐
                              │    Python Services      │
                              │  ┌─────────────────┐    │
                              │  │  Transcription  │    │  <- faster-whisper
                              │  │    (Port 8001)  │    │
                              │  └─────────────────┘    │
                              │  ┌─────────────────┐    │
                              │  │      Q&A        │    │  <- Ollama/LLM
                              │  │    (Port 8002)  │    │
                              │  └─────────────────┘    │
                              └─────────────────────────┘
```

## Prerequisites

- **Node.js** 18+ and npm
- **Python** 3.9+ with pip
- **MongoDB** 5.0+ (local or Atlas)
- **ESP32** development board with I2S microphone (INMP441 recommended)
- **Ollama** (optional, for local LLM Q&A)

## Project Structure

```
voicemind/
├── frontend/           # React.js + Redux + TailwindCSS
├── backend/            # Node.js + Express + MongoDB
├── python_services/    # Python microservices
│   ├── transcription_service/   # faster-whisper STT
│   └── qa_service/              # Ollama Q&A
└── esp32/              # ESP32 Arduino firmware
```

## Quick Start

### 1. Backend Setup

```bash
cd backend
npm install

# Create .env file
cp .env.example .env
# Edit .env with your MongoDB URI and settings

# Start server
npm run dev
```

Backend runs on `http://localhost:5001`

### 2. Frontend Setup

```bash
cd frontend
npm install

# Create .env file
cp .env.example .env

# Start development server
npm start
```

Frontend runs on `http://localhost:3000`

### 3. Python Transcription Service

```bash
cd python_services/transcription_service
pip install -r requirements.txt

# Download Whisper model (first run)
# The model will auto-download on first use

# Start service
python main.py
```

Service runs on `http://localhost:8001`

### 4. Python Q&A Service (Optional)

```bash
cd python_services/qa_service
pip install -r requirements.txt

# Install Ollama first: https://ollama.ai
# Pull a model: ollama pull llama3.2:latest

# Start service
python main.py
```

Service runs on `http://localhost:8002`

### 5. ESP32 Setup

1. Install Arduino IDE with ESP32 board support
2. Install required libraries:
   - ESP32 Board Package
3. Open `esp32/voicemind_esp32.ino`
4. Update WiFi credentials and backend URL
5. Upload to ESP32

## Features

### Frontend
- **Real-time Dashboard**: Live monitoring of ESP32 recording status
- **Hardware Live Panel**: Visual indicator that recording happens externally
- **Meeting Management**: Start/stop meetings, view history
- **Transcripts**: Global transcript library with search
- **Q&A**: Ask questions about meetings using AI
- **Statistics**: Analytics dashboard with charts
- **Notifications**: Real-time notifications with deduplication
- **User Profile**: Preferences, theme settings
- **Responsive Design**: Works on desktop and mobile

### Backend
- **REST API**: Full CRUD for meetings, devices, transcripts
- **SSE (Server-Sent Events)**: Real-time updates to frontend
- **Polling Fallback**: Automatic fallback if SSE fails
- **Device Heartbeat**: ESP32 health monitoring
- **Offline Detection**: Automatic device status updates
- **JWT Authentication**: Secure user sessions
- **File Upload**: Audio chunk storage
- **MongoDB**: Scalable document storage

### ESP32 Firmware
- **I2S Audio**: High-quality microphone input
- **20-Second Chunks**: Efficient upload strategy
- **Start/Stop Button**: Physical control with LED indicator
- **Auto-Upload**: HTTP POST to backend
- **Heartbeat**: Keep-alive and telemetry
- **WiFi Management**: Automatic reconnection

### Python Services
- **faster-whisper**: Fast, accurate speech-to-text
- **Ollama Integration**: Local LLM for Q&A (no API keys!)
- **Async Processing**: Non-blocking transcription
- **REST API**: Easy integration with Node backend

## Environment Variables

### Backend (.env)
```env
PORT=5001
MONGO_URI=mongodb://127.0.0.1:27017/voicemind
JWT_SECRET=your_secret_key
CORS_ORIGIN=http://localhost:3000
UPLOAD_DIR=./uploads
DEVICE_OFFLINE_AFTER_SEC=30
TRANSCRIBE_API_URL=http://127.0.0.1:8001
QA_API_URL=http://127.0.0.1:8002
```

### Frontend (.env)
```env
REACT_APP_API_BASE_URL=http://localhost:5001/api
REACT_APP_SSE_URL=http://localhost:5001/api/events
```

### Python Transcription (.env)
```env
PORT=8001
WHISPER_MODEL=small  # small, medium, large-v3
WHISPER_DEVICE=cpu   # cpu or cuda
WHISPER_COMPUTE=int8 # int8 or float16
```

### Python Q&A (.env)
```env
PORT=8002
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2:latest
```

## API Endpoints

### Authentication
- `POST /api/auth/signup` - Register new user
- `POST /api/auth/login` - Login
- `GET /api/auth/me` - Get current user
- `PUT /api/auth/me` - Update profile

### Meetings
- `POST /api/meetings/start` - Start new meeting
- `POST /api/meetings/:id/end` - End meeting
- `GET /api/meetings` - List meetings
- `GET /api/meetings/:id` - Get meeting details
- `POST /api/meetings/:id/chunks` - Upload audio chunk
- `GET /api/meetings/:id/transcript` - Get transcript

### Devices
- `GET /api/devices` - List devices
- `GET /api/devices/:id/status` - Get device status
- `POST /api/devices/:id/heartbeat` - Device heartbeat (ESP32)

### Real-time
- `GET /api/events` - SSE endpoint for live updates

### Analytics
- `GET /api/analytics/overview` - Dashboard stats
- `GET /api/analytics/meetings-timeseries` - Meeting trends
- `GET /api/analytics/qa` - Q&A trends

## Hardware Wiring (ESP32 + INMP441)

```
ESP32          INMP441
------------------------
GPIO2  (SCK) -> SCK
GPIO15 (WS)  -> WS
GPIO13 (SD)  -> SD
3.3V         -> VDD
GND          -> GND

Button: GPIO0 (Built-in BOOT button)
LED:    GPIO2 (Built-in LED)
```

## Usage Flow

1. **Power on ESP32** - Connects to WiFi, starts heartbeat
2. **Press BOOT button** - LED turns on, recording starts
3. **ESP32 records** - 20-second chunks uploaded to backend
4. **Backend processes** - Audio transcribed by Python service
5. **Frontend updates** - Real-time transcript appears in browser
6. **Press BOOT again** - Recording stops, meeting finalized
7. **Review & Analyze** - View transcript, ask Q&A, see stats

## Troubleshooting

### Backend won't connect to MongoDB
- Check MongoDB is running: `mongod --version`
- Verify MONGO_URI in .env
- Try: `mongosh` to test connection

### Frontend shows "Offline"
- Check backend is running on port 5001
- Verify CORS_ORIGIN in backend .env matches frontend URL
- Check browser console for CORS errors

### ESP32 won't upload chunks
- Verify WiFi credentials in sketch
- Check backend URL is accessible from ESP32 network
- Monitor Serial output for HTTP error codes
- Ensure SPIFFS is formatted (happens automatically)

### Transcription not working
- Check Python service is running on port 8001
- Verify TRANSCRIBE_API_URL in backend .env
- Check Python console for errors

### Q&A not working
- Install Ollama: `curl -fsSL https://ollama.ai/install.sh | sh`
- Pull model: `ollama pull llama3.2:latest`
- Check Ollama is running: `ollama list`

## Production Deployment

### Backend
```bash
# Set NODE_ENV=production
# Use PM2 for process management
npm install -g pm2
pm2 start src/server.js --name voicemind-api
```

### Frontend
```bash
npm run build
# Serve build/ folder with nginx or similar
```

### Python Services
```bash
# Use systemd services or Docker
# Example with systemd:
sudo systemctl enable voicemind-transcription
sudo systemctl start voicemind-transcription
```

### MongoDB
- Use MongoDB Atlas for managed database
- Or set up replica set for production

## License

MIT License - See LICENSE file

## Support

For issues and feature requests, please create an issue in the repository.
