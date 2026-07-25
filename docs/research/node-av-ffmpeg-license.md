# node-av のプレビルド FFmpeg バイナリ調査（ライセンス・H.264 エンコーダ・配布方式）

調査日: 2026-07-24 / 対象: node-av v6.1.1（npm latest）、リポジトリ https://github.com/seydx/node-av （npm registry の repository フィールドで確認）

## TL;DR

1. **GPL ビルドである（全プラットフォーム、例外なし）**。node-av のプレビルドは seydx フォークの jellyfin-ffmpeg を `--enable-gpl --enable-version3` でビルドしたもの（LICENSE_FILE は COPYING.GPLv3）。ビルド variant は **gpl 系しか存在しない**。libx264 / libx265 / libfdk-aac 等を静的リンクした `.node` アドオンと ffmpeg CLI が配布される。npm 上のラッパー TS コード自体は MIT だが、プレビルドバイナリの実体は GPLv3 相当。
2. **H.264 エンコーダは libx264（GPL）**。libopenh264 は使われていない。加えて HW エンコーダ（macOS: VideoToolbox、Windows/Linux: NVENC/QSV/AMF/VAAPI 等）も有効。品質面ではソフトウェアエンコーダとして最良クラスの x264 が使える構成。
3. **配布方式は 2 系統**: ① ネイティブアドオン `.node` は npm の **optionalDependencies**（`@seydx/node-av-<platform>-<arch>[-msvc|-mingw]`）として非圧縮同梱 — オフラインでも npm キャッシュがあれば動く。② ffmpeg CLI バイナリは **postinstall で GitHub Releases から DL** — 失敗しても警告のみでインストールは成功する（アドオンは動く）。mediabunny issue #378 の Windows ロード失敗は「旧方式（zip + postinstall 展開）が Bun の postinstall 無効デフォルトと衝突」した問題で、**node-av v5.2.4 で非圧縮同梱に変更して解決済み**（mediabunny v1.45.1 で追随）。

---

## 前提: 依存チェーン

- `@mediabunny/server` v1.51.0 (MPL-2.0) → `dependencies: { "node-av": "^6.0.0" }`（npm registry `@mediabunny/server/latest` で確認）
- `node-av` v6.1.1: package.json `license: MIT`、`repository: git+https://github.com/seydx/node-av.git`
- FFmpeg ソースは git submodule `externals/jellyfin-ffmpeg` = **https://github.com/seydx/jellyfin-ffmpeg.git（branch: ffmpeg-master、Jellyfin 公式 jellyfin-ffmpeg の seydx フォーク）**
  - 出典: https://raw.githubusercontent.com/seydx/node-av/main/.gitmodules
- 最新リリース v6.1.1 の同梱 FFmpeg は **FFmpeg 8.1 ベース**（release assets が `ffmpeg-v8.1-*`）
  - 出典: https://api.github.com/repos/seydx/node-av/releases/latest

## 問い 1: GPL ビルドか LGPL ビルドか → GPL（GPLv3）

### 根拠 1: ビルド variant が gpl しかない

seydx/jellyfin-ffmpeg の `builder/variants/` の一覧（GitHub API で取得）:

```
defaults-gpl.sh / defaults-gpl-shared.sh / linux64-gpl.sh / linuxarm64-gpl.sh /
mac64-gpl.sh / macarm64-gpl.sh / win64-gpl.sh / ...
```

LGPL variant は存在しない。`builder/variants/defaults-gpl.sh` の冒頭:

```sh
FF_CONFIGURE="--enable-gpl --enable-version3 --disable-ffplay --disable-debug --disable-doc --disable-sdl2"
...
LICENSE_FILE="COPYING.GPLv3"
```

出典: https://raw.githubusercontent.com/seydx/jellyfin-ffmpeg/ffmpeg-master/builder/variants/defaults-gpl.sh

### 根拠 2: node-av の CI が明示的に gpl フレーバーを指定

`.github/workflows/build-prebuilds.yaml`（node-av main）:

