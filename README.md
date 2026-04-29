<img src="https://user-images.githubusercontent.com/25244986/216099424-dd0f4ed2-e594-4f1a-bd15-ab2afe8ba1fe.png"/>

<h2 align="center">Couch</h2>
<p align="center"><a rel="noreferrer noopener" href="https://chrome.google.com/webstore/detail/synclify/okdfcljlaacbdacenfeaiekllplonlfm/"><img alt="Chrome Web Store" src="https://img.shields.io/badge/Chrome-141e24.svg?&style=for-the-badge&logo=google-chrome&logoColor=white"></a>  <a rel="noreferrer noopener" href="https://addons.mozilla.org/firefox/addon/Synclify/"><img alt="Firefox Add-ons" src="https://img.shields.io/badge/Firefox-141e24.svg?&style=for-the-badge&logo=firefox-browser&logoColor=white"></a>  <a rel="noreferrer noopener" href="https://microsoftedge.microsoft.com/addons/detail/synclify/chbmaekcnddeekhpcdefmmalilcinjne"><img alt="Edge Addons" src="https://img.shields.io/badge/Edge-141e24.svg?&style=for-the-badge&logo=microsoft-edge&logoColor=white"></a> 
<p align="center">The aim of Couch is to enable two users to sync any kind of streaming service playback by simply sharing a room code similar to how <a href="https://w2g.tv">w2g.tv</a> works.
Couch is an ad-free open-source browser extension that syncs user's clicks in their browser through a websocket.<br/>
<strong>The project is currently in early development so bugs are to be expected.</strong></p>

## How to contribute

Read more about contributing to Couch in [CONTRIBUTING.md](https://github.com/Synclify/Synclify/blob/master/CONTRIBUTING.md).

## Getting Started

First, run the development server:

```bash
pnpm dev
# or
npm run dev
```

Open your browser and load the appropriate development build. For example, if you are developing for the chrome browser, using manifest v3, use: `build/chrome-mv3-dev`.

For further guidance, [visit the Documentation](https://docs.plasmo.com/)

### One-command local run

Run extension + local room server together:

```bash
npm run dev:all
```

Run extension + local room server + ngrok tunnel together:

```bash
npm run dev:public
```

## Local room server (required for room code sync)

This extension expects a socket backend at `http://localhost:3001`.
Without it, creating/joining room codes will fail with `ERR_CONNECTION_REFUSED`.

Run the local room server in a separate terminal:

```bash
npm run server:dev
```

Then verify:

- Open `http://localhost:3001/create` in your browser
- You should receive a room code string (for example: `A7K2P`)

After that, run the extension dev build:

```bash
npm run dev
```

No paid hosting is needed for local testing. You can run both the extension and the room server entirely on your machine for free.

## Production setup (no manual server start on user machines)

For production, host the socket server once and point the extension to that URL.
End users should only install the extension; they should never run `npm run server:dev`.

### 1) Deploy the room server

Deploy this repo's Node server (entrypoint: `server/index.js`) to a platform like Render/Railway/Fly.

- Start command: `npm start`
- Port: `3001` (or platform-provided `PORT`, already supported)

### 2) Build extension with hosted endpoint

Set `WXT_SOCKET_ENDPOINT` to your hosted HTTPS URL before building.

Example:

```bash
# PowerShell
$env:WXT_SOCKET_ENDPOINT="https://your-api.example.com"
npm run build
```

or via `.env`/`.env.production`:

```bash
WXT_SOCKET_ENDPOINT=https://your-api.example.com
```

Then run:

```bash
npm run build
```

### Fastest free deployment for current code (Render)

If you want no terminal/server steps for end users and minimal engineering changes, deploy the existing Node room server for free:

1. Push this repo to GitHub.
2. Go to [Render](https://render.com) and create a new **Web Service** from the repo.
3. Render will auto-detect `render.yaml` (included in this repo).
4. Wait for deploy, then copy the service URL (for example `https://couch-room-server.onrender.com`).
5. Set extension endpoint before build:

```bash
# PowerShell
$env:WXT_SOCKET_ENDPOINT="https://couch-room-server.onrender.com"
npm run build
```

6. Publish that built extension. End users only install extension; they never run local server commands.

## Making production build

Run the following:

```bash
pnpm build
# or
npm run build
```

This should create a production bundle, ready to be zipped and published to the stores.

Logo branding by [Victor Adetona](https://www.behance.net/victoradetona)
