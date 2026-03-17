# NetRequest

NetRequest is a browser-based network inspector that captures requests and responses for a target URL using Playwright in a backend service, then streams events to a frontend UI over WebSocket.

## What This Repository Contains

- `backend/main.py`: FastAPI WebSocket service that launches headless Chromium and captures network activity.
- `frontend/index.html`: Static UI.
- `frontend/script.js`: WebSocket client, filtering, and request/response rendering logic.
- `frontend/style.css`: UI styling.
