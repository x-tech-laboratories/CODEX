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
  npmDeps = importNpmLock { npmRoot = ../.; };
  npmConfigHook = importNpmLock.npmConfigHook;
  env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

  nativeBuildInputs = [
    makeWrapper
    copyDesktopItems
  ];

  npmBuildScript = "build:desktop";

  installPhase = ''
    runHook preInstall

    npm prune --omit=dev --no-save --ignore-scripts
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
