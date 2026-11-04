// The household module's interface. Other modules import from here.
export {
  type HouseholdFacts,
  type HouseholdFactsEdit,
  type HouseholdFactsInput,
  householdTimeZone,
  isKnownTimeZone,
  isNeverSentToAi,
  NEVER_SENT_TO_AI,
  onHouseholdFactsEdited,
  type RentOrOwn,
  readHouseholdFacts,
  type SaveFactsResult,
  saveHouseholdFacts,
} from "./facts.ts";
export { lookUpZipCode, type ZipPlace, type ZipSource, zipTableSources } from "./zip-table.ts";
