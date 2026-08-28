{
  description = "Codev - lightweight cross-platform code and document reader with an integrated terminal";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }: let
    forAllSystems = nixpkgs.lib.genAttrs [ "x86_64-linux" "x86_64-darwin" "aarch64-darwin" ];
  in {
    packages = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      codev = pkgs.callPackage ./nix/package.nix { };
      default = self.packages.${system}.codev;
    });

    nixosModules.codev = { pkgs, ... }: {
      environment.systemPackages = [ self.packages.${pkgs.system}.codev ];
    };

    darwinModules.codev = { pkgs, ... }: {
      environment.systemPackages = [ self.packages.${pkgs.system}.codev ];
    };
  };
}
