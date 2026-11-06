// The secrets module's interface. Other modules import from here. It is the only module that uses
// node:crypto for secrets.
export { linkTokenHash, newLinkToken, sameLinkTokenHash } from "./link-tokens.ts";
export {
  DEFAULT_MASTER_KEY_FILE,
  findMasterKey,
  loadMasterKey,
  type MasterKey,
  MasterKeyError,
  makeMasterKey,
  masterKeyFile,
} from "./master-key.ts";
export {
  checkDataKey,
  type DerivedUse,
  decryptsDataKey,
  SecretDecryptError,
  type SecretPlace,
  type Secrets,
  sealNewDataKey,
  unlockSecrets,
  WrongMasterKeyError,
} from "./secrets.ts";
export { setupCodeOf } from "./setup-code.ts";
