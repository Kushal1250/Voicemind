# VoiceMind Frontend

React.js frontend for VoiceMind - Meeting Intelligence Platform

## Tech Stack

- **React 18** - UI Framework
- **Redux Toolkit** - State Management
- **React Router v6** - Routing
- **TailwindCSS** - Styling
- **Axios** - HTTP Client
- **Recharts** - Charts
- **Lucide React** - Icons
- **React Toastify** - Notifications

## Setup

```bash
# Install dependencies
npm install

# Create environment file
cp .env.example .env

# Start development server
npm start
```

## Environment Variables

```env
REACT_APP_API_BASE_URL=http://localhost:5001/api
REACT_APP_SSE_URL=http://localhost:5001/api/events
REACT_APP_NAME=VoiceMind
```

## Features

- **Authentication**: JWT-based auth with login/signup
- **Real-time Updates**: SSE with polling fallback
- **Responsive Design**: Mobile-friendly interface
- **Dark Mode**: Theme switching support
- **Live Monitoring**: ESP32 hardware status dashboard
- **Meeting Management**: CRUD operations
- **Transcripts**: Search and view transcripts
- **Q&A**: AI-powered question answering
- **Statistics**: Analytics dashboard with charts
- **Notifications**: Real-time notification system

## Folder Structure

```
src/
├── components/       # Reusable components
│   ├── AppShell.jsx
│   ├── Sidebar.jsx
│   └── Topbar.jsx
├── pages/           # Route pages
│   ├── Dashboard.jsx
│   ├── Meetings.jsx
│   ├── LiveMonitor.jsx
│   └── ...
├── store/           # Redux store
│   ├── slices/
│   └── index.js
├── services/        # API services
│   └── api.js
├── hooks/           # Custom hooks
│   ├── useLiveStatus.js
│   └── useDebounce.js
└── index.js
```

## Available Scripts

- `npm start` - Development server
- `npm run build` - Production build
- `npm test` - Run tests

## Browser Support

- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+
