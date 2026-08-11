#!/usr/bin/env bash
# Stop everything Starling is running, whatever state it is in.
#
# `pnpm dev` runs the API and the web shell under `concurrently --kill-others`,
# which means a stuck process on one port takes the other down with it -- and
# if the terminal dies without reaping its children, the API survives holding
# :8000 and every later `pnpm dev` fails with "Address already in use". That
# is the case this script exists for.
#
# SIGKILL rather than SIGTERM, deliberately: the process that strands the port
# is usually mid-synthesis in OmniVoice, pegged in a native call and not
# servicing signals. There is nothing to flush here -- generated WAVs live in
# the system temp directory and models reload on demand -- so a polite
# shutdown buys nothing and sometimes never lands.

set -uo pipefail

PORTS=(3000 3001 8000 7860)  # web, web fallback, API, Gradio lab

found=0
for port in "${PORTS[@]}"; do
  pids=$(lsof -ti "tcp:${port}" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    # shellcheck disable=SC2086 -- word splitting is wanted; pids may be a list
    kill -9 $pids 2>/dev/null || true
    echo "  :${port}  killed ${pids//$'\n'/ }"
    found=1
  fi
done

# Orphaned supervisors hold no port but will respawn nothing and only confuse
# the next `ps`. Matched narrowly so this never touches an unrelated project.
for pattern in "starling.main:app" "starling.lab" "concurrently.*starling"; do
  pids=$(pgrep -f "$pattern" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
    echo "  orphan  killed ${pids//$'\n'/ }  (${pattern})"
    found=1
  fi
done

[ "$found" -eq 0 ] && echo "  nothing was running"
echo "Starling stopped."
