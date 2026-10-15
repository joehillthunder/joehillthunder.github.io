"""Talk to Muse for the avatar page, and relay Muse's answers back to it.

One ChatPump lives for one Muse session. It keeps a chat subscription open,
sends what the page asks (typed text, a WAV voice note, a camera still), and
follows each request with the SDK's ``MuseTurn``, which picks this request's
replies and status out of the chat's event stream. What the page gets:

* ``turn``: the request was sent (``state: "sent"``) or finished (``"done"``);
* ``status``: Muse's public progress (thinking, researching, …);
* ``reply``: the reply text so far, then the final text with ``done: true``;
* ``tts_start`` / binary MP3 frames / ``tts_end``: Muse's spoken reply;
* ``mirror``: assistant text from other conversations on the same chat, so the
  page can caption what Muse says on the phone too (the page decides whether to).

One request runs at a time. A new one retires the previous turn, so talking
over Muse works the way it does on the phone.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import time
from typing import Optional

from musegadget.muse_turn import AgentStatus, MuseTurn, ReplayScope, Reply

log = logging.getLogger(__name__)

TURN_TIMEOUT_S = 180.0
POLL_S = 0.25
SUBSCRIBE_RETRY_S = 3.0
_MIRROR_EVENTS = ("message.assistant", "delta.message_done")
MAX_LOOK_BYTES = 1_500_000


class ChatPump:
    def __init__(self, session, hub, *, node_id: str, session_id: Optional[str] = None,
                 vision: bool = False) -> None:
        self.session = session
        self.hub = hub
        self.node_id = node_id
        self.session_id = session_id
        self.owns_chat = session_id is not None
        self.vision = vision
        self.scope = ReplayScope()
        self._turn: Optional[MuseTurn] = None
        self._turn_id: Optional[str] = None
        self._speak = False
        self._spoken: set[str] = set()
        self._tts_queue: asyncio.Queue = asyncio.Queue()
        self._tts_busy = False
        self._mirrored: dict[str, None] = {}
        self._own: dict[str, None] = {}   # reply ids of the avatar's own turns, never mirrored

    # -- Lifecycle --------------------------------------------------------------

    async def run(self) -> None:
        """Hold the chat subscription and the speech queue until cancelled."""
        speaker = asyncio.ensure_future(self._speak_loop())
        try:
            while True:
                try:
                    async for event in self.session.subscribe_chat(self.session_id):
                        await self._on_event(event)
                    log.info("chat subscription ended; reopening")
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    log.warning("chat subscription failed: %s", exc)
                await asyncio.sleep(SUBSCRIBE_RETRY_S)
        finally:
            speaker.cancel()
            await asyncio.gather(speaker, return_exceptions=True)

    # -- Requests from the page ------------------------------------------------

    async def handle(self, message: dict, data: Optional[bytes]) -> None:
        kind = message.get("type")
        request_id = str(message.get("id") or "")[:64]
        speak = bool(message.get("speak", True))
        if kind == "say":
            text = message.get("text")
            if not isinstance(text, str) or not text.strip():
                raise ValueError("say: text is empty")
            await self._request(request_id, speak, lambda: self.session.send_chat(
                text.strip()[:4000], self.session_id, output_modality="voice" if speak else "text"))
        elif kind == "voice":
            if not data:
                raise ValueError("voice: no audio arrived")
            await self._request(request_id, speak, lambda: self.session.send_voice(
                data, self.session_id, output_modality="voice" if speak else None))
        elif kind == "look":
            if not self.vision:
                raise ValueError("look: start the bridge with --vision to send camera images")
            if not data or len(data) > MAX_LOOK_BYTES:
                raise ValueError("look: the image is empty or over 1.5 MB")
            prompt = message.get("text") if isinstance(message.get("text"), str) else ""
            await self._request(request_id, speak, lambda: self._send_image(
                data, str(message.get("mime_type") or "image/jpeg"), prompt, speak))
        elif kind == "stop_speech":
            self._drop_speech()
        else:
            raise ValueError(f"unknown request {kind!r}")

    async def _send_image(self, data: bytes, mime: str, prompt: str, speak: bool) -> dict:
        # EXPERIMENTAL: the SDK documents file items only for audio/wav voice notes
        # (LinkSession.send_voice). This sends an image the same way.
        body = {
            "message": prompt or "This is what my camera sees right now.",
            "device_id": self.node_id,
            "items": [{
                "type": "file", "mime_type": mime,
                "filename": "avatar_camera.jpg" if mime == "image/jpeg" else "avatar_camera.png",
                "data_base64": base64.b64encode(data).decode("ascii"),
            }],
        }
        if self.session_id:
            body["session_id"] = self.session_id
        if speak:
            body["output_modality"] = "voice"
        return await self.session._post_chat(body)

    async def _request(self, request_id: str, speak: bool, send) -> None:
        self._retire_turn()
        self._drop_speech()
        turn = MuseTurn(self.session_id, owns_chat=self.owns_chat,
                        replay_scope=self.scope if self.owns_chat else None)
        self._turn, self._turn_id, self._speak = turn, request_id, speak
        await self.hub.broadcast({"type": "turn", "id": request_id, "state": "sending"})
        ack = await send()
        if self._turn is not turn:
            return  # a newer request replaced this one while it was sending
        if not ack.get("ok"):
            self._turn = None
            raise ConnectionError(f"Muse refused the message (HTTP {ack.get('status')})")
        held = turn.acknowledge(ack.get("response") or {})
        await self.hub.broadcast({"type": "turn", "id": request_id, "state": "sent"})
        await self._emit(turn, held)
        asyncio.ensure_future(self._watch(turn, request_id))

    # -- Events from Muse ------------------------------------------------------

    async def _on_event(self, event: dict) -> None:
        turn = self._turn
        if turn is not None:
            try:
                results = turn.feed(event)
            except ValueError as exc:
                log.warning("dropping an oversized turn: %s", exc)
                self._retire_turn()
                return
            if results:
                await self._emit(turn, results)
                return
        elif self.owns_chat:
            self.scope.observe_idle(event, self.session_id)
        await self._mirror(event)

    async def _emit(self, turn: MuseTurn, results) -> None:
        if turn is not self._turn:
            return
        for result in results:
            if isinstance(result, AgentStatus):
                await self.hub.broadcast({"type": "status", "id": self._turn_id,
                                          "code": result.activity_code, "text": result.activity_text})
            elif isinstance(result, Reply):
                _remember(self._own, result.message_id)
                await self.hub.broadcast({"type": "reply", "id": self._turn_id, "message_id": result.message_id,
                                          "text": result.text, "done": result.done})
                if result.done and self._speak and result.text.strip() and result.message_id not in self._spoken:
                    self._spoken.add(result.message_id)
                    self._tts_queue.put_nowait((self._turn_id, result.message_id))

    async def _mirror(self, event: dict) -> None:
        name = event.get("event")
        payload = event.get("payload")
        if name not in _MIRROR_EVENTS or not isinstance(payload, dict) or payload.get("role") == "user":
            return
        text = payload.get("display_text")
        if not isinstance(text, str):
            text = payload.get("content")
        message_id = payload.get("message_id") or event.get("message_id")
        if not isinstance(text, str) or not text.strip() or not isinstance(message_id, str):
            return
        if message_id in self._own or message_id in self._mirrored:
            return
        _remember(self._mirrored, message_id)
        await self.hub.broadcast({"type": "mirror", "message_id": message_id, "text": text[:4000]})

    async def _watch(self, turn: MuseTurn, request_id: str) -> None:
        started = time.monotonic()
        while self._turn is turn:
            now = time.monotonic()
            timed_out = now - started > TURN_TIMEOUT_S
            if timed_out or (turn.complete(now) and self._tts_queue.empty() and not self._tts_busy):
                self._retire_turn()
                await self.hub.broadcast({"type": "turn", "id": request_id, "state": "done",
                                          "timed_out": timed_out})
                return
            await asyncio.sleep(POLL_S)

    def _retire_turn(self) -> None:
        if self._turn is not None:
            self._turn.retire()
        self._turn = None

    # -- Speech ----------------------------------------------------------------

    def _drop_speech(self) -> None:
        while not self._tts_queue.empty():
            self._tts_queue.get_nowait()

    async def _speak_loop(self) -> None:
        while True:
            request_id, message_id = await self._tts_queue.get()
            self._tts_busy = True
            try:
                await self._stream(request_id, message_id)
            finally:
                self._tts_busy = self._tts_queue.qsize() > 0

    async def _stream(self, request_id: str, message_id: str) -> None:
        await self.hub.broadcast({"type": "tts_start", "id": request_id, "message_id": message_id,
                                  "mime_type": "audio/mpeg"})
        error = None
        sent = 0
        try:
            async for chunk in self.session.stream_tts(message_id):
                sent += len(chunk)
                await self.hub.broadcast_bytes(chunk)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            error = str(exc)
            log.warning("speech for a reply failed: %s", exc)
        await self.hub.broadcast({"type": "tts_end", "id": request_id, "message_id": message_id,
                                  "bytes": sent, "error": error})


def _remember(ids: dict, value: str, limit: int = 256) -> None:
    """Add to an insertion-ordered set, forgetting the oldest past ``limit``."""
    ids[value] = None
    while len(ids) > limit:
        del ids[next(iter(ids))]
