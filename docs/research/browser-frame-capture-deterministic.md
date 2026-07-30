# ブラウザ frame capture の技術手段（決定論的レンダリング）

- 調査日: 2026-07-31（issue #174 / map #172）
- 調査対象バージョン: CDP protocol docs (tot) / Chromium main・M132 以降の headless 構成 / Puppeteer v25.4.0 / Playwright main（Clock API は v1.45+）/ GSAP 3 (master) / Bun 1.3.x〜1.4 / mediabunny 1.x / Chrome for Testing Stable 151.0.7922.71
- 調査方法: 一次情報のみ。CDP 公式 protocol docs・devtools-protocol PDL 原文・Chromium ソース (source.chromium.org)・Chromium 公式設計ドキュメント・pptr.dev / playwright.dev / developer.chrome.com・GSAP 公式ソースと docs・oven-sh/bun の issue・実測値を含む GitHub issue 報告（出典明記）。二次記事は不使用。並列の research agent 4 本（CDP 仮想時間 / Puppeteer・Playwright と Chrome 供給 / スループット相場 / Bun 上の CDP クライアント）の結果を本書に統合した。

## 結論サマリ

- **決定論的レンダリングの「正典」は CDP 仮想時間 + BeginFrameControl のロックステップだが、tayk の本命にはできない。** BeginFrameControl は Target.pdl に "headless shell only, not supported on MacOS yet" と明文があり、chrome-headless-shell 専用かつ **macOS 非対応**。tayk の dogfood 環境（macOS）で動かない上、2026 年に Chromium 147 で beginFrame が機能しなくなったという運用報告もある（§2.2）。
- **本命は「ページ内時間の外部制御（seek）+ `Page.captureScreenshot`」。** GSAP は公式 API `gsap.updateRoot(t)` の外部駆動で、CSS/WAAPI アニメーションは `document.getAnimations()` + `currentTime` seek（pause 中の出力固定は W3C 仕様が保証）で、**どの Chrome・どの OS でも**フレーム精度の決定論化ができる。timecut/timesnap（時間 API の JS 注入上書き）・HyperFrames（`seek(t)` 注入）・Remotion（フレーム番号駆動）も本質は同じ「時計を止めて 1 フレームずつ進めて撮る」方式で、screencast 系だけが構造的に非決定論（§1）。
- **GSAP は rAF + `Date.now` 駆動**（公式ソースで確認）。仮想時間・fake clock の下でも進むが、**`gsap.ticker.lagSmoothing(0)` を呼ばないと 500ms 超のステップで時間が欠落**する。完全決定論には `gsap.ticker.remove(gsap.updateRoot)` + 毎フレーム `gsap.updateRoot(frame / fps)` が公式手順（§3）。
- **スループット**: 合格ライン（1h@30fps = 10.8 万フレームを 7200 秒以内 → 持続 15 fps）に対し、見つかった単タブ実測（2017〜2020）は PNG 1.4〜3.8 fps / JPEG 5.8 fps と不足。ただし JPEG 化で約 2 倍・`optimizeForSpeed`（2023 追加）・タブ並列（Remotion の設計そのもの、ボトルネックはキャプチャでプロトコル転送は数 ms）で到達見込みはある。**最新環境の 1080p 一次実測は存在せず、自前ベンチ（#175）が必須**（§6）。
- **静止画シーンの 1 フレーム省略は成立する。** mediabunny の `CanvasSource.add(timestamp, duration)` は秒単位の duration を明示指定でき、静止区間は 1 サンプルの引き延ばしで表現できる。v0.1 の動画要件（静止画 + 音声）なら capture は数枚に縮退し、10.8 万フレーム問題はそもそも発生しない（§7）。
- **Chrome 供給は Chrome for Testing / chrome-headless-shell の 2 択が pin 可能**（`@puppeteer/browsers` で `install`・パス解決、純 JS 依存のみ）。chrome-headless-shell は zip 約 99〜120 MB で chrome（187〜193 MB）の約 55〜62%。ユーザーの Chrome は自動更新でバージョン固定不可、開発時フォールバック以上にはならない（§5）。
- **Bun からの CDP は「素の WebSocket 自前」が最も筋が良い。** Bun で puppeteer/chrome-remote-interface が歴史的に壊れてきたのは常に `ws` npm シム層で、Bun ネイティブ `WebSocket` はその外にある。CDP transport は JSON over WebSocket だけで、自前実装は型定義 `devtools-protocol` を当てて 200〜400 行規模。puppeteer の Bun 対応は v1.4 でようやく主要故障が解消される段階（§8）。

---

## 1. アプローチ比較

「フレーム精度で決定論的に」の成立条件は、**(i) ページ内のすべての時間源を外部制御できること**と **(ii) 任意の時点の描画結果を 1 枚ずつ取り出せること**の 2 つ。調査で確認できたアプローチは 4 系統に分類できる。

