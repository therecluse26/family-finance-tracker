// The notify module's interface. Other modules import from here. It is the only module that imports
// web-push and nodemailer.
export {
  DeliveryJob,
  deliverWaiting,
  EMAIL_STOPPED,
  EMAIL_TRIES_CAP,
  MorningDeliveryJob,
  requestDelivery,
  requestDeliveryAt,
  SMTP_PASSWORD_UNREADABLE,
} from "./delivery.ts";
export {
  channelSettings,
  type Mail,
  type MailTransport,
  type SmtpServer,
  smtpSettings,
  smtpTransport,
  type TransportMaker,
} from "./email.ts";
export {
  askForDelivery,
  type DeliveryServices,
  endCondition,
  type NewNotice,
  raiseNotice,
  startNotify,
} from "./notices.ts";
export {
  isPushServiceEndpoint,
  MAX_PUSH_BODY,
  PUSH_KEYS_REPLACED,
  PUSH_STOPPED,
  PUSH_TRIES_CAP,
  type PushSender,
  type PushServices,
  pushSettings,
  removeMemberDevices,
  type Vapid,
  vapidKeysOf,
} from "./push.ts";
