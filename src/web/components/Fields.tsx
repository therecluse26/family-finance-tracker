import type { ReactNode } from "react";
import { totpSecretOf } from "../requests.ts";

// Shared form pieces.

export const FIELD = "mt-1 block w-full rounded border border-gray-300 px-3 py-2";
export const BUTTON = "mt-4 rounded bg-blue-700 px-4 py-2 text-white disabled:opacity-50";

export function ErrorLine(props: { error: string | undefined }) {
  if (props.error === undefined) return null;
  return (
    <p className="mt-3 text-red-700" role="alert">
      {props.error}
    </p>
  );
}

export function TextField(props: {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  autoComplete?: string;
  // A field the form may send empty.
  optional?: boolean;
}) {
  return (
    <label className="mt-3 block">
      {props.label}
      <input
        className={FIELD}
        type={props.type ?? "text"}
        autoComplete={props.autoComplete}
        required={props.optional !== true}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}

// A box for pasting a secret, such as the Master key. The browser neither fills nor spell-checks it.
export function PasteField(props: {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="mt-3 block">
      {props.label}
      <textarea
        className={`${FIELD} font-mono`}
        rows={3}
        autoComplete="off"
        spellCheck={false}
        required
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}

// A new TOTP secret for an authenticator app: the link a phone opens, and the secret to type in.
export function NewTotp(props: { totpURI: string }) {
  return (
    <div className="mt-3 rounded border border-gray-300 p-3">
      <p>Add this to your authenticator app.</p>
      <p className="mt-2">
        On this phone:{" "}
        <a className="text-blue-700 underline" href={props.totpURI}>
          open in your authenticator app
        </a>
      </p>
      <p className="mt-2">
        Or type in this TOTP secret:{" "}
        <code className="break-all">{totpSecretOf(props.totpURI)}</code>
      </p>
    </div>
  );
}

// Backup codes, shown once.
export function BackupCodes(props: { codes: string[] }) {
  return (
    <div className="mt-3 rounded border border-gray-300 p-3">
      <p>Save these backup codes now. Each works once, in place of a TOTP code.</p>
      <ul className="mt-2 grid grid-cols-2 gap-1 font-mono">
        {props.codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
    </div>
  );
}