| 方式 | 時間制御 | キャプチャ | 決定論性 | フレーム精度 | 実装の薄さ | 制約 |
|---|---|---|---|---|---|---|
| (A) CDP 仮想時間 + BeginFrameControl | `Emulation.setVirtualTimePolicy`（JS 時計・タイマー）+ `HeadlessExperimental.beginFrame`（rAF・compositor アニメーション） | `beginFrame` の `screenshot` パラメータ（フレーム確定と同時に画像が返る） | 完全（ブラウザ内部時間ごと制御） | 完全 | CDP 2 ドメインのみ | **chrome-headless-shell 専用・macOS 不可**・experimental・2026 年に故障報告 |
| (B) クライアントサイド仮想時間 | JS 注入で `Date.now` / `performance.now` / rAF / `setTimeout` 等を上書き（timeweb / Playwright Clock） | `Page.captureScreenshot` | JS 駆動アニメは完全。**CSS/compositor アニメは対象外**（WAAPI seek の併用が必要） | 完全 | 注入スクリプト + screenshot | 上書き漏れ（media 要素等）は方式ごとのカバレッジ次第 |
| (C) seek 方式（フレーム番号駆動） | ページ側 API で時刻 t へ seek（Remotion `useCurrentFrame` / HyperFrames `__hf.seek(t)` / GSAP `updateRoot(t)` + WAAPI `currentTime`） | `Page.captureScreenshot` | 完全（時計に依存する箇所が構造的にない） | 完全 | screenshot + ページ内 seek 関数 | composition 側に「seek 可能」という記述規約を課す |
| (D) screencast | なし（wall-clock の再描画に従属） | `Page.startScreencast` → `screencastFrame` イベント | **なし** | **なし**（frame swap の実時刻が付くだけ） | 薄い | 決定論用途には不適 |

- (D) は仕様レベルで除外できる。`Page.startScreencast` にはフレーム時刻を指定する手段がなく（`everyNthFrame` は生成済みフレームの間引きのみ）、`ScreencastFrameMetadata.timestamp` は "Frame swap timestamp."（型は `Network.TimeSinceEpoch` = wall-clock）— https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast 。Playwright のビデオ録画はこの上に載っている（`crPage.ts` が `Page.startScreencast` を送り、`videoRecorder.ts` が `frameSwapWallTime` 付きで ffmpeg に 25fps で書き出す — https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/chromium/crPage.ts / videoRecorder.ts）。公式 docs（https://playwright.dev/docs/videos ）にフレームレート・フレーム精度の保証は一切記載がない。
- (A)〜(C) は排他ではない。(C) の seek 関数の中身が (B) の時間上書きでもよい。実務上の分岐は「(A) を使えるか」＝ headless shell + Linux/Windows 限定を許容するか、だけ。

## 2. CDP プリミティブの詳細

### 2.1 `Emulation.setVirtualTimePolicy`

https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setVirtualTimePolicy （experimental）:

> "Turns on virtual time for all frames (replacing real-time with a synthetic time source) and sets the current virtual time policy."

- policy は `advance` / `pause` / `pauseIfNetworkFetchesPending` の 3 種。`budget` を与えると「仮想 N ms 経過後に一時停止して `Emulation.virtualTimeBudgetExpired` イベントを送る」。`maxVirtualTimeTaskStarvationCount` は無限ループページによるデッドロック回避（Chromium テストヘルパのデフォルトは 100000）。`initialVirtualTime` の説明に "base::Time::Now will be overridden to initially return this value" とある。
- 何が仮想時間に従うか: 実装は Blink スケジューラの `AutoAdvancingVirtualTimeDomain`（"A time domain that runs tasks sequentially in time order but doesn't sleep between delayed tasks." — https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/platform/scheduler/common/auto_advancing_virtual_time_domain.h ）で、**`base::Time::Now` / `base::TimeTicks::Now` をオーバーライドする**。よって renderer 内の `Date.now()`（base::Time 由来）・`performance.now()`（base::TimeTicks 由来）・`setTimeout` / `setInterval`（scheduler の遅延タスク）は仮想時間に従う。設計ドキュメントは "Virtual Time in Blink"（headless/README.md からリンク）。
- **rAF のタイムスタンプは仮想時間ではなく BeginFrame の frame time が駆動する**（§2.3 の Chromium テストで確認）。つまり `setVirtualTimePolicy` 単独では「JS の時計とタイマー」しか握れず、rAF と compositor アニメーションのフレーム時刻は別途 BeginFrameControl が必要 — これが (A) 方式が 2 ドメイン 1 組である理由。

### 2.2 `HeadlessExperimental.beginFrame`

