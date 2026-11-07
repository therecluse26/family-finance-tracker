import { type FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { calendarDateIn, dateLabel } from "../../../format.ts";
import type { InviteView, MemberView } from "../../../server/members-views.ts";
import { api } from "../../api.ts";
import { Button } from "../../components/Button.tsx";
import { ErrorLine } from "../../components/Fields.tsx";
import { StatusText } from "../../components/Status.tsx";
import { BOX, BUTTONS, HINT, Lead, ROW, SettingCard, TabHeading } from "./settings-ui.tsx";

// Settings, Members (spec 09, Members; Invites; Login reset): every Member, "Make an invite link",
// the open invite links with Cancel, Remove on each Member, and "Reset login" on every other
// Member. The app shows a new link once, for the Member to copy and send by hand; it sends no
// email.

// The requests the page sends, each with a JSON body, even an empty one: the routes take only JSON.
// The routes read their body themselves, so each body goes in through a separate object.
export function makeInviteLink() {
  const make = { json: {} };
  return api.invites.$post(make);
}
export function cancelInviteLink(id: string) {
  const cancel = { param: { id }, json: {} };
  return api.invites[":id"].cancel.$post(cancel);
}
export function removeMember(id: string) {
  const remove = { param: { id }, json: {} };
  return api.members[":id"].remove.$post(remove);
}
export function resetMemberLogin(id: string) {
  const reset = { param: { id }, json: {} };
  return api.members[":id"]["reset-login"].$post(reset);
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

// The line under a Household's one Member, which says why its Remove is off. The server refuses
// that request too.
const LAST_MEMBER_NOTE = "last-member-note";

// One Member, with Remove, and with Reset login unless it is the Member signed in. Each asks the
// Member to confirm first. The Household's last Member cannot be removed, so its Remove is off,
// with the reason in the line under the list.
export function MemberLine(props: {
  member: MemberView;
  last?: boolean;
  onRemoved: (you: boolean) => void;
}) {
  const { member } = props;
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    removeMember(member.id)
      .then(async (res) => {
        if (!res.ok) return setError(await errorOf(res));
        props.onRemoved(member.you);
      })
      .catch(() => setError("The server did not answer."))
      .finally(() => setBusy(false));
  }

  return (
    <li className={ROW}>
      <div className="min-w-0 flex-[1_1_220px]">
        <p>
          <span className="font-semibold">{member.name}</span>
          {member.you ? " (you)" : ""}
        </p>
        <p className="mt-0.5 text-small break-words text-muted">{member.email}</p>
      </div>
      {asking ? (
        <form className="w-full" onSubmit={submit}>
          <p>
            {member.you
              ? "Removing yourself signs you out on every device, and cancels the invite links you made. You cannot sign in again."
              : `Removing ${member.name} signs them out on every device at once, and cancels the invite links they made. Their Goals and Chat messages keep their name.`}
          </p>
          <div className={BUTTONS}>
            <Button type="submit" disabled={busy}>
              Remove {member.you ? "me" : member.name}
            </Button>
          </div>
          <ErrorLine error={error} />
        </form>
      ) : (
        <Button
          type="button"
          variant="outlined"
          size="small"
          disabled={props.last === true}
          aria-describedby={props.last === true ? LAST_MEMBER_NOTE : undefined}
          onClick={() => setAsking(true)}
        >
          Remove
        </Button>
      )}
      {member.you ? null : <ResetLogin member={member} />}
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
    <li className={ROW}>
      <p className="min-w-0 flex-[1_1_220px]">
        Made {dayOf(invite.createdAt)} by {invite.madeBy}. Works until {dayOf(invite.expiresAt)}.
      </p>
      <Button type="button" variant="outlined" size="small" onClick={cancel}>
        Cancel
      </Button>
      <div className="w-full empty:hidden">
        <ErrorLine error={error} />
      </div>
    </li>
  );
}

// A new invite or reset link, shown once for the Member to copy.
export function LinkToCopy(props: { made: { link: string; expiresAt: string } }) {
  const { made } = props;
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | undefined>();

  function copy() {
    setError(undefined);
    navigator.clipboard
      .writeText(made.link)
      .then(() => setCopied(true))
      .catch(() => setError("The browser did not copy the link. Select it and copy it by hand."));
  }

  return (
    <div className="mt-3 w-full rounded-control border border-line bg-page p-3.5">
      <p className="font-semibold">Copy this link now. The app shows it only this once.</p>
      <input className={`${BOX} font-mono text-sm`} readOnly value={made.link} />
      <div className={BUTTONS}>
        <Button type="button" onClick={copy}>
          Copy the link
        </Button>
        {copied ? (
          <p className="text-small" role="status">
            <StatusText tone="good">Copied.</StatusText>
          </p>
        ) : null}
      </div>
      <p className={HINT}>It works until {dayOf(made.expiresAt)}.</p>
      <ErrorLine error={error} />
    </div>
  );
}

// "Reset login" on another Member. It asks the Member to confirm, then shows the reset link once,
// for the Member to hand over.
export function ResetLogin(props: { member: MemberView }) {
  const { member } = props;
  const [asking, setAsking] = useState(false);
  const [made, setMade] = useState<{ link: string; expiresAt: string } | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    resetMemberLogin(member.id)
      .then(async (res) => {
        if (!res.ok) return setError(await errorOf(res));
        setMade(((await res.json()) as { reset: { link: string; expiresAt: string } }).reset);
        setAsking(false);
      })
      .catch(() => setError("The server did not answer."))
      .finally(() => setBusy(false));
  }

  if (made !== undefined) {
    return (
      <>
        <p className="w-full">
          {member.name} is signed out on every device. Their old password, TOTP, and backup codes no
          longer work. Give them this reset link to set a new login. It works once.
        </p>
        <LinkToCopy made={made} />
      </>
    );
  }

  if (!asking) {
    return (
      <Button type="button" variant="outlined" size="small" onClick={() => setAsking(true)}>
        Reset login
      </Button>
    );
  }

  return (
    <form className="w-full" onSubmit={submit}>
      <p>
        Resetting {member.name}'s login signs them out on every device at once, and their password,
        TOTP, and backup codes stop working. The app makes a reset link for you to hand to them. It
        works once, for 24 hours.
      </p>
      <div className={BUTTONS}>
        <Button type="submit" disabled={busy}>
          Reset {member.name}'s login
        </Button>
      </div>
      <ErrorLine error={error} />
    </form>
  );
}