- **Linux** (line 649, 665): Docker イメージ `ghcr.io/seydx/jellyfin-ffmpeg/${TARGET}-gpl:latest` を使い `./build.sh "${TARGET}" gpl` を実行
- **macOS** (line 950): `./buildmac.sh $ARCH_NAME` — buildmac.sh 内部で `VARIANT="gpl"`、`source "variants/${TARGET}-gpl.sh"` 固定（seydx/jellyfin-ffmpeg builder/buildmac.sh line 45, 63）
- **Windows MinGW** (line 179-186): jellyfin-ffmpeg の `msys2/build.sh` を実行。同スクリプトの configure に `--enable-gpl --enable-version3 --enable-libx264 --enable-libx265 --enable-libfdk-aac` 等（msys2/build.sh line 46-74）
- **Windows MSVC** (line 453-458): seydx/ffmpeg-msvc-prebuilt の release asset **`ffmpeg...gpl-${ARCH}-static.zip`** をダウンロードしてリンク。同リポジトリ README: 「The binaries are **GPL-licensed** due to included components like x264, x265, and fdk-aac.」

出典:

- https://github.com/seydx/node-av/blob/main/.github/workflows/build-prebuilds.yaml
- https://raw.githubusercontent.com/seydx/jellyfin-ffmpeg/ffmpeg-master/msys2/build.sh
- https://raw.githubusercontent.com/seydx/ffmpeg-msvc-prebuilt/main/README.md

### 根拠 3: `.node` アドオンは GPL ライブラリを静的リンク

`binding-jellyfin.gyp`（プレビルド生成に使う gyp。CI で `cp binding-jellyfin.gyp binding.gyp` してからビルド）は libav* 一式に加え `libx264.a`, `libx265.a` 等を `-force_load` で静的リンクする（line 94-123 付近）:

```
"-Wl,-force_load,/opt/ffbuild/prefix/lib/libavcodec.a",
...
"/opt/ffbuild/prefix/lib/libx264.a",
"/opt/ffbuild/prefix/lib/libx265.a",
```

出典: https://raw.githubusercontent.com/seydx/node-av/main/binding-jellyfin.gyp

つまり npm から落ちてくる `@seydx/node-av-*` の `node-av.node`（1 ファイル約 60 MB、darwin-arm64 は unpackedSize 61,686,949 bytes）は **GPL コードを含む単一バイナリ**である。

### 注意: npm メタデータの「MIT」表記は実体と乖離

- node-av 本体と全プラットフォームパッケージ（`packages/platform-template.json`）は `"license": "MIT"` を宣言している
- README の License 節も「MIT。ただし FFmpeg 自体は LGPL/GPL なので FFmpeg のライセンス遵守はユーザー責任」という一般論を書くのみで、**同梱プレビルドが GPL 構成である事実を明示していない**
- ラッパーのソースコードは確かに MIT だが、配布物（.node / ffmpeg CLI）は GPLv3 由来コードを含むため、バイナリを再配布する場合の実効ライセンスは GPLv3

出典: https://raw.githubusercontent.com/seydx/node-av/main/packages/platform-template.json / https://github.com/seydx/node-av/blob/main/README.md#license

### 付記: libfdk-aac

configure に `--enable-libfdk-aac` があるが `--enable-nonfree` はない。これは Jellyfin 系ビルドが特許問題部分を除去した **fdk-aac-stripped**（`builder/scripts.d/50-fdk-aac-stripped.sh`）を使うため。GPL バイナリとしての再配布可否は Jellyfin プロジェクトの整理に依拠しており、厳密な検証はここでは未実施（未特定）。

## 問い 2: H.264 エンコーダの実体 → libx264（GPL）+ HW エンコーダ

- **libopenh264 ではない**。jellyfin-ffmpeg の `builder/scripts.d/` には `50-x264.sh` / `50-x265.sh` があり、openh264 のビルドスクリプトは存在しない。configure も `--enable-libx264` のみ
- HW アクセラレーション: macOS は `--enable-videotoolbox --enable-audiotoolbox --enable-metal`（`builder/variants/defaults-mac.sh`）、Linux/Windows は scripts.d に ffnvcodec (NVENC), libvpl (QSV), amf, vaapi 等
- node-av の API も `FF_ENCODER_LIBX264` 定数を README のメインの使用例として提示している
- **品質への含意**: x264 はソフトウェア H.264 エンコーダの事実上の最高品質。openh264 系プレビルド（例: LGPL 構成の FFmpeg ビルド）で起きがちな「H.264 エンコード品質・レート制御の弱さ」問題はない。YouTube 向け高品質エンコードには好都合
- **特許面**: x264 のコピイラ(GPL)問題とは別に、H.264/H.265 自体の特許プール（Via LA 等)は残る。エンドユーザーの私的利用・自社チャンネル運用の範囲では実務上問題化しにくい

出典:

- https://github.com/seydx/jellyfin-ffmpeg/tree/ffmpeg-master/builder/scripts.d （50-x264.sh あり、openh264 なし）
- https://raw.githubusercontent.com/seydx/jellyfin-ffmpeg/ffmpeg-master/msys2/build.sh （`--enable-libx264`）
- https://raw.githubusercontent.com/seydx/jellyfin-ffmpeg/ffmpeg-master/builder/variants/defaults-mac.sh

## 問い 3: インストール時バイナリ取得の失敗モード

### 配布方式（2 系統）

| 成果物 | 配布経路 | 失敗時の挙動 |
| --- | --- | --- |
| ネイティブアドオン `node-av.node`（libav 静的リンク済み、約 60 MB） | npm **optionalDependencies**: `@seydx/node-av-{darwin,linux}-{x64,arm64}`, `@seydx/node-av-win32-{x64,arm64}-{msvc,mingw}`。v5.2.4 以降は **非圧縮でパッケージに同梱**（`files: ["node-av.node"]`、scripts なし） | 対応プラットフォームなら npm レジストリ/キャッシュから取得できれば動く。**未対応環境（musl/Alpine、他 arch）では node-av の `install` スクリプト（`install/check.js`）が exit 1 してインストール失敗**。npm パッケージにはソースが含まれないため node_modules 内でのソースビルドは不可（check.js が明言） |
| ffmpeg CLI バイナリ（jellyfin ビルド） | **postinstall**（`dist/ffmpeg/install.js`）が **GitHub Releases**（`https://github.com/seydx/node-av/releases/download/v<pkgver>/ffmpeg-v8.1-<platform>-<arch>[-jellyfin].zip`）から DL。SHA256SUMS 検証・リトライ 2 回・API フォールバックあり | **失敗しても警告のみで `process.exit(0)`** — インストールは成功し、アドオン機能は使える。ffmpeg CLI 依存機能のみ欠ける。`SKIP_FFMPEG=true` で明示スキップ可 |

出典:

- https://raw.githubusercontent.com/seydx/node-av/main/install/check.js （プラットフォームパッケージ解決と失敗時 exit 1、musl 検出メッセージ）
- https://raw.githubusercontent.com/seydx/node-av/main/src/ffmpeg/install.ts （line 19-22: SKIP_FFMPEG、line 32-33: GitHub Releases URL、line 293-301: 失敗時も exit 0）
- npm registry: node-av@6.1.1 の `optionalDependencies` / `scripts.install` / `scripts.postinstall`

### mediabunny issue #378（Windows ロード失敗）の顛末

- 症状: Bun 1.3.14 + Windows 11 で `Cannot find module '@seydx/node-av-win32-x64-msvc/node-av.node'`。`trustedDependencies` を足しても直らず
- 原因（node-av 作者 seydx 本人のコメント）: 当時のプラットフォームパッケージは「`.node` を **zip で同梱し postinstall で展開**」する方式で、Bun は postinstall をデフォルト実行しないため `.node` が展開されないままだった
- 解決: **node-av v5.2.4 で `.node` を非圧縮同梱に変更し postinstall を廃止**（「works with npm/pnpm/yarn/bun/deno out of the box」）。mediabunny は v1.45.1 で node-av をバンプ
- 現行 v6.1.1 のプラットフォームパッケージは fileCount 3・scripts なしで、この修正済み方式であることを npm registry で確認

出典: https://github.com/Vanilagy/mediabunny/issues/378 （closed。seydx / Vanilagy のコメント）、https://github.com/seydx/node-av/releases/tag/v5.2.4

### オフライン / CI での実務上の注意

- `.node` アドオン: npm レジストリ（またはミラー/キャッシュ）だけで完結。GitHub への到達性は不要
- ffmpeg CLI: **GitHub Releases への到達性が必要**。プロキシ遮断環境では毎回警告が出る。CLI を使わないなら `SKIP_FFMPEG=true` を CI に入れるのが正解
- Bun 利用時: node-av の `install`（check.js）と `postinstall`（ffmpeg DL）はデフォルトで実行されない → アドオンは動くが ffmpeg CLI は落ちてこない。CLI が要るなら `trustedDependencies` に `node-av` を追加する
- Alpine/musl は非対応（check.js が glibc 検出で明示的にエラーメッセージを出す）
- Windows は MSVC 版を優先ロードし MinGW 版へフォールバック（check.js line 17-44）。どちらも GPL ビルド

## tayk への影響評価

### 結論