https://chromedevtools.github.io/devtools-protocol/tot/HeadlessExperimental/ （ドメイン宣言: "This domain provides experimental commands only supported in headless mode."）:

> "Sends a BeginFrame to the target and returns when the frame was completed. Optionally captures a screenshot from the resulting frame. Requires that the target was created with enabled BeginFrameControl. Designed for use with --run-all-compositor-stages-before-draw, see also https://goo.gle/chrome-headless-rendering for more background."

- `frameTimeTicks`（このフレームの時刻。Renderer TimeTicks の ms）・`interval`（compositor に報告するフレーム間隔。既定 16.666 ms）・`noDisplayUpdates`（layout・アニメーション等の副作用だけ走らせ描画しない）・`screenshot`（format png/jpeg/webp・quality・optimizeForSpeed。**フレーム確定と同一コマンドで screenshotData が返る**）。`beginFrame` 自体に deprecated マークはない（deprecated は同ドメインの `enable`/`disable` のみ）。
- **使用条件**（ここが決定的な制約）:
  - `Target.createTarget` の `enableBeginFrameControl` パラメータの PDL 原文: **"Whether BeginFrames for this target will be controlled via DevTools (headless shell only, not supported on MacOS yet, false by default)."** — https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Target.pdl
  - 実装は headless shell の埋め込み層（`headless/lib/browser/protocol/headless_handler.cc`）にのみ存在し、`--enable-begin-frame-control` なしでは "Command is only supported if BeginFrameControl is enabled."、`--run-all-compositor-stages-before-draw` なしでは同旨のエラーを返す。macOS は `target_handler.cc` の `#if BUILDFLAG(IS_MAC)` で "BeginFrameControl is not supported on MacOS yet" を返す。`--deterministic-mode` が関連フラグを一括で立てる実装もある（`headless/lib/browser/command_line_handler.cc`）。
  - Chrome 132 で旧 headless は本体から削除され（"The old Headless mode will be removed in Chrome 132." — https://developer.chrome.com/blog/removing-headless-old-from-chrome ）、headless/README.md も "As of M132, headless shell functionality is no longer part of the Chrome binary" と記載。**「新 headless で使えない」という単一の明文はないが**、PDL の "headless shell only" とソース配置から、現行では chrome-headless-shell 専用と結論できる。
- **2026 年の故障報告**: HyperFrames の issue #294（https://github.com/heygen-com/hyperframes/issues/294 ）に「Chromium 147 で `HeadlessExperimental.beginFrame` が動かなくなり screenshot モードへ強制 fallback した」という運用報告がある。また puppeteer issue #11315（https://github.com/puppeteer/puppeteer/issues/11315 ）には headless で beginFrame が screenshot data を返さずハングする flaky 報告。CDP tot ドキュメントには experimental のまま掲載が続いており、削除の公式声明は見つからなかったが、**「experimental・headless shell 専用・macOS 不可・現行版での故障報告あり」の 4 点が揃っている API に 2026 年から新規依存するのはリスクが大きい**。

### 2.3 仮想時間 + beginFrame の正典手順（参考: (A) 方式の全体像）

Chromium 自身のテストヘルパ `headless/test/data/protocol/helpers/virtual-time-controller.js`（"A helper class to manage virtual time and automatically generate animation frames within the granted virtual time interval."）が正典手順そのもの:

1. `Emulation.setVirtualTimePolicy({policy: 'pause', initialVirtualTime})` で停止し `virtualTimeTicksBase` を記録
2. 最初の 1 フレームはフル更新の `beginFrame({frameTimeTicks: base})`（"Renderer wants the very first frame to be fully updated."）
3. `setVirtualTimePolicy({policy: 'pauseIfNetworkFetchesPending', budget: フレーム間隔, maxVirtualTimeTaskStarvationCount})` で 1 フレーム分だけ進める
4. `virtualTimeBudgetExpired` を待ち、`beginFrame({frameTimeTicks: base + 経過仮想時間, ...})` — 画像が要るフレームだけ `screenshot` 付き、不要なフレームは `noDisplayUpdates: true`
5. 3 に戻る

CSS アニメーション（compositor-driven）が `frameTimeTicks` に従って進むことは同テスト群 `compositor-css-animation-test.js`（opacity 4 秒往復を 500ms 刻みでピクセル検証）、rAF が beginFrame 駆動であることは `compositor-basic-raf.js` で確認できる。ただし threaded animation を切るフラグ（"Animation-only BeginFrames are only supported when updates from the impl-thread are disabled." — `headless_compositor_browsertest.cc`）等の同時指定が前提。設計ドキュメント "Rendering in Headless Chrome"（https://goo.gle/chrome-headless-rendering ）も "DevTools clients can choose manually when a frame should be rendered" / 仮想時間は "virtual time budget to the page in chunks (e.g. 50ms at a time for 20 virtual fps)" と同じ構図を示す。

