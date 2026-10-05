# knowledge codec は npm パッケージに同梱し、下流リポは node_modules への symlink で読む

## Status

accepted (2026-10-02) / 改訂 2026-10-04（#587。ADR-0011 でリポを公開することにしたので、リポが private であることを前提にした記述を改めた。決定は変えていない）

## Context

ADR-0007 で workflow tool を廃止したため、区間を歩く手順を持つのは knowledge codec だけになった。v0.1 では `explainer-lifecycle` と `distribution` の 2 本を書く（ADR-0009）。この 2 本をリポのどこに置き、下流のチャンネルリポで Claude Code と Codex にどう読ませるかが決まっていなかった。

旧 map では「skills CLI でリポを直指定してグローバルに入れ、起動時に版を比べて警告する」と決めていた（#20）。ただし、この決定は ADR にも GLOSSARY.md にも入っていない。

一番避けたい事故は、codec と MCP tool の版がずれて、**codec が存在しない tool を呼ぶ**ことである。

調べた事実（2026-10-02 時点。詳細は #471 の解決コメント）は次のとおり。

- Claude Code はリポの `.claude/skills/` を読み、Codex はリポの `.agents/skills/` を読む。どちらも symlink をたどる。node_modules を自分で探しには行かない
- npm パッケージに `skills/<名前>/SKILL.md` を同梱する書き方が広がっている（TanStack Intent、antfu の skills-npm、Prisma 8、`chrome-devtools-mcp`）。利点として「パッケージの版がそのまま skill の版になる」ことが挙げられている。利用側でどう読ませるかの標準はまだ固まっていない
  - skills-npm v2 と vercel-labs/skills の RFC #2323 は、node_modules を指す相対 symlink をコミットする方式
  - vercel-labs/skills の `experimental_sync` は、node_modules からコピーする方式
- MCP の prompts は Codex に実装が無い。server の `instructions` は両方が自動で読むが、短い（Codex は 512 文字を推奨）
- npm パッケージは public である。（改訂 2026-10-04 / #587）リポは当初 private だったが、ADR-0011 で公開することになった。下の決定は、どちらの状態でも変わらない

## Decision

1. **codec を nyaucast の npm パッケージに同梱する。** 置き場はリポ直下の `skills/<codec 名>/`（`skills/explainer-lifecycle/` と `skills/distribution/`）とし、`package.json` の `files` に `skills` を加える。`skills/` 直下に置くのは codec だけにする。nyaucast の開発用の skill は `.claude/skills/` か `.agents/skills/` に置き、配布物と混ぜない
2. **下流のチャンネルリポは、nyaucast を exact pin の devDependency に入れる。** MCP server は、その `node_modules` にある nyaucast をローカルの stdio MCP として起動する
3. **下流リポは codec を相対 symlink で読み、symlink をコミットする。** `.agents/skills/<codec>` が `node_modules/nyaucast/skills/<codec>` を指し、`.claude/skills/<codec>` は `.agents/skills/<codec>` を指す（RFC #2323 と同じ形）。symlink は一度きりの準備として手で作る。skills-npm や `skills sync` などの利用側ツールを使うかどうかは下流リポが選ぶことで、nyaucast はそれに依存しない
4. **1 codec = 1 skill とする。** SKILL.md は入口（トリガー発話、区間の地図、ゲートの判断基準、作り直しの手順）にとどめ、区間ごとの手順は `references/` に分けて必要なときだけ読ませる。agent は区間単位で起動されるので（ADR-0007 決定 3）、分け方を起動の単位にそろえる
5. **codec 独自の版、agent 向けの changelog、起動時の版比べは持たない。** 決定 1〜3 で、codec と MCP tool は同じ tarball の同じ版から来る
6. **MCP server の `instructions` に codec への道案内を置く。** 512 文字以内で、codec の名前と、どの区間で読むかだけを書く。手順そのものは書かない（順序の知識は codec の領分。ADR-0007 決定 6）
7. **tool description と codec の線引き。** tool description はその tool 単体の WHAT と隣接する tool への誘導を持ち、codec は WHEN と、複数の tool にまたがる HOW を持つ。不可逆な操作（投稿・公開）の制約だけは両方にわざと重ねて書く。codec を読んでいない agent が tool を直接叩いても、安全側に倒すためである
8. **codec は `pnpm run check` の静的テストで検証する。** codec が名前を出す MCP tool と CLI コマンドが実在すること、frontmatter が規定の形であることを確かめる。手順の良し悪しは dogfood で確かめる

