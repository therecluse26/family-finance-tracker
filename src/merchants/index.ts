// The merchants module's interface (spec 04, Merchants). Other modules import from here.
export { isPaymentApp, merchantKey, sameMerchant } from "./identity.ts";
export { accountLastFours, plainForms } from "./lead-ins.ts";
export { isMaskedMerchant, MASKED_MERCHANTS, type MaskedMerchant } from "./masked.ts";
export {
  cleanDescription,
  cleanMerchant,
  isFixedName,
  type Merchant,
  type MerchantCleanup,
} from "./names.ts";
export {
  PAYMENT_APPS,
  type PaymentApp,
  type PaymentAppLine,
  type PaymentAppParty,
  paymentAppLine,
} from "./payment-apps.ts";
