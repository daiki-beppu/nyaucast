# Diagram contract — 解説動画の図解

解説動画の**図解**の契約の正書。図解は agent が書く入力で、シーンごとに 1 枚（演出の時刻を台本上の位置で宣言し、秒も script も持たない HTML の断片）。`explainer_write_diagram` が検証して `videos/{videoId}/diagrams/{scene}.html` に書き、`explainer_assemble_composition` が検査し直して、タイミング表・字幕・テーマ・`window.__hf` を加えた composition（`docs/reference/composition-contract.md`）にする。語彙と規則は `src/diagrams/diagram.ts` の定数で、本書はそれを写す（食い違ったらコードの定数が正で、本書を直す）。決定の出所は ADR-0005 決定 12 と ADR-0009 決定 11・14。

## 形式

- XML として整形式の断片（XHTML と SVG）。ルートは複数あってよい。要素名は大文字小文字を区別し、`<div/>` は空の要素
- 属性の値は `"` か `'` で囲む。同じ要素に、大文字小文字を除くと同じ名前の属性を 2 つ置かない
- 名前付きの実体参照は XML の 5 つ（`&amp;` `&lt;` `&gt;` `&quot;` `&apos;`）と数値参照だけ。`&nbsp;` などは使えない
- コメントは捨てられる。CDATA はテキストとして扱われる。コメント・CDATA・テキストの中の字面（`<script>`、`data-beat`、`url(...)`）は検査の対象にならず、composition ではエスケープされたテキストになる
- composition へは、解析した木から HTML の規則で書き出す（void 要素は閉じタグを付けず、それ以外は閉じタグを明示する）。`<div/>` が後続の要素を飲み込むことはない

## 位置

演出の時刻は、秒ではなく台本上の位置で宣言する。

- `P` — そのシーンの P 段落目の頭。`P.1` と同じ時刻
- `P.K` — そのシーンの P 段落目の K 番目の句の頭

`P` と `K` は 1 から数える正の整数（`^[1-9][0-9]*(\.[1-9][0-9]*)?$`）。句は `splitPhrases`（ナレーションのタイミング表と同じ分割）の句。組み立ての tool が、タイミング表の段落・句の開始時刻で秒に直す。

## 語彙

| 属性         | 値                                  | 意味                                                                                          |
| ------------ | ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `data-beat`  | 位置                                | 要素が現れる位置。付けない要素は、シーンの頭から見えている                                    |
| `data-enter` | `fade`（既定）/ `slide` / `pop`     | 現れ方。`data-beat` が必要                                                                    |
| `data-from`  | `left` / `right` / `top` / `bottom` | `slide` の向き。`data-enter="slide"` では必須（既定の向きは無い）で、`slide` 以外には書けない |
| `data-dim`   | 位置                                | 要素が沈む位置（不透明度が下がる）。同じ要素に `data-beat` があれば、それより後の位置         |

属性名は大文字小文字を区別しない。上の 4 つ以外の `data-*` 属性は書けない。

## 同時に動くのは 1 か所だけ

1 つの図解の中で、すべての動き（`data-beat` と `data-dim`）の位置は互いに異なる。`P` と `P.1` は同じ位置とみなす。composition の runtime は、各動きの長さを `min(0.5 秒, 次の動きが始まるまでの時間)` にするので、動きは時刻の上でも重ならない。

## 安全の規則

図解は script を持たず、外部を参照せず、時計で動かない。

- `script`・`style`・`iframe`・`object`・`embed`・`frame`・`frameset`・`link`・`meta`・`base`・`html`・`head`・`body`・`title`・`audio`・`video`・`animate`・`animateMotion`・`animateTransform`・`set` と処理命令は書けない。名前は大文字小文字と名前空間の接頭辞を除いて照合する（`<Script>`・`<svg:script>` も同じ）
- `on` で始まる属性（イベントハンドラ）は書けない
- `src`・`srcset`・`poster`・`href`（`xlink:href` を含む）の値は、`#` で始まる文書内の参照か `data:image/` だけ。`srcset` は候補（記述子 `1x`・`100w` を除く各 URL）ごとに検査する。属性の値の `url(...)` と、`image-set(...)`（`-webkit-image-set(...)` を含む）の引数の文字列も同じ（`image-set()` は `url()` で包まない文字列も URL として読む）
- `style` 属性に `animation` / `transition`（ベンダー接頭辞付きを含む）は書けない。CSS のコメントとエスケープ（`\61nimation` など）は、ブラウザと同じく解釈してから判定する。動きは `data-*` だけで宣言する
- `id` と `class` は、tool が生成する `nc-` で始まる名前を使えない。`data-nc-motion` などの生成する属性も書けない
- `id` は、図解の中でも、composition 全体（シーンをまたぐ）でも重複しない

