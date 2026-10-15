import asyncio
import json

import pytest
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from muse_avatar.hub import DisplayHub, origin_allowed, page_url

KEY = "test-key"


async def start(hub: DisplayHub):
    server = await hub.serve("127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    return server, f"ws://127.0.0.1:{port}/"


async def recv_json(ws):
    return json.loads(await asyncio.wait_for(ws.recv(), 5))


def run(coro):
    return asyncio.run(coro)


def test_a_wrong_key_is_refused_before_any_message():
    async def go():
        hub = DisplayHub(key=KEY)
        server, url = await start(hub)
        try:
            async with connect(url + "?key=nope") as ws:
                with pytest.raises(ConnectionClosed) as info:
                    await asyncio.wait_for(ws.recv(), 5)
                assert info.value.rcvd.code == 4401
            assert not hub.clients
        finally:
            server.close()
    run(go())


def test_welcome_then_invoke_round_trip():
    async def go():
        hub = DisplayHub(key=KEY, welcome=lambda: {"node_id": "homelink-abcdef"})
        server, url = await start(hub)
        try:
            async with connect(url + "?key=" + KEY) as ws:
                assert await recv_json(ws) == {"type": "welcome", "node_id": "homelink-abcdef"}
                task = asyncio.ensure_future(hub.invoke("avatar.gesture", {"gesture": "wave"}, 5))
                invoke = await recv_json(ws)
                assert invoke["command"] == "avatar.gesture" and invoke["params"] == {"gesture": "wave"}
                await ws.send(json.dumps({"type": "result", "id": invoke["id"], "ok": True,
                                          "payload": {"gesture": "wave"}}))
                assert await task == {"ok": True, "payload": {"gesture": "wave"}}
        finally:
            server.close()
    run(go())


def test_invoke_without_a_display_or_an_answer():
    async def go():
        hub = DisplayHub(key=KEY)
        assert (await hub.invoke("display.clear", {}, 1))["ok"] is False
        server, url = await start(hub)
        try:
            async with connect(url + "?key=" + KEY) as ws:
                await recv_json(ws)
                result = await hub.invoke("display.clear", {}, 0.2)
                assert result == {"ok": False, "error": "The avatar display did not answer in time."}
        finally:
            server.close()
    run(go())


def test_voice_message_is_paired_with_the_next_binary_frame():
    async def go():
        seen = []

        async def on_request(message, data):
            seen.append((message["type"], data))

        hub = DisplayHub(key=KEY, on_request=on_request)
        server, url = await start(hub)
        try:
            async with connect(url + "?key=" + KEY) as ws:
                await recv_json(ws)
                await ws.send(json.dumps({"type": "voice", "id": "v1"}))
                await ws.send(b"RIFF....WAVE")
                await ws.send(json.dumps({"type": "say", "id": "s1", "text": "hi"}))
                await ws.send(b"stray")   # not announced: dropped
                await ws.send(json.dumps({"type": "voice", "id": "v2", "mime_type": "audio/ogg"}))
                error = await recv_json(ws)
                assert error["type"] == "error" and "unsupported" in error["error"]
                await asyncio.sleep(0.1)
        finally:
            server.close()
        assert seen == [("voice", b"RIFF....WAVE"), ("say", None)]
    run(go())


def test_request_errors_go_back_to_the_page():
    async def go():
        async def on_request(message, data):
            raise ConnectionError("not connected to Muse yet")

        hub = DisplayHub(key=KEY, on_request=on_request)
        server, url = await start(hub)
        try:
            async with connect(url + "?key=" + KEY) as ws:
                await recv_json(ws)
                await ws.send(json.dumps({"type": "say", "id": "s1", "text": "hi"}))
                assert await recv_json(ws) == {"type": "error", "id": "s1", "error": "not connected to Muse yet"}
        finally:
            server.close()
    run(go())


def test_origins():
    assert origin_allowed(None)
    assert origin_allowed("https://joehillthunder.github.io")
    assert origin_allowed("http://localhost:5173")
    assert origin_allowed("http://127.0.0.1")
    assert not origin_allowed("https://evil.example")
    assert not origin_allowed("https://localhost.evil.example")
    assert origin_allowed("https://kiosk.example", ("https://kiosk.example",))


def test_a_foreign_origin_is_refused():
    async def go():
        hub = DisplayHub(key=KEY)
        server, url = await start(hub)
        try:
            async with connect(url + "?key=" + KEY, origin="https://evil.example") as ws:
                with pytest.raises(ConnectionClosed) as info:
                    await asyncio.wait_for(ws.recv(), 5)
                assert info.value.rcvd.code == 4403
        finally:
            server.close()
    run(go())


def test_static_files_never_leave_the_folder(tmp_path):
    (tmp_path / "site").mkdir()
    (tmp_path / "site" / "index.html").write_text("<p>avatar</p>")
    (tmp_path / "secret.txt").write_text("no")

    async def go():
        hub = DisplayHub(key=KEY, static_dir=tmp_path / "site")
        server, url = await start(hub)
        port = int(url.rsplit(":", 1)[1].strip("/"))
        try:
            async def get(path):
                reader, writer = await asyncio.open_connection("127.0.0.1", port)
                writer.write(f"GET {path} HTTP/1.1\r\nHost: x\r\n\r\n".encode())
                await writer.drain()
                data = await asyncio.wait_for(reader.read(65536), 5)
                writer.close()
                return data.decode(errors="replace")

            assert "<p>avatar</p>" in await get("/")
            assert "200 OK" in await get("/index.html")
            assert "404" in (await get("/../secret.txt")).split("\r\n")[0]
            assert "404" in (await get("/%2e%2e/secret.txt")).split("\r\n")[0]
        finally:
            server.close()
    run(go())


def test_page_url_keeps_secrets_in_the_fragment():
    url = page_url("https://x.github.io/app/", "ws://localhost:8765", "a/b+c")
    assert url == "https://x.github.io/app/#bridge=ws://localhost:8765&key=a%2Fb%2Bc"
