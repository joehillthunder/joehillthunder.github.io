"""Rehearse the page <-> bridge path with no Muse account, Pi or Bluetooth.

Runs the real DisplayHub and ChatPump against a scripted Muse session: replies
stream as chat events through the SDK's MuseTurn, display commands go through
the same validation and invoke round trip Muse's would, and spoken replies are
real MP3 (a synthesized hum, so the mouth has something to follow).

Needs Meta's SDK (for musegadget.muse_turn, pure Python) and lameenc:

    uv run --with websockets --with lameenc --with <muse-gadget-sdk>/linux --with . \
        python tools/rehearsal.py

then open the page with #bridge=ws://localhost:8765&key=rehearsal, for example
http://localhost:8090/#bridge=ws://localhost:8765&key=rehearsal
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import math
import struct

from muse_avatar.commands import validate
from muse_avatar.hub import DisplayHub
from muse_avatar.pump import ChatPump

log = logging.getLogger("rehearsal")

SCRIPT = [
    ("planet", "Here is a ringed planet. Lean left and right to look around it.",
     [("display.show_shape", {"shape": "planet", "caption": "A ringed planet"}), ("avatar.express", {"expression": "excited", "seconds": 3})]),
    ("card", "Here are your three meetings today.",
     [("display.show_card", {"title": "Today", "bullets": "9:30 Stand-up\n13:00 Design review\n16:00 1:1 with Sam"})]),
    ("wave", "Hello from the bridge!", [("avatar.gesture", {"gesture": "wave"})]),
    ("clear", "All clear.", [("display.clear", {})]),
]


def hum_mp3(seconds: float) -> bytes:
    """A voice-like hum with syllable-rate amplitude, as MP3."""
    import lameenc

    rate = 22050
    frames = bytearray()
    for i in range(int(seconds * rate)):
        t = i / rate
        envelope = max(0.0, math.sin(t * math.pi * 3.2)) ** 0.6
        sample = envelope * 0.35 * (math.sin(2 * math.pi * 170 * t) + 0.5 * math.sin(2 * math.pi * 340 * t))
        frames += struct.pack("<h", int(max(-1, min(1, sample)) * 32767))
    enc = lameenc.Encoder()
    enc.set_bit_rate(64)
    enc.set_in_sample_rate(rate)
    enc.set_channels(1)
    enc.set_quality(5)
    return enc.encode(bytes(frames)) + enc.flush()


class ScriptedSession:
    """Just enough of LinkSession for ChatPump: a chat to post to, events back, TTS."""

    def __init__(self, hub: DisplayHub):
        self.hub = hub
        self.events: asyncio.Queue = asyncio.Queue()
        self.n = 0
        self.mp3: dict[str, bytes] = {}

    async def subscribe_chat(self, session_id=None):
        while True:
            yield await self.events.get()

    async def send_chat(self, message, session_id=None, *, output_modality="text"):
        return self._answer(message.lower(), output_modality == "voice")

    async def send_voice(self, wav, session_id=None, *, message="", output_modality=None):
        log.info("voice note: %d bytes of WAV", len(wav))
        return self._answer("planet", output_modality == "voice")

    def _answer(self, text: str, speak: bool) -> dict:
        self.n += 1
        user_id = f"u{self.n}"
        reply_id = f"a{self.n}"
        line, commands = "I am the rehearsal Muse. Try: planet, card, wave or clear.", []
        for word, answer, actions in SCRIPT:
            if word in text:
                line, commands = answer, actions
        asyncio.ensure_future(self._play(user_id, reply_id, line, commands, speak))
        return {"ok": True, "status": 200, "response": {"result": {"message_id": user_id, "session_id": "main"}}}

    async def _play(self, user_id, reply_id, line, commands, speak):
        def event(name, **payload):
            return {"type": "event", "event": name,
                    "payload": {"session_id": "main", "reply_to_message_id": user_id, **payload}}

        await asyncio.sleep(0.3)
        self.events.put_nowait(event("agent.status", activity_code="thinking", activity_text="Thinking"))
        await asyncio.sleep(0.6)
        for command, params in commands:
            result = await self.hub.invoke(command, validate(command, params), 10)
            log.info("%s -> %s", command, result)
        words = line.split()
        for i in range(2, len(words), 2):
            self.events.put_nowait(event("delta.text_append", message_id=reply_id, text=" ".join(words[i - 2:i]) + " "))
            await asyncio.sleep(0.08)
        if speak:
            self.mp3[reply_id] = hum_mp3(1.2 + 0.06 * len(line))
        self.events.put_nowait(event("delta.message_done", message_id=reply_id, display_text=line))
        self.events.put_nowait(event("task.status", status="completed", task_id="t" + user_id))

    async def stream_tts(self, message_id):
        data = self.mp3.pop(message_id, b"")
        for i in range(0, len(data), 4096):
            await asyncio.sleep(0.02)
            yield data[i:i + 4096]


async def main(port: int, key: str) -> None:
    pump_box = {}

    async def on_request(message, data):
        await pump_box["pump"].handle(message, data)

    hub = DisplayHub(key=key, on_request=on_request, welcome=lambda: {
        "bridge_version": "rehearsal", "sdk_version": "-", "node_id": "homelink-rehrsl", "display_name": "rehearsal",
        "muse_connected": True, "muse_name": "Rehearsal Muse", "side_chat": False, "vision": False,
        "system_commands": False, "commands": [],
    })
    session = ScriptedSession(hub)
    pump_box["pump"] = ChatPump(session, hub, node_id="homelink-rehrsl")
    await hub.serve("127.0.0.1", port)
    log.info("open the page with #bridge=ws://localhost:%d&key=%s", port, key)
    await pump_box["pump"].run()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--key", default="rehearsal")
    parser.add_argument("-v", "--verbose", action="store_true", help="log every HTTP and WebSocket frame")
    args = parser.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(name)s: %(message)s")
    asyncio.run(main(args.port, args.key))
