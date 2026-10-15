#!/usr/bin/env bash
# Install the Muse avatar bridge on a Muse Linux gadget (a Raspberry Pi or any
# Linux box running Meta's Linux Device SDK).
#
# Install and pair the SDK first, with Meta's installer:
#   https://github.com/facebookincubator/muse-gadget-sdk/tree/main/linux
#
# Then, from this folder:
#   sudo bash install-pi.sh                       # avatar + Muse's shell/file commands
#   sudo bash install-pi.sh --no-system-commands  # avatar commands only
#   sudo bash install-pi.sh --side-chat --vision  # see README for both
#   sudo bash install-pi.sh --uninstall           # back to the stock musegadget service
#
# The bridge replaces the stock `musegadget` service (same pairing, same device
# in the Muse app) and adds the display hub on 127.0.0.1:8765.
set -euo pipefail

SDK_DIR=/opt/musegadget
UNIT=/etc/systemd/system/muse-avatar.service
RUN_AS="${SUDO_USER:-}"
ARGS=()
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --run-as) RUN_AS="$2"; shift 2 ;;
    --no-system-commands|--side-chat|--vision) ARGS+=("$1"); shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 1 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo." >&2
  exit 1
fi

if [ "$UNINSTALL" -eq 1 ]; then
  systemctl disable --now muse-avatar.service 2>/dev/null || true
  rm -f "$UNIT"
  systemctl daemon-reload
  if [ -x "$SDK_DIR/bin/uv" ]; then
    "$SDK_DIR/bin/uv" pip uninstall --python "$SDK_DIR/venv/bin/python" muse-avatar || true
  fi
  systemctl enable --now musegadget.service
  echo "Removed the avatar bridge; the stock musegadget service is running again."
  exit 0
fi

if [ ! -x "$SDK_DIR/venv/bin/musegadget" ] || [ ! -x "$SDK_DIR/bin/uv" ]; then
  echo "Meta's Linux Device SDK is not installed in $SDK_DIR." >&2
  echo "Install and pair it first: https://github.com/facebookincubator/muse-gadget-sdk/tree/main/linux" >&2
  exit 1
fi
if ! "$SDK_DIR/venv/bin/python" -c "import musegadget.muse_turn" 2>/dev/null; then
  echo "The installed SDK has no musegadget.muse_turn; update it with Meta's install.sh first." >&2
  exit 1
fi
case " ${ARGS[*]-} " in
  *" --no-system-commands "*) ;;
  *)
    if [ -z "$RUN_AS" ] || ! id "$RUN_AS" >/dev/null 2>&1; then
      echo "Pass --run-as ACCOUNT: the account whose permissions Muse's shell commands get." >&2
      exit 1
    fi
    ;;
esac

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$SDK_DIR/bin/uv" pip install --python "$SDK_DIR/venv/bin/python" --no-deps --reinstall "$here"

exec_args=""
for arg in "${ARGS[@]+"${ARGS[@]}"}"; do
  exec_args="$exec_args $arg"
done

cat > "$UNIT" <<UNIT_EOF
# Muse avatar bridge: the Muse Linux gadget plus the 3D avatar display hub.
# Installed by apps/muse-avatar/gadget/install-pi.sh. Replaces musegadget.service.
[Unit]
Description=Muse avatar bridge (Muse Linux gadget + glasses-free 3D avatar)
Wants=network-online.target
After=network-online.target bluetooth.target
Conflicts=musegadget.service

[Service]
Environment=PYTHONUNBUFFERED=1
Environment=MUSEGADGET_RUN_AS=$RUN_AS
ExecStart=$SDK_DIR/venv/bin/muse-avatar run$exec_args
RuntimeDirectory=musegadget
RuntimeDirectoryMode=0755
StateDirectory=musegadget
StateDirectoryMode=0700
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT_EOF

systemctl daemon-reload
systemctl disable --now musegadget.service 2>/dev/null || true
systemctl enable --now muse-avatar.service

echo
echo "The avatar bridge is running. Check it with:  sudo journalctl -u muse-avatar -f"
echo "A healthy start logs 'registered with the Muse' and 'display hub listening'."
echo
echo "On the PC with the 3D display, open a tunnel to this machine:"
echo "  ssh -N -L 8765:localhost:8765 $(logname 2>/dev/null || echo pi)@$(hostname).local"
echo "then open this address in the DisplayXR Browser:"
"$SDK_DIR/venv/bin/muse-avatar" url