## 字幕は図解に描かない

字幕（句ごと、下端、表記）は組み立ての tool が描く。図解に字幕を描かない。図解の領域は、枠の余白と字幕の帯の内側に収まる。

## tool が与えるもの

組み立ての tool は、チャンネル設定の `theme`（`config/channel/video.json`）を CSS 変数にして与える。図解は `style` 属性の `var(...)` で使える。

| 変数                                                                                               | 元のキー                                                               |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `--nc-color-background` / `-text` / `-accent` / `-muted` / `-caption-text` / `-caption-background` | `theme.colors`                                                         |
| `--nc-size-caption-font-size` / `-caption-margin` / `-stage-padding`（px）                         | `theme.sizes`                                                          |
| `--nc-font-body` / `--nc-font-caption`                                                             | `theme.fonts`（フォントのファイルは composition に base64 で埋め込む） |

`theme.colors` は 16 進（`#rgb` `#rgba` `#rrggbb` `#rrggbbaa`）だけ。`theme.fonts` はチャンネルルートの中の相対パス（絶対パスと `..` の区間は設定の読み込みで拒否される）で、拡張子は `.woff2` `.woff` `.ttf` `.otf`。

## 違反の規則名

違反は 1 回の `InvalidDiagrams { videoId, violations }` にすべて列挙される（縮退して続けない）。各違反は `{ scene, rule, element?, attribute?, value?, line? }`。並びはシーンの昇順、その中は文書の順。規則名は失敗の契約で、codec が参照する。

| 規則名                  | 対象                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `malformed`             | 整形式でない（閉じ忘れ・属性の重複・許されない実体参照など）。この場合は、その図解の違反はこの 1 件だけ |
| `missing`               | 組み立て時に、そのシーンの図解が無い                                                                    |
| `forbidden-element`     | 禁止された要素・処理命令                                                                                |
| `event-handler`         | `on*` 属性                                                                                              |
| `external-reference`    | `#` や `data:image/` 以外を指す参照・`url(...)`・`image-set(...)` の文字列                              |
| `wall-clock-animation`  | `style` 属性の `animation*` / `transition*`                                                             |
| `unknown-attribute`     | 語彙にない `data-*` 属性                                                                                |
| `invalid-position`      | 位置の構文が誤っている                                                                                  |
| `position-out-of-range` | 存在しない段落・句を指している                                                                          |
| `simultaneous-motion`   | 動きの位置が図解の中で重複している                                                                      |
| `invalid-enter`         | 値が語彙にない、または `data-beat` が無い                                                               |
| `invalid-from`          | 値が語彙にない、`data-enter="slide"` ではない、または `data-enter="slide"` なのに `data-from` が無い    |
| `dim-not-after-beat`    | `data-dim` の位置が、同じ要素の `data-beat` の位置以前                                                  |
| `duplicate-id`          | `id` の重複（シーンをまたぐものを含む）                                                                 |
| `reserved-name`         | `nc-` で始まる `id` / `class`                                                                           |

## 置き場と鮮度

- 図解は `videos/{videoId}/diagrams/{scene}.html`（② agent が書く入力。tool は消さない）。同じシーンに書き直すと置き換わる
- composition は `videos/{videoId}/compositions/long.html`（③ 生成成果物。local store に行を持たない）。鮮度の鍵（図解群・タイミング表・テーマ（フォントのバイト列を含む）・レイアウトのハッシュ）を `<meta name="nyaucast-composition-hash">` に持ち、一致すれば既存を返す。`force` で作り直す

## Related

- `docs/reference/composition-contract.md` — composition の契約（`window.__hf`）
- ADR-0005 決定 12 — 図解と組み立ての役割分担
- ADR-0009 決定 11・14 — 図解・composition の置き場と、失敗のタグが契約であること
