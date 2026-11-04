# Data sources

The app drafts Budgets with Benchmarks: typical Spending for a Category by similar US households, from public data. Each release ships a Benchmark snapshot built from the US federal sources below. The app also ships a ZIP table, which maps each ZIP code to a state and a time zone.

## No endorsement

No agency named on this page endorses this app, its Benchmarks, or its Budgets.

BLS.gov cannot vouch for the data or analyses derived from these data after the data have been retrieved from BLS.gov.

USDA asks that a copy whose contents are altered in any way not cite USDA. The app adjusts the USDA food plan costs (for household size, prices, and Alaska and Hawaii), so every food figure the app shows is derived from USDA data, not a USDA figure.

## Terms

- **The government numbers are public domain.** Every number copied from the sources below is a work of the US federal government. It has no copyright and is outside the AGPL. Anyone may use it.
- **Our own work is under the AGPL.** The Category-to-CE-line map, the Benchmark formulas, and the code that builds the snapshot are this project's work. They are under the GNU Affero General Public License, version 3 or later, like the rest of the app.

## Sources and data dates

<!-- sources:start -->
**Sample numbers, not real data.** The release script has not yet run on the real files. Every Benchmark figure the app ships now is made up.

| Agency | Table | Data date |
|---|---|---|
| Bureau of Labor Statistics | [Consumer Expenditure Survey, calendar-year table by income before taxes](https://www.bls.gov/cex/tables.htm) | 2025 |
| Bureau of Labor Statistics | [Consumer Expenditure Survey, size of consumer unit by income before taxes](https://www.bls.gov/cex/tables.htm) | 2023-2024 |
| Bureau of Labor Statistics | [Consumer Price Index (CPI-U), all items, US city average (CUUR0000SA0)](https://api.bls.gov/publicAPI/v1/timeseries/data/CUUR0000SA0) | 2026-09 |
| Bureau of Labor Statistics | [Consumer Price Index (CPI-U), food at home, US city average (CUUR0000SAF11)](https://api.bls.gov/publicAPI/v1/timeseries/data/CUUR0000SAF11) | 2026-09 |
| U.S. Department of Agriculture | [Cost of Food at Home, Moderate-Cost plan, US average](https://www.fns.usda.gov/research/cnpp/usda-food-plans/cost-food-monthly-reports) | 2026-09 |
| U.S. Department of Agriculture | [Cost of Food at Home, Thrifty plan, US average](https://www.fns.usda.gov/research/cnpp/usda-food-plans/cost-food-monthly-reports) | 2026-09 |
| U.S. Department of Agriculture | [Cost of Food at Home, Thrifty plan, Alaska](https://www.fns.usda.gov/research/cnpp/usda-food-plans/cost-food-monthly-reports) | 2026-09 |
| U.S. Department of Agriculture | [Cost of Food at Home, Thrifty plan, Hawaii](https://www.fns.usda.gov/research/cnpp/usda-food-plans/cost-food-monthly-reports) | 2026-09 |
| U.S. Census Bureau | [2020 ZCTA to County Relationship File](https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt) | 2021-12-09 |
| National Weather Service | [U.S. Counties, time zone field](https://www.weather.gov/source/gis/Shapefiles/County/c_16ap26.zip) | 2026-04-16 |
<!-- sources:end -->

The app fetches the CPI again each month (spec 05, CPI). The Data sources page in settings shows the date of its last fetch.

## The Category-to-CE-line map

Our own work, under the AGPL. Each Category's Benchmark share is the sum of its CE lines. Each CE line belongs to at most one Category that has a Benchmark. The Benchmark column says what the Benchmark does: it drafts the Budget, drafts a shared Budget (Groceries and Superstores share B_GS), gives a Bills Budget its context line, or none.

<!-- map:start -->
| Category | Benchmark | CE lines |
|---|---|---|
| Housing | context | Renters: Rented dwellings. Owners: Owned dwellings. |
| Utilities | context | Natural gas; Electricity; Fuel oil and other fuels; Water and other public services |
| Phone and internet | context | Telephone services |
| Insurance | context | Vehicle insurance; Health insurance; Life and other personal insurance |
| Taxes and government | none | None |
| Interest and fees | none | None |
| Groceries | drafts shared | USDA Moderate-Cost plan, plus Housekeeping supplies; Personal care products |
| Superstores | drafts shared | USDA Moderate-Cost plan, plus Housekeeping supplies; Personal care products |
| Clothing | drafts | Apparel and services |
| Home and garden | drafts | Household furnishings and equipment; Other household expenses |
| Alcohol and tobacco | drafts | Alcoholic beverages; Tobacco products and smoking supplies |
| General goods | none | None |
| Gas | drafts | Gasoline, other fuels, and motor oil |
| Car | drafts | Maintenance and repairs; Vehicle rental, leases, licenses, and other charges |
| Transit and rideshare | drafts | Public and other transportation |
| Health | drafts | Medical services; Drugs; Medical supplies |
| Personal care | drafts | Personal care services |
| Childcare | drafts | Personal services |
| Pets | drafts | Pets |
| Fitness | drafts | Fees and admissions |
| Restaurants | drafts | Food away from home |
| Entertainment | drafts | Audio and visual equipment and services |
| Hobbies | drafts | Toys, hobbies, and playground equipment; Other entertainment supplies, equipment, and services |
| Travel | none | Other lodging; Public and other transportation |
| Books and education | drafts | Reading; Education |
| Gifts and donations | none | None |
| Payments to people | none | None |
| Cash | none | None |
| Services | none | None |
| Miscellaneous | none | None |
<!-- map:end -->

## Building the snapshot

The release script reads only files on disk. It makes no network request. Before each release, download each file below by hand, in a browser, and save it under the name given, in the folder `benchmark-sources/` at the root of the repo. git ignores that folder.

| Save as | Agency | Download from |
|---|---|---|
| `ce-income-before-taxes.xlsx` | BLS | [CE tables](https://www.bls.gov/cex/tables.htm), "Calendar year tables", "Income before taxes": the means, shares, and standard errors table (XLSX) for the newest year, such as `cu-income-before-taxes-2025.xlsx` |
| `ce-size-1-by-income.xlsx` to `ce-size-5-by-income.xlsx` | BLS | [CE tables](https://www.bls.gov/cex/tables.htm), "Cross-tabulated tables", "Size of consumer unit by income before taxes": one XLSX for each size: one person (1), two (2), three (3), four (4), and five or more persons (5) |
| `usda-moderate-cost.xlsx` | USDA | [Cost of Food monthly reports](https://www.fns.usda.gov/research/cnpp/usda-food-plans/cost-food-monthly-reports): the newest Moderate-Cost plan XLSX, such as `usda-moderatecostplan-sept2007-sept2026.xlsx` |
| `usda-thrifty-us.xlsx` | USDA | The same page: the newest Thrifty plan XLSX, such as `usda-thriftyplan-june2021-sept2026.xlsx` |
| `usda-thrifty-alaska.xlsx` | USDA | The same page: the newest Alaska XLSX, such as `usda-alaska-june2023-sept2026.xlsx` |
| `usda-thrifty-hawaii.xlsx` | USDA | The same page: the newest Hawaii XLSX, such as `usda-hawaii-june2023-sept2026.xlsx` |
| `cpi-all-items.json` | BLS | Open `https://api.bls.gov/publicAPI/v1/timeseries/data/CUUR0000SA0?startyear=<first CE year>&endyear=<this year>` and save the page. The first CE year is the first year of the size tables, such as 2023 for 2023-2024 |
| `cpi-food-at-home.json` | BLS | The same, for `CUUR0000SAF11` |
| `census-zcta-county-<date>.txt` | Census Bureau | [The 2020 ZCTA relationship files](https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/): `tab20_zcta520_county20_natl.txt`. Put its "Last modified" date from that page in the name, such as `census-zcta-county-2021-12-09.txt` |
| `c_<DDmmYY>.zip` | NWS | [NWS counties](https://www.weather.gov/gis/Counties): the county shapefile in effect today. Keep its name, such as `c_16ap26.zip` |

Then run:

```sh
node scripts/build-benchmark-snapshot.ts
pnpm check:benchmarks
```

The script writes `src/benchmarks/snapshot.data.ts`, `src/household/zip-table.data.ts`, and the two generated tables on this page. It fails with a message that names each missing file, and each table row or column it cannot find. `pnpm check:benchmarks` fails while the snapshot holds sample numbers, so a release cannot ship them.

`node scripts/build-benchmark-snapshot.ts --sample` builds a sample snapshot from the made-up files in `scripts/fixtures/benchmarks/`, for development only. It keeps the ZIP table as it is.

v1 ships no IRS Collection Financial Standards, HUD Fair Market Rents, Census American Community Survey, or Department of Labor childcare data.
