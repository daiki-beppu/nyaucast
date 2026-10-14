# フラグ併用時の Chrome の空回りを止める手段

- 調査日: 2026-10-14（issue #791 / map #789 / 背景 #747）
- 調査対象バージョン: chrome-headless-shell mac_arm 154.0.8037.92（`src/lib/chrome-pin.ts` の pin）/ Chromium ソースは同じ版のタグ `refs/tags/154.0.8037.92` / CDP protocol PDL（ChromeDevTools/devtools-protocol master）
- 調査方法: Chromium ソース（chromium.googlesource.com のタグ）と CDP の PDL 原文を一次資料とし、この Mac（Apple Silicon 10 コア）で小さな Node スクリプトによる実測を加えた。実測は 3 秒の窓で Chrome のプロセスツリーの CPU 時間（`ps` の TIME）の差を取った。測定中の負荷平均は 14 前後（ほかのセッションが動いていた）で、絶対値には揺れがある。ページは #747 と同じ形（320x180、`window.__hf.seek(t)` で transform と停止中の CSS animation の `currentTime` を動かす）、撮影手順は `src/compositions/capture.ts` と同じ（seek → double rAF と 50 ms の race → `Page.captureScreenshot` の PNG）。

## 結論サマリ

- **空回りは「ページ（renderer の compositor）が 1 枚でも開いている間」だけ起きる。** 起動直後のページなしの Chrome と、ページを `Target.closeTarget` で閉じた後の Chrome は 0.00 コア。ページを開くと 3.4〜3.6 コアになる（§3.1）。
- **原因は 2 つのフラグの組み合わせでできる busy loop。** `--run-all-compositor-stages-before-draw` は cc の scheduler を `HeadlessSchedulerStateMachine` に替え、これは**仕事がなくても常に BeginFrame を購読する**。`--disable-frame-rate-limit` は viz の表示側の BeginFrame の源を `BackToBackBeginFrameSource`（前のフレームが終わった直後に次を出す、間隔の待ちなし）に替え、cc の描画の ack 待ちの抑止も外す。「常に欲しがる」×「待たずに出す」で、何も描くものがないページでも BeginFrame が休みなく回る（§1）。片方だけなら、60 Hz で回る（前者）か、仕事がないと購読を止める（後者）ので空回りしない。
- **ページを開いたまま空回りを止める CDP の手段は見つからなかった。**
  - `Page.setWebLifecycleState` の `frozen`: 2.9 コアに下がるだけで止まらない。しかも凍結は先にページを hidden にする実装で、`active` に戻しても hidden のまま残り、rAF が止まり `setTimeout` が 1 秒に間引かれる。撮影は 1 フレーム約 1 秒に落ちた（PNG のバイト列は一致した）。**使えない**（§2.1）
  - `Emulation.setCPUThrottlingRate`: renderer の main thread だけを間引く実装で、compositor と viz の loop には効かない。3.8 コアのまま（§2.2）
  - `Emulation.setVirtualTimePolicy` の `pause`: 2.8 コア。止まらない（§2.2）
  - `about:blank` への遷移: 3.4 コアのまま（§2.2）
- **実行時に 2 つのフラグを切り替える手段はない。** どちらもプロセス起動時のコマンドラインを、compositor・frame sink を作る時点で読む（renderer へはプロセス起動時に引き継がれる）。CDP の PDL にも BeginFrame の源や frame rate の制限を変えるコマンドはない（§1.3）。切り替えは Chrome の起動し直しでしかできない。
- **「撮影の間だけ Chrome を起動する」はすでに現行の形で、それでも空回りの問題は消えない。** 現行の `Chrome.openPage` は呼ぶたびに Chrome を起動し、描画（`video.renderCut`）は 1 カットのスコープで開いて閉じる（§4）。ところが空回りは撮影の**最中にも**起きている: フラグ併用で 60 フレームを撮る間、Chrome は 4.0 コア（撮影の間に 30 ms の待ちを挟むと 3.6 コア）を使い、フラグなしの 0.1 コアの約 9〜30 倍の CPU 時間を消費した（§3.2）。撮影と並行するエンコードや、並行に走るテストとの CPU の奪い合いは、カット単位の起動では避けられない。起動の費用自体は小さい（起動から 1 ページの読み込みまで約 0.2 秒、終了 20〜40 ms）。
- **含意**: 併用を採るなら「空回りは止められない前提で、Chrome を同時に 1 本に絞る（並行の描画・テストで複数の Chrome を開かない）」か、「`--disable-frame-rate-limit` 単独（空回りなし）」のどちらかになる。採否は #793 で扱う。

