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
# Watches the 'Zebra' folder on the external drive (Nima's existing workflow — his
# browser saves NetSuite labels there) and deletes each file once it has printed,
# since NetSuite keeps the ZPL and can re-issue it.
#
# That folder lives on a REMOVABLE disk, so the loop below explicitly checks the
# drive is mounted and says so in big letters when it isn't. An unplugged drive
# must never fail quietly — that's the DropPrint trap all over again.
# Override with: ZPL_WATCH_DIR="/some/other/folder" open '🖨 Print Labels.command'

WATCH_DIR="${ZPL_WATCH_DIR:-/Volumes/Mac External Hard Drive/Zebra}"
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
echo "  Watching: $WATCH_DIR"
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
  # The watch folder is on a removable drive. If it's not there, say so LOUDLY and
  # keep checking — never sit silently pretending to watch a folder that's gone.
  if [ ! -d "$WATCH_DIR" ]; then
    printf '\033]0;⚠️ Label Printer — DRIVE NOT CONNECTED\007'
    echo "  ╔══════════════════════════════════════════════════════════╗"
    echo "  ║  ⚠️   CANNOT PRINT — folder not found                     ║"
    echo "  ╚══════════════════════════════════════════════════════════╝"
    echo "     $WATCH_DIR"
    echo
    echo "     The external drive looks disconnected. Plug it back in and"
    echo "     this will pick up on its own — nothing else to do."
    echo "     (checking again every 5s…)"
    echo
    sleep 5
    clear
    continue
  fi

  printf '\033]0;🖨  Label Printer — watching\007'
  node "$SCRIPT" --watch "$WATCH_DIR" --delete
  code=$?
  echo
  echo "  ⚠️  watcher stopped (exit $code) at $(date '+%-I:%M:%S %p') — restarting in 3s…"
  echo "     (close this window if you meant to stop it)"
  sleep 3
  echo
done
