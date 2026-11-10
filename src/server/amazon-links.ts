import type { Database } from "../db/index.ts";
import { linkShipmentByHand, shipmentsToLink, undoShipmentLinks } from "../line-items/index.ts";
import type { AmazonLinkRoutes } from "./amazon-links-views.ts";

// A Transaction's Amazon links, on its detail view (spec 14, Hand links): the shipments a Member
// may link to it, the hand link, and Undo.
export function amazonLinkRoutes(database: Database): AmazonLinkRoutes {
  return {
    shipmentsToLink: (transactionId) => shipmentsToLink(database, transactionId),
    link: (transactionId, shipment) => linkShipmentByHand(database, transactionId, shipment),
    undo: (transactionId, memberId) => undoShipmentLinks(database, transactionId, memberId),
  };
}
