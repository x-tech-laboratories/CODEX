{
  lib,
  buildNpmPackage,
  importNpmLock,
  nodejs_24,
  electron_45,
  makeWrapper,
  copyDesktopItems,
  makeDesktopItem,
}:

buildNpmPackage {
  pname = "codex-desktop";
  version = (lib.importJSON ../package.json).version;
  src = lib.cleanSource ../.;

  nodejs = nodejs_24;
  # Read from package-lock.json, so there is no deps hash to keep in step with it.
  npmDeps = importNpmLock {
    npmRoot = ../.;
    # The lock names the git dependencies, RoboBuddy (which the page bundles) and SmartHarness, by ssh, which needs a key;
    # the same commits come over https.
    fetcherOpts."node_modules/@x-tech-laboratories/robobuddy".url = "https://github.com/x-tech-laboratories/RoboBuddy.git";
    fetcherOpts."node_modules/@x-tech-laboratories/smartharness".url = "https://github.com/x-tech-laboratories/SmartHarness.git";
  };
  npmConfigHook = importNpmLock.npmConfigHook;
  # npm unpacks a git dependency through its cache, so the cache must be writable.
  makeCacheWritable = true;
  env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

  nativeBuildInputs = [
    makeWrapper
    copyDesktopItems
  ];

  npmBuildScript = "build:desktop";

  installPhase = ''
    runHook preInstall

    # importNpmLock puts the original lock back, whose git entries npm would fetch again, so prune with its copy.
    mv package.json package.json.orig
    mv package-lock.json package-lock.json.orig
    cp --no-preserve=mode $npmDeps/package.json $npmDeps/package-lock.json .
    npm prune --omit=dev --no-save --ignore-scripts
    mv package.json.orig package.json
    mv package-lock.json.orig package-lock.json
    # A git or folder dependency is linked from its store path, where Node would look for its own dependencies, so copy
    # it in; prune drops what only a linked package needs, so package.json also lists SmartHarness's own dependencies.
    for link in node_modules/* node_modules/@*/*; do
      if [ -L "$link" ]; then
        target=$(readlink -f "$link")
        rm "$link"
        cp -r --no-preserve=mode "$target" "$link"
      fi
    done
    mkdir -p $out/lib/codex-desktop
    cp -r out package.json node_modules resources $out/lib/codex-desktop/
    install -Dm644 resources/icon.png $out/share/icons/hicolor/512x512/apps/codex.png
    makeWrapper ${lib.getExe electron_45} $out/bin/codex-desktop \
      --add-flags $out/lib/codex-desktop \
      --unset ELECTRON_RUN_AS_NODE \
      --set CODEX_LAUNCHER codex-desktop

    runHook postInstall
  '';

  desktopItems = [
    (makeDesktopItem {
      name = "codex";
      desktopName = "CODEX";
      comment = "Contexts that gather items from other apps";
      exec = "codex-desktop %U";
      icon = "codex";
      categories = [ "Utility" ];
      # Opens codex://<page> links, such as a reminder's, in the app.
      mimeTypes = [ "x-scheme-handler/codex" ];
    })
  ];

  meta = {
    description = "CODEX as a desktop app with its own database";
    license = lib.licenses.gpl3Plus;
    mainProgram = "codex-desktop";
  };
}
