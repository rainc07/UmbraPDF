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

# Motion check in the real Android WebView: animations on (the emulator runner turns them off, which
# makes the page prefer reduced motion), then measure every frame of the slides over DevTools.
mkdir -p motion
for k in window_animation_scale transition_animation_scale animator_duration_scale; do adb shell settings put global $k 1; done
status=0
for scale in 1.0 1.3; do
  adb shell settings put system font_scale $scale
  adb shell am force-stop "$pkg"
  adb shell am start -W -n "$pkg/app.umbrapdf.MainActivity" >/dev/null
  sleep 12
  pid=$(adb shell pidof "$pkg" | tr -d '\r')
  adb forward --remove-all
  adb forward tcp:9222 "localabstract:webview_devtools_remote_$pid"
  adb shell screenrecord --time-limit 60 "/sdcard/motion-$scale.mp4" & rec=$!
  node .github/scripts/motion.mjs "motion/font-$scale" || status=1
  sleep 1; adb shell pkill -INT screenrecord; wait $rec 2>/dev/null; sleep 2
  adb pull "/sdcard/motion-$scale.mp4" motion/ >/dev/null || true
done
adb shell settings put system font_scale 1.0
exit $status