---

## 1. 2 つのフラグが Chromium の中で変えるもの

### 1.1 `--run-all-compositor-stages-before-draw`

- 定義: "Effectively disables pipelining of compositor frame production stages by waiting for each stage to finish before completing a frame."（`components/viz/common/switches.cc` L47-50 — https://chromium.googlesource.com/chromium/src/+/refs/tags/154.0.8037.92/components/viz/common/switches.cc#47 ）
- 読む場所: renderer の `LayerTreeSettings` が `settings.wait_for_all_pipeline_stages_before_draw = cmd.HasSwitch(::switches::kRunAllCompositorStagesBeforeDraw)` で読む（`third_party/blink/renderer/platform/widget/compositing/layer_tree_settings.cc` L555-556）。browser 側の `ui::Compositor` も同じく読む（`ui/compositor/compositor.cc` L223-224）。cc の `SchedulerSettings` には "This is enabled for headless-mode and some tests" とある（`cc/scheduler/scheduler_settings.h` L43-47）。
- 効果: この設定が立つと cc の `Scheduler` は状態機械に `HeadlessSchedulerStateMachine` を使う（`cc/scheduler/scheduler.cc` L66-67 — https://chromium.googlesource.com/chromium/src/+/refs/tags/154.0.8037.92/cc/scheduler/scheduler.cc#66 ）。この状態機械の `ShouldSubscribeToBeginFrames` は、frame sink の初期化さえ済んでいれば**無条件に true** を返す:

  > "The propagation of the NeedsBeginFrame signal to viz is inherently racy with issuing the next BeginFrame. In full-pipe mode, it is important we don't miss a BeginFrame because our needsBeginFrames signal propagated to viz too slowly. To avoid the race, we simply always request BeginFrames from viz."
  > — `cc/scheduler/headless_scheduler_state_machine.cc` L31-43（https://chromium.googlesource.com/chromium/src/+/refs/tags/154.0.8037.92/cc/scheduler/headless_scheduler_state_machine.cc#31 ）

  通常の `SchedulerStateMachine::ShouldSubscribeToBeginFrames` は「hidden なら購読しない」「描く・commit する等の仕事があるときだけ購読する」（`BeginFrameRequiredForAction() || BeginFrameNeededForVideo() || ProactiveBeginFrameWanted()`）という判定を持つが（`cc/scheduler/scheduler_state_machine.cc` L1179-1191）、headless 版はこれを丸ごと飛ばす。**ページが hidden でも、描くものがなくても、BeginFrame を欲しがり続ける。**
  また headless 版は deadline を即時に切る（"In full-pipe mode, we just gave all pipeline stages a chance to contribute. We shouldn't wait any longer in any case - even if there are no updates." — 同ファイル L50-74）。
- 参考: headless shell の `--deterministic-mode` はこのフラグを自動で足す（`headless/lib/browser/command_line_handler.cc` L36-50）。本来は `HeadlessExperimental.beginFrame`（BeginFrameControl。macOS 非対応 — docs/research/browser-frame-capture-deterministic.md §2.2）と組で使う前提のフラグで、BeginFrame を DevTools が手で出す構成なら「常に購読」でも空回りしない。

### 1.2 `--disable-frame-rate-limit`

