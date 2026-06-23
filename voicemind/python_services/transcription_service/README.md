# VoiceMind Backend

Node.js/Express backend for VoiceMind with MongoDB

## Tech Stack

- **Node.js 18+**
- **Express.js** - Web Framework
- **MongoDB + Mongoose** - Database
- **JWT** - Authentication
- **Multer** - File Upload
- **SSE** - Server-Sent Events
- **node-cron** - Scheduled jobs

## Setup

```bash
# Install dependencies
npm install

# Create environment file
cp .env.example .env
# Edit .env with your settings

# Start development server
npm run dev

# Or production
npm start
```

## Environment Variables

```env
PORT=5001
MONGO_URI=mongodb://127.0.0.1:27017/voicemind
JWT_SECRET=your_secret_key
JWT_EXPIRES_IN=7d
CORS_ORIGIN=http://localhost:3000
UPLOAD_DIR=./uploads
DEVICE_OFFLINE_AFTER_SEC=30
TRANSCRIBE_API_URL=http://127.0.0.1:8001
QA_API_URL=http://127.0.0.1:8002
```

## API Endpoints

### Auth
- `POST /api/auth/signup` - Register
- `POST /api/auth/login` - Login
- `GET /api/auth/me` - Get user
- `PUT /api/auth/me` - Update profile

### Meetings
- `POST /api/meetings/start` - Start meeting
- `POST /api/meetings/:id/end` - End meeting
- `GET /api/meetings` - List meetings
- `GET /api/meetings/:id` - Get meeting
- `POST /api/meetings/:id/chunks` - Upload chunk
- `GET /api/meetings/:id/transcript` - Get transcript

### Devices
- `GET /api/devices` - List devices
- `GET /api/devices/:id/status` - Get status
- `POST /api/devices/:id/heartbeat` - Heartbeat (ESP32)

### Real-time
- `GET /api/events` - SSE endpoint

## Architecture

```
Request -> Routes -> Controllers -> Models -> MongoDB
                    |
                    -> Services (EventBus)
                    |
                    -> Python Services (STT, Q&A)
```

## File Upload

Audio chunks are stored in `uploads/<meetingId>/chunk_<index>.wav`

## Real-time Events

Events broadcast via SSE:
- `device_online/offline`
- `recording_started/stopped`
- `chunk_uploaded/failed`
- `transcript_updated`

## Device Offline Detection

Cron job runs every 10s to mark devices as offline if no heartbeat for 30s.
