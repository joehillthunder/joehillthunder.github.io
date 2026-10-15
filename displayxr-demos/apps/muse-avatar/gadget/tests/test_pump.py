import asyncio

import pytest

from muse_avatar import pump as pump_module
from muse_avatar.pump import ChatPump


def event(name, message_id=None, *, parent=None, session="main", **payload):
    data = {"session_id": session, **payload}
    if message_id is not None:
        data["message_id"] = message_id
    if parent is not None:
        data["reply_to_message_id"] = parent
    return {"type": "event", "event": name, "payload": data}


class FakeHub:
    def __init__(self):
        self.messages = []
        self.audio = []

    async def broadcast(self, message):
        self.messages.append(message)

    async def broadcast_bytes(self, data):
        self.audio.append(data)

    def of(self, kind):
        return [m for m in self.messages if m["type"] == kind]


class FakeSession:
    """Plays a scripted Muse: each request gets the next script of chat events."""

    def __init__(self, scripts, tts=(b"ID3", b"mp3")):
        self.scripts = list(scripts)
        self.tts = tts
        self._events = None
        self.sent = []
        self.counter = 0

    @property
    def events(self) -> asyncio.Queue:
        if self._events is None:   # made inside the running loop, for Python 3.9
            self._events = asyncio.Queue()
        return self._events

    async def subscribe_chat(self, session_id=None):
        while True:
            yield await self.events.get()

    async def _ack(self, kind, payload, modality):
        self.counter += 1
        user_id = f"u{self.counter}"
        self.sent.append((kind, payload, modality))
        for raw in self.scripts.pop(0)(user_id):
            self.events.put_nowait(raw)
        return {"ok": True, "status": 200, "response": {"result": {"message_id": user_id, "session_id": "main"}}}

    async def send_chat(self, message, session_id=None, *, output_modality="text"):
        return await self._ack("chat", message, output_modality)

    async def send_voice(self, wav, session_id=None, *, message="", output_modality=None):
        return await self._ack("voice", wav, output_modality)

    async def _post_chat(self, body):
        return await self._ack("image", body, body.get("output_modality"))

    async def stream_tts(self, message_id):
        for chunk in self.tts:
            yield chunk


def answer(text, reply_id="r1"):
    def script(user_id):
        return [
            event("agent.status", parent=user_id, activity_code="thinking", activity_text="Thinking"),
            event("delta.text_append", reply_id, parent=user_id, text=text[:3]),
            event("delta.message_done", reply_id, parent=user_id, display_text=text),
            event("task.status", parent=user_id, status="completed", task_id="t-" + user_id),
        ]
    return script


@pytest.fixture(autouse=True)
def fast(monkeypatch):
    monkeypatch.setattr(pump_module, "POLL_S", 0.01)


async def until(predicate, timeout=5.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("timed out")
        await asyncio.sleep(0.01)


def run_with_pump(session, body, **options):
    async def go():
        hub = FakeHub()
        pump = ChatPump(session, hub, node_id="homelink-abcdef", **options)
        task = asyncio.ensure_future(pump.run())
        try:
            await body(pump, hub)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
    asyncio.run(go())


def test_spoken_turn_streams_status_text_speech_then_done():
    session = FakeSession([answer("Hello there.")])

    async def body(pump, hub):
        await pump.handle({"type": "say", "id": "s1", "text": " hi ", "speak": True}, None)
        await until(lambda: any(m.get("state") == "done" for m in hub.of("turn")))
        assert session.sent == [("chat", "hi", "voice")]
        assert [m["state"] for m in hub.of("turn")] == ["sending", "sent", "done"]
        assert hub.of("status")[0]["code"] == "thinking"
        replies = hub.of("reply")
        assert replies[0] == {"type": "reply", "id": "s1", "message_id": "r1", "text": "Hel", "done": False}
        assert replies[-1]["text"] == "Hello there." and replies[-1]["done"]
        assert hub.of("tts_start")[0]["message_id"] == "r1"
        assert hub.audio == [b"ID3", b"mp3"]
        assert hub.of("tts_end")[0]["bytes"] == 6
        kinds = [m["type"] for m in hub.messages]
        assert kinds.index("tts_end") < len(kinds) - 1 - kinds[::-1].index("turn")
        assert hub.of("mirror") == []

    run_with_pump(session, body)


def test_text_turn_is_not_spoken():
    session = FakeSession([answer("Quiet.")])

    async def body(pump, hub):
        await pump.handle({"type": "say", "id": "s1", "text": "hi", "speak": False}, None)
        await until(lambda: any(m.get("state") == "done" for m in hub.of("turn")))
        assert session.sent == [("chat", "hi", "text")]
        assert hub.of("tts_start") == [] and hub.audio == []

    run_with_pump(session, body)


def test_voice_note_goes_to_send_voice():
    session = FakeSession([answer("Heard you.")])

    async def body(pump, hub):
        await pump.handle({"type": "voice", "id": "v1"}, b"RIFFwav")
        await until(lambda: any(m.get("state") == "done" for m in hub.of("turn")))
        assert session.sent == [("voice", b"RIFFwav", "voice")]

    run_with_pump(session, body)


def test_other_conversations_are_mirrored_once():
    session = FakeSession([])

    async def body(pump, hub):
        session.events.put_nowait(event("delta.message_done", "p1", parent="phone", display_text="From the phone"))
        session.events.put_nowait(event("message.assistant", "p1", parent="phone", display_text="From the phone"))
        session.events.put_nowait(event("message.assistant", "q1", parent="phone", role="user", content="me"))
        await until(lambda: hub.of("mirror"))
        await asyncio.sleep(0.05)
        assert hub.of("mirror") == [{"type": "mirror", "message_id": "p1", "text": "From the phone"}]

    run_with_pump(session, body)


def test_own_replies_are_never_mirrored_even_after_the_turn():
    session = FakeSession([answer("Mine.")])

    async def body(pump, hub):
        await pump.handle({"type": "say", "id": "s1", "text": "hi", "speak": False}, None)
        await until(lambda: any(m.get("state") == "done" for m in hub.of("turn")))
        session.events.put_nowait(event("message.assistant", "r1", parent="u1", display_text="Mine."))
        await asyncio.sleep(0.05)
        assert hub.of("mirror") == []

    run_with_pump(session, body)


def test_look_needs_vision_and_is_marked_experimental():
    session = FakeSession([answer("A cat.")])

    async def body(pump, hub):
        with pytest.raises(ValueError, match="--vision"):
            await pump.handle({"type": "look", "id": "l1"}, b"\xff\xd8jpeg")

    run_with_pump(session, body)
    session = FakeSession([answer("A cat.")])

    async def body_on(pump, hub):
        await pump.handle({"type": "look", "id": "l1", "text": "What is this?", "mime_type": "image/jpeg"},
                          b"\xff\xd8jpeg")
        await until(lambda: any(m.get("state") == "done" for m in hub.of("turn")))
        kind, sent, modality = session.sent[0]
        assert kind == "image" and modality == "voice"
        assert sent["message"] == "What is this?" and sent["device_id"] == "homelink-abcdef"
        assert sent["items"][0]["mime_type"] == "image/jpeg"

    run_with_pump(session, body_on, vision=True)


def test_empty_requests_are_refused():
    async def body(pump, hub):
        with pytest.raises(ValueError):
            await pump.handle({"type": "say", "id": "s1", "text": "  "}, None)
        with pytest.raises(ValueError):
            await pump.handle({"type": "voice", "id": "v1"}, None)
        with pytest.raises(ValueError):
            await pump.handle({"type": "dance"}, None)

    run_with_pump(FakeSession([]), body)