**含意**: JS の時計・タイマーは仮想時間が、rAF と compositor アニメーションは beginFrame の frameTimeTicks が駆動する。**両者をロックステップで進めることが (A) 方式の決定論性の条件**。tayk 環境（macOS）では使えないため、この手順は「Linux CI で将来使う可能性のある参考形」に留まる。

### 2.4 `Animation` ドメイン（CSS/WAAPI の seek）

https://chromedevtools.github.io/devtools-protocol/tot/Animation/ （experimental）に `setPaused`（"Sets the paused state of a set of animations."）・`seekAnimations`（"Seek a set of animations to a particular time within each animation."）・`setTiming`・`setPlaybackRate` があり、`Animation` 型の `type` は `CSSTransition` / `CSSAnimation` / `WebAnimation` の 3 種をカバーする。

ページ内 JS でも同じことができる: `document.getAnimations()` は "CSS Animations・CSS Transitions・Web Animations API の Animation" をすべて返し（https://developer.mozilla.org/en-US/docs/Web/API/Document/getAnimations ）、`Animation.currentTime` は read-write（https://developer.mozilla.org/en-US/docs/Web/API/Animation/currentTime ）。W3C Web Animations spec は pause 中の出力が hold time で固定されることを規定している（"An animation also maintains a hold time time value which is used to fix the animation's output time value … in circumstances such as pausing." — https://www.w3.org/TR/web-animations-1/ ）ため、**pause → currentTime 設定 → screenshot の結果は screenshot 取得タイミングに依存しない**。

**含意**: 宣言的アニメーション（CSS/WAAPI）は仮想時間なしで決定論化できる。効かないのは `Date.now` / rAF ループで自前駆動する JS アニメーション（GSAP 等）— そこは §3 の手段で補う。

## 3. GSAP / CSS アニメーションが決定論的に進む条件

GSAP 公式ソース（https://github.com/greensock/GSAP/blob/master/src/gsap-core.js の TICKER セクション）で確認した事実:

- **(a) ticker は rAF 駆動、setTimeout フォールバック**: `_req = _raf || (f => setTimeout(f, ...))`。公式 docs も "updates the globalTimeline on every `requestAnimationFrame` event"（https://gsap.com/docs/v3/GSAP/gsap.ticker/ ）。
- **(b) 時刻取得は `Date.now`**（`performance.now` ではない）: `let _getTime = Date.now,` … `_tick = v => { let elapsed = _getTime() - _lastUpdate, ...`。
- **(c) lagSmoothing が決定論性を壊す**: デフォルト `_lagThreshold = 500, _adjustedLag = 33`。tick 間の経過が 500ms を超える（または負になる）と内部基準時刻をずらして「33ms しか経っていない」ことにする（`(elapsed > _lagThreshold || elapsed < 0) && (_startTime += elapsed - _adjustedLag)`）。フレームステップ実行で 1 ステップ > 500ms 進めると時間が欠落する。**`gsap.ticker.lagSmoothing(0)` で完全に無効化できる**（`_lagThreshold = threshold || Infinity`）。
- **(d) 完全外部駆動の公式手順**: `gsap.updateRoot(seconds)`（https://gsap.com/docs/v3/GSAP/gsap.updateRoot()/ — "manually update the root (global) timeline"）。`gsap.ticker.remove(gsap.updateRoot)` で ticker から root 更新を外し、自前ループで毎フレーム `gsap.updateRoot(frame / fps)` を呼ぶ。この形は **`Date.now` にも rAF にも依存しない完全決定論**になる。

方式別の帰結:

| 方式 | GSAP が正しく進む条件 |
|---|---|
| (A) 仮想時間 + beginFrame | `Date.now` は仮想時間に、rAF は beginFrame に従うので、ロックステップなら進む。**`lagSmoothing(0)` 必須**（プリロール等で 500ms 超を進める場合に時間欠落） |
| (B) クライアントサイド仮想時間 | timeweb 系は `Date.now`・rAF とも上書きするので進む（同条件で `lagSmoothing(0)` 推奨）。Playwright Clock も `Date` と `requestAnimationFrame` を fake する（§4.2）ので JS 世界に閉じた GSAP は駆動できる |
| (C) seek 方式 | `gsap.updateRoot(t)` 外部駆動なら時計上書き自体が不要。CSS/WAAPI は §2.4 の seek で併走 |

なお Remotion は「コンポーネントは `useCurrentFrame()` の純関数であれ」を前提にするため、実時間駆動の GSAP はそのままでは壊れる（HeyGen の比較文書に、Remotion 出力で GSAP の 4 秒アニメがレンダリング最初の 1 秒で走り切る実例 — https://github.com/heygen-com/hyperframes/blob/main/docs/guides/hyperframes-vs-remotion.mdx ）。**tayk が GSAP を採るなら (B) か (C) が構造的に相性が良い。**

