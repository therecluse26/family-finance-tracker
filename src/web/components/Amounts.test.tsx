import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { keepAmountsWhole } from "./Amounts.tsx";

// Spec 07, Number formats: a signed amount in a line of text never breaks between its sign and its
// "$". At 375 px a Review list line broke as "· −" over "$80.56".

const html = (text: string) => renderToString(<p>{keepAmountsWhole(text)}</p>);

describe("a line of text with signed amounts", () => {
  it("keeps each signed amount on one line and leaves the rest of the line free to wrap", () => {
    expect(html("Feb 10 · City of Mapleford Utilities · −$80.56 · Interest Checking")).toBe(
      '<p>Feb 10 · City of Mapleford Utilities · <span class="whitespace-nowrap">−$80.56</span> · Interest Checking</p>',
    );
  });

  it("keeps money in, thousands, and a price change whole too", () => {
    expect(html("+$1,865.90, then up from $23.75 to $25.00 (+$1.25, +5%).")).toBe(
      '<p><span class="whitespace-nowrap">+$1,865.90</span>, then up from $23.75 to $25.00 (<span class="whitespace-nowrap">+$1.25</span>, +5%).</p>',
    );
  });

  it("leaves a line with no signed amount as it is", () => {
    expect(html("No links.")).toBe("<p>No links.</p>");
  });
});
