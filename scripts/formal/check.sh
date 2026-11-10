#!/usr/bin/env bash
# TLA+ モデルを TLC で検査する。使い方: scripts/formal/check.sh formal/<area>/<Module>.tla
#
# <Module>.cfg の INVARIANT を 1 本ずつ別の TLC の実行で検査し、cfg の "\* expect: NAME[,NAME]"
# 行に書いた既知の破れと突き合わせる。既知の破れだけが破れ、それ以外が成り立てば exit 0。
# 予期しない破れや、既知の破れが成り立ったときは exit 1。反例は formal/<area>/out/<NAME>.txt に残す。
#
# TLC は tla2tools.jar 1.7.4 を固定し、チェックサムを確かめて ~/.cache/tla に置く。
# java は PATH のものを使う（JAVA で上書きできる）。
set -euo pipefail

TLC_VERSION=1.7.4
TLC_SHA256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/tla"
JAR="${TLA2TOOLS:-$CACHE_DIR/tla2tools-$TLC_VERSION.jar}"
JAVA_BIN="${JAVA:-java}"

spec="${1:?usage: scripts/formal/check.sh formal/<area>/<Module>.tla}"
dir="$(cd "$(dirname "$spec")" && pwd)"
module="$(basename "$spec" .tla)"
cfg="$dir/$module.cfg"

if [[ ! -f "$JAR" ]]; then
  mkdir -p "$CACHE_DIR"
  curl -fsSL -o "$JAR.part" \
    "https://github.com/tlaplus/tlaplus/releases/download/v$TLC_VERSION/tla2tools.jar"
  mv "$JAR.part" "$JAR"
fi
if [[ -z "${TLA2TOOLS:-}" ]]; then
  actual="$(shasum -a 256 "$JAR" | cut -d' ' -f1)"
  if [[ "$actual" != "$TLC_SHA256" ]]; then
    echo "tla2tools.jar のチェックサムが違う: $actual" >&2
    exit 1
  fi
fi

expected=" $(sed -n 's/^\\\* expect: *//p' "$cfg" | tr ',' ' ' | tr '\n' ' ') "
invariants=$(sed -n 's/^INVARIANT *//p' "$cfg")
out="$dir/out"
mkdir -p "$out"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp "$dir"/*.tla "$work/"

status=0
for inv in $invariants; do
  grep -v '^INVARIANT' "$cfg" > "$work/$module.cfg"
  echo "INVARIANT $inv" >> "$work/$module.cfg"
  log="$out/$inv.txt"
  (cd "$work" && "$JAVA_BIN" -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -deadlock -workers auto \
    -metadir "$work/states-$inv" -config "$module.cfg" "$module.tla") > "$log" 2>&1 || true
  if grep -q "Invariant $inv is violated" "$log"; then
    result=broken
  elif grep -q "No error has been found" "$log"; then
    result=holds
  else
    echo "ERROR    $inv: TLC が完走しなかった（$log）"
    status=1
    continue
  fi
  states=$(sed -n 's/.* \([0-9][0-9]*\) distinct states found.*/\1/p' "$log" | tail -1)
  if [[ "$expected" == *" $inv "* ]]; then
    want=broken
  else
    want=holds
  fi
  if [[ "$result" == "$want" ]]; then
    printf 'ok       %-28s %s (expected, %s states)\n' "$inv" "$result" "${states:-?}"
  else
    printf 'MISMATCH %-28s %s, expected %s（%s）\n' "$inv" "$result" "$want" "$log"
    status=1
  fi
done
exit $status