## 4. Puppeteer / Playwright / 素の CDP の比較

### 4.1 Puppeteer

- `page.screenshot()` は CDP `Page.captureScreenshot` の薄いラッパ（`packages/puppeteer-core/src/cdp/Page.ts` が `Page.captureScreenshot` に `format / optimizeForSpeed / fromSurface / captureBeyondViewport` をそのまま渡す — https://github.com/puppeteer/puppeteer/blob/main/packages/puppeteer-core/src/cdp/Page.ts ）。隠れた加工はない。
- `page.createCDPSession()` で生 CDP を送れる（https://pptr.dev/api/puppeteer.page.createcdpsession ）。
- **virtual time / beginFrame の高レベル API は存在しない**（リポジトリ全体で `HeadlessExperimental` / `setVirtualTimePolicy` のヒット 0 件）。フレーム精度制御をやる部分は結局生 CDP を書くことになり、Puppeteer は「ブラウザ起動と接続管理の層」としてだけ働く。

### 4.2 Playwright

- Chromium では screenshot も CDP `Page.captureScreenshot` 経由（`crPage.ts`）。screenshot には `animations: 'disabled'` オプションがあり、公式 docs は "stops CSS animations, CSS transitions and Web Animations. … finite animations are fast-forwarded to completion" — **Playwright 自身が「CSS アニメーションは screenshot 時に別枠で止める必要があるもの」として設計している**。
- **Clock API（v1.45+、https://playwright.dev/docs/clock ）**: fake するのは "`Date`, `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`, `requestAnimationFrame`, `cancelAnimationFrame`, `requestIdleCallback`, `cancelIdleCallback`, `performance`, `Event.timeStamp`"（公式列挙）。実装は Sinon fake-timers の fork を init script として注入する方式（`packages/injected/src/clock.ts` の著作権ヘッダが Christian Johansen = Sinon 作者。https://github.com/microsoft/playwright/blob/main/packages/injected/src/clock.ts ）。**列挙されるのはすべて JS 世界の API で、compositor のフレームクロック・宣言的 CSS アニメーション・動画再生は含まれない**（明文はないが、列挙 + 注入実装 + `animations: 'disabled'` の存在が傍証）。rAF 駆動の JS 描画に限れば `clock.pauseAt` → `clock.runFor(1000/fps)` → screenshot のループは成立する。
- 生 CDP は `browserContext.newCDPSession(page)`（"CDP sessions are only supported on Chromium-based browsers."）。
- ブラウザは Playwright 専用ビルド必須（`npx playwright install`、Playwright 更新のたび再取得 — https://playwright.dev/docs/browsers ）。**tayk が Chromium だけ使う前提では、3 エンジン対応・独自ビルドという Playwright の差別化要素はすべて不要側に落ち、独自ビルド管理だけがコストとして残る。**

### 4.3 素の CDP

- 必要なプリミティブ（`Target.attachToTarget` / `Page.captureScreenshot` / 必要なら `Emulation.setVirtualTimePolicy`）はすべて protocol docs に定義があり、Chromium の headless README 自身が `chrome-remote-interface` による生 CDP の利用例を載せている（https://github.com/chromium/chromium/blob/main/headless/README.md ）。
- 3 者とも最終的に同じ CDP コマンドへ行き着くため、**差はブラウザ供給と接続管理の層だけ**。最薄構成は「chrome-headless-shell または CfT + WebSocket クライアント（§8）」、次点が「puppeteer-core（起動・接続管理のみ）+ `@puppeteer/browsers`（供給）」。

## 5. Chrome の供給方法

| 選択肢 | セットアップ | 配布物同梱 / 実行時 DL | バージョン pin | サイズ（zip 実測、Stable 151.0.7922.71） |
|---|---|---|---|---|
| Chrome for Testing | `npx @puppeteer/browsers install chrome@<ver>`（または known-good-versions JSON から URL を引いて curl） | どちらも可（URL がバージョン固定で CI キャッシュ向き） | **可** | mac-arm64 187.1 MB / linux64 193.3 MB |
| chrome-headless-shell | `npx @puppeteer/browsers install chrome-headless-shell@<ver>` | どちらも可 | **可** | mac-arm64 99.0 MB / linux64 120.2 MB（chrome の約 55〜62%） |
| ユーザーの Chrome | 不要（puppeteer `channel: 'chrome'` / `executablePath`、playwright `channel: 'chrome'`） | 同梱不可・DL 不要（環境依存） | **不可**（自動更新。pptr.dev は executablePath 利用を "at your own risk" と明記） | — |

