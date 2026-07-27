{
  description = "tayk development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "aarch64-darwin" "x86_64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {
      devShells = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; };
        in {
          default = pkgs.mkShell {
            packages = with pkgs; [ bun nodejs_24 ];
            # devShell に入った時点で依存が解決済みであることを不変条件にする。
            # bun install は変更が無ければ no-op（~0.3s）なので、自前の鮮度判定
            # （node_modules の有無や lockfile の mtime 比較）は持たない。
            shellHook = ''
              export PATH="$PWD/node_modules/.bin:$PATH"

              if [ -f package.json ]; then
                if [ ! -d node_modules ]; then
                  echo "tayk: 依存を導入しています (bun install)…" >&2
                fi
                if ! bun install --frozen-lockfile --silent; then
                  echo "tayk: bun install --frozen-lockfile が失敗しました。package.json と bun.lock の差分を解消してから bun install を実行してください。" >&2
                fi
              fi
            '';
          };
        });
    };
}