## Why

- **版のずれが構造上起きない。** MCP server と codec が下流リポの同じ lockfile の版から来るので、「codec が存在しない tool を呼ぶ」事故の源が消える。版を上げる操作も、`package.json` の 1 行と install で済む
- **Claude Code と Codex の両方が読める。** どちらもリポの skill ディレクトリにある symlink をたどる
- **リポの公開状態に依存しない。**（改訂 2026-10-04 / #587）配る経路は public な npm パッケージだけで、下流はリポを読まない。リポを公開しても、配り方は変わらない
- **チャンネルリポごとに版を固定できる。** グローバルに入れると、全リポが同じ版の codec を読むことになる

## Considered Options

- **skills CLI でリポを直指定してグローバルに入れ、起動時に版を比べて警告する**（旧 #20）: 採らない。codec と MCP tool の版の対応を、タグの運用と警告で守ることになる。（改訂 2026-10-04 / #587）当初は「下流がリポを読める権限も要る」ことも理由にしていた。リポの公開でこの理由は消えたが、版ずれの理由だけで採らない判断は変わらない
- **Claude Code plugin の npm source で、skills と MCP 設定を一緒に配る**: 採らない。pnpm の lockfile では plugin の依存が入らないので、依存を bundle するか `npm-shrinkwrap.json` を同梱する必要がある。外部 source の plugin は各自が install しなければならず、Codex で stdio MCP が動くかも確認できていない
- **MCP の prompts / resources で配る**: 採らない。Codex に prompts の実装が無く、resources は agent が自分から読まない
- **Hono の方式（別リポに skill を置き、plugin marketplace と skills CLI で配る）**: 採らない。ライブラリと skill の版が連動しない構造で、避けたい事故がそのまま起こりうる
- **区間ごとに別の skill に分ける**: 採らない。GLOSSARY.md の「codec は 6 本」という数え方と食い違う。入口が分かれると、ゲートの判断基準と作り直しの手順の置き場も割れる
- **LLM に codec を読ませて手順をたどらせる eval**: v0.1 では採らない。結果がぶれるので、CI の裁定者にできない

## Consequences

- 前提は「MCP server が、下流リポの node_modules から起動するローカルの stdio MCP である」ことにある。MCP をリモートで動かすことになったら、server の版が下流の lockfile から外れるので、配り方を決め直す
- 次の 2 点は実装で確かめる。
  - pnpm の node_modules の構造の下で、相対 symlink が解決すること
  - install の前（リンク先が無い状態）で、Claude Code と Codex がどう振る舞うか
- 利用側ツール（`skills sync` など）が標準として固まったら、下流リポは手作りの symlink をそれに置き換えてよい。提供側の配置（`skills/<名前>/SKILL.md`）はどのツールからも見つかるので、変えなくてよい
- GLOSSARY.md の `knowledge codec` に、配り方を 1 文で加えた

## Related

- ADR-0001（thin architecture）/ ADR-0003（Node 配布と pnpm）/ ADR-0006（takt を製品の orchestration に採らない）/ ADR-0007（codec を読んだ agent が区間を歩く）/ ADR-0009（解説動画と 3 SNS 配信）/ ADR-0011（配布モデル。リポの公開を決めた）
- issue #471「knowledge codec の置き場と下流への配り方」（地図 #457 の決定 ticket）
- issue #587「リポ公開に合わせて ADR-0010 の private 前提を改める」（地図 #574 の決定 ticket）
- 旧 issue #20（codec の配布・更新方式の確定）/ #13（v0.1 codec の範囲と深さ）/ #401（collection-lifecycle codec の執筆と配布整備）— 材料
