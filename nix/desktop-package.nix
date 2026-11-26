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
  pname = "x-context-desktop";
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
    mkdir -p $out/lib/x-context-desktop
    cp -r out package.json node_modules resources $out/lib/x-context-desktop/
    install -Dm644 resources/icon.png $out/share/icons/hicolor/512x512/apps/x-context.png
    makeWrapper ${lib.getExe electron_45} $out/bin/x-context-desktop \
      --add-flags $out/lib/x-context-desktop \
      --unset ELECTRON_RUN_AS_NODE \
      --set X_CONTEXT_LAUNCHER x-context-desktop

    runHook postInstall
  '';

  desktopItems = [
    (makeDesktopItem {
      name = "x-context";
      desktopName = "X-Context";
      comment = "Contexts that gather items from other apps";
      exec = "x-context-desktop %U";
      icon = "x-context";
      categories = [ "Utility" ];
      # Opens x-context://<page> links, such as a reminder's, in the app.
      mimeTypes = [ "x-scheme-handler/x-context" ];
    })
  ];

  meta = {
    description = "X-Context as a desktop app with its own database";
    license = lib.licenses.gpl3Plus;
    mainProgram = "x-context-desktop";
  };
}
