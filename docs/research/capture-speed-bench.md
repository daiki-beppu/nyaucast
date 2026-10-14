# 1080p の解説動画で撮影を速くする 4 つの手段の実測

- 測定日: 2026-10-14（issue #790 / map #789 / 背景 #747・#791）
- 対象: chrome-headless-shell mac_arm 154.0.8037.92（`src/lib/chrome-pin.ts` の pin）、Apple M4（10 コア: 性能 4 + 高効率 6）、Node 26.9.0
- ベンチ: `prototype/capture-bench/`（このブランチ）。起動フラグは `src/lib/chrome.ts` の `launchFlags` と同じものに比べるフラグを足し、撮影手順は `src/compositions/capture.ts` と同じ（seek → double rAF と 50 ms の race → `Page.captureScreenshot`）
- 測定中はほかのセッションも動いていた（負荷平均 4〜50 の間で揺れた）。主な組み合わせは 2〜3 回測り、揺れは ±5% 程度だった

## composition

本物の tool（`video_write_script` → `video_write_diagram` → `video_synthesize_narration` → `video_assemble_composition`）で組み立てた、1920x1080・30 fps・621 秒（18,633 フレーム）の解説動画（`prototype/capture-bench/generate.test.ts`）。音声だけが偽の Gemini（段落ごとに 13.3 秒）。

- 15 シーン × 3 段落 × 3 句。字幕は 135 句
- 図解はシーンごとに見出しと、箱・矢印・ラベルの SVG。動きは 105 個（シーンあたり 7 つ現れ、1 つ沈む。9 句のうち 8 句で 1 つ動く）。fade・slide・pop を混ぜた
- フォントは Noto Sans JP（9.6 MB の ttf）を本文と字幕に埋め込んだ（composition は 12.9 MB）

dogfood のチャンネルにはまだ実際の解説動画の composition が無いため、動きの密度は「ほぼ句ごとに 1 つ動く」の多めの側に置いた。static 区間の割合（§2）はこの密度に依存する。

## 結論サマリ

10 分の動画（18,000 フレーム）の撮影時間に換算した値。合格ラインは描画全体で 10 分以内（撮影のほかにエンコードがある）。

| 手段 | 撮影（10 分の動画） | 現行比 | 撮影中の Chrome の CPU | 何もしていないときの CPU |
| --- | --- | --- | --- | --- |
| 現行（フラグなし・1 タブ・PNG） | 24〜25 分 | 1.0 | 0.3 コア | 0 |
| (i) `--disable-frame-rate-limit` | 15.5〜16 分 | 1.6 倍 | 0.56 コア | 0 |
| (i) `--run-all-compositor-stages-before-draw` | 29.7 分 | 0.8 倍（遅くなる） | 0.23 コア | 0 |
| (i) 2 つを併用 | 11.1 分 | 2.2 倍 | 3.5 コア | **3.35 コア** |
| (ii) static 区間の省略（撮る枚数が 10.7%） | 約 2.6 分 | 9.3 倍 | 0.3 コア | 0 |
| (iii) Chrome 8 プロセス × 1 タブ | 3.1〜3.5 分 | 7〜8 倍 | 2.5〜3.7 コア | 0 |
| (iv) PNG の `optimizeForSpeed` | 15.6〜17 分 | 1.5 倍 | 0.3 コア | 0 |
| (iii)+(iv) フラグなし・8 プロセス・速い PNG | 1.9〜2.1 分 | 12 倍 | 2.6 コア | 0 |
| (ii)+(iii)+(iv) | 約 0.2 分（13 秒） | 約 115 倍 | 2.6 コア | 0 |

