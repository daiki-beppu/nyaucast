# tayk architecture Knowledge

tayk の診断・設計・レビューで構造を判定するための project Knowledge。takt builtin の一般的な architecture Knowledge を tayk の正書に合わせて置き換える。

判定前に `docs/adr/0001-thin-architecture.md` の Decision を読む。本ファイルと ADR が食い違う場合は ADR を優先し、記憶や一般的な設計パターンを根拠に補完しない。用語とドメイン境界は `CONTEXT.md` を正書とする。

## tayk 固有の優先規則

- TA-02 REQUIRED: `docs/adr/0001-thin-architecture.md` を tayk の構造規約の正書とし、一般的なレイヤー構成や Vertical Slice は ADR-0001 と競合しない場合に限って補助観点として使う。
- TA-03 OK: 1 MCP tool を実装1ファイルとテスト1ファイルの基本単位にし、zod の入出力 schema・description・handler を tool 定義ファイルに同居させる。
- TA-03 REJECT: schema・service・index を別ファイルへ分割する。
- TA-04 OK: tool 一覧には entry point のフラットな import 配列を使う。
- TA-04 REJECT: tool registry、動的収集、または「登録」工程を新設する。
- TA-05 OK: core 内部は throw し、MCP/CLI adapter 境界で外部表現へ変換する。
- TA-05 REJECT: Result 型・createService・toServiceError の追加 service frame を導入する。
- TA-06 OK: adapter は MCP primary と CLI thin の境界に限定する。
- TA-06 REJECT: adapter に業務ロジックを書く。
- TA-07 REQUIRED: ADR から逸脱する変更には該当 ADR の改訂を同じ変更に含める。
- TA-07 REJECT: ADR を改訂せず黙って逸脱する。

## 判定手順

1. 対象が MCP tool、entry point、core、adapter のどこに属するかを実コードと `CONTEXT.md` で確定する。
2. ADR-0001 の該当 Decision と上の TA 規則を先に適用する。
3. 一般的な architecture 観点は、TA 規則と競合しない残りの設計判断にだけ適用する。
4. 逸脱が必要なら、実装だけを承認せず該当 ADR の改訂を同じ差分に要求する。

## 補助観点

ADR-0001 と競合しない範囲では、高凝集、低結合、循環依存の回避、責務と副作用の明確さを評価する。ただし、これらを理由に schema・service・repository 等の追加レイヤー、Vertical Slice、registry、service frame を導入してはならない。ファイル行数だけを分割の合否条件にせず、tool の基本単位と責務の凝集を優先する。