- Chrome for Testing の目的はまさに再現性: "consistent, reproducible results across repeated test runs" / "without auto-update … made available for every Chrome release"（https://developer.chrome.com/blog/chrome-for-testing/ ）。ダッシュボードと JSON API は https://googlechromelabs.github.io/chrome-for-testing/ 。
- chrome-headless-shell は旧 headless の分離配布（"The old Headless implementation is now available as a standalone `chrome-headless-shell` binary" — https://developer.chrome.com/blog/chrome-headless-shell ）。BeginFrameControl を使うならこれが実質一択（§2.2）だが、(B)/(C) 方式なら CfT（新 headless）でもよい。Remotion は「Chrome Headless Shell は CPU バウンドなレンダリングで速く、Chrome for Testing は GPU バウンドで速い」と定性的に述べる（https://www.remotion.dev/docs/miscellaneous/chrome-headless-shell 、数値なし）。
- `@puppeteer/browsers` は Puppeteer 本体なしで単独利用できるダウンローダ/ランチャ（"Manage and launch browsers/drivers from a CLI or programmatically." — https://pptr.dev/browsers-api/ ）。依存は純 JS 2 つ（`modern-tar` / `yargs`）でネイティブモジュールなし。`computeExecutablePath` でパスだけ取り、起動は `Bun.spawn` に寄せれば `child_process` 互換にも依存しない。Bun 上の動作報告は肯定・否定とも見つからなかったが、依存構成から動く公算が高い（未検証と明記）。

## 6. 1080p capture スループットの相場と合格ライン見込み

合格ライン: フルパイプラインで実時間の 2 倍以内（1h 動画 = 108,000 frames @30fps を 7200 秒以内）→ **持続 15 fps 以上**。エンコード側は実測 165 fps（ADR-0005 / issue #46）で余裕があり、律速は capture。

一次実測として見つかったもの:

| 出典 | 条件 | 実測 |
|---|---|---|
| puppeteer #476（2017、メンテナ実測、1000x1000） | `Page.captureScreenshot` 単発 | 合計 138ms = キャプチャ 61ms + PNG エンコード 71ms + 転送約 6ms。**JPEG は 53ms**（PNG 101ms の約半分） |
| puppeteer #2568（2018、macOS、1920x1080） | newPage〜close 一式 | headless 平均 647.5ms/回 |
| timesnap #8 / timecut #23（2018〜2020） | 1920x1080 連続 capture | PNG 単タブ **1.4〜3.8 fps**、JPEG q80 **約 5.8 fps**、canvas capture mode なら約 30 fps。作者 tungs: "puppeteer の screenshot がボトルネックで、実用上ほとんどのケースで実時間より遅い" |
| WebVideoCreator README（https://github.com/Vinlic/WebVideoCreator ） | 1280x720@30fps、beginFrame 方式、Ryzen 7 3700X + NVENC | 300 秒の動画を 61 秒 = **RTF 4.84 ≒ 720p で約 145 fps** |

判定材料:

- **悲観**: 見つかった 1080p 実測はすべて 2017〜2020 のもので、単タブ PNG では合格ラインに遠く届かない。15 fps ライン = 66ms/枚に対し当時の JPEG 実測 53ms/枚はボーダー。
- **楽観**: (i) JPEG 化だけで約 2 倍（#476）。(ii) `Page.captureScreenshot` に `optimizeForSpeed`（"Optimize image encoding for speed, not for resulting size"）が追加済み（puppeteer には PR #10492、2023-07、v20.8.0 — 定量効果の一次実測は未発見）。(iii) ボトルネックはキャプチャ + 画像エンコードでプロトコル転送は数 ms → **決定論的な時間制御があればタブ並列でほぼ線形にスケールする**。これは Remotion の設計そのもの（concurrency = 並列タブ数、デフォルト CPU スレッド数の半分 — https://www.remotion.dev/docs/terminology/concurrency ）。(iv) 静止区間スキップ（§7)が実効スループットを底上げする。
- beginFrame 方式は 720p RTF 4.8 の実績があるが §2.2 の理由で新規採用リスクが大きい。**本命は `Page.captureScreenshot`（JPEG + optimizeForSpeed）+ タブ並列**。
- **確定には自前ベンチが必須**（2024 年以降の環境での 1080p 公開実測は存在しない）。#175 の end-to-end プロトタイプで「JPEG q80 + optimizeForSpeed、単タブ → 2/4 タブ」を数百フレーム回して測るのが最短。

なお Remotion 自体の流用について: レンダラは自前 CDP クライアントで `Page.captureScreenshot` を呼ぶフレーム番号駆動方式（https://github.com/remotion-dev/remotion/blob/main/packages/renderer/src/screenshot-task.ts ）で公式実測 fps の公表はなく、ライセンスは従業員 3 名以下の営利組織まで無料・それ超は有償 Company License（https://github.com/remotion-dev/remotion/blob/main/LICENSE.md ）。v0.1 スコープ外（CLAUDE.md）に加えライセンス面の考慮も要るため、本調査では方式の参照実装として扱うに留める。

