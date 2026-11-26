{
  lib,
  buildNpmPackage,
  importNpmLock,
  nodejs_24,
  makeWrapper,
}:

buildNpmPackage {
  pname = "codex";
  version = (lib.importJSON ../package.json).version;
  src = lib.cleanSource ../.;

  nodejs = nodejs_24;
  # Read from package-lock.json, so there is no deps hash to keep in step with it.
  npmDeps = importNpmLock {
    npmRoot = ../.;
    # The lock names RoboBuddy, a git dependency the page bundles, by ssh, which needs a key; the same commit comes over https.
    fetcherOpts."node_modules/@x-tech-laboratories/robobuddy".url = "https://github.com/x-tech-laboratories/RoboBuddy.git";
  };
  npmConfigHook = importNpmLock.npmConfigHook;
  # npm unpacks a git dependency through its cache, so the cache must be writable.
  makeCacheWritable = true;
  env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

  nativeBuildInputs = [ makeWrapper ];

  # Node will not run .ts files from under a node_modules folder, so the app lives in lib/codex.
  installPhase = ''
    runHook preInstall

    npm prune --omit=dev --no-save --ignore-scripts

    mkdir -p $out/lib/codex/src $out/lib/codex/out
    cp -r package.json node_modules $out/lib/codex/
    cp -r out/web $out/lib/codex/out/
    cp -r src/server src/shared $out/lib/codex/src/

    makeWrapper ${lib.getExe nodejs_24} $out/bin/codex \
      --add-flags "--disable-warning=ExperimentalWarning $out/lib/codex/src/server/main.ts" \
      --set-default NODE_ENV production

    runHook postInstall
  '';

  meta = {
    description = "Contexts that gather tasks, notes, files, emails and links from the apps that keep them";
    license = lib.licenses.gpl3Plus;
    mainProgram = "codex";
  };
}
