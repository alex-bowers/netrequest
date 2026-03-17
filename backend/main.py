import asyncio
import hmac
import ipaddress
import json
import os
import socket
import time
from urllib.parse import urlparse
from typing import Any, Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from playwright.async_api import async_playwright
import uvicorn

app = FastAPI(title="NetRequest Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ALLOW_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)

MAX_BODY_CHARS = int(os.getenv("MAX_BODY_CHARS", "15000"))
MAX_POST_DATA_CHARS = int(os.getenv("MAX_POST_DATA_CHARS", "4000"))
MAX_CONCURRENT_INSPECTIONS = int(os.getenv("MAX_CONCURRENT_INSPECTIONS", "2"))
ALLOW_CAPTURE_BODY = os.getenv("ALLOW_CAPTURE_BODY", "false").lower() == "true"
NAVIGATION_TIMEOUT_MS = int(os.getenv("NAVIGATION_TIMEOUT_MS", "30000"))
API_KEY = os.getenv("NETREQUEST_API_KEY", "").strip()
ALLOWED_WS_ORIGINS = {
    origin.strip()
    for origin in os.getenv("ALLOWED_WS_ORIGINS", "").split(",")
    if origin.strip()
}
SENSITIVE_HEADER_KEYS = {
    "authorization",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "x-api-key",
}
BLOCKED_HOSTNAMES = {
    "localhost",
    "localhost.localdomain",
}

inspection_slots = asyncio.Semaphore(MAX_CONCURRENT_INSPECTIONS)


class InspectRequest(BaseModel):
    url: str
    capture_responses: bool = True
    capture_headers: bool = True
    capture_body: bool = False
    filter_types: Optional[list[str]] = None  # e.g. ["fetch", "xhr", "document"]


def truncate(value: Optional[str], limit: int) -> Optional[str]:
    if value is None:
        return None
    if len(value) <= limit:
        return value
    return value[:limit] + "\n\n... [truncated]"


def redact_headers(headers: dict[str, Any]) -> dict[str, Any]:
    redacted: dict[str, Any] = {}
    for key, value in headers.items():
        if key.lower() in SENSITIVE_HEADER_KEYS:
            redacted[key] = "[redacted]"
        else:
            redacted[key] = value
    return redacted


async def resolve_host_ips(host: str) -> list[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, None, family=socket.AF_UNSPEC, type=socket.SOCK_STREAM)
    resolved = []
    for info in infos:
        sockaddr = info[4]
        ip_str = sockaddr[0]
        resolved.append(ipaddress.ip_address(ip_str))
    return resolved


async def validate_target_url(raw_url: str) -> None:
    parsed = urlparse(raw_url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("Only http/https URLs are allowed.")
    if not parsed.hostname:
        raise ValueError("URL must include a valid hostname.")

    host = parsed.hostname.strip().lower()
    if host in BLOCKED_HOSTNAMES or host.endswith(".local"):
        raise ValueError("Target hostname is not allowed.")

    try:
        ips = await resolve_host_ips(host)
    except Exception:
        raise ValueError("Unable to resolve target hostname.")

    if not ips:
        raise ValueError("Unable to resolve target hostname.")

    for ip_addr in ips:
        if (
            ip_addr.is_private
            or ip_addr.is_loopback
            or ip_addr.is_link_local
            or ip_addr.is_multicast
            or ip_addr.is_reserved
            or ip_addr.is_unspecified
        ):
            raise ValueError("Target resolves to a blocked IP range.")


@app.websocket("/ws/inspect")
async def inspect_ws(websocket: WebSocket):
    """
    WebSocket endpoint. Client sends JSON config, server streams
    network events back in real time as the page loads.
    """
    origin = websocket.headers.get("origin", "")
    if ALLOWED_WS_ORIGINS and origin not in ALLOWED_WS_ORIGINS:
        await websocket.close(code=1008)
        return

    if API_KEY:
        incoming_key = (
            websocket.headers.get("x-api-key", "").strip()
            or websocket.query_params.get("api_key", "").strip()
        )
        if not hmac.compare_digest(incoming_key, API_KEY):
            await websocket.close(code=1008)
            return

    await websocket.accept()

    try:
        async with inspection_slots:
            # Receive inspection config
            raw = await websocket.receive_text()
            if len(raw) > 20000:
                await websocket.send_json({"type": "error", "message": "Request config is too large."})
                return

            config = InspectRequest(**json.loads(raw))
            await validate_target_url(config.url)

            if not ALLOW_CAPTURE_BODY:
                config.capture_body = False

            await websocket.send_json({"type": "status", "message": "Launching browser..."})

            async with async_playwright() as p:
                browser = await p.chromium.launch(headless=True)
                context = await browser.new_context(
                    ignore_https_errors=False,
                    user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                )
                page = await context.new_page()

                # Track in-flight requests
                pending: dict[str, dict] = {}

                async def on_request(request):
                    resource_type = request.resource_type
                    if config.filter_types and resource_type not in config.filter_types:
                        return

                    req_id = str(id(request))
                    request_headers = dict(request.headers) if config.capture_headers else {}
                    request_post_data = truncate(request.post_data, MAX_POST_DATA_CHARS) if config.capture_body else None
                    pending[req_id] = {
                        "id": req_id,
                        "url": request.url,
                        "method": request.method,
                        "resource_type": resource_type,
                        "start_time": time.time(),
                        "headers": redact_headers(request_headers) if config.capture_headers else {},
                        "post_data": request_post_data,
                    }

                    await websocket.send_json({
                        "type": "request",
                        "data": pending[req_id]
                    })

                async def on_response(response):
                    req_id = str(id(response.request))
                    req_data = pending.get(req_id, {})
                    duration = round((time.time() - req_data.get("start_time", time.time())) * 1000)

                    body = None
                    content_type = response.headers.get("content-type", "")

                    if config.capture_body:
                        try:
                            if any(t in content_type for t in ["json", "text", "xml", "javascript", "html"]):
                                body = truncate(await response.text(), MAX_BODY_CHARS)
                        except Exception:
                            body = None

                    event = {
                        "type": "response",
                        "data": {
                            "id": req_id,
                            "url": response.url,
                            "status": response.status,
                            "status_text": response.status_text,
                            "duration_ms": duration,
                            "content_type": content_type,
                            "headers": redact_headers(dict(response.headers)) if config.capture_headers else {},
                            "body": body,
                            "resource_type": req_data.get("resource_type", "unknown"),
                            "method": req_data.get("method", "GET"),
                        }
                    }
                    await websocket.send_json(event)

                async def on_request_failed(request):
                    req_id = str(id(request))
                    req_data = pending.get(req_id, {})
                    await websocket.send_json({
                        "type": "request_failed",
                        "data": {
                            "id": req_id,
                            "url": request.url,
                            "method": request.method,
                            "failure": request.failure,
                            "resource_type": req_data.get("resource_type", "unknown"),
                        }
                    })

                page.on("request", on_request)
                page.on("response", on_response)
                page.on("requestfailed", on_request_failed)

                await websocket.send_json({"type": "status", "message": f"Navigating to {config.url}..."})

                try:
                    await page.goto(config.url, wait_until="networkidle", timeout=NAVIGATION_TIMEOUT_MS)
                    await websocket.send_json({"type": "status", "message": "Page loaded. Waiting for late requests..."})
                    await asyncio.sleep(3)
                except Exception:
                    await websocket.send_json({"type": "error", "message": "Navigation failed."})

                await browser.close()
                await websocket.send_json({"type": "done", "message": "Capture complete."})

    except WebSocketDisconnect:
        pass
    except ValueError as e:
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
    except Exception:
        try:
            await websocket.send_json({"type": "error", "message": "Internal server error."})
        except Exception:
            pass


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8001, reload=False)
