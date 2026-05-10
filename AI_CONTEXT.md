# AI Context: Couch (Synclify)

> **Purpose**: This file provides AI agents with a comprehensive overview of the Couch project structure, architecture, and key concepts without needing to read every file.

## Project Overview

**Couch** (also known as Synclify) is an open-source browser extension that enables users to synchronize video playback across streaming services. Two or more users can watch videos together by sharing a room code, similar to w2g.tv.

- **Type**: Browser Extension (Cross-browser: Chrome, Firefox, Edge)
- **Status**: Early development
- **Key Feature**: Real-time video synchronization via WebSocket
- **Distribution**: Chrome Web Store, Firefox Add-ons, Edge Add-ons

## Tech Stack

### Frontend (Extension)
- **Framework**: WXT (modern browser extension framework)
- **UI Library**: React 19 (aliased to Preact for smaller bundle size)
- **Styling**: TailwindCSS v3 + shadcn/ui components
- **Build Tool**: Vite (via WXT)
- **Language**: TypeScript
- **State Management**: Browser extension storage APIs (`browser.storage.local`, `browser.storage.sync`)
- **Real-time Communication**: Socket.io-client
- **Forms**: React Hook Form + Zod validation
- **Analytics**: PostHog

### Backend (Room Server)
- **Runtime**: Node.js
- **Framework**: Express (minimal HTTP server)
- **Real-time**: Socket.io server
- **Language**: JavaScript (ES modules)
- **Deployment**: Render (recommended), Railway, Fly.io

### Development Tools
- **Package Manager**: pnpm (preferred) / npm
- **Linting**: ESLint + Prettier
- **CSS Processing**: PostCSS + Autoprefixer + cssnano

## Architecture Overview

### High-Level Flow

```
┌─────────────────┐     WebSocket      ┌──────────────────┐
│  Browser Tab 1  │ ←─────────────────→ │                  │
│  (Extension)    │                     │   Room Server    │
└─────────────────┘                     │  (Node.js)       │
                                        │  Socket.io       │
┌─────────────────┐     WebSocket      │                  │
│  Browser Tab 2  │ ←─────────────────→ │                  │
│  (Extension)    │                     └──────────────────┘
└─────────────────┘
```

### Extension Architecture

The extension uses a **multi-entrypoint architecture** with different scripts serving different purposes:

1. **Background Script** (`src/entrypoints/background.ts`)
   - Service worker that runs persistently
   - Handles room creation, tab lifecycle, script injection
   - Central message router for all extension communication
   - Manages persistent room state across page navigations

2. **Content Scripts** (injected dynamically)
   - **Main Content Script** (`src/content-script.ts`) - Legacy, mostly replaced by injected.ts
   - **Injected Script** (`src/entrypoints/injected.ts`) - Core sync logic, runs in isolated world
   - **Support Scripts** (dynamically injected):
     - `chat.ts` - Chat overlay UI
     - `reactions.ts` - Emoji reactions overlay
     - `toast.ts` - Toast notifications
     - `videoPlayer.ts` - Custom video player controls
     - `videoSelector.ts` - Multi-video detection UI
     - `autoInject.ts` - Auto-injection on SPA navigation
     - `fullscreenPatch.ts` - Fullscreen compatibility fixes
     - `debugShield.ts` - Debug protections for streaming sites

3. **Popup** (`src/entrypoints/popup/`)
   - Extension popup UI for creating/joining rooms
   - Manages room codes and participant nicknames

4. **Options Page** (`src/entrypoints/options/`)
   - Extension settings (e.g., audio sync preferences)

## Directory Structure

