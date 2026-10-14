# 可変フレームレートの mp4 を配布先が受け付けるかの調査

調査日: 2026-10-14 / issue: #804（親: #789、この答えを使う先: #793）/ 前提の実測: #797（`research/render-encode-bench` ブランチの `docs/research/render-encode-bench.md`）

## TL;DR

1. **3 つの配布先とも、公式のアップロード仕様は可変フレームレート（VFR）にも固定フレームレート（CFR）にも触れていない。** 書いてあるのはフレームレートの値だけ。YouTube は「撮ったときと同じフレームレートでエンコードしてアップロードする」、Instagram（Graph API の Reels）は「23〜60 FPS」、X（API）は「60 FPS 以下」（推奨 30 / 60 FPS）。VFR を受け付けるとも断るとも書いていないので、**一次情報だけでは「受け付ける」と言い切れない。**
2. **長い `duration` の形の mp4 は、ffprobe の上では「名目 30 fps・平均 3 fps」のファイルに見える。** `r_frame_rate=30/1`（タイムスケールから推す最小の間隔）、`avg_frame_rate` はパケット数 ÷ 尺。#797 の実物（1,986 パケット・621.1 秒）なら平均は **約 3.2 fps**。H.264 のビットストリームにはフレームレートが入っていない（VUI なし）ので、配布先が読めるフレームレートは mp4 の `stts`（とタイムスケール）から算出するしかない。
3. **いちばんの懸念は Instagram の「23〜60 FPS」。** 配布先が平均フレームレートで判定するなら、平均 3 fps のファイルは下限を割る。どちらで判定するかは公開されていないので、実際に上げて確かめるまで「通る」とは言えない。YouTube と X の上限（X は 60 FPS 以下）には、どちらの読み方でも収まる。
4. **CFR に戻す安い手段は見つからなかった。** 試した 3 通りはどれも「全フレームのエンコード」をやり直すか、CFR にならない:
   - mediabunny の `VideoSampleSource` に `transform: { frameRate: 30 }` を渡す → 長い `duration` の 1 枚を受け取ったまま、内部で同じフレームを枚数分エンコードし直す。出力は CFR（1,800 枚・`avg_frame_rate=30/1`）だが、時間は「同じ RGBA を枚数分流す」形（`holdsRepeat`）と同じ（60 秒の合成動画で 8.1 秒 vs 長い `duration` で 1.2 秒）。**デコードは連ごとに 1 回のまま、エンコードは全フレーム**という、`holdsRepeat` と同じ費用の別の書き方にすぎない
   - ffmpeg で後から CFR に再エンコード（`-fps_mode cfr -r 30`）→ 全フレームのエンコード。60 秒の合成動画で VideoToolbox 8.0 秒・libx264 veryfast 2.2 秒（CPU 14.9 秒）
   - ffmpeg のストリームコピー（`-c copy -fps_mode cfr`）→ **CFR にならない**（パケットは 180 枚のまま、`avg_frame_rate=3/1`）。エンコード済みのパケットを複製して埋める手段は、mediabunny にも ffmpeg のストリームコピーにも無い
5. **#793 への含意:** 「長い `duration` で流して VFR のまま出す」を採るなら、Instagram（と念のため X・YouTube）へ実物を 1 本上げて、受け付けと再エンコード後の再生を確かめることが前提条件になる。確かめないで済ませたいなら、CFR を保つ `holdsRepeat`（あるいは同じ費用の `transform.frameRate`）を採るのが安全側。

---

## 1. 配布先の公式仕様（一次情報）

### YouTube