- **1080p では、1 フレームの時間の大半はスクリーンショット**（PNG で 40〜56 ms）。フラグが縮めるのは seek と settle（フラグなし 20〜30 ms → 併用 1〜1.5 ms）だけなので、320x180 で見えた「併用で 12 倍」は 1080p では 2.2 倍に縮む（#747 の予想どおり）
- **1 タブの撮影は待ちに縛られていて、CPU を使っていない**（フレーム 80 ms の間に Chrome は 0.3 コア）。そのため並列はほぼ線形に伸びる（2 → 4 で半分ずつ）。8 では 1 つの Chrome に 8 タブ（5.3 分）より、8 つの Chrome（3.1〜3.5 分）が速い
- **併用は並列と組み合わせられない。** 1 つの Chrome に 2 タブを開くと、どちらのタブでも撮影が返らなくなる（`hang.ts`）。Chrome を 4 本以上並べると空回りが CPU を食い尽くし、1 フレーム 108〜465 ms に崩れる（現行より遅い）。併用で速いのは Chrome 2 本（7.3 分、ただし 6.5 コアを空回り）まで
- **`--disable-frame-rate-limit` 単独の利得は、並列にすると消える。** 8 プロセスでは PNG で 2.4〜2.5 分（フラグなし 3.1〜3.5 分）と少し速いが、速い PNG では 2.7〜2.9 分（フラグなし 1.9〜2.1 分）と逆転し、CPU は約 2 倍（5.5 コア）使う
- **(ii) 単独でも、(iii) 単独でも、撮影は合格ライン（10 分）の内側に入る。** 組み合わせれば撮影は無視できる大きさになり、残りはエンコードになる
- **(iv) で効くのは PNG の `optimizeForSpeed` だけ。** 可逆で、再 seek のバイトも一致し、1 タブで 30〜35% 速い（ファイルは 1.5 倍）。可逆な WebP（`quality: 100`）は遅く（1 フレーム 73〜85 ms）、3.3 倍大きい。既定の WebP は非可逆で、撮り直しのバイトは一致するが PNG の画素と一致しない（採れない）

---

## 1. (i) Chrome のフラグ

### 1.1 1 フレームの内訳（`formats.ts`、9 時刻の平均）

| フラグ | seek + settle | スクリーンショット（PNG） | 同（速い PNG） |
| --- | --- | --- | --- |
| なし | 21〜29 ms | 52〜56 ms | 47 ms |
| `--disable-frame-rate-limit` | 18 ms | 46 ms | — |
| 併用 | 1.2〜1.5 ms | 40〜47 ms | 33 ms |

### 1.2 1 タブで 360 フレーム（`bench.ts`、8 つの窓 × 45 フレーム）

| フラグ | 1 フレーム | 撮影中の Chrome | 何もしていないとき（3 秒） |
| --- | --- | --- | --- |
| なし | 80〜83 ms | 0.28〜0.32 コア | 0.00 |
| `--disable-frame-rate-limit` | 52〜54 ms | 0.55〜0.58 コア | 0.00〜0.01 |
| `--run-all-compositor-stages-before-draw` | 99 ms | 0.23 コア | 0.01 |
| 併用 | 37〜50 ms | 3.53〜3.55 コア | 3.35〜3.39 |

併用の空回り（3.4 コア）は #791 の 320x180 の値と同じで、1080p でも変わらない。

## 2. (ii) static 区間の省略（`static.ts`）

composition の `nc-data` から、各フレームの状態（見えるシーン・字幕・105 個の動きの進み）を runtime の `seek` と同じ式で計算し、前のフレームと同じ状態が続く「連」を数えた。

| 項目 | 値 |
| --- | --- |
| 全フレーム | 18,633 |
| 長さ 2 以上の連に属するフレーム（static） | 16,828（**90.3%**） |
| static の連の数 | 181 |
| 連ごとに 1 枚撮るときの枚数 | 1,986（**10.7%**） |

検証: 3〜23 秒の 600 フレームを実際に撮り、隣り合う 599 組で「状態が同じ」と「PNG のバイトが同じ」を比べた。584 組が一致し、15 組は「状態は変わるがバイトは同じ」（動きの終わり際の、画素に出ない差）だった。**「状態は同じなのにバイトが違う」（省くと絵が欠ける向き）は 0 組。**

これは状態が変わらないフレームを理想的に省いたときの値で、static の宣言を segment の単位でどう書くか（#792）によって枚数は増える。動きの密度が今回より低ければ、割合はさらに上がる。

## 3. (iii) 並列（`bench.ts`、360 フレームをワーカーの数で連続する塊に分ける）

10 分の動画の撮影時間（分）。括弧は撮影中の Chrome の CPU（コア）。

