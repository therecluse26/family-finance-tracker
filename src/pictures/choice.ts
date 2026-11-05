import * as z from "zod";
import { MAX_PICTURE_MERCHANTS, type PictureChoice } from "./picture-view.ts";

// A picture choice's shape (spec 08, Picture menu). The shape only: a Category or a Merchant is
// any name here, and drawing checks it against the data, so a name the data does not hold shows no
// picture rather than failing the answer that holds it. A choice with a field its type does not
// take, such as a cards picture that names a Category, is not a choice.

const NAME = z.string().trim().min(1).max(100);

const days = z
  .object({
    type: z.literal("days"),
    category: NAME.optional(),
    merchants: z.array(NAME).min(1).max(MAX_PICTURE_MERCHANTS).optional(),
  })
  .strict()
  .refine((choice) => (choice.category === undefined) !== (choice.merchants === undefined), {
    message: "A days picture names a Category or a list of Merchants, not both.",
  })
  .transform(
    ({ category, merchants }): PictureChoice =>
      merchants === undefined
        ? { type: "days", category: category ?? "" }
        : { type: "days", merchants },
  );

export const pictureChoice: z.ZodType<PictureChoice, unknown> = z.union([
  days,
  z.object({ type: z.literal("trend"), category: NAME }).strict(),
  z.object({ type: z.literal("cards") }).strict(),
  z.object({ type: z.literal("recurring"), category: NAME }).strict(),
]);