// "Make an invite link", and the new link, shown once for the Member to copy.
export function MakeInvite(props: { onMade: () => void }) {
  const [made, setMade] = useState<{ link: string; expiresAt: string } | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    makeInviteLink()
      .then(async (res) => {
        if (!res.ok) return setError(await errorOf(res));
        setMade(((await res.json()) as { invite: { link: string; expiresAt: string } }).invite);
        props.onMade();
      })
      .catch(() => setError("The server did not answer."))
      .finally(() => setBusy(false));
  }

  return (
    <SettingCard id="invite-a-member" title="Invite a Member">
      <Lead>
        The app makes a link for you to copy and send by hand. It sends no email. The link works
        once, for 7 days.
      </Lead>
      <form className={BUTTONS} onSubmit={submit}>
        <Button type="submit" variant="outlined" disabled={busy}>
          Make an invite link
        </Button>
      </form>
      {made === undefined ? null : <LinkToCopy key={made.link} made={made} />}
      <ErrorLine error={error} />
    </SettingCard>
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
      <SettingCard id="members" title="Members">
        <ul className="mt-2.5">
          {props.members.map((member) => (
            <MemberLine
              key={member.id}
              member={member}
              last={props.members.length === 1}
              onRemoved={props.onRemoved}
            />
          ))}
        </ul>
        {props.members.length === 1 ? (
          <p id={LAST_MEMBER_NOTE} className={HINT}>
            The app cannot remove the last Member.
          </p>
        ) : null}
      </SettingCard>
      <MakeInvite onMade={props.onChange} />
      <SettingCard id="open-invite-links" title="Open invite links">
        {props.invites.length === 0 ? (
          <p className="mt-1.5 text-muted">No open invite links.</p>
        ) : (
          <ul className="mt-2.5">
            {props.invites.map((invite) => (
              <InviteLine key={invite.id} invite={invite} onCancelled={props.onChange} />
            ))}
          </ul>
        )}
      </SettingCard>
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
      <TabHeading>Members</TabHeading>
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
