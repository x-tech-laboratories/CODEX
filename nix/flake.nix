{
  description = "CODEX — a personal knowledge base and assistant: contexts that gather items from the apps that keep them";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        packages.default = pkgs.callPackage ./package.nix { };
        packages.desktop = pkgs.callPackage ./desktop-package.nix { };
        devShells.default = import ./shell.nix { inherit pkgs; };
      }
    ) // {
      nixosModules.default = import ./module.nix self;
    };
}