- 定義: "Disables begin frame limiting in both cc scheduler and display scheduler. Also implies --disable-gpu-vsync"（`components/viz/common/switches.cc` L30-36）。
- 表示側（viz）: browser が root の frame sink を作るとき `root_params->disable_frame_rate_limit = true` を立て（`content/browser/compositor/viz_process_transport_factory.cc` L426-427）、viz はその場合、Mac なら本来使う `ExternalBeginFrameSourceMac`（display link 駆動）の代わりに `BackToBackBeginFrameSource` を作る（`components/viz/service/frame_sinks/root_compositor_frame_sink_impl.cc` L202-206 — https://chromium.googlesource.com/chromium/src/+/refs/tags/154.0.8037.92/components/viz/service/frame_sinks/root_compositor_frame_sink_impl.cc#202 ）。
- `BackToBackBeginFrameSource` の動き（`components/viz/common/frame_sinks/begin_frame_source.cc` L268-361）: 時間源を間隔 0 で作り（"The time_source_ ticks immediately, so we SetActive(true) for a single tick when we need it"）、observer がフレームを終えた（`DidFinishFrame`）直後に時間源を再び active にして次の BeginFrame を出す。間隔の待ちはなく、止まるのは observer が外れた（`RemoveObserver`）ときだけ。
- 描画側（cc）: renderer の `LayerTreeSettings.disable_frame_rate_limit`（`layer_tree_settings.cc` L570-571）が scheduler に渡り（`cc/trees/layer_tree_settings.cc` L52）、`IsDrawThrottled()` が常に false になる（"pending_submit_frames_ >= kMaxPendingSubmitFrames && !settings_.disable_frame_rate_limit" — `scheduler_state_machine.cc` L1508-1513）。未 ack のフレームが溜まっても描画を止めない。browser の `ui::Compositor` は vsync の間隔の更新を無視する（`ui/compositor/compositor.cc` L638-644）。

### 1.3 組み合わせで何が回り続けるか

- 併用時、renderer の compositor は（1.1 により）BeginFrame を**常に購読**し、viz は（1.2 により）その observer に**前のフレームが終わった直後に次の BeginFrame を出す**。描く変化がなくても「BeginFrame → 即時の deadline でフレームを終える → 次の BeginFrame」が休みなく続く。片方だけの構成では、`--run-all-compositor-stages-before-draw` 単独は購読し続けても源が 60 Hz（display link）なので 1 秒 60 回で止まり、`--disable-frame-rate-limit` 単独は源が back-to-back でも、仕事がなくなれば通常の状態機械が購読を外すので止まる。実測もこれと一致する（§3.1: 単独はどちらも 0.00〜0.03 コア）。
- 実測のプロセス別の内訳（併用・何もしていないページ・3 秒）: GPU プロセス（viz の表示側）5.81 秒 / renderer 3.07 秒 / browser 1.46 秒。BeginFrame の往復が 3 つのプロセスにまたがって回っている。
- **実行時の切り替えはできない。** どのフラグも `base::CommandLine` をプロセスと compositor の作成時に読む（renderer の `LayerTreeSettings` は widget の compositor を作るとき、viz の BeginFrame の源は root の frame sink を作るとき、`ui::Compositor` の vsync の無視は関数内 static で 1 回だけ）。renderer へは browser がプロセス起動時に引き継ぐスイッチの一覧に両方が入っている（`content/browser/renderer_host/render_process_host_impl.cc` L3881・L4012）。CDP の PDL（Page / Emulation / Target / HeadlessExperimental / Browser / Overlay）にも、BeginFrame の源・frame rate の制限・vsync を変えるコマンドはない（BeginFrame を手で出す `HeadlessExperimental.beginFrame` は macOS 非対応）。

## 2. CDP で空回りを止める候補

### 2.1 `Page.setWebLifecycleState`（`frozen`）

- PDL: `experimental command setWebLifecycleState`、`enum state { frozen, active }`（Page.pdl — https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Page.pdl ）。
- 実装（`content/browser/devtools/protocol/page_handler.cc` L1981-2002 — https://chromium.googlesource.com/chromium/src/+/refs/tags/154.0.8037.92/content/browser/devtools/protocol/page_handler.cc#1981 ）: `frozen` は `web_contents->WasHidden()` の後に `SetPageFrozen(true)`（"TODO(fmeawad): Instead of forcing a visibility change, only allow freezing a page if it was already hidden."）。`active` は `SetPageFrozen(false)` だけで、**hidden は戻さない**。
- 効果がない理由: 凍結が止めるのは renderer の main thread のタスクで、compositor thread と viz の BeginFrame の loop は止まらない。hidden にしても、§1.1 のとおり headless 版の状態機械は visibility を見ずに購読を続ける。
- 実測:

  | 状態 | Chrome の CPU（3 秒） |
  | --- | --- |
  | 併用・何もしていないページ | 10.87 秒（3.62 コア） |
  | `frozen` にした後 | 8.70 秒（2.90 コア） |
  | `frozen` → `active` の後（hidden のまま） | 8.60 秒（2.87 コア） |
  | さらに `Page.bringToFront` の後 | 8.60 秒（2.87 コア）。`document.visibilityState` は `hidden` のまま |

