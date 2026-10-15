"""The local WebSocket the avatar page connects to.

One hub serves any number of display pages. Every page must present the
bridge key (``?key=``); without it the socket closes before any message. The
bridge listens on 127.0.0.1 by default, so a display on another machine
reaches it through an SSH tunnel and still connects to ``localhost``, the one
plain-ws origin browsers let an https page and its microphone use.

Text frames are JSON. Binary frames carry audio: the bridge streams Muse's
MP3 speech between ``tts_start`` and ``tts_end``, and a page sends a WAV voice
note (or a camera still) as the binary frame right after the ``voice`` (or
``look``) message that announces it.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import mimetypes
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Awaitable, Callable, Optional
from urllib.parse import parse_qs, urlsplit

log = logging.getLogger(__name__)

MAX_FRAME_BYTES = 3 * 1024 * 1024
DEFAULT_ORIGINS = (
    "https://joehillthunder.github.io",
)
_LOCAL_HOSTS = ("localhost", "127.0.0.1", "[::1]")
_UPLOAD_TYPES = {"voice": ("audio/wav",), "look": ("image/jpeg", "image/png")}

RequestHandler = Callable[[dict, Optional[bytes]], Awaitable[None]]


def origin_allowed(origin: Optional[str], extra: tuple[str, ...] = ()) -> bool:
    """Pages from this repo's site, from localhost, or listed with --allow-origin.

    A client without an Origin header is not a browser page (a test, a script on
    this machine) and still needs the key.
    """
    if not origin:
        return True
    if origin in DEFAULT_ORIGINS or origin in extra:
        return True
    parts = urlsplit(origin)
    return parts.scheme in ("http", "https") and parts.hostname in ("localhost", "127.0.0.1", "::1")


@dataclass(eq=False)
class Client:
    connection: object
    name: str = "page"
    pending: Optional[dict] = None   # a voice/look message waiting for its binary frame

    async def send_json(self, message: dict) -> None:
        await self.connection.send(json.dumps(message, separators=(",", ":")))

    async def send_bytes(self, data: bytes) -> None:
        await self.connection.send(data)


@dataclass
class DisplayHub:
    key: str
    on_request: Optional[RequestHandler] = None
    welcome: Callable[[], dict] = dict
    extra_origins: tuple[str, ...] = ()
    static_dir: Optional[Path] = None
    clients: set[Client] = field(default_factory=set)
    _results: dict[str, asyncio.Future] = field(default_factory=dict)
    _loop: Optional[asyncio.AbstractEventLoop] = None

    # -- Server ---------------------------------------------------------------

    async def serve(self, host: str, port: int):
        from websockets.asyncio.server import serve

        self._loop = asyncio.get_running_loop()
        server = await serve(self.handle, host, port, max_size=MAX_FRAME_BYTES,
                             process_request=self._process_request)
        log.info("display hub listening on ws://%s:%d", host if host not in ("", "0.0.0.0") else "*", port)
        return server

    def _process_request(self, connection, request):
        """Serve the page itself for plain HTTP requests when --serve is set."""
        if request.headers.get("Upgrade", "").lower() == "websocket":
            return None
        if self.static_dir is None:
            return connection.respond(404, "This is the Muse avatar bridge. Open the avatar page.\n")
        return self._static_response(connection, request.path)

    def _static_response(self, connection, raw_path: str):
        from websockets.datastructures import Headers
        from websockets.http11 import Response

        path = urlsplit(raw_path).path
        if path.endswith("/"):
            path += "index.html"
        root = self.static_dir.resolve()
        target = (root / path.lstrip("/")).resolve()
        if root != target and root not in target.parents or not target.is_file():
            return connection.respond(404, "Not found\n")
        body = target.read_bytes()
        mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if target.suffix == ".js":
            mime = "text/javascript"
        headers = Headers([("Content-Type", mime), ("Content-Length", str(len(body))),
                           ("Cache-Control", "no-cache")])
        return Response(200, "OK", headers, body)

    async def handle(self, connection) -> None:
        request = getattr(connection, "request", None)
        query = parse_qs(urlsplit(getattr(request, "path", "") or "").query)
        offered = (query.get("key") or [""])[0]
        origin = request.headers.get("Origin") if request is not None else None
        if not origin_allowed(origin, self.extra_origins):
            log.warning("refused a display page from %s", origin)
            await connection.close(4403, "origin not allowed")
            return
        if not hmac.compare_digest(offered.encode(), self.key.encode()):
            log.warning("refused a display page with a wrong key")
            await connection.close(4401, "wrong bridge key")
            return
        client = Client(connection)
        self.clients.add(client)
        log.info("display connected (%d open)", len(self.clients))
        try:
            await client.send_json({"type": "welcome", **self.welcome()})
            async for frame in connection:
                await self._receive(client, frame)
        except Exception as exc:  # a page vanishing mid-frame is normal
            log.debug("display connection ended: %s", exc)
        finally:
            self.clients.discard(client)
            log.info("display disconnected (%d open)", len(self.clients))

    async def _receive(self, client: Client, frame) -> None:
        if isinstance(frame, (bytes, bytearray)):
            pending, client.pending = client.pending, None
            if pending is None:
                log.warning("dropping a binary frame nobody announced")
                return
            await self._dispatch(client, pending, bytes(frame))
            return
        try:
            message = json.loads(frame)
        except ValueError:
            log.warning("dropping a malformed message from a display")
            return
        if not isinstance(message, dict):
            return
        kind = message.get("type")
        if kind == "result":
            future = self._results.get(str(message.get("id")))
            if future is not None and not future.done():
                future.set_result(message)
            return
        if kind == "hello":
            client.name = str(message.get("client") or "page")[:40]
            return
        if kind in _UPLOAD_TYPES:
            mime = message.get("mime_type") or _UPLOAD_TYPES[kind][0]
            if mime not in _UPLOAD_TYPES[kind]:
                await client.send_json({"type": "error", "id": message.get("id"), "error": f"{kind}: unsupported {mime}"})
                return
            client.pending = message
            return
        await self._dispatch(client, message, None)

    async def _dispatch(self, client: Client, message: dict, data: Optional[bytes]) -> None:
        if self.on_request is None:
            await client.send_json({"type": "error", "id": message.get("id"), "error": "not connected to Muse"})
            return
        try:
            await self.on_request(message, data)
        except Exception as exc:
            log.warning("display request %s failed: %s", message.get("type"), exc)
            await client.send_json({"type": "error", "id": message.get("id"), "error": str(exc)})

    # -- Fan-out --------------------------------------------------------------

    async def broadcast(self, message: dict) -> None:
        text = json.dumps(message, separators=(",", ":"))
        await asyncio.gather(*(c.connection.send(text) for c in list(self.clients)), return_exceptions=True)

    async def broadcast_bytes(self, data: bytes) -> None:
        await asyncio.gather(*(c.connection.send(data) for c in list(self.clients)), return_exceptions=True)

    # -- Commands from Muse ---------------------------------------------------

    async def invoke(self, command: str, params: dict, timeout_s: float) -> dict:
        """Run a display command on every open page; the first answer wins.

        Returns a ``link.result``-shaped dict: ``{"ok": True, "payload": …}`` or
        ``{"ok": False, "error": …}``.
        """
        if not self.clients:
            return {"ok": False, "error": "No avatar display is open. Ask the user to open the avatar page."}
        invoke_id = uuid.uuid4().hex
        future = asyncio.get_running_loop().create_future()
        self._results[invoke_id] = future
        try:
            await self.broadcast({"type": "invoke", "id": invoke_id, "command": command, "params": params})
            reply = await asyncio.wait_for(future, timeout_s)
        except asyncio.TimeoutError:
            return {"ok": False, "error": "The avatar display did not answer in time."}
        finally:
            self._results.pop(invoke_id, None)
        if reply.get("ok"):
            payload = reply.get("payload")
            return {"ok": True, "payload": payload if isinstance(payload, dict) else {}}
        return {"ok": False, "error": str(reply.get("error") or "the display refused the command")[:500]}

    def invoke_threadsafe(self, command: str, params: dict, timeout_s: float) -> dict:
        """``invoke`` for the worker thread LinkSession runs commands on."""
        if self._loop is None:
            return {"ok": False, "error": "the display hub is not running"}
        future = asyncio.run_coroutine_threadsafe(self.invoke(command, params, timeout_s), self._loop)
        return future.result(timeout_s + 5)


def page_url(base: str, bridge: str, key: str) -> str:
    """The address to open: the page, told where the bridge is and its key.

    Both go in the fragment, which the browser never sends to the page's host.
    """
    from urllib.parse import quote

    return f"{base}#bridge={quote(bridge, safe=':/')}&key={quote(key, safe='')}"


def is_local_host(host: str) -> bool:
    return host in _LOCAL_HOSTS or host == "::1"
