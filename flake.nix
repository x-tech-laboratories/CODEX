{
  description = "CODEX: a personal assistant on a locally run language model";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        config = {
          allowUnfree = true;
          cudaSupport = true;
        };
      };
      nodejs = pkgs.nodejs_24;
      electron = pkgs.electron_45;

      # node-llama-cpp's prebuilt CUDA build needs the CUDA runtime and the driver's libcuda at run time.
      runtimeLibraryPath = pkgs.lib.makeLibraryPath [
        pkgs.cudaPackages.cuda_cudart
        pkgs.cudaPackages.libcublas
        pkgs.stdenv.cc.cc.lib
      ] + ":/run/opengl-driver/lib";
      runtimePath = pkgs.lib.makeBinPath [ pkgs.util-linux ];

      packageJson = builtins.fromJSON (builtins.readFile ./package.json);
      app = pkgs.buildNpmPackage {
        pname = packageJson.name;
        version = packageJson.version;
        src = self;
        inherit nodejs;
        # Read from package-lock.json, so there is no deps hash to keep in step with it.
        npmDeps = pkgs.importNpmLock {
          npmRoot = ./.;
          # The lock names RoboBuddy and SmartHarness by ssh, which needs a key; the same commits come over https.
          fetcherOpts."node_modules/@x-tech-laboratories/robobuddy".url = "https://github.com/x-tech-laboratories/RoboBuddy.git";
          fetcherOpts."node_modules/@x-tech-laboratories/smartharness".url = "https://github.com/x-tech-laboratories/SmartHarness.git";
        };
        npmConfigHook = pkgs.importNpmLock.npmConfigHook;
        npmFlags = [ "--ignore-scripts" ];
        # npm unpacks the git dependencies through the cache, so the cache must be writable.
        makeCacheWritable = true;
        env = {
          ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
          NODE_LLAMA_CPP_SKIP_DOWNLOAD = "true";
        };
        nativeBuildInputs = [ pkgs.makeWrapper ];
        installPhase = ''
          runHook preInstall
          # importNpmLock puts the original lock back, whose git entries npm would fetch again, so prune with its copy.
          mv package.json package.json.orig
          mv package-lock.json package-lock.json.orig
          cp --no-preserve=mode $npmDeps/package.json $npmDeps/package-lock.json .
          npm prune --omit=dev --ignore-scripts
          mv package.json.orig package.json
          mv package-lock.json.orig package-lock.json
          # A git dependency is linked from its store path, where Node would look for its own dependencies, so copy it in;
          # prune drops what only a linked package needs, so package.json also lists SmartHarness's own dependencies.
          for link in node_modules/@x-tech-laboratories/*; do
            if [ -L "$link" ]; then
              target=$(readlink -f "$link")
              rm "$link"
              cp -r --no-preserve=mode "$target" "$link"
            fi
          done
          mkdir -p $out/lib/codex $out/bin
          cp -r dist out node_modules share resources package.json $out/lib/codex/
          makeWrapper ${nodejs}/bin/node $out/bin/codex \
            --add-flags $out/lib/codex/dist/cli/index.js \
            --prefix LD_LIBRARY_PATH : "${runtimeLibraryPath}" \
            --prefix PATH : "${runtimePath}"
          makeWrapper ${nodejs}/bin/node $out/bin/codex-daemon \
            --add-flags $out/lib/codex/dist/daemon/index.js \
            --prefix LD_LIBRARY_PATH : "${runtimeLibraryPath}" \
            --prefix PATH : "${runtimePath}"
          makeWrapper ${electron}/bin/electron $out/bin/codex-gui \
            --add-flags $out/lib/codex/out/main/index.js \
            --prefix LD_LIBRARY_PATH : "${runtimeLibraryPath}" \
            --prefix PATH : "${runtimePath}" \
            --set CODEX_GUI_COMMAND $out/bin/codex-gui
          install -Dm644 share/org.codex.CODEX.desktop $out/share/applications/org.codex.CODEX.desktop
          install -Dm644 share/org.codex.CODEX.svg $out/share/icons/hicolor/scalable/apps/org.codex.CODEX.svg
          runHook postInstall
        '';
      };
    in
    {
      packages.${system} = {
        default = app;
        codex = app;
      };

      apps.${system} = {
        default = {
          type = "app";
          program = "${app}/bin/codex-gui";
        };
        cli = {
          type = "app";
          program = "${app}/bin/codex";
        };
      };

      devShells.${system}.default = pkgs.mkShell {
        packages = [
          nodejs
          electron
          pkgs.util-linux
        ];
        # The npm electron package runs the Nix binary through this path, so electron-vite dev and preview work on NixOS.
        ELECTRON_OVERRIDE_DIST_PATH = "${electron}/libexec/electron";
        # The npm electron package runs the bare binary, which dumps core without the wrapper's sandbox path.
        CHROME_DEVEL_SANDBOX = "${electron}/libexec/electron/chrome-sandbox";
        ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
        LD_LIBRARY_PATH = runtimeLibraryPath;
      };
    };
}
