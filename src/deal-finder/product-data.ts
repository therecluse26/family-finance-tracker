// The Product data source (spec 15, Price sources): Open Food Facts, which gives ingredients and
// allergens by barcode (UPC) for the dietary check. It needs no key, and gets a barcode only (spec
// 15, Data and privacy). Like the Price source adapter, it is one interface with a fake for every
// test and development run. A lookup that throws counts as no facts: the match goes on without them.

export type ProductFacts = {
  // The ingredients, as the source lists them.
  ingredients: string | null;
  // Each allergen, such as "peanuts".
  allergens: string[];
};

export type ProductDataAdapter = {
  // The facts for one barcode, or null when the source has none.
  lookUp(barcode: string): Promise<ProductFacts | null>;
};

// The in-memory fake: made-up facts for made-up barcodes. It never touches a network.
export class FakeProductData implements ProductDataAdapter {
  // Each barcode asked, in order.
  readonly calls: string[] = [];
  readonly facts = new Map<string, ProductFacts>();
  // While set, every lookup throws, as a source that does not answer.
  failing = false;

  async lookUp(barcode: string): Promise<ProductFacts | null> {
    this.calls.push(barcode);
    if (this.failing) throw new Error("The fake Product data source did not answer.");
    return this.facts.get(barcode) ?? null;
  }
}
