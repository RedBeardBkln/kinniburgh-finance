"use client";

// "Text messages" card on /settings/notifications (twilio-sms-consent): the signed-in person's own US mobile number and an
// explicit, never pre-ticked consent to review-queue texts, plus Stop texts. Plain props only; the two server actions arrive as
// props from the page (a client component must not import server code). The full stored number is never shown, only the last 4.

import { useId, useState, useTransition, type FormEvent } from "react";
import Link from "next/link";
import type { Route } from "next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  SMS_CONSENT_TEXT,
  SMS_CONSENT_VERSION,
  SMS_NOT_SET_UP_TEXT,
  SMS_OPTIONAL_TEXT,
  SMS_PRIVACY_HREF,
  SMS_READ_FAILED_TEXT,
} from "@/lib/sms-consent-text";

export type SmsConsentActionResult =
  | { ok: true; status: "on" | "off"; masked: string | null; message: string }
  | { ok: false; error: string };

export interface SmsConsentCardProps {
  load: "ok" | "table_missing" | "error";
  status: "on" | "off";
  /** "ending 0123"; null when off. */
  masked: string | null;
  /** Date the current consent was given (New York date), formatted by the page. */
  sinceLabel: string | null;
  save: (input: { phone: string; agreed: boolean; wordingVersion: string }) => Promise<SmsConsentActionResult>;
  withdraw: () => Promise<SmsConsentActionResult>;
}

export function SmsConsentCard(props: SmsConsentCardProps) {
  const phoneId = useId();
  const boxId = useId();
  const [status, setStatus] = useState<"on" | "off">(props.status);
  const [masked, setMasked] = useState<string | null>(props.masked);
  const [sinceLabel, setSinceLabel] = useState<string | null>(props.sinceLabel);
  const [phone, setPhone] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  if (props.load === "table_missing") {
    return <p className="text-sm text-muted-foreground">{SMS_NOT_SET_UP_TEXT}</p>;
  }
  if (props.load === "error") {
    return <p className="text-sm text-muted-foreground">{SMS_READ_FAILED_TEXT}</p>;
  }

  const on = status === "on";
  const canSave = phone.trim().length > 0 && agreed && !pending;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSave) return;
    startTransition(async () => {
      const res = await props.save({ phone, agreed, wordingVersion: SMS_CONSENT_VERSION });
      if (res.ok) {
        setStatus(res.status);
        setMasked(res.masked);
        setSinceLabel(null);
        setPhone("");
        setAgreed(false);
        setMessage({ tone: "ok", text: res.message });
      } else {
        setMessage({ tone: "error", text: res.error });
      }
    });
  }

  function stop() {
    startTransition(async () => {
      const res = await props.withdraw();
      if (res.ok) {
        setStatus(res.status);
        setMasked(null);
        setSinceLabel(null);
        setMessage({ tone: "ok", text: res.message });
      } else {
        setMessage({ tone: "error", text: res.error });
      }
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Get a text when transactions are assigned to you for review, and a reminder if they are still waiting.
      </p>

      <p className="text-sm font-medium" data-testid="sms-status">
        {on
          ? `Texts are on for your number ${masked ?? ""}${sinceLabel ? ` (since ${sinceLabel})` : ""}.`
          : "Texts are off."}
      </p>

      <form onSubmit={submit} className="space-y-3">
        <div className="space-y-1">
          <label htmlFor={phoneId} className="text-sm font-medium">
            {on ? "Change number: mobile number (US)" : "Mobile number (US)"}
          </label>
          <Input
            id={phoneId}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="(202) 555-0123"
            maxLength={32}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full sm:max-w-xs"
          />
        </div>

        <div className="flex items-start gap-2">
          <input
            id={boxId}
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="mt-1 h-4 w-4 shrink-0"
          />
          <label htmlFor={boxId} className="text-sm leading-snug">{SMS_CONSENT_TEXT}</label>
        </div>

        <p className="text-sm">
          <Link href={SMS_PRIVACY_HREF as Route} className="underline hover:text-muted-foreground">
            Privacy policy
          </Link>
        </p>

        <p className="text-xs text-muted-foreground">{SMS_OPTIONAL_TEXT}</p>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!canSave}>
            {on ? "Save new number" : "Turn on texts"}
          </Button>
          {on ? (
            <Button type="button" variant="outline" onClick={stop} disabled={pending}>
              Stop texts
            </Button>
          ) : null}
        </div>
      </form>

      {on ? <p className="text-xs text-muted-foreground">You can also reply STOP to any text.</p> : null}

      <p
        aria-live="polite"
        className={message?.tone === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
      >
        {message?.text ?? ""}
      </p>
    </div>
  );
}
