import { AmazonStore } from "./Amazon.tsx";
import { TabHeading } from "./settings-ui.tsx";

// Settings → Store orders (spec 14, The Store orders page in Settings): one card per store, each
// with its own order history file. Amazon is the only store today; another store is one more entry
// here.
export const STORES: readonly { id: string; name: string; Card: () => React.JSX.Element }[] = [
  { id: "amazon", name: "Amazon", Card: AmazonStore },
];

export function StoreOrders() {
  return (
    <>
      <TabHeading>Store orders</TabHeading>
      <p className="text-muted">
        A store's order history file links each order's items to the charge that paid for it, and
        gives each item a Category.
      </p>
      {STORES.map((store) => (
        <store.Card key={store.id} />
      ))}
    </>
  );
}
