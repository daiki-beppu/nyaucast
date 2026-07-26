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
            shellHook = ''
              export TMP="$PWD/.tmp"
              export TEMP="$TMP"
              export TMPDIR="$TMP"
              mkdir -p "$TMP"
              export PATH="$PWD/node_modules/.bin:$PATH"
            '';
          };
        });
    };
}
