#!/bin/sh
#
# Run one half of the harness, or both, and report through the filesystem.
#
#   entrypoint.sh linux | windows | both     (default: both)
#
# Both halves report the same way, for one platform's reason: Node's Windows
# build cannot open a standard stream under Wine — `process.stdout` throws
# EBADF before a byte is written — so the Windows probe has to write a file and
# have this script read it back from the Linux side. The Linux probe could
# print directly and does not, because one output path is easier to trust than
# two, and because the exit status then comes from the report's own `ok` field
# in both cases rather than depending on Wine to propagate one.
set -u

status=0

run() {
  target="$1"
  shift

  report="/app/report-${target}.json"
  log="/app/${target}.log"
  rm -f "$report"

  echo "==> ${target}" >&2
  E2E_TARGET="$target" "$@" > "$log" 2>&1

  # Wine leaves a server behind; without this the container lingers after the
  # probe has exited.
  if [ "$target" = windows ]; then
    wineserver -k 2>/dev/null || true
  fi

  if [ ! -f "$report" ]; then
    echo "{\"target\": \"${target}\", \"ok\": false, \"error\": \"probe produced no report\"}"
    echo "--- ${target} probe output ---" >&2
    tail -40 "$log" >&2
    status=1
    return
  fi

  cat "$report"
  if ! grep -q '"ok": true' "$report"; then
    echo "--- ${target} probe output ---" >&2
    tail -40 "$log" >&2
    status=1
  fi
}

run_linux() {
  run linux node /app/probe.mjs
}

run_windows() {
  run windows wine /opt/node-win/node.exe /app/probe.mjs
}

case "${1:-both}" in
  linux) run_linux ;;
  windows) run_windows ;;
  both)
    # Linux first: it is the cheaper half and it fails faster, so a broken
    # `dist/` surfaces without waiting on a Wine start-up.
    run_linux
    run_windows
    ;;
  *)
    echo "usage: entrypoint.sh [linux|windows|both]" >&2
    exit 2
    ;;
esac

exit $status
