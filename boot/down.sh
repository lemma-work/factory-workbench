#!/usr/bin/env bash
# Stop what boot/up.sh started in <out_dir>, by the pids it recorded and nothing
# else. The backend's own cleanup takes its containers down on SIGTERM.
OUT=$1
for name in frontend backend; do
  pid=$(cat "$OUT/$name.pid" 2>/dev/null) || continue
  kill "$pid" 2>/dev/null
  for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill -9 "$pid" 2>/dev/null || true
done
