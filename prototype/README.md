# issue #45 / #46 プロトタイプ: Bun 上の mediabunny 音声・動画パス検証

**merge しない前提のプロトタイプ**（採否判断は #47 の ADR で行う）。issue #42「メディア処理基盤の技術選定マップ」の子チケット #45（音声）・#46（動画）の成果物。

## 検証内容

### 音声パス (#45)

- mp3/wav 混在トラックのデコード → 等パワークロスフェード結合 → -14 LUFS 正規化 → master.wav / master.mp3 出力
- `@audio/loudness-lufs` の Bun 実機スモーク（#44 引き継ぎ: EBU Tech 3341 相当のテスト信号 + 1 時間素材の性能）
- 1 時間素材のフルパイプライン性能（合格ライン: 実時間の 2 倍以内）

### 動画パス (#46)

- 静止画 PNG（pngjs で読み書き）+ 音声 → H.264 + AAC の mp4 生成（1fps 静止画動画）
- 1 時間級動画のエンコード性能（合格ライン: 実時間の 2 倍以内）
- 毎フレームをプログラム描画して流し込む動的映像パスのスループット（拡張性評価）
- 生成物のメタデータ読み（duration・解像度・コーデック — upload 前検証の想定）

## 実行方法

```
ni            # trustedDependencies: ["node-av"] が必要（postinstall で FFmpeg プレビルドを DL）
nr proto:lufs
nr proto:master
nr proto:bench         # 音声 1h。BENCH_HOURS=1（既定）
nr proto:video         # 動画スモーク（60s 静止画 + 10s 動的）
nr proto:video-bench   # 動画 1h。BENCH_HOURS=1（既定）
```

## 結果

環境: Apple Silicon Mac / Bun 1.3.13 / mediabunny 1.51.0 / @mediabunny/server 1.51.0 / @audio/loudness-lufs 1.0.2 / pngjs 7.0.0

結果の詳細と結論は issue #45 / #46 の resolution コメントを参照。
