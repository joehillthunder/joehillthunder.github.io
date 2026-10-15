"""``muse-avatar`` command line.

    sudo muse-avatar run --run-as pi          # the gadget plus the display hub
    sudo muse-avatar url                      # print the page address with the key
    sudo muse-avatar new-key                  # replace the key (open pages must reconnect)
"""

from __future__ import annotations

import argparse
import logging
import os
import secrets
import signal
import socket
import sys
import uuid
from pathlib import Path

from muse_avatar import __version__
from muse_avatar.hub import is_local_host, page_url

log = logging.getLogger("muse_avatar")

KEY_FILE = "avatar_key"
SIDE_CHAT_FILE = "avatar_side_chat"
DEFAULT_PAGE = "https://joehillthunder.github.io/displayxr-demos/apps/muse-avatar/"
DEFAULT_PORT = 8765


def _state_file(name: str) -> Path:
    from musegadget import config

    return config.state_dir() / name


def _read_or_create(name: str, make) -> str:
    path = _state_file(name)
    try:
        value = path.read_text(encoding="utf-8").strip()
        if value:
            return value
    except FileNotFoundError:
        pass
    value = make()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(value + "\n")
    return value


def bridge_key() -> str:
    return os.environ.get("MUSE_AVATAR_KEY") or _read_or_create(KEY_FILE, lambda: secrets.token_urlsafe(18))


def cmd_url(args: argparse.Namespace) -> int:
    print(page_url(args.page, f"ws://localhost:{args.port}", bridge_key()))
    return 0


def cmd_new_key(args: argparse.Namespace) -> int:
    _state_file(KEY_FILE).unlink(missing_ok=True)
    print(page_url(args.page, f"ws://localhost:{args.port}", bridge_key()))
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    import asyncio

    from musegadget import config, identity

    from muse_avatar.hub import DisplayHub
    from muse_avatar.service import AvatarService

    from musegadget.executor import Account, Executor

    # The SDK's service also needs the account for its local socket's group, so
    # there is always an executor; --no-system-commands only stops registering it.
    if os.geteuid() == 0 and args.run_as:
        try:
            account = Account.lookup(args.run_as)
        except KeyError:
            print(f"Account {args.run_as!r} does not exist.", file=sys.stderr)
            return 1
    elif os.geteuid() == 0 and args.system_commands:
        print("Pass --run-as ACCOUNT (whose permissions Muse's shell commands get), "
              "or --no-system-commands.", file=sys.stderr)
        return 1
    else:
        account = Account.current()
    executor = Executor(account)
    try:
        sdk_token = config.sdk_token()
    except ValueError as exc:
        log.warning("running without an SDK token: %s", exc)
        sdk_token = None
    if not is_local_host(args.host):
        log.warning("the display hub listens on %s: anyone on that network who learns the key "
                    "can talk to your Muse as this device", args.host)
    side_chat = _read_or_create(SIDE_CHAT_FILE, lambda: str(uuid.uuid4())) if args.side_chat else None
    static_dir = Path(args.serve).resolve() if args.serve else None
    if static_dir is not None and not (static_dir / "index.html").is_file():
        print(f"--serve {args.serve}: no index.html there", file=sys.stderr)
        return 1

    key = bridge_key()

    async def main() -> None:
        service = AvatarService(
            identity=identity.load_or_create(), executor=executor, sdk_token=sdk_token,
            display_name=args.name, system_commands=args.system_commands,
            side_chat_id=side_chat, vision=args.vision,
        )
        hub = DisplayHub(key=key, on_request=service.handle_page, welcome=service.welcome,
                         extra_origins=tuple(args.allow_origin), static_dir=static_dir)
        service.hub = hub
        loop = asyncio.get_running_loop()
        for signum in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(signum, service.stop)
        server = await hub.serve(args.host, args.port)
        local = await service.serve_local(config.socket_path())
        page = f"http://localhost:{args.port}/" if static_dir else args.page
        log.info("muse-avatar %s: open %s", __version__, page_url(page, f"ws://localhost:{args.port}", "<key>"))
        log.info("print the address with the key: sudo muse-avatar url")
        try:
            await service.run()
        finally:
            local.close()
            server.close()

    asyncio.run(main())
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="muse-avatar")
    parser.add_argument("-v", "--verbose", action="store_true")
    parser.add_argument("--page", default=os.environ.get("MUSE_AVATAR_PAGE", DEFAULT_PAGE),
                        help="the avatar page's address (default: %(default)s)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("MUSE_AVATAR_PORT", DEFAULT_PORT)))
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="connect to Muse and serve the avatar display")
    run.add_argument("--run-as", default=os.environ.get("MUSEGADGET_RUN_AS") or os.environ.get("SUDO_USER"),
                     help="account Muse's shell and file commands run as")
    run.add_argument("--host", default=os.environ.get("MUSE_AVATAR_HOST", "127.0.0.1"),
                     help="address the display hub listens on (default: %(default)s; use an SSH tunnel)")
    run.add_argument("--name", default=os.environ.get("MUSE_AVATAR_NAME") or socket.gethostname(),
                     help="the device name Muse sees (default: the host name)")
    run.add_argument("--no-system-commands", dest="system_commands", action="store_false",
                     help="register only the avatar commands, not system.run and file.*")
    run.add_argument("--side-chat", action="store_true",
                     help="talk in a dedicated Muse side chat instead of the main chat")
    run.add_argument("--vision", action="store_true",
                     help="EXPERIMENTAL: let the page send camera stills to Muse")
    run.add_argument("--serve", metavar="DIR", help="also serve the avatar page from DIR over HTTP")
    run.add_argument("--allow-origin", action="append", default=[], metavar="ORIGIN",
                     help="another site allowed to open the page (repeatable)")
    run.set_defaults(func=cmd_run)
    sub.add_parser("url", help="print the page address with the bridge key").set_defaults(func=cmd_url)
    sub.add_parser("new-key", help="replace the bridge key").set_defaults(func=cmd_new_key)

    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    try:
        return args.func(args)
    except PermissionError as exc:
        print(f"Can't access {exc.filename}; run this with sudo.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
