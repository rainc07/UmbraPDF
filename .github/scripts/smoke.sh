#!/usr/bin/env bash
# Install the dev APK, start it, and check it is still running after a while. Prints crash traces as ::error.
set -u
apk=$(ls app/build/outputs/apk/dev/*.apk | head -1)
pkg=app.umbrapdf.dev
adb install -r "$apk"
adb logcat -c
adb shell am start -W -n "$pkg/app.umbrapdf.MainActivity"
sleep 25
pid=$(adb shell pidof "$pkg" | tr -d '\r')
adb logcat -d > logcat.txt
grep -E "AndroidRuntime|FATAL|umbra|Umbra|onnxruntime|chromium.*(Uncaught|Error)" logcat.txt | tail -80 || true
fatal=$(grep -A40 "FATAL EXCEPTION" logcat.txt | head -60)
if [ -z "$pid" ] || [ -n "$fatal" ]; then
  while IFS= read -r line; do echo "::error::$line"; done <<< "${fatal:-app not running after launch (no FATAL in logcat)}"
  exit 1
fi
# The page itself must not report script errors at start.
errs=$(grep -E "chromium.*Uncaught" logcat.txt | head -10)
if [ -n "$errs" ]; then while IFS= read -r line; do echo "::error::$line"; done <<< "$errs"; exit 1; fi
echo "app is running (pid $pid)"
