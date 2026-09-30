# Composition contract — `window.__hf`

動画生成パイプライン（ADR-0005 決定 6）における composition と capturer の契約の**正書**。composition は「`window.__hf` を実装した自己完結 HTML 1 枚」であり、契約はこのオブジェクトの形だけで定まる。シーン構造・アニメーション手段は本書で縛らない（執筆レシピは `collection-lifecycle` codec が持つ）。

消費者は 3 者 — `collection-lifecycle` codec（執筆レシピの根拠）、`video.render` / `video.preview`（検証実装の根拠）、ADR-0005（決定記録）。出所は issue #176（記述規約の設計）と issue #175（プロトタイプ実証）。

## 契約スケッチ

```html
<script>
  window.__hf = {
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 3600, // 秒
    seek(t) {
      /* 純関数: t → 描画状態 */
    },
    segments: [
      // タイムラインを網羅・非重複
      { start: 0, duration: 3600, static: true },
    ],
  };
</script>
```

`duration` + `seek(t)` は HyperFrames capture engine の要求と互換のプロトコル。それ以外（`width` / `height` / `fps` / `segments`)は nyacast 拡張キーで、HyperFrames engine は未知キーとして無視するため互換を壊さない。

## キー定義

| キー       | 型                              | 必須                 | 意味                                                                      |
| ---------- | ------------------------------- | -------------------- | ------------------------------------------------------------------------- |
| `width`    | number（正の整数、px）          | 必須                 | 撮影 viewport の幅。デザイン寸法と撮影寸法の SSOT                         |
| `height`   | number（正の整数、px）          | 必須                 | 撮影 viewport の高さ                                                      |
| `fps`      | number（正）                    | 必須                 | capture レート                                                            |
| `duration` | number（正、秒）                | 必須                 | タイムライン全長                                                          |
| `seek`     | `(t: number) => void`           | 必須                 | 時刻 `t`（秒、`0 <= t < duration`）の描画状態へ遷移させる。純関数性は次節 |
| `segments` | `{ start, duration, static }[]` | 必須（nyacast 拡張） | 静的シーンの自己申告。規則は後述                                          |

capture plan に必要な事実（`duration`・`segments`・寸法・`fps`）はすべて `__hf` に同居し、`Runtime.evaluate` 1 発で取得できる。channel config（データ 4 分類 ①）は**執筆時**のインテントとして codec 経由で参照するもので、**render 時**の SSOT は composition 側の申告である。

## seek の純関数性

`seek(t)` は `t` のみの関数として振る舞わなければならない:

- 同一 `t` への seek は、呼び出し履歴によらず同一の描画状態を生む（再 seek・逆順 seek でも同じ）
- wall-clock・乱数・外部入力・ネットワークに依存しない
- `video.render` はこれを**検証する**: サンプルフレームについて同一 `t` へ再 seek し、capture 結果をバイト比較する。不一致は非決定論として throw する（ADR-0005 改訂の Consequences）

決定論化の手段（GSAP は `gsap.ticker.remove(gsap.updateRoot)` + `lagSmoothing(0)` + `updateRoot(t)` 外部駆動、CSS / WAAPI は `document.getAnimations()` の `currentTime` seek 等）は本書の対象外 — 知識は codec のレシピが持ち、執行は agent が composition に埋め込む。本書が定めるのは意味論（上の 3 点）だけである。

## segments の規則

`segments` はタイムライン `[0, duration)` を**切れ目なく・重複なく**覆う:

- `start` 昇順に並べたとき、先頭の `start` は `0`
- 各要素の `start + duration` が次の要素の `start` に一致する
- 末尾の `start + duration` が `duration` に一致する

`static: true` は「区間内のどの `t` に seek しても同一の描画状態になる」ことの**自己申告**である。実行時検出はせず、申告を SSOT とする（issue #174 の決定）。capturer は static 区間の capture を代表 1 フレームに省略し、エンコード側で引き延ばしてよい（mediabunny `CanvasSource.add(timestamp, duration)`）。

申告の誤りは構造的に検出される — `video.preview` が各 segment の中点を撮るため誤申告は絵に出るほか、static 区間内の再 seek バイト比較でも不一致として表面化する。

## settle は capturer の責務

seek 後の描画安定（settle）を待つのは **capturer 側**の責務である: `seek(t)` 呼び出し後、**double rAF（`requestAnimationFrame` 2 段）を 50ms timeout と race** させてから capture する。これは capture 契約の一部 — 省くと stale capture（前の seek の絵）が混入することが issue #175 で実測されている。

composition 側は `seek(t)` が同期的に状態遷移を開始すれば足り、seek 内で描画完了を待つ義務を負わない。

## 自己完結性

composition は HTML 1 ファイルで完結する — スタイル・スクリプト・フォント・画像等の依存をファイル内に内包し、render の再現が成果物 1 ファイルで完結すること（issue #176 決定 3）。composition HTML はデータ 4 分類 ③（生成成果物）として collection ディレクトリ配下に置かれ、`video.render` / `video.preview` の入力になる。

## Related

- ADR-0005（改訂 2026-07-31 / #178）— 本契約を採用した決定記録
- issue #176 — 記述規約・役割分担の設計（本書の出所）
- issue #175 / PR #183 — end-to-end プロトタイプ（settle 規約・決定論検証の実証）
- `docs/research/hyperframes-internals-partial-use.md` — `__hf` プロトコル互換の根拠
- `docs/research/browser-frame-capture-deterministic.md` — seek 方式・決定論化レシピの根拠