- 撮影への副作用: `active` に戻した後は `document.visibilityState` が `hidden` のままで、rAF は 3 秒待っても呼ばれず、`setTimeout(50)` は約 1000 ms で発火した（hidden のページのタイマーの間引き）。撮影の settle は double rAF と 50 ms の race なので、1 フレーム約 970 ms（30 フレームで 29,115 ms。凍結前は 259 ms）に落ちた。**PNG のバイト列は 30 フレームともフラグなしの撮影と一致した**（seek は同期的に style を変え、`Page.captureScreenshot` が自分でフレームを作るため）。ただし速度の面で使えない。

### 2.2 そのほかの候補

| 手段 | 実装・根拠 | 実測（併用、3 秒） |
| --- | --- | --- |
| `Emulation.setCPUThrottlingRate`（rate 20） | blink の `InspectorEmulationAgent::setCPUThrottlingRate` が `ThreadCPUThrottler` を呼び（`third_party/blink/renderer/core/inspector/inspector_emulation_agent.cc` L594-599）、これは**呼んだスレッド（renderer の main thread）だけ**をシグナルで一時停止させる（`thread_cpu_throttler.cc` L74-83 の `throttled_thread_handle_(base::PlatformThread::CurrentHandle())`） | 11.38 秒（3.79 コア）。止まらない |
| `Emulation.setVirtualTimePolicy`（`pause`） | 仮想時間は renderer の scheduler のタスクの時間を差し替えるもので、BeginFrame の源には関与しない（docs/research/browser-frame-capture-deterministic.md §2.1） | 8.41 秒（2.80 コア）。止まらない |
| `Page.navigate` で `about:blank` へ | renderer の compositor は残る | 10.18 秒（3.39 コア）。止まらない |
| `Target.closeTarget` でページを閉じる | renderer の compositor（購読者）がいなくなり、`BackToBackBeginFrameSource::RemoveObserver` で時間源が止まる | **0.00 秒**。止まる（§3.1） |
| `Page.stopLoading` | 読み込みを止めるだけで、BeginFrame の購読に関与する実装の経路はない | 未計測 |

補足: 凍結 → `active` で hidden になったページを `about:blank` へ遷移させたときは 0.00 秒だった。hidden のまま新しい document を作ると frame sink が初期化されない（`ShouldSubscribeToBeginFrames` の最初の条件 `HasInitializedLayerTreeFrameSink()` が偽）ためと考えられるが、ソースで経路を確かめていない。いずれにせよ描画できない状態なので、撮影の休止中の手段にはならない。

## 3. 実測

### 3.1 何もしていないときの Chrome の CPU（3 秒）

| Chrome の起動フラグ（現行に追加） | ページを開いた後 |
| --- | --- |
| なし（現行） | 0.00 秒 |
| `--disable-frame-rate-limit` | 0.00 秒 |
| `--run-all-compositor-stages-before-draw` | 0.09 秒（0.03 コア）— #747 で未計測だった欄 |
| 併用 | 10.58 秒（3.53 コア） |

併用時のページの有無:

| 状態 | Chrome の CPU（3 秒） |
| --- | --- |
| 起動直後（`Target.getTargets` は空。ページなし） | 0.00 秒 |
| ページを開いた後 | 10.09 秒（3.36 コア） |
| `Target.closeTarget` でページを閉じた後 | 0.00 秒 |

### 3.2 撮影中の Chrome の CPU

60 フレームを撮る間の Chrome の CPU 時間。「間の待ち」は、呼び出し側のエンコード等の仕事を模して 1 フレームごとに挟んだ待ち時間。

