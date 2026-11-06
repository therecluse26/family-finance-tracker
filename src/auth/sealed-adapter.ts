import { type DBAdapter, type DBTransactionAdapter, generateId, type Where } from "better-auth";
import type { Secrets } from "../secrets/index.ts";

// The columns that hold a Member's TOTP secret and backup codes, by Better Auth model and field.
// Better Auth already encrypts each value with the login signing secret. The secrets module
// encrypts that again, bound to its row and column, so a value moved to another row does not
// decrypt (spec 09, Encryption at rest).
const SEALED: Record<string, Record<string, string>> = {
  twoFactor: { secret: "two_factors.secret", backupCodes: "two_factors.backup_codes" },
};

type Row = Record<string, unknown>;

const sealedFields = (model: string) => SEALED[model] ?? {};

// The values as app.db holds them: each sealed column encrypted, bound to its row and column. For
// a write the auth module makes itself, in a transaction with other rows.
export function sealedValues(secrets: Secrets, model: string, rowId: unknown, values: Row): Row {
  const sealed = { ...values };
  for (const [field, column] of Object.entries(sealedFields(model))) {
    const value = sealed[field];
    if (typeof value !== "string") continue;
    if (typeof rowId !== "string" || rowId === "") {
      throw new Error(`The auth module cannot seal ${column} without its row ID.`);
    }
    sealed[field] = secrets.encrypt(value, { rowId, column });
  }
  return sealed;
}

// Wraps Better Auth's database adapter so the sealed columns are encrypted on each write and
// decrypted on each read. Better Auth sees the values it wrote; app.db holds only ciphertext.
export function sealedAdapter<A extends DBTransactionAdapter>(adapter: A, secrets: Secrets): A {
  const isSealed = (model: string, field: string) => field in sealedFields(model);
  const seal = (model: string, rowId: unknown, values: Row) =>
    sealedValues(secrets, model, rowId, values);

  function open<T>(model: string, row: T): T {
    if (row === null || typeof row !== "object") return row;
    const opened: Row = { ...(row as Row) };
    for (const [field, column] of Object.entries(sealedFields(model))) {
      const value = opened[field];
      if (typeof value !== "string") continue;
      opened[field] = secrets.decrypt(value, { rowId: String(opened.id), column });
    }
    return opened as T;
  }

  // Better Auth compares a sealed column with a value it read, as in "update the backup codes
  // only if they are still these". A stored ciphertext never equals that value, so the
  // condition is swapped for the row's ID and its stored ciphertext. A write between this read
  // and the update changes the ciphertext, so the update still matches nothing then.
  // Undefined when no row can match.
  async function storedWhere(model: string, where: Where[] = []): Promise<Where[] | undefined> {
    const onSealed = where.filter((condition) => isSealed(model, condition.field));
    if (onSealed.length === 0) return where;
    for (const condition of onSealed) {
      if ((condition.operator ?? "eq") !== "eq" || condition.connector === "OR") {
        throw new Error(`The auth module compares ${model}.${condition.field} only for equality.`);
      }
    }
    const rest = where.filter((condition) => !isSealed(model, condition.field));
    const rows = await adapter.findMany<Row>({ model, where: rest });
    const matches = rows.filter((row) => {
      const opened = open(model, row);
      return onSealed.every((condition) => opened[condition.field] === condition.value);
    });
    const [match, ...others] = matches;
    if (match === undefined) return undefined;
    if (others.length > 0) throw new Error(`More than one ${model} row matches a sealed value.`);
    return [
      ...rest,
      { field: "id", value: String(match.id) },
      ...onSealed.map((condition) => ({
        field: condition.field,
        value: match[condition.field] as string,
      })),
    ];
  }

  // The one row a write changes, for the place its new sealed values are bound to.
  async function rowIdFor(model: string, where: Where[]): Promise<string | undefined> {
    const byId = where.find((c) => c.field === "id" && (c.operator ?? "eq") === "eq");
    if (typeof byId?.value === "string") return byId.value;
    const rows = await adapter.findMany<Row>({ model, where, limit: 2 });
    if (rows.length > 1) throw new Error(`A sealed write to ${model} must change one row.`);
    return rows[0] === undefined ? undefined : String(rows[0].id);
  }

  const writesSealed = (model: string, values: Row | undefined) =>
    values !== undefined && Object.keys(values).some((field) => isSealed(model, field));

  // Adds the ID to a field list, since a sealed value cannot be read without its row ID.
  const withId = (select: string[] | undefined) =>
    select === undefined || select.includes("id") ? select : [...select, "id"];

  const wrapped: DBTransactionAdapter = {
    ...adapter,

    async create(data) {
      if (!writesSealed(data.model, data.data)) return open(data.model, await adapter.create(data));
      const values = data.data as Row;
      const id = typeof values.id === "string" ? values.id : generateId();
      const created = await adapter.create({
        ...data,
        data: seal(data.model, id, { ...values, id }),
        select: withId(data.select),
        forceAllowId: true,
      });
      return open(data.model, created);
    },

    async findOne(data) {
      const where = await storedWhere(data.model, data.where);
      if (where === undefined) return null;
      const row = await adapter.findOne({ ...data, where, select: withId(data.select) });
      return open(data.model, row);
    },

    async findMany(data) {
      const where = await storedWhere(data.model, data.where);
      if (where === undefined) return [];
      const rows = await adapter.findMany({ ...data, where, select: withId(data.select) });
      return rows.map((row) => open(data.model, row));
    },

    async count(data) {
      const where = await storedWhere(data.model, data.where);
      return where === undefined ? 0 : adapter.count({ ...data, where });
    },

    async update(data) {
      const where = await storedWhere(data.model, data.where);
      if (where === undefined) return null;
      let update = data.update;
      if (writesSealed(data.model, update)) {
        const id = await rowIdFor(data.model, where);
        if (id === undefined) return null;
        update = seal(data.model, id, update);
      }
      return open(data.model, await adapter.update({ ...data, where, update }));
    },

    async updateMany(data) {
      if (writesSealed(data.model, data.update)) {
        throw new Error(`The auth module writes ${data.model}'s sealed values one row at a time.`);
      }
      const where = await storedWhere(data.model, data.where);
      return where === undefined ? 0 : adapter.updateMany({ ...data, where });
    },

    async incrementOne(data) {
      const where = await storedWhere(data.model, data.where);
      if (where === undefined) return null;
      let set = data.set;
      if (writesSealed(data.model, set)) {
        const id = await rowIdFor(data.model, where);
        if (id === undefined) return null;
        set = seal(data.model, id, set ?? {});
      }
      return open(data.model, await adapter.incrementOne({ ...data, where, set }));
    },

    async consumeOne(data) {
      const where = await storedWhere(data.model, data.where);
      if (where === undefined) return null;
      return open(data.model, await adapter.consumeOne({ ...data, where }));
    },

    async delete(data) {
      const where = await storedWhere(data.model, data.where);
      if (where !== undefined) await adapter.delete({ ...data, where });
    },

    async deleteMany(data) {
      const where = await storedWhere(data.model, data.where);
      return where === undefined ? 0 : adapter.deleteMany({ ...data, where });
    },
  };

  const transaction = (adapter as Partial<DBAdapter>).transaction;
  if (transaction === undefined) return wrapped as A;
  return {
    ...wrapped,
    transaction: (callback) =>
      transaction((trx: DBTransactionAdapter) => callback(sealedAdapter(trx, secrets))),
  } as DBAdapter as unknown as A;
}