出典: [YouTube recommended upload encoding settings](https://support.google.com/youtube/answer/1722171?hl=en)

- コンテナ: 「Container: MP4」「No Edit Lists (or the video might not get processed correctly)」「moov atom at the front of the file (Fast Start)」
- 映像: 「Video codec: H.264」「Progressive scan (no interlacing)」「High Profile」「2 consecutive B frames」「Closed GOP. GOP of half the frame rate.」「CABAC」「Variable bitrate」「Chroma subsampling: 4:2:0」
- フレームレート: 「Content should be encoded and uploaded in the same frame rate it was recorded.」「Common frame rates include: 24, 25, 30, 48, 50, 60 frames per second (other frame rates are also acceptable).」
- 音声: 「Audio codec: AAC-LC or Opus or Eclipsa Audio」「Sample rate: 48kHz」
- **VFR / CFR への言及は無い。**「variable」が出てくるのはビットレートだけ。

出典: [Troubleshoot audio or video issues with uploads](https://support.google.com/youtube/answer/58134?hl=en)

- 「Make sure the durations of your audio and video tracks are the same.」（尺が揃わないと音ずれしうる）
- 「24, 25, 30, 48, 50, 60 FPS rates are preferred.」「Other less-common frame rates like 23.98, 29.97, and 59.94 are also acceptable.」
- ここにも VFR への言及は無い。

参考（適用範囲が違う）: [Video and audio formatting specifications](https://support.google.com/youtube/answer/4603579?hl=en) は音楽レーベル・ディストリビューター向け（Content Manager / DDEX）の納品仕様で、「Videos should be in their native frame rates without resampling.」と書く。一般のアップロードの規則ではない。

### Instagram（Meta）

出典: [IG User Media（Instagram Graph API リファレンス）](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media)の Reel Specifications

- 「Container: MOV or MP4 (MPEG-4 Part 14), no edit lists, moov atom at the front of the file.」
- 「Audio codec: AAC, 48khz sample rate maximum, 1 or 2 channels (mono or stereo).」
- 「Video codec: HEVC or H264, progressive scan, closed GOP, 4:2:0 chroma subsampling.」
- 「Frame rate: 23-60 FPS.」
- 「Video bitrate: VBR, 25Mbps maximum」「Duration: 15 mins maximum, 3 seconds minimum」「File size: 300MB maximum」
- Story も容器・コーデック・フレームレートは同じ。
- **VFR / CFR への言及は無い。** 「23-60 FPS」をどの値（名目・平均・瞬間）で判定するかも書いていない。

Instagram ヘルプセンターの Reels の寸法のページ（[help.instagram.com/1038071743007909](https://help.instagram.com/1038071743007909/)）は「最低 30 FPS」と書いているとする検索結果があるが、ページが JavaScript で描画されるため本文を取得できず、**原文は確かめていない**。

### X

出典: [X API Media best practices](https://docs.x.com/x-api/media/quickstart/best-practices.md)

- 推奨: 「Video Codec: H264 High Profile」「Frame Rates: 30 FPS, 60 FPS」「Audio Codec: AAC LC」
- 必須（Advanced）: 「Frame rate: must be 60 FPS or less」「Pixel format: Only YUV 4:2:0 is supported」「Audio must be AAC with Low Complexity profile」「Must not have open GOP」「Must use progressive scan」「Duration: must be at least 0.5 seconds.」
- **VFR / CFR への言及は無い。** 容器（mp4）にも触れていない。
- X ヘルプセンターの動画のページ（help.x.com）は取得を拒否された（403）。

### 3 社の比較

| 項目 | YouTube | Instagram（Graph API） | X（API） | 長い `duration` の mp4 |
| --- | --- | --- | --- | --- |
| VFR / CFR の規定 | 無し | 無し | 無し | VFR |
| フレームレートの値 | 撮ったときと同じ（30 等） | 23〜60 FPS | 60 FPS 以下（推奨 30 / 60） | 名目 30、平均約 3.2 |
| GOP | Closed、フレームレートの半分 | Closed | Open GOP 不可 | Closed（IDR 始まり） |
| edit list | 不可 | 不可 | 記載なし | 無し（`edts` 無しを確認） |
| moov の位置 | 先頭（Fast Start） | 先頭 | 記載なし | 末尾（`fastStart: false`）※ |

※ moov の位置は VFR とは別の論点。mediabunny の `Mp4OutputFormat({ fastStart: "in-memory" })` 等で先頭に置ける。いまの `fastStart: false` は YouTube と Instagram の仕様に反するので、配布用の書き出しでは別途直す必要がある（スコープ外。issue 化の候補）。

## 2. mp4 の `stts` とフレームレートの見え方

### `stts` の意味

ISO BMFF（ISO/IEC 14496-12）の `stts`（Time-to-Sample Box）は、各サンプルの長さ（`sample_delta`、単位はトラックのタイムスケール）を「同じ長さが何枚続くか」の連長で持つ表。サンプルのデコード時刻は先頭から長さを足し上げて求める。長さの違うサンプルを混ぜてよく、これが mp4 の VFR の正体（参照: [Apple QuickTime File Format: Time-to-sample atom](https://developer.apple.com/documentation/quicktime-file-format/time-to-sample_atom)。ISO 本文は有償のため直接は確かめていない）。

mediabunny は `addVideoTrack` の `frameRate` から映像トラックのタイムスケールを決める（`isobmff-muxer.js`: `computeRationalApproximation(1 / (track.metadata.frameRate ?? GLOBAL_TIMESCALE), 1e6).den`）。`frameRate: 30` ならタイムスケールは 30 で、`frameRate` の型の説明は「all timestamps and durations of this track will be snapped to this frame rate」（`mediabunny.d.ts` の `VideoTrackMetadata.frameRate`、v1.61.0）。**`frameRate: 30` はどこかに「30 fps」と書くメタデータではなく、タイムスケールと時刻の丸めにだけ効く。**

### ffprobe の `r_frame_rate` と `avg_frame_rate`

FFmpeg の `AVStream` の定義（[libavformat/avformat.h](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/avformat.h)）:

- `avg_frame_rate`: 「Average framerate」
- `r_frame_rate`: 「Real base framerate of the stream. This is the lowest framerate with which all timestamps can be represented accurately (it is the least common multiple of all framerates in the stream). Note, this value is just a guess!」

### 実測（合成動画）

#797 の実物は約 3 GB のフレームの書き出しから作り直す必要があるため作り直さず、`holdsLong` と同じエンコード設定（mediabunny 1.61.0 + `@mediabunny/server`、H.264 8 Mbps、AAC 192 kbps、`addVideoTrack(..., { frameRate: 30 })`、`fastStart: false`）で、1920×1080・60 秒の合成動画を作って ffprobe（ホストの ffmpeg）で読んだ。絵は 10 秒ごとに「29 フレーム動く → 271 フレーム止まる」の繰り返し。

| 書き方 | `add` した枚数 | 時間 | パケット | `r_frame_rate` | `avg_frame_rate` | `stts` のエントリ | キーフレーム |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `holdsLong`（止まる区間を `duration` 271/30 秒の 1 枚で覆う） | 180 | 1.2 秒 | 180 | 30/1 | **3/1** | 12（`29×1, 1×271` の繰り返し） | 6 |
| `holdsRepeat`（同じ RGBA を 271 枚流す） | 1,800 | 8.1 秒 | 1,800 | 30/1 | 30/1 | 1（`1800×1`） | 30 |
| `holdsLong` + `transform: { frameRate: 30 }` | 180 | 8.1 秒 | 1,800 | 30/1 | 30/1 | 1（`1800×1`） | 30 |

読み取れること:

- **`holdsLong` の mp4 は `r_frame_rate` では 30 fps、`avg_frame_rate` では 3 fps に見える。** 尺（60.000 秒）・音声の尺（60.032 秒）は CFR のものと同じで、尺のずれは無い
- 長いサンプルのパケットは `duration_time=9.033` 秒で、その次がキーフレーム。止まる区間の直後にキーフレームが入るので、キーフレームの間隔は 10 秒（CFR のときは 2 秒）
- H.264 の SPS は `vui_parameters_present_flag = 0`（`-bsf:v trace_headers` で確認）。ビットストリーム側にフレームレート（`timing_info`）は無く、**フレームレートを知る手掛かりは mp4 の `stts` とタイムスケールだけ**
- `edts`（edit list）は無い。YouTube・Instagram の「no edit lists」には触れない

#797 の実物に当てはめると、`avg_frame_rate` は 1,986 ÷ 621.1 秒 ≈ **3.2 fps**、`r_frame_rate` は 30/1 になるはず（実物では未確認）。

## 3. CFR に戻す手段と費用

| 手段 | CFR になるか | 費用 | 備考 |
| --- | --- | --- | --- |
| `holdsRepeat`（同じ RGBA を枚数分流す） | なる | 全フレームのエンコード（#797: 10 分の動画で描画全体 2.5〜3.1 分） | #797 で CFR 版とバイト単位で同じ mp4 を確認済み |
| mediabunny `VideoSampleSource` の `transform: { frameRate: 30 }` | なる | `holdsRepeat` と同じ（全フレームのエンコード） | 呼び出し側は長い `duration` の 1 枚を渡すだけで済む。内部の `padFrameRate` が前の 1 枚を `1 / frameRate` 刻みで複製してエンコーダーへ流す（`media-source.js`）。出力のサイズと枚数は `holdsRepeat` と同じ（バイト単位では一致しなかった） |
| mediabunny `Conversion` の `video.frameRate` | なる | 再デコード + 全フレームの再エンコード | 型の説明: 「The desired frame rate of the output video, in hertz. If not specified, the original input frame rate will be used (which may be variable).」後処理として一番重い |
| ffmpeg で後から再エンコード（`-fps_mode cfr -r 30`） | なる | 全フレームの再エンコード（60 秒で VideoToolbox 8.0 秒・libx264 veryfast 2.2 秒 / CPU 14.9 秒） | `-fps_mode cfr` は「Frames will be duplicated and dropped to achieve exactly the requested constant frame rate.」（[ffmpeg ドキュメント](https://ffmpeg.org/ffmpeg.html)）。ffmpeg CLI はいまの依存に無い（`@mediabunny/server` が依存する node-av の中の FFmpeg は GPL ビルド。`docs/research/node-av-ffmpeg-license.md`） |
| ffmpeg のストリームコピー（`-c copy -fps_mode cfr -r 30`） | **ならない** | ほぼ 0 | 出力は 180 パケット・`avg_frame_rate=3/1` のまま。エンコードをしない経路ではフレームは複製されない |
| エンコード済みパケットの複製 | 試していない | — | H.264 のパケットをそのまま複製すると `frame_num` や参照関係が重なるため、正しいストリームにならない見込み。止まった絵を表す「全マクロブロック skip の P フレーム」を自分で書けば安く CFR にできる可能性はあるが、mediabunny にも VideoToolbox の API にもその手段は無い |

**結論: CFR を保つ方法の費用は、どれも「全フレームのエンコード」が床になる。** 長い `duration` の速さ（エンコードを 1,986 枚に減らしたこと）は、CFR にした時点で失われる。#797 の数字では、CFR にすると描画全体は 0.8〜1.2 分から 2.5〜3.1 分（`holdsRepeat`）へ戻る。

## 4. 確かめていないこと

- **3 つの配布先へ VFR の mp4 を実際に上げたときの挙動**（受け付けるか、再エンコード後に止まる区間がどう再生されるか、Instagram の「23〜60 FPS」を平均で判定するか）。アカウントと投稿の手段が要るので今回は試していない。ここが #793 の判断の残りの不確実性
- #797 の実物（621.1 秒・1,986 パケット）での ffprobe。合成動画で同じ構造を確かめただけ
- Instagram ヘルプセンター・X ヘルプセンターの本文（取得できなかった）
- ISO/IEC 14496-12 本文（有償）。`stts` の意味は Apple の QuickTime File Format と ffprobe の挙動で確かめた
- 配布先の再エンコードが VFR の入力をどの CFR に直すか（YouTube の「撮ったときと同じフレームレート」が、名目 30 fps と平均 3 fps のどちらで解釈されるか）
