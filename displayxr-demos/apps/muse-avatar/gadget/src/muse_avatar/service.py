"""The Linux gadget service with an avatar display attached.

``AvatarService`` is the Linux SDK's ``Service`` (reconnects, token rotation,
the local ``send-user-msg`` socket) with three additions per Muse session:

* the avatar commands are registered next to the SDK's own (``system.run``,
  ``file.*``, ``device.health``), or instead of them with ``--no-system-commands``;
* a ``ChatPump`` relays the page's text, voice and camera requests to Muse and
  Muse's replies and speech back to the page;
* the display hub learns whether Muse is connected, so the page can say so.

It runs in place of ``musegadget run`` and uses the same paired identity in
/var/lib/musegadget, so stop the stock service first (install-pi.sh does).
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Optional

from musegadget import __version__ as SDK_VERSION
from musegadget.link_client import DeviceDescription, LinkSession, Outcome
from musegadget.service import DEFAULT_NOISE_HOST, Service

from muse_avatar import __version__
from muse_avatar.commands import AVATAR_COMMANDS, InvalidParams, validate
from muse_avatar.hub import DisplayHub
from muse_avatar.pump import ChatPump

log = logging.getLogger(__name__)


@dataclass
class AvatarService(Service):
    hub: Optional[DisplayHub] = None
    system_commands: bool = True
    side_chat_id: Optional[str] = None
    vision: bool = False
    _pump: Optional[ChatPump] = None
    _muse_name: str = ""
    _connected_at: Optional[float] = field(default=None)

    def commands(self) -> dict:
        commands = dict(AVATAR_COMMANDS)
        if self.system_commands:
            from musegadget.executor import COMMAND_SPECS

            commands = {**COMMAND_SPECS, **commands}
        return commands

    def run_command(self, command: str, params: dict, timeout_ms: Optional[int] = None) -> dict:
        """Called by LinkSession on a worker thread for every ``link.invoke``."""
        if command in AVATAR_COMMANDS:
            try:
                clean = validate(command, params)
            except InvalidParams as exc:
                return {"ok": False, "error": str(exc)}
            limit_ms = min(timeout_ms or AVATAR_COMMANDS[command]["timeout_ms"], 60_000)
            return self.hub.invoke_threadsafe(command, clean, limit_ms / 1000)
        if self.system_commands:
            return self.executor.run(command, params, timeout_ms)
        return {"ok": False, "error": f"unknown command {command!r}"}

    def welcome(self) -> dict:
        """What a page learns when it connects."""
        return {
            "bridge_version": __version__,
            "sdk_version": SDK_VERSION,
            "node_id": self.identity.node_id,
            "display_name": self.display_name,
            "muse_connected": self._pump is not None,
            "muse_name": self._muse_name,
            "side_chat": self.side_chat_id is not None,
            "vision": self.vision,
            "system_commands": self.system_commands,
            "commands": sorted(self.commands()),
        }

    async def handle_page(self, message: dict, data: Optional[bytes]) -> None:
        pump = self._pump
        if pump is None:
            raise ConnectionError("not connected to Muse yet")
        await pump.handle(message, data)

    async def _session(self, vm: dict, pairing: dict) -> tuple[Outcome, float]:
        # Mirrors Service._session in the Linux SDK, plus the pump and the merged commands.
        device = DeviceDescription(
            node_id=self.identity.node_id,
            display_name=self.display_name,
            version=f"{SDK_VERSION}+avatar.{__version__}",
            commands=self.commands(),
        )
        session = LinkSession(
            noise_host=pairing.get("noise_host") or DEFAULT_NOISE_HOST,
            vm_id=vm["vm_id"] or vm["vm_name"],
            vm_auth_token=vm["vm_auth_token"],
            device=device,
            run_command=self.run_command,
        )
        self._muse_name = vm.get("vm_name") or ""
        log.info("connecting to %s", self._muse_name or vm["vm_id"])
        started = time.monotonic()
        self._current = session
        pump_task = asyncio.ensure_future(self._run_pump(session))
        try:
            outcome = await session.run(self._stop)
        except Exception as exc:
            log.warning("session failed: %s: %s", type(exc).__name__, exc)
            outcome = Outcome.CLOSED
        finally:
            self._current = None
            pump_task.cancel()
            await asyncio.gather(pump_task, return_exceptions=True)
        lasted = time.monotonic() - (session.registered_at or time.monotonic())
        log.info("session ended: %s after %.0fs", outcome.value, time.monotonic() - started)
        return outcome, lasted

    async def _run_pump(self, session: LinkSession) -> None:
        await session.registered.wait()
        pump = ChatPump(session, self.hub, node_id=self.identity.node_id,
                        session_id=self.side_chat_id, vision=self.vision)
        self._pump = pump
        await self.hub.broadcast({"type": "muse", "connected": True, "muse_name": self._muse_name})
        try:
            await pump.run()
        finally:
            self._pump = None
            await self.hub.broadcast({"type": "muse", "connected": False})
