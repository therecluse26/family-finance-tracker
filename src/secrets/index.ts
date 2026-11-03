// The secrets module's interface. Other modules import from here. It is the only module that uses
// node:crypto for secrets.
export {
  DEFAULT_MASTER_KEY_FILE,
  loadMasterKey,
  type MasterKey,
  MasterKeyError,
} from "./master-key.ts";
export {
  checkDataKey,
  type DerivedUse,
  SecretDecryptError,
  type SecretPlace,
  type Secrets,
  unlockSecrets,
  WrongMasterKeyError,
} from "./secrets.ts";
