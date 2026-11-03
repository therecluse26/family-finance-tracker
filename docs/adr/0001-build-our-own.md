# Build our own; do not fork an existing tracker

The app's first rule is hands-off: the analysis is correct even if no Member ever reviews anything. Several open-source trackers exist: Actual Budget (TypeScript), Sure and Maybe (Ruby on Rails), and Firefly III (PHP). A review of their code found that none is hands-off. Each leaves Transfers, Refunds, or Categories for a person to finish. Only Sure pairs Transfers by itself, and it pairs them greedily. No project links Refunds or Reimbursements to the original purchase. Sure's classifier and AI run only through rules a person creates, and Firefly III has declined AI.

We build our own app, in TypeScript. Other trackers are reference material only; we do not fork them.

The hands-off core is exactly what every candidate lacks: global Transfer pairing with stored evidence and undo, Refund and Reimbursement linking, and an always-on categorization cascade. A fork would mean rewriting that core inside another project's data model, then carrying its upstream changes. Three of the four candidates are not TypeScript. Actual, the TypeScript one, is built for budgeting by hand and has no automatic Transfer pairing.

## Considered options

- **Fork Sure (Maybe's successor).** It comes closest on Transfers and Categories. But it is Ruby on Rails, its pairing is first come, first served, and an unconfirmed match still counts as Spending and Income.
- **Fork Actual Budget.** It is TypeScript. But a person writes one rule per Account pair to catch Transfers, and it finds Recurring charges only on a button press.

Sources: [Scope and product principles](https://github.com/therecluse26/family-finance-tracker-private/issues/2), [Prior art: Transfer matching and categorization](https://github.com/therecluse26/family-finance-tracker-private/issues/7) ([findings](https://github.com/therecluse26/family-finance-tracker-private/blob/research/transfer-matching-prior-art/docs/research/transfer-matching-prior-art.md)).
