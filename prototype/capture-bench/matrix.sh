#!/bin/sh
# issue #790: 組み合わせを順に測り、結果を out/results.jsonl に追記する。
# 実行: sh prototype/capture-bench/matrix.sh prototype/capture-bench/out/long.html
set -eu

file=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
out=$(dirname "$0")/out/results.jsonl
run() { node "$(dirname "$0")/bench.ts" "$file" "$@" | tee -a "$out"; }
# (i) フラグ（1 Chrome・1 タブ・PNG）
for f in none dfrl racsbd both; do run "$f" 1 1 png; done
# (iii) タブ並列（1 Chrome に 2 / 4 / 8 タブ）と、複数の Chrome（2 / 4 / 8 プロセス）
# 併用（both）で 1 つの Chrome に 2 タブ以上を開くと撮影が返らなくなる（hang.ts）ので、both は複数の Chrome だけを測る
for f in none dfrl; do
  for n in 2 4 8; do run "$f" 1 "$n" png; done
  for n in 2 4 8; do run "$f" "$n" 1 png; done
done
for n in 2 4 8; do run both "$n" 1 png; done
# (iv) 画像形式（PNG の optimizeForSpeed、可逆な WebP）
for f in none dfrl both; do run "$f" 1 1 pngFast; done
run none 1 1 webp100
for n in 4 8; do run dfrl "$n" 1 pngFast; run none "$n" 1 pngFast; done