```
Couch/
├── server/                      # Backend room server
│   └── index.js                 # Socket.io server + HTTP endpoints
├── src/
│   ├── entrypoints/             # Extension entry points (WXT convention)
│   │   ├── background.ts        # Background service worker
│   │   ├── injected.ts          # Main injection script (isolated world)
│   │   ├── chat.ts              # Chat overlay content script
│   │   ├── reactions.ts         # Reactions overlay content script
│   │   ├── toast.ts             # Toast notification content script
│   │   ├── videoPlayer.ts       # Custom video player controls
│   │   ├── videoSelector.ts     # Video selection UI (multi-video)
│   │   ├── autoInject.ts        # Auto-injection helper
│   │   ├── fullscreenPatch.ts   # Fullscreen API patches
│   │   ├── debugShield.ts       # Debug protection for streaming sites
│   │   ├── popup/               # Extension popup UI
│   │   │   ├── App.tsx
│   │   │   └── main.tsx
│   │   └── options/             # Options page UI
│   │       ├── App.tsx
│   │       └── main.tsx
│   ├── runtime/                 # React UI components rendered in content scripts
│   │   ├── chat.tsx
│   │   ├── reactions.tsx
│   │   ├── toast.tsx
│   │   ├── videoPlayer.tsx
│   │   └── videoSelector.tsx
│   ├── components/              # Reusable React components (shadcn/ui)
│   │   └── ui/
│   ├── types/                   # TypeScript type definitions
│   │   ├── messaging.ts         # Extension messaging types
│   │   ├── socket.ts            # Socket.io event types
│   │   ├── state.ts             # Extension state types
│   │   └── video.ts             # Video event types
│   ├── lib/                     # Utility libraries
│   │   ├── debug.ts             # Debug utilities
│   │   ├── posthog.ts           # Analytics setup
│   │   ├── i18n.ts              # Internationalization
│   │   ├── video-detection.ts   # Video detection logic
│   │   ├── fullscreen.ts        # Fullscreen helpers
│   │   ├── runtime-ui.ts        # UI rendering helpers
│   │   └── utils.ts             # General utilities
│   ├── assets/                  # Static assets
│   │   └── style.css            # Global styles
│   ├── content-script.ts        # Legacy content script (mostly unused)
│   └── options.tsx              # Legacy options (replaced by entrypoints/options)
├── public/                      # Public assets
│   └── _locales/                # i18n translations
│       ├── en/messages.json
│       ├── es/messages.json
│       └── [other locales]/
├── wxt.config.ts                # WXT configuration
├── package.json                 # Dependencies and scripts
├── tsconfig.json                # TypeScript configuration
├── tailwind.config.js           # Tailwind CSS configuration
└── render.yaml                  # Render deployment config
```

## Key Components & Their Roles

### 1. Background Script (`background.ts`)
**Role**: Central coordinator and message router

**Key Responsibilities**:
- Creates room codes (via HTTP request to backend)
- Manages tab state persistence (`browser.storage.local`)
- Injects content scripts dynamically based on video detection
- Handles tab lifecycle events (close, navigate, reload)
- Routes messages between content scripts and popup
- Manages debug shield registration (for streaming site compatibility)

**Important Functions**:
- `handleInject()` - Injects scripts and initializes sync
- `handleCreateRoom()` - Fetches room code from server
- `detectPageVideos()` - Detects videos on page (runs in page context)
- `reinjectTab()` - Re-injects scripts after navigation
- `setPersistentDebugShield()` - Registers debug protections

**Message Actions**: `createRoom`, `inject`, `shouldInject`, `getTabId`, `showToast`, `chatMessage`, `reaction`, etc.

### 2. Injected Script (`injected.ts`)
**Role**: Core synchronization engine

**Key Responsibilities**:
- Establishes WebSocket connection to room server
- Listens to local video events (play, pause, seek, volume)
- Broadcasts video events to other participants via socket
- Receives and applies video events from other participants
- Manages synthetic event flags (prevents feedback loops)

**Socket Events**:
- Emits: `join`, `videoEvent`, `chatMessage`, `reaction`
- Listens: `connect`, `reconnect`, `videoEvent`, `chatMessage`, `reaction`, `full`, `roomError`

