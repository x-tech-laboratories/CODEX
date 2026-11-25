// CODEX's names for the harness's folders and instructions file; importing this module sets them.
import { setAppIdentity, type AppIdentity } from '@x-tech-laboratories/smartharness/identity';

export const CODEX_IDENTITY: AppIdentity = {
    displayName: 'CODEX',
    configFolderName: 'codex',
    projectFolderName: '.codex',
    instructionsFileName: 'CODEX.md',
};

setAppIdentity(CODEX_IDENTITY);