- **tayk 自身のソースを MIT で公開すること自体は可能**。node-av は package.json 上の依存として参照するだけで、GPL バイナリは各ユーザーのインストール時に npm / GitHub から取得される。tayk のリポジトリ・npm パッケージに GPL コードを同梱しない限り、tayk が GPL コードを「配布」する形にはならない
- ただし **FSF 的な厳格解釈（GPL ライブラリにリンクして動くプログラムは結合著作物）を取ると、node-av 必須の構成で tayk を配布する行為はグレー**。MIT は GPL 互換なので「結合物全体は実効 GPLv3」という整理なら配布自体は合法にできるが、「tayk = MIT」という主張は弱まる
- **v0.1.0 の実態（first-party チャンネルでの dogfood = 社内利用、配布なし）では GPL の義務は一切発生しない**。GPL の義務は頒布時にのみ生じる

### リスクと回避策

| リスク | 深刻度 | 回避策 |
| --- | --- | --- |
| tayk を npm 公開 / バイナリ配布する将来、node-av 直依存だと実効 GPLv3 の議論を招く | 中（v0.2 以降の話） | node-av（@mediabunny/server）を **optionalDependencies / プラグイン境界**に隔離し、コア機能は node-av なしで動く設計にする。または「エンコードはユーザー環境の ffmpeg CLI を spawn」に逃がす |
| Docker イメージ等 node_modules 同梱物を配布すると GPL バイナリの再配布に該当 | 中 | イメージ配布時は GPLv3 表記とソース入手先明示（jellyfin-ffmpeg はソース公開済みなので対応可能）。もしくはイメージに node-av を含めない |
| node-av 側の npm license 表記（MIT）と実体（GPL 同梱）の乖離 — 自動ライセンススキャナは検出しない | 低〜中 | 依存ライセンス監査で node-av を手動アノテーションする。本レポートを根拠資料として残す |
| fdk-aac-stripped の再配布可否の法的グレー | 低 | AAC エンコードに fdk-aac を使わず FFmpeg ネイティブ aac か libopus を使う |
| オフライン CI で ffmpeg CLI DL が失敗しノイズ | 低 | `SKIP_FFMPEG=true`。Bun なら CLI が要る場合のみ `trustedDependencies: ["node-av"]` |

### 判断材料の整理（tayk の文脈）

- v0.1.0 ゲート（dogfood 完走）には**ライセンス上のブロッカーなし**
- 出力品質の観点では libx264 入り GPL ビルドはむしろ利点（LGPL ビルドだと SW H.264 エンコーダが事実上失われる）
- 「tayk を将来 OSS/npm 配布するか」が決まった時点で、node-av の依存位置（必須 or optional）を ADR で決めるのが妥当

## 出典一覧

1. npm registry node-av: https://registry.npmjs.org/node-av （repository / license / optionalDependencies / scripts）
2. node-av リポジトリ: https://github.com/seydx/node-av
3. .gitmodules（jellyfin-ffmpeg submodule）: https://raw.githubusercontent.com/seydx/node-av/main/.gitmodules
4. CI workflow（gpl 指定・各 OS ビルド手順）: https://github.com/seydx/node-av/blob/main/.github/workflows/build-prebuilds.yaml
5. gyp（静的リンク対象）: https://raw.githubusercontent.com/seydx/node-av/main/binding-jellyfin.gyp
6. インストールスクリプト: https://raw.githubusercontent.com/seydx/node-av/main/install/check.js / https://raw.githubusercontent.com/seydx/node-av/main/src/ffmpeg/install.ts
7. プラットフォームパッケージ template: https://raw.githubusercontent.com/seydx/node-av/main/packages/platform-template.json
8. seydx/jellyfin-ffmpeg configure フラグ: https://raw.githubusercontent.com/seydx/jellyfin-ffmpeg/ffmpeg-master/builder/variants/defaults-gpl.sh / .../msys2/build.sh / .../builder/buildmac.sh / .../builder/variants/defaults-mac.sh
9. codec スクリプト一覧（x264 あり・openh264 なし）: https://github.com/seydx/jellyfin-ffmpeg/tree/ffmpeg-master/builder/scripts.d
10. MSVC prebuilt（GPL 明記）: https://github.com/seydx/ffmpeg-msvc-prebuilt （README License 節）
11. mediabunny issue #378: https://github.com/Vanilagy/mediabunny/issues/378
12. node-av v5.2.4 release（zip→非圧縮同梱の修正）: https://github.com/seydx/node-av/releases/tag/v5.2.4
13. node-av v6.1.1 release assets（ffmpeg-v8.1-*）: https://api.github.com/repos/seydx/node-av/releases/latest
14. @mediabunny/server 依存関係: https://registry.npmjs.org/@mediabunny%2Fserver/latest
