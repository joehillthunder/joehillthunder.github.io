"""AvatarService on top of the Linux SDK's Service (Linux only, like the SDK)."""

import asyncio
import threading

import pytest

pytest.importorskip("pwd")

from musegadget.executor import Account, Executor  # noqa: E402
from musegadget.identity import Identity  # noqa: E402

from muse_avatar.hub import DisplayHub  # noqa: E402
from muse_avatar.service import AvatarService  # noqa: E402


def make(**options):
    service = AvatarService(identity=Identity("02:11:22:33:44:55"), executor=Executor(Account.current()),
                            display_name="pi", **options)
    service.hub = DisplayHub(key="k")
    return service


def test_registration_merges_or_drops_the_sdk_commands():
    with_system = make().commands()
    assert "system.run" in with_system and "device.health" in with_system and "avatar.express" in with_system
    only_avatar = make(system_commands=False).commands()
    assert "system.run" not in only_avatar and "display.show_card" in only_avatar


def test_avatar_commands_are_validated_then_sent_to_the_page():
    service = make()
    loop = asyncio.new_event_loop()
    service.hub._loop = loop
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    try:
        assert service.run_command("avatar.express", {"expression": "smug"}) == {
            "ok": False, "error": "expression must be one of: neutral, happy, excited, thinking, surprised, "
                                  "sad, confused, wink, love, sleepy"}
        # Valid, but no page is open: the hub answers for it.
        result = service.run_command("avatar.express", {"expression": "happy"}, 2000)
        assert result["ok"] is False and "No avatar display" in result["error"]
    finally:
        loop.call_soon_threadsafe(loop.stop)
        thread.join(5)


def test_system_commands_still_run_and_can_be_switched_off():
    assert make().run_command("system.run", {"command": "echo hi"}, 5000)["payload"]["stdout"].strip() == "hi"
    assert make(system_commands=False).run_command("system.run", {"command": "echo hi"}) == {
        "ok": False, "error": "unknown command 'system.run'"}


def test_welcome_describes_the_bridge():
    hello = make(vision=True).welcome()
    assert hello["node_id"] == "homelink-334455"
    assert hello["muse_connected"] is False and hello["vision"] is True
    assert "display.show_model" in hello["commands"]


def test_page_requests_wait_for_muse():
    with pytest.raises(ConnectionError, match="not connected"):
        asyncio.run(make().handle_page({"type": "say", "text": "hi"}, None))
