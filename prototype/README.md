# issue #45 プロトタイプ: Bun 上の mediabunny 音声パス検証

**merge しない前提のプロトタイプ**（採否判断は #47 の ADR で行う）。issue #42「メディア処理基盤の技術選定マップ」の子チケット #45 の成果物。

## 検証内容

- mp3/wav 混在トラックのデコード → 等パワークロスフェード結合 → -14 LUFS 正規化 → master.wav / master.mp3 出力
- `@audio/loudness-lufs` の Bun 実機スモーク（#44 引き継ぎ: EBU Tech 3341 相当のテスト信号 + 1 時間素材の性能）
- 1 時間素材のフルパイプライン性能（合格ライン: 実時間の 2 倍以内）

## 実行方法

```
ni            # trustedDependencies: ["node-av"] が必要（postinstall で FFmpeg プレビルドを DL）
nr proto:lufs
nr proto:master
nr proto:bench   # BENCH_HOURS=1（既定）
```

## 結果

環境: Apple Silicon Mac / Bun 1.3.13 / mediabunny 1.51.0 / @mediabunny/server 1.51.0 / @audio/loudness-lufs 1.0.2

結果の詳細と結論は issue #45 の resolution コメントを参照。