| フラグ | 間の待ち | 60 フレームの所要 | Chrome の CPU 時間 | 平均のコア数 |
| --- | --- | --- | --- | --- |
| なし | 0 ms | 3,039 ms | 0.40 秒 | 0.13 |
| なし | 30 ms | 5,063 ms | 0.51 秒 | 0.10 |
| 併用 | 0 ms | 919 ms | 3.70 秒 | 4.02 |
| 併用 | 30 ms | 2,556 ms | 9.07 秒 | 3.55 |

併用は 1 フレームの所要を 3 分の 1 以下にするが、Chrome の CPU 時間は 9 倍（待ちなし）〜18 倍（待ち 30 ms）になる。空回りは撮影と撮影の間の待ちの長さに比例して増えるので、エンコードが重い 1080p ほど比率は悪化する。

### 3.3 Chrome の起動の費用（併用、5 回）

起動から `DevTools listening` まで 93〜123 ms、1 ページを開き composition を読み込むまで 191〜259 ms、`Browser.close` からプロセス終了まで 18〜37 ms。

## 4. 撮影の間だけ Chrome を起動する形

- 現行の nyaucast はすでにこの形になっている。`Chrome.openPage`（`src/lib/chrome.ts`）は呼ぶたびに一時ディレクトリを作って chrome-headless-shell を起動し、呼び出し側のスコープが閉じるとプロセスごと片付く。`openComposition`（`src/compositions/capture.ts`）がこれを呼び、`video.renderCut` は 1 カットの `Effect.scoped`（`renderMp4`）の中で開いて閉じる。`video.previewCut` も同様。
- したがって空回りはすでに「Chrome を開いているカットの描画中」に限られているが、§3.2 のとおり**撮影中こそが空回りの主な時間**で、カット単位の起動では消えない。`Page.captureScreenshot` の応答を待つ間も、エンコードに PNG を渡している間も、renderer・viz・browser の 3 プロセスで約 3.5〜4 コアを使い続ける。これは並行するエンコード（同じマシンの CPU）を遅くし、テストやカットの描画を並行に走らせると Chrome の本数だけ空回りが積み上がる（#747 で負荷平均 155）。
- カット単位よりさらに細かく「撮影の休止中はページを閉じる」ことはできるが、seek の状態と composition の読み込みを捨てることになり、再読み込みの費用（§3.3 で約 0.1 秒の読み込み + composition 自体の初期化）を毎回払う。撮影が途切れなく続くカットの描画では効果がない。

## 5. nyaucast への含意

1. **ページを開いたまま空回りを止める手段はない**（CDP にも実行時の切り替えにもない）。併用を採るなら空回りを前提に置き、同時に開く Chrome を 1 本に絞る（描画とテストの並行度を Chrome の本数で制限する）設計が要る。
2. 空回りを避けたいなら `--disable-frame-rate-limit` 単独（#747 で撮影 約 1.5 倍速、何もしていないとき 0.00 コア）が残る。
3. BeginFrame を DevTools から手で出す構成（`--run-all-compositor-stages-before-draw` + BeginFrameControl）は、空回りせず決定論的な本来の形だが、macOS 非対応のため nyaucast の dogfood 環境では使えない。
4. いずれの採否も 1080p の実際の composition での実測（#790）を待って #793 で決める。

## 分からなかったこと

- 凍結 → `active` で hidden になったページを `about:blank` へ遷移させると空回りが止まる経路（§2.2 補足）は、ソースで追っていない。
- `Page.stopLoading` は計測していない（BeginFrame の購読に関わる経路がないため候補から外した）。
- 実測はほかのセッションが動いている負荷平均 14 前後のマシンで行った。コア数の絶対値は揺れるが、「ページがあると 3 コア前後、ないと 0」の差は繰り返しても同じだった。
- 1080p の composition と実際のエンコードを並行させたときの影響は測っていない（#790 の範囲）。

## Related

- map #789（描画の撮影を速くする手段の決定マップ）/ 兄弟チケット #790（1080p の実測）・#793（採否と ADR-0005 の改訂）
- 背景 #747（描画の撮影が Chrome のフレームの拍に待たされる）
- `docs/research/browser-frame-capture-deterministic.md`（BeginFrameControl・仮想時間）
