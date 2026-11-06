import { type FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { calendarDateIn, dateLabel } from "../../../format.ts";
import type { InviteView, MemberView } from "../../../server/members-views.ts";
import { api } from "../../api.ts";
import { BUTTON, ErrorLine, FIELD } from "../../components/Fields.tsx";

// Settings, Members (spec 09, Members; Invites): every Member, "Make an invite link", the open
// invite links with Cancel, and Remove on each Member. The app shows a new link once, for the
// Member to copy and send by hand; it sends no email.

// The requests the page sends, each with a JSON body, even an empty one: the routes take only JSON.
// The routes read their body themselves, so each body goes in through a separate object.
export const makeInviteLink = () => api.invites.$post({ json: {} });
export function cancelInviteLink(id: string) {
  const cancel = { param: { id }, json: {} };
  return api.invites[":id"].cancel.$post(cancel);
}
export function removeMemberWithCode(id: string, code: string) {
  const remove = { param: { id }, json: { code } };
  return api.members[":id"].remove.$post(remove);
}

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : "That did not work.";
}

// "Nov 12", in this browser's time zone.
function dayOf(iso: string): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return dateLabel(calendarDateIn(new Date(iso), zone), calendarDateIn(new Date(), zone));
}

// One Member, with Remove. Remove asks for a fresh code first.
export function MemberLine(props: { member: MemberView; onRemoved: (you: boolean) => void }) {
  const { member } = props;
  const [asking, setAsking] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    removeMemberWithCode(member.id, code.trim())
      .then(async (res) => {
        setCode("");
        if (!res.ok) return setError(await errorOf(res));
        props.onRemoved(member.you);
      })
      .catch(() => setError("The server did not answer."))
      .finally(() => setBusy(false));
  }

  return (
    <li className="mt-3 rounded border border-gray-300 p-3">
      <p>
        <span className="font-medium">{member.name}</span>
        {member.you ? " (you)" : ""}
      </p>
      <p className="text-sm text-gray-600">{member.email}</p>
      {asking ? (
        <form onSubmit={submit}>
          <p className="mt-2">
            {member.you
              ? "Removing yourself signs you out on every device, and cancels the invite links you made. You cannot sign in again."
              : `Removing ${member.name} signs them out on every device at once, and cancels the invite links they made. Their Goals and Chat messages keep their name.`}
          </p>
          <label className="mt-3 block">
            To remove, enter a code from your authenticator app, or a backup code
            <input
              className={FIELD}
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <button className={BUTTON} type="submit" disabled={busy || code.trim() === ""}>
            Remove {member.you ? "me" : member.name}
          </button>
          <ErrorLine error={error} />
        </form>
      ) : (
        <button className={BUTTON} type="button" onClick={() => setAsking(true)}>
          Remove
        </button>
      )}
    </li>
  );
}

// One open invite link, with Cancel.
export function InviteLine(props: { invite: InviteView; onCancelled: () => void }) {
  const { invite } = props;
  const [error, setError] = useState<string | undefined>();

  function cancel() {
    setError(undefined);
    cancelInviteLink(invite.id)
      .then(async (res) => {
        if (!res.ok) return setError(await errorOf(res));
        props.onCancelled();
      })
      .catch(() => setError("The server did not answer."));
  }

  return (
    <li className="mt-3 rounded border border-gray-300 p-3">
      <p>
        Made {dayOf(invite.createdAt)} by {invite.madeBy}. Works until {dayOf(invite.expiresAt)}.
      </p>
      <button className={BUTTON} type="button" onClick={cancel}>
        Cancel
      </button>
      <ErrorLine error={error} />
    </li>
  );
}

// "Make an invite link", and the new link, shown once for the Member to copy.
export function MakeInvite(props: { onMade: () => void }) {
  const [made, setMade] = useState<{ link: string; expiresAt: string } | undefined>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | undefined>();

  function make() {
    setBusy(true);
    setError(undefined);
    setCopied(false);
    makeInviteLink()
      .then(async (res) => {
        if (!res.ok) return setError(await errorOf(res));
        setMade(((await res.json()) as { invite: { link: string; expiresAt: string } }).invite);
        props.onMade();
      })
      .catch(() => setError("The server did not answer."))
      .finally(() => setBusy(false));
  }

  function copy(link: string) {
    navigator.clipboard
      .writeText(link)
      .then(() => setCopied(true))
      .catch(() => setError("The browser did not copy the link. Select it and copy it by hand."));
  }

  return (
    <div className="mt-4">
      <h3 className="font-semibold">Invite a Member</h3>
      <p className="mt-2">
        The app makes a link for you to copy and send by hand. It sends no email. The link works
        once, for 7 days.
      </p>
      <button className={BUTTON} type="button" onClick={make} disabled={busy}>
        Make an invite link
      </button>
      {made === undefined ? null : (
        <div className="mt-3 rounded border border-gray-300 p-3">
          <p>Copy this link now. The app shows it only this once.</p>
          <input className={`${FIELD} font-mono`} readOnly value={made.link} />
          <button className={BUTTON} type="button" onClick={() => copy(made.link)}>
            Copy the link
          </button>
          {copied ? (
            <p className="mt-2 text-green-700" role="status">
              Copied.
            </p>
          ) : null}
          <p className="mt-2">It works until {dayOf(made.expiresAt)}.</p>
        </div>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

export function MembersLists(props: {
  members: MemberView[];
  invites: InviteView[];
  onChange: () => void;
  onRemoved: (you: boolean) => void;
}) {
  return (
    <>
      <ul>
        {props.members.map((member) => (
          <MemberLine key={member.id} member={member} onRemoved={props.onRemoved} />
        ))}
      </ul>
      {props.members.length === 1 ? (
        <p className="mt-2 text-gray-600">The app cannot remove the last Member.</p>
      ) : null}
      <MakeInvite onMade={props.onChange} />
      <h3 className="mt-4 font-semibold">Open invite links</h3>
      {props.invites.length === 0 ? (
        <p className="mt-2">No open invite links.</p>
      ) : (
        <ul>
          {props.invites.map((invite) => (
            <InviteLine key={invite.id} invite={invite} onCancelled={props.onChange} />
          ))}
        </ul>
      )}
    </>
  );
}

export function Members() {
  const navigate = useNavigate();
  const [view, setView] = useState<{ members: MemberView[]; invites: InviteView[] } | undefined>();
  const [error, setError] = useState<string | undefined>();

  function load() {
    api.members
      .$get()
      .then(async (res) => {
        if (res.ok) return setView(await res.json());
        setError("The Members cannot be shown.");
      })
      .catch(() => setError("The server did not answer."));
  }

  useEffect(load, []);

  return (
    <>
      <h2 className="text-xl font-semibold">Members</h2>
      {view === undefined ? null : (
        <MembersLists
          members={view.members}
          invites={view.invites}
          onChange={load}
          onRemoved={(you) => (you ? void navigate("/sign-in", { replace: true }) : load())}
        />
      )}
      <ErrorLine error={error} />
    </>
  );
}
