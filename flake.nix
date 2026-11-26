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
        packages.default = pkgs.callPackage ./nix/package.nix { };
        packages.desktop = pkgs.callPackage ./nix/desktop-package.nix { };
        devShells.default = import ./shell.nix { inherit pkgs; };
      }
    ) // {
      nixosModules.default = import ./nix/module.nix self;
    };
}
