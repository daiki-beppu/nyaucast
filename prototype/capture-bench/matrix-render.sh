#!/bin/sh
# issue #797: デコードとエンコード、描画全体の組み合わせを順に測り、結果を out/render.jsonl に追記する。
# 先に dump.ts で frames-png と frames-pngFast を作っておく。
# 実行: sh prototype/capture-bench/matrix-render.sh prototype/capture-bench/out/long.html
set -eu

file=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
dir=$(dirname "$0")
out=$dir/out/render.jsonl
stages() { node "$dir/stages.ts" "$file" "$@" | tee -a "$out"; }
e2e() { node "$dir/e2e.ts" "$file" "$@" | tee -a "$out"; }

# デコードだけ（同時に 1 / 4 / 8 枚）
for f in png pngFast; do stages "$f" decode 1; done
for n in 4 8; do stages png decode "$n"; done
# 撮影を除いた後ろ 2 段: 現行（直列）と、デコードを先回りさせたとき（エンコードの床）
for f in png pngFast; do stages "$f" serial; stages "$f" pipelined 4; done
# static 区間: 長い duration の VideoSample 1 枚で覆う / 同じ RGBA を枚数分流す
stages png holdsLong
stages png holdsRepeat
stages png audio
# 描画全体: 現行（1 タブ・直列。先頭 900 フレーム）
e2e png serial 1 900
# 描画全体: 並列の撮影（Chrome 4 / 8 本）＋ 順に並べ直してエンコード
for n in 4 8; do e2e pngFast parallel "$n"; done
e2e png parallel 8
# 描画全体: static 区間の省略（1 タブ / Chrome 8 本）
e2e png holdsLong 1
e2e pngFast holdsLong 8
e2e pngFast holdsRepeat 8
