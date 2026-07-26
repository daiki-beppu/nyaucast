# Feature coding policy

feature workflow の実装ステップでは、承認済みの requirements.md と test-design.md に記録された要件だけを実装する。

- 要件 ID と受け入れ条件を変更しない。
- 変更対象は issue の影響範囲に限定する。
- フォールバック、互換層、未使用コード、無関係なリファクタリングを追加しない。
- 不明点や矛盾は推測で埋めず、実装を停止して report に記録する。
- 実装、テスト、品質ゲートの結果を implementation report に残す。
