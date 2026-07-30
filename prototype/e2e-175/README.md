# issue #175 プロトタイプ: HTML → rasterize → mediabunny の end-to-end 検証

**merge しない前提のプロトタイプ**（採否判断は #178 の ADR-0005 改訂で行う）。map #172「動画生成 HTML パイプライン化マップ」の子チケット #175 の成果物。

## 検証内容

research 2 本（#173 HyperFrames 部分利用 / #174 決定論的 frame capture）の結論に従い、
**seek 方式 + `Page.captureScreenshot` + Bun ネイティブ WebSocket の自前 CDP client + `@puppeteer/browsers` 供給**で
フルパイプライン（HTML composition → Chrome rasterize → mediabunny エンコード）を Bun 実機で通す。

- `cdp.ts` — 素の CDP クライアント（launcher + connection + flatten session + screenshot。約 210 行）
- `capture.ts` — seek 方式 capture セッション（`window.__hf` プロトコル + double rAF settle）
- `compositions/` — 静止画シーンと GSAP 動的シーン（`gsap.updateRoot(t)` 外部駆動 + `lagSmoothing(0)` + WAAPI `currentTime` seek）
- `browsers.ts` — Chrome for Testing / chrome-headless-shell の pin 供給（151.0.7922.71、`~/.cache/puppeteer`）
- `smoke.ts` / `determinism.ts` / `bench-capture.ts` / `bench-e2e-1h.ts` — 検証スクリプト

## 実行方法

```
bun install                              # trustedDependencies: ["node-av"] 必要
bun prototype/e2e-175/smoke.ts           # 供給 → 起動 → capture 1 枚
bun prototype/e2e-175/determinism.ts     # 300 フレーム sweep + 再 seek / 逆順 seek（SETTLE=none で settle 無し比較）
bun prototype/e2e-175/bench-capture.ts   # スループット（BROWSERS=chrome-headless-shell,chrome / N=150）
bun prototype/e2e-175/bench-e2e-1h.ts    # e2e（BENCH_HOURS=1 既定 / PROTO_BROWSER で切替）
```

## 結果（Apple Silicon Mac / Bun 1.3.13 / Chrome 151.0.7922.71 / mediabunny 1.51.0）

### 決定論（chrome-headless-shell, png, 10s@30fps = 300 frames）

| 検査 | settle=raf | settle=none |
|---|---|---|
| 線形マーカーの時間ずれ（±2px） | **PASS**（max 1px） | PASS（max 1px） |
| 全フレーム hash 一意性 | **PASS**（300/300） | PASS（300/300） |
| 同一 t 再 seek のバイト一致 | **PASS**（3/3） | **FAIL**（1/3） |
| 逆順 seek のバイト一致 | **PASS**（10/10） | **FAIL**（2/10） |

**double rAF settle（50ms timeout と race）は capture 契約の一部**。settle 無しは 1.6 倍速いが 1 フレーム遅れの stale capture が混ざる。

### capture スループット（1920x1080, N=150/tab, settle=raf）

| 条件 | chrome-headless-shell | chrome (CfT) |
|---|---|---|
| 単タブ png | 13.8 fps | 12.2 fps |
| 単タブ jpeg80 | 14.9 fps | 14.5 fps |
| 単タブ jpeg80+optimizeForSpeed | 15.0 fps | 14.8 fps |
| 単タブ jpeg80+ofs settle=none（参考） | 25.6 fps | 21.8 fps |
| 2 タブ jpeg80+ofs | **29.8 fps** | 24.4 fps |
| 4 タブ jpeg80+ofs | **59.8 fps**（合格ライン 15fps の 4.0 倍） | 43.8 fps |

- 単タブは double rAF settle（60Hz 待ち）込みでちょうど合格ライン。**タブ並列はほぼ線形スケール**（research #174 §6 の予測どおり）
- headless-shell が CfT より速く、並列スケールも良い。CfT はさらに macOS キーチェーンダイアログ問題あり（`--use-mock-keychain` で回避、cdp.ts 参照）

### end-to-end（chrome-headless-shell）

- **動的 10s@30fps e2e**: capture 24.3s（12.3fps）+ pngjs デコード + エンコード 5.7s（53fps）= 30.0s — 実時間の 3.0 倍（単タブ直列。4 タブ並列なら 1h 動的も合格圏）
- **静止画 + 音声 1h（v0.1 要件）**: フルパイプライン **125.9s = 実時間の 0.035 倍 → PASS**（合格ライン 2 倍に対し 57 倍の余裕。内訳: browser 起動 0.4s + capture/デコード 0.3s + 音声生成 4.3s + 1h エンコード 90.6s + Phase 1 の 30s）
- 生成物のメタデータ検証: 3600.02s / 1920x1080 / avc + aac / 329MB — mediabunny の読み戻しで確認

### Bun 互換の実証

- `@puppeteer/browsers` 3.0.6 の install / computeExecutablePath は Bun 1.3.13 で動作（research #174 §5 の未検証項目を解消）
- Bun ネイティブ WebSocket での CDP は問題なし。スクリーンショットの base64（数 MB/frame）も安定
- 落とし穴: 環境変数 `BROWSER` は macOS シェルで別用途に定義されがち（本プロトタイプは `PROTO_BROWSER` を使用）