| 形 | フラグなし | `--disable-frame-rate-limit` | 併用 |
| --- | --- | --- | --- |
| 1 Chrome × 1 タブ | 24.4（0.3） | 15.5（0.6） | 11.1（3.5） |
| 1 Chrome × 2 タブ | 12.5（0.5） | 9.5（1.0） | **撮影が返らない** |
| 1 Chrome × 4 タブ | 6.2（1.0） | 6.3（1.3） | — |
| 1 Chrome × 8 タブ | 5.3（1.5） | 4.4（1.5） | — |
| 2 Chrome × 1 タブ | 12.5（0.6） | 8.6（1.1） | 7.3（7.1、何もしていないとき 6.5） |
| 4 Chrome × 1 タブ | 6.3（1.8） | 4.8（2.0） | **139.5**（9.7） |
| 8 Chrome × 1 タブ | 3.1〜3.5（2.5〜3.7） | 2.4〜2.8（4.4〜4.6） | **32.4**（10.0） |

- 1 つの Chrome のタブは 4 を超えると伸びが鈍る（8 タブで 5.3 分）。スクリーンショットの経路を 1 つの browser プロセスで共有するためと見られる（原因は調べていない）
- 併用で 1 つの Chrome に 2 タブを開くと、片方のタブだけを撮っても、もう片方を撮っても返らない（5 秒で打ち切り）

## 4. (iv) 画像形式（`formats.ts` と `bench.ts`）

| 形式（CDP の引数） | スクリーンショット | 平均のサイズ | PNG の画素と一致 | 再 seek でバイト一致 |
| --- | --- | --- | --- | --- |
| PNG（`format: "png"`、現行） | 40〜56 ms | 67 KB | 9/9 | 9/9 |
| 速い PNG（`optimizeForSpeed: true`） | 33〜47 ms | 103 KB | 9/9 | 9/9 |
| WebP `quality: 100` | 73〜86 ms | 226 KB | 9/9 | 9/9 |
| WebP（既定） | 100〜121 ms | 27 KB | **0/9** | 9/9 |

1 タブで 360 フレームでは、速い PNG はフラグなしで 52〜57 ms（PNG 80〜83 ms）、`--disable-frame-rate-limit` で 36 ms（同 52〜54 ms）、併用で 33 ms（同 37〜50 ms）。8 プロセスでは、フラグなしで 6.4〜7.0 ms（同 10.4〜11.8 ms）。WebP `quality: 100` は 1 タブで 83 ms と PNG と同じで、利得がない。

速い PNG は PNG とバイト列が違う（画素は同じ）。決定論の検証は同じ形式どうしの再 seek の比較なので成り立つが、形式を切り替えると既存の撮影結果とのバイト比較はできなくなる。

## 5. 測っていないこと

- エンコードを含む描画全体の時間（`video_render_cut`）。撮影が速くなると、PNG のデコードとエンコードの比重が上がる
- 並列のもとでの再 seek の検証（どのタブで撮り直すか）。今回の再 seek は同じタブの中だけ
- collection（BGM 動画）の composition
- 8 を超える並列度と、性能コアと高効率コアの違い

## 実行方法

```
# composition を作る（FONT は日本語の ttf / otf）
FONT=<ttf> OUT=$PWD/prototype/capture-bench/out/long.html pnpm exec vitest run -c prototype/capture-bench/vitest.config.ts --root .
node prototype/capture-bench/static.ts prototype/capture-bench/out/long.html --verify
node prototype/capture-bench/formats.ts prototype/capture-bench/out/long.html none
sh prototype/capture-bench/matrix.sh prototype/capture-bench/out/long.html   # 結果は out/results.jsonl
node prototype/capture-bench/hang.ts prototype/capture-bench/out/long.html   # 併用 × 2 タブで撮影が返らないことの再現
```

生の結果: `prototype/capture-bench/results/`（`results.jsonl` は 1 回目、`repeat.jsonl` は主な組み合わせの 2・3 回目）。1 回目の並列の `meanBytes` は集計の誤り（並行のタブで足し算を取りこぼした）で、`repeat.jsonl` で直した値を使う。
