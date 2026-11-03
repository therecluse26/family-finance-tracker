// The notify module's interface. Other modules import from here. It is the only module that imports
// web-push and nodemailer.
export { endCondition, type NewNotice, raiseNotice, startNotify } from "./notices.ts";
