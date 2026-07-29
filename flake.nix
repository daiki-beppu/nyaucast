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
            # direnv は開発者がホスト側に持つが、CI は nix develop 経由で入るため
            # devShell が供給しないと devshell テストの前提（direnv on PATH）が満たせない
            packages = with pkgs; [ bun direnv git nodejs_24 ];
            # devShell へ入るたびに依存の解決を試みる。bun install は変更が無ければ
            # no-op（~0.3s）なので、自前の鮮度判定（node_modules の有無や lockfile の
            # mtime 比較）は持たない。
            #
            # 失敗は非致命にする。package.json を編集中で lockfile と乖離している間に
            # devShell へ入れなくなるほうが困るため。ただしその場合 node_modules は
            # 生成されないので、「入場 = 依存が揃っている」は保証しない。
            shellHook = ''
              if tayk_root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
                package_json="$tayk_root/package.json"
                package_name="$(
                  bun --eval '
                    const name = JSON.parse(await Bun.file(process.argv[1]).text()).name;
                    if (typeof name !== "string") process.exit(1);
                    process.stdout.write(name);
                  ' "$package_json" 2>/dev/null
                )"
                if [ "$?" -eq 0 ] && [ "$package_name" = "@daiki-beppu/tayk" ]; then
                  export PATH="$tayk_root/node_modules/.bin:$PATH"
                  if [ ! -d "$tayk_root/node_modules" ]; then
                    echo "tayk: 依存を導入しています (bun install)…" >&2
                  fi
                  if ! bun install --cwd "$tayk_root" --frozen-lockfile --silent; then
                    echo "tayk: bun install --frozen-lockfile が失敗しました。package.json と bun.lock の差分を解消してから bun install を実行してください。" >&2
                  fi
                else
                  echo "tayk: Git リポジトリの package.json から tayk を識別できないため、依存を導入しません。" >&2
                fi
              else
                echo "tayk: Git リポジトリ外では tayk を識別できないため、依存を導入しません。" >&2
              fi
            '';
          };
        });
    };
}
