import type { Database } from "../db/index.ts";
import { drawPicture, type PictureRoutes } from "../pictures/index.ts";

// The picture route (spec 08, Picture menu): a choice from the menu, drawn from app.db through the
// pictures module.
export function pictureRoutes(database: Database): PictureRoutes {
  return { draw: (choice, month) => drawPicture(database, choice, month) };
}