## 7. 静止画シーンの 1 フレーム省略

**エンコーダ側は API 上ストレートに成立する。** mediabunny の `CanvasSource.add(timestamp, duration)` は秒単位の timestamp と duration を明示指定する API（例: `await canvasSource.add(0.0, 0.1)` — https://mediabunny.dev/guide/media-sources ）。静止区間は 1 サンプルに長い duration を与えるだけで表現でき、可変フレームレートの mux が自然に書ける。`VideoSampleSource` も同様にサンプル自身の timestamp/duration に従う。**つまり「静止シーンは 1 枚だけ撮って引き延ばす」は capture 側が静止区間を知ってさえいれば成立し、10.8 万フレーム問題は回避できる。** v0.1 の動画要件（静止画 + 音声、map #172）なら capture 枚数はシーン数程度まで縮退する。

**「静止であること」の機械判定に公式ワンライナーはない:**

- `document.getAnimations()` は CSS Animations / CSS Transitions / WAAPI を返すが、**GSAP や rAF ベースの JS アニメは含まれない**（https://developer.mozilla.org/en-US/docs/Web/API/Document/getAnimations ）。
- GSAP の `gsap.globalTimeline.isActive()` は「常に true を返す」と公式 docs が明記しており使えない（https://gsap.com/docs/v3/GSAP/gsap.globalTimeline/ ）。`globalTimeline.getChildren()` で子 tween を列挙して個別に `isActive()` を見る組み合わせは API 上可能だが、公式推奨手順としては見つからなかった。

**含意**: 静止区間は実行時検出ではなく **composition 記述（#176 の記述規約）側の自己申告（シーン timeline をデータとして持つ）を SSOT にする**のが確実で、`getAnimations()` + GSAP 子 tween 走査は検証用の補助に留めるのが安全。これは (C) seek 方式（時刻 → 描画の純関数化）と同じ前提に乗る。

## 8. Bun 上の CDP クライアント

| | (A) puppeteer-core | (B) chrome-remote-interface | (C) 素の WebSocket 自前 |
|---|---|---|---|
| Bun での動作 | 主要故障（`connect` ハング #8320、`ws` シムの `unexpected-response` 未実装 #31792 等）が 2026-07 に "Fixed on main" で一斉クローズ、**修正が載るのは Bun v1.4**（Jarred Sumner: "The fix for this will be part of the Bun v1.4 release" — https://github.com/oven-sh/bun/issues/31792 ）。`bun test` からの launch（#21058）・`bun build`（#19185）等は open のまま | Bun main で動作検証済み（#9505、2026-07-24 クローズ）だが `ws` シム経由は変わらず | **Bun ネイティブ `WebSocket` は `ws` シム問題の構造的な外側**（"Bun implements the `WebSocket` class." — https://bun.com/docs/runtime/http/websockets ） |
| 依存 | ws / chromium-bidi / webdriver-bidi-protocol ほか多数（engines node >=22） | `ws` + `commander` の 2 つのみ。ブラウザ管理なし。型は DefinitelyTyped 頼み | 実行時依存ゼロ。型は公式 `devtools-protocol` パッケージ（型定義のみ）。供給に `@puppeteer/browsers` を任意で併用 |
| 実装量 | ほぼゼロ | 少（起動管理と capture ループは自前） | **200〜400 行規模の見積り**: launcher（`Bun.spawn` + `--remote-debugging-port=0` → stderr の "DevTools listening on ws://…" / `DevToolsActivePort` から URL 取得）60〜100 行、connection（id 採番と pending Map、イベント分配）80〜120 行、session（`Target.createTarget` → `attachToTarget({flatten: true})` → コマンドに `sessionId` 付与）40〜60 行、capture 40〜80 行 |
| リスク | Bun 互換バグの再発に人質。v1.4 未満では動かない経路あり | メンテ頻度不明・`ws` シム間接層が残る | CDP エッジケース（再接続・targetCrashed 等）を自分で持つ |

- CDP transport は「JSON over WebSocket だけ」: コマンド `{id, method, params}` / 応答 `{id, result|error}` / イベント `{method, params}`、ページごとの多重化は `Target.attachToTarget` の `flatten: true` で得た `sessionId` をコマンドに付けるだけ（"Enables 'flat' access to the session via specifying sessionId attribute in the commands." — https://chromedevtools.github.io/devtools-protocol/tot/Target/ ）。エンドポイント発見は `--remote-debugging-port` 起動 + `GET /json/version` の `webSocketDebuggerUrl`（https://chromedevtools.github.io/devtools-protocol/ ）。サブプロトコルも拡張フレームも使わないため標準 WebSocket クライアントで足りる。
- playwright は公式に「Bun ではテストしていない・自己責任」（maintainer 回答で feature request は NOT_PLANNED クローズ — https://github.com/microsoft/playwright/issues/38095 ）。候補から外してよい。
- 番外: **`Bun.WebView`**（Bun v1.3.12+、https://bun.com/docs/runtime/webview ）はランタイム組み込みの CDP ベース自動化で `screenshot()` と生 `cdp(method, params)` を持つが、experimental 明記・macOS の既定バックエンドは Chrome ではなく WKWebView（レンダリング一貫性が要る用途では Chrome バックエンド明示が必要）・open bug あり。将来 (C) を置き換えうる候補として監視に留める。

