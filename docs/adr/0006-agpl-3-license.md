# License the project under AGPL-3.0-or-later

The app is free and open source, with no paid tier. It is a web app, so someone could run a changed copy for other people as a paid hosted service. Its dependencies include Sidequest (LGPL-3.0-or-later) and web-push (MPL-2.0). Its bundled Benchmark data is US federal work, which has no copyright.

The project license is AGPL-3.0-or-later. `LICENSE` holds the FSF text, unchanged. `package.json` carries `"license": "AGPL-3.0-or-later"`, and the README's license section reads "Copyright (C) 2026 therecluse26 and contributors,". There is no CLA and no DCO: outside code comes in under the project license, as GitHub's terms already say. The copied government numbers stay public domain, outside the AGPL; our own work on them stays under it.

MIT or Apache-2.0 would let anyone close the code and sell it, including as a paid hosted version. GPL-3.0 would let a hosted service keep its changes private, because a service hands out no copies. The AGPL makes whoever runs a changed copy for other people offer them its source. A Household that runs the code unchanged owes nothing. Firefly III, Maybe, Sure, Ghostfolio, and Immich use the AGPL too. Every dependency's license is compatible with it. Without a CLA, the license cannot change later without every author's consent; with no paid tier, nothing needs relicensing.

The build carries this out with a "Source code" link to the running version, a CI license allowlist, generated third-party notices, and a "Data sources" page. The rules are in [Stack and architecture](../spec/10-stack-and-architecture.md#license-compliance-in-the-build).

Source: [Software license](https://github.com/therecluse26/family-finance-tracker-private/issues/23).
