{
  lib,
  buildNpmPackage,
  importNpmLock,
  nodejs_24,
  makeWrapper,
}:

buildNpmPackage {
  pname = "x-context";
  version = (lib.importJSON ../package.json).version;
  src = lib.cleanSource ../.;

  nodejs = nodejs_24;
  # Read from package-lock.json, so there is no deps hash to keep in step with it.
  npmDeps = importNpmLock { npmRoot = ../.; };
  npmConfigHook = importNpmLock.npmConfigHook;
  env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

  nativeBuildInputs = [ makeWrapper ];

  # Node will not run .ts files from under a node_modules folder, so the app lives in lib/x-context.
  installPhase = ''
    runHook preInstall

    npm prune --omit=dev --no-save --ignore-scripts

    mkdir -p $out/lib/x-context/src $out/lib/x-context/out
    cp -r package.json node_modules $out/lib/x-context/
    cp -r out/web $out/lib/x-context/out/
    cp -r src/server src/shared $out/lib/x-context/src/

    makeWrapper ${lib.getExe nodejs_24} $out/bin/x-context \
      --add-flags "--disable-warning=ExperimentalWarning $out/lib/x-context/src/server/main.ts" \
      --set-default NODE_ENV production

    runHook postInstall
  '';

  meta = {
    description = "Contexts that gather tasks, notes, files, emails and links from the apps that keep them";
    license = lib.licenses.gpl3Plus;
    mainProgram = "x-context";
  };
}