**Important Pattern**: Uses `syntheticEvent` flag to distinguish user-initiated events from programmatic events (prevents infinite loops)

### 3. Room Server (`server/index.js`)
**Role**: Central coordination server

**Key Responsibilities**:
- Generates unique 5-character room codes
- Manages room lifecycle (create, join, leave, cleanup)
- Routes video events between participants
- Handles room state (host, control mode, participant list)
- Enforces max participant limit (default: 10)

**HTTP Endpoints**:
- `GET /create` - Generate new room code
- `GET /room/:roomId/url` - Get host's current URL

**Socket Events**:
- `join` - Join room with participant details
- `leaveRoom` - Leave room
- `videoEvent` - Broadcast video sync event
- `chatMessage` - Broadcast chat message
- `reaction` - Broadcast emoji reaction
- `syncPing`/`syncPong` - Network latency measurement

**Room State**:
```javascript
{
  roomId: string,
  hostId: string,
  controlMode: "shared" | "host",
  hostUrl: string,
  participants: Map<participantId, { id, nickname, isHost }>,
  socketsByParticipant: Map<participantId, socketId>,
  maxParticipants: number
}
```

**Control Mode enforcement** (`controlMode: "host"`):
- The server drops `videoEvent` emissions from non-host sockets when `controlMode === "host"` (checked via `socketsByParticipant`)
- Non-host clients receive a DOM overlay (`position: absolute; inset: 0; z-index: max`) injected into the player container, blocking all mouse/touch input
- A `keydown` capture-phase listener on `window` blocks playback keys (Space, K, J, L, ←, →, Home, End, 0–9, `.`, `,`) before site handlers receive them
- As a safety net, `videoEventHandler` in `injected.ts` still detects user-initiated events that slip through and reverts the video to `lastSyncedHostState` (which tracks the host's last PLAY/PAUSE/SEEKED/RATECHANGE with a timestamp for elapsed-time compensation)

### 4. Video Detection
**Location**: `background.ts` (function `detectPageVideos`)

**Strategy**:
1. **Known Sites**: Uses site-specific selectors (Netflix, YouTube, Prime Video, Disney+, etc.)
2. **Unknown Sites**: Falls back to generic `<video>` tag detection
3. **Filtering**: Excludes ads, overlays, non-playable videos
4. **Custom Player Decision**: Shows custom controls only for native videos on unknown sites

**Site Configurations**: Defined in `SITE_VIDEO_SELECTORS` object with:
- `hostPatterns` - Regex patterns for domain matching
- `videoSelector` - CSS selector for video element
- `playerContainer` - CSS selector for player wrapper
- `excludeSelector` - Elements to exclude (ads)
- `watchPageTest` - Function to verify if on watch page

### 5. State Management
**Location**: `browser.storage.local` (extension storage API)

**State Schema** (`types/state.ts`):
```typescript
type State = {
  [tabId: number]: {
    roomId: string
    participantId?: string
    controlMode?: "shared" | "host"   // "shared" = Allow control ON; "host" = Allow control OFF
    videoFound?: boolean
    nickname?: string
    participants?: RoomParticipant[]
    participantCount?: number
    hostId?: string
    isHost?: boolean
    maxParticipants?: number
  }
}
```

**Persistence**: State survives page reloads but not extension reloads

### 6. UI Components (React)
**Location**: `src/runtime/*.tsx`

All UI components are rendered using a custom `runtime-ui.ts` helper that creates isolated Shadow DOM containers to prevent style conflicts with host pages.

- **Chat** (`runtime/chat.tsx`) - Floating chat overlay with message history
- **Reactions** (`runtime/reactions.tsx`) - Emoji reaction overlay
- **Toast** (`runtime/toast.tsx`) - Toast notifications using Sonner
- **Video Player** (`runtime/videoPlayer.tsx`) - Custom video controls
- **Video Selector** (`runtime/videoSelector.tsx`) - UI for selecting between multiple videos

## Communication Flow

### 1. Creating/Joining a Room

```
Popup UI → Background (createRoom) → Server (/create) → Returns room code
       ↓
Popup stores room + nickname in storage
       ↓
Popup → Background (inject) → Injects content scripts → Initializes sync
```

### 2. Video Event Synchronization

```
User pauses video → Video element fires "pause" event
                 ↓
Injected script captures event → Emits to Socket.io
                 ↓
Server broadcasts to all participants in room
                 ↓
Other participants receive event → Apply pause programmatically
```

### 3. Chat Message Flow

```
User types in chat → runtime/chat.tsx
                  ↓
Sends message to background via browser.runtime.sendMessage
                  ↓
Background forwards to injected script
                  ↓
Injected script emits to socket → Server broadcasts
                  ↓
Other participants receive → Background forwards to runtime/chat.tsx
```

## Development Workflow

### Local Development

**Option 1: Extension only**
```bash
npm run dev
# Opens dev build in build/chrome-mv3-dev
# Socket will fail (ERR_CONNECTION_REFUSED) without server
```

**Option 2: Extension + Server**
```bash
npm run dev:all
# Runs extension + local server together
```

**Option 3: Extension + Server + ngrok**
```bash
npm run dev:public
# Runs extension + server + ngrok tunnel (for testing across devices)
```

### Building for Production

```bash
# Set socket endpoint
$env:WXT_SOCKET_ENDPOINT="https://your-server.com"

# Build extension
npm run build

# Create zip for store submission
npm run zip
```

### Environment Variables

- `WXT_SOCKET_ENDPOINT` - Backend server URL (default: `http://localhost:3001`)
- `WXT_PUBLIC_POSTHOG_HOST` - PostHog analytics host

### Scripts

- `dev` - Start extension development build
- `server:dev` - Start local room server
- `dev:all` - Extension + server concurrently
- `build` - Production build for Chrome
- `build:firefox` - Production build for Firefox
- `zip` - Create distribution zip
- `start` - Start production server (used by hosting platforms)

## Important Patterns & Conventions

### 1. Synthetic Event Prevention
To prevent infinite loops when applying remote video events:
```typescript
let syntheticEvent = false

// Before programmatic action
syntheticEvent = true
video.pause()

// In event listener
if (syntheticEvent) {
  event.stopImmediatePropagation()
  syntheticEvent = false
} else {
  // Real user event - broadcast it
  socket.emit(...)
}
```

### 2. Message Routing
Extension uses a message-passing architecture:
- **Between contexts**: Use `browser.runtime.sendMessage()` with action types
- **Background as router**: All messages go through background script
- **Content script targeting**: Use `browser.tabs.sendMessage()` with `frameId`

### 3. Dynamic Script Injection
Scripts are injected on-demand rather than declared in manifest:
```typescript
await browser.scripting.executeScript({
  files: ["chat.js", "reactions.js", ...],
  target: { tabId, frameIds }
})
```

### 4. Video Detection Retry Strategy
Videos may load asynchronously (SPAs), so detection retries up to 6 times with 750ms delays.

### 5. Debug Shield
For streaming sites that detect automation, a debug shield can be registered to run at `document_start` and prevent detection.

### 6. React-Preact Aliasing
React imports are aliased to Preact in `wxt.config.ts` for smaller bundle size:
```typescript
resolve: {
  alias: {
    react: "preact/compat",
    "react-dom": "preact/compat"
  }
}
```

## Internationalization (i18n)

- **Location**: `public/_locales/*/messages.json`
- **Supported Languages**: English, Spanish, French, Russian, Hindi, Bengali, Urdu, Chinese, Portuguese, Arabic
- **Usage**: Via `browser.i18n.getMessage()` API

## Known Streaming Sites

The extension has built-in support for:
- Netflix
- YouTube
- Prime Video
- Disney+
- Max (HBO Max)
- Hulu
- Apple TV+
- Peacock
- Crunchyroll
- Paramount+
- Hotstar
- Mubi

Each site has custom selectors and detection logic to avoid ads and find the main video player.

## State Persistence Strategy

- **Per-Tab State**: Stored in `browser.storage.local` indexed by `tabId`
- **Settings**: Stored in `browser.storage.sync` (syncs across devices)
- **Navigation Handling**: Background script listens to `tabs.onUpdated` and re-injects scripts when `status === "complete"`
- **Tab Cleanup**: State is deleted when tab closes (`tabs.onRemoved`)
- **Extension Updates**: State is cleared on version change to prevent migration issues

## Debugging

### Available Debug Tools (exposed on `window`)

In background script, run in console:
```javascript
// Enable debug shield on current tab
await synclifyDebug.enableShield()

// Detect videos on current tab
await synclifyDebug.detectVideos()

// Get active tab ID
await synclifyDebug.getActiveTabId()
```

### Console Logs
Enable debug logging by setting:
```typescript
const DEBUG_INJECT_FLOW = true // in background.ts
```

## Deployment

### Server Deployment (Render)
1. Push repo to GitHub
2. Connect to Render
3. Render auto-detects `render.yaml`
4. Copy service URL (e.g., `https://couch-room-server.onrender.com`)

### Extension Deployment
1. Set `WXT_SOCKET_ENDPOINT` to production server
2. Build extension: `npm run build`
3. Zip: `npm run zip`
4. Upload to Chrome Web Store / Firefox Add-ons / Edge Add-ons

## Security Considerations

- **CORS**: Server allows all origins for development flexibility
- **Private Network Access**: Headers set to allow localhost connections
- **CSP**: Content Security Policy configured in manifest for extension pages
- **No Authentication**: Current version has no authentication (rooms are discoverable by code)
- **Rate Limiting**: Not implemented (consider for production)

## Future Improvements & TODOs

- Add authentication/authorization for rooms
- Implement room passwords
- Add persistent room history
- Improve mobile browser support
- Add video quality sync
- Implement seek-while-playing sync (currently only on seeked event)
- Add voice chat capability
- Improve error handling and recovery
- Add rate limiting to prevent abuse

## Common Issues & Solutions

### Issue: ERR_CONNECTION_REFUSED
**Cause**: Room server not running
**Solution**: Run `npm run server:dev` or `npm run dev:all`

### Issue: Multiple socket connections
**Cause**: Scripts injected into multiple frames
**Solution**: Target specific `frameIds` during injection

### Issue: Video not detected
**Cause**: Video loads after scripts inject, or SPA navigation
**Solution**: Uses MutationObserver fallback and retry logic

### Issue: Sync loops (play/pause fighting)
**Cause**: Not using synthetic event flags
**Solution**: Always set `syntheticEvent = true` before programmatic actions

### Issue: Extension reloads lose state
**Cause**: Extension state not persisted across extension reloads
**Solution**: This is intentional; state cleared on `runtime.onInstalled` with version change

---

## Quick Reference: File → Purpose

| File | Purpose |
|------|---------|
| `server/index.js` | Room server (Socket.io + HTTP) |
| `src/entrypoints/background.ts` | Background service worker, message router |
| `src/entrypoints/injected.ts` | Core sync engine (video event capture/apply) |
| `src/entrypoints/popup/App.tsx` | Extension popup UI |
| `src/entrypoints/options/App.tsx` | Settings page UI |
| `src/runtime/chat.tsx` | Chat overlay component |
| `src/runtime/reactions.tsx` | Emoji reactions component |
| `src/types/socket.ts` | Socket event types |
| `src/types/state.ts` | Extension state schema |
| `wxt.config.ts` | Extension build configuration |

---

**Last Updated**: 2026-05-10 (control lock feature + "Allow control" rename)
**Project Version**: 0.5.0
**Maintained by**: andrea