**含意**: tayk の前提（Bun 必須・thin architecture・capture という狭い用途）では **(C) 素の WebSocket 自前が最も筋が良い**。歴史的に壊れてきたのは常に `ws` シム層でネイティブ `WebSocket` はその外にあり、必要な CDP 面積（Target + Page + Emulation の一部）が小さく、バイナリ供給は `@puppeteer/browsers` の `install` + `computeExecutablePath` だけ借りれば puppeteer 本体を持ち込まずに済む。

## 9. tayk への含意（推奨の形）

1. **方式**: (C) seek 方式を軸にする — composition 記述（#176）に「時刻 t への seek 関数」を規約として課し、GSAP は `gsap.updateRoot(t)` 外部駆動 + `lagSmoothing(0)`、CSS/WAAPI は `document.getAnimations()` + `currentTime` seek。capture は `Page.captureScreenshot`（JPEG + `optimizeForSpeed`）。この形は macOS/Linux 両対応で、beginFrame にも Playwright にも依存しない。
2. **capture 層**: Bun ネイティブ WebSocket の薄い自前 CDP クライアント（200〜400 行規模）+ `@puppeteer/browsers` によるバイナリ供給。ADR-0001 の thin architecture と整合する。
3. **性能**: 単タブで 15 fps に届かない場合はタブ並列（決定論的 seek なら安全に並列化できる）。まず #175 のプロトタイプで単タブ実測 → 必要なら並列化。静止区間は capture 省略 + mediabunny `add(timestamp, duration)` で縮退させる。
4. **Chrome 供給**: Chrome for Testing をバージョン pin（beginFrame を使わないので headless shell 縛りはないが、サイズ・速度次第で chrome-headless-shell も可。#175 で両方測るとよい）。
5. HyperFrames の capture 層部分利用の可否は #173 が担当（本調査の範囲外）。HyperFrames 自身も「`__hf.seek(t)` 注入 + Linux では beginFrame / それ以外は screenshot fallback」という本書 (A)+(C) のハイブリッドであることだけ付記する。

## 分からなかったこと（正直な申告）

- "Virtual Time in Blink" 設計ドキュメントに「Date.now / performance.now / rAF タイムスタンプを置き換える」という明示列挙はない。Date.now / performance.now は PDL と `auto_advancing_virtual_time_domain.h` の Time/TimeTicks オーバーライド記述からの導出、rAF は Chromium テストの挙動（beginFrame 駆動）が根拠。
- 新 headless（統合モード）が将来 BeginFrameControl をサポートするかの公式声明は未発見（現状 "headless shell only" の PDL 明文のみ確定）。Chromium 147 での beginFrame 故障（hyperframes #294）の正確な原因・公式アナウンスも未発見 — 採用するなら自前検証が要る。
- 「Playwright の video はフレーム精度が保証されない」「CSS/compositor アニメーションは Clock の影響を受けない」の明文は公式 docs に存在しない。いずれもソース実装（screencast / init-script 注入）+ 保証の不在 + `animations: 'disabled'` オプションの存在からの推論。
- `optimizeForSpeed` の定量効果の公式一次実測、beginFrame vs `captureScreenshot` の直接速度比較、2024 年以降の環境での 1080p capture 公開実測は、いずれも見つからなかった。合格ライン判定の確定は #175 の自前ベンチに委ねる。
- `@puppeteer/browsers` の Bun 上での動作報告（肯定・否定とも未発見。純 JS 依存 2 つという構成からの推測のみ）。`Bun.spawn` で FD 3/4 を渡す `--remote-debugging-pipe` 接続の可否も未検証（ポート方式が使えるなら不要）。

## Related

- map issue #172（動画生成 HTML パイプライン化マップ）/ 兄弟チケット #173（HyperFrames 内部構造）・#175（end-to-end プロトタイプ）・#176（composition 記述規約）・#178（ADR-0005 改訂）
- ADR-0003（Bun 必須配布）/ ADR-0005（mediabunny + node-av 統一、1080p30 エンコード 165 fps 実測）
- `docs/research/mediabunny-bun-codec-support.md`（mediabunny の Bun 成立性）
