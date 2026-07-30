#!/bin/bash
# scripts/zpl-watch.command — double-clickable label printer watcher.
#
# A .command file is macOS's native "double-click me" script: Finder opens it in
# Terminal, so the window itself IS the status light. That's the deliberate fix for
# DropPrint's worst trait — it was a hidden background agent with no Dock icon and
# no visible success/failure, so when its queue jammed on 2026-07-27 printing just
# silently stopped for days. Here: window open = running. Every label prints a line.
#
# Put it in the Dock, or add it to System Settings → General → Login Items to have
# it start itself. Closing the window stops it.
#
# Watches ~/Downloads (LOCAL on purpose — the old 'Zebra' folder lived on an
# external drive, so an unplugged disk silently broke printing) and deletes each
# file once it has printed, since NetSuite keeps the ZPL and can re-issue it.

WATCH_DIR="${ZPL_WATCH_DIR:-$HOME/Downloads}"
SCRIPT="$HOME/src/Work-Hub/scripts/zpl-print.js"

# Give the Terminal window a recognisable title + a roomy scrollback.
printf '\033]0;🖨  Label Printer — watching\007'
clear

cat <<'BANNER'
  ┌────────────────────────────────────────────────────────┐
  │   🖨   NAGHEDI LABEL PRINTER                            │
  │                                                        │
  │   This window running = labels will print.              │
  │   Close it to stop.                                     │
  └────────────────────────────────────────────────────────┘
BANNER
echo
echo "  Download a .zpl from NetSuite → it prints automatically → file is deleted."
echo

if [ ! -f "$SCRIPT" ]; then
  echo "  ❌ Can't find the printer script at:"
  echo "     $SCRIPT"
  echo
  echo "  Press any key to close."
  read -n 1 -s
  exit 1
fi

# Auto-restart: if the watcher ever dies (printer yanked, drive hiccup, crash) it
# comes back in 3s instead of leaving you silently unable to print — the exact
# failure mode we're replacing. Ctrl-C twice, or close the window, to stop.
while true; do
  node "$SCRIPT" --watch "$WATCH_DIR" --delete
  code=$?
  echo
  echo "  ⚠️  watcher stopped (exit $code) at $(date '+%-I:%M:%S %p') — restarting in 3s…"
  echo "     (close this window if you meant to stop it)"
  sleep 3
  echo
done
