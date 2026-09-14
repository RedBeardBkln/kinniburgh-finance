// Pure decision logic for the custom PWA "Install app" prompt — client-safe.

export interface ShouldShowInstallBannerOptions {
  /** Whether a `beforeinstallprompt` event has fired and been captured. */
  hasDeferredPrompt: boolean;
  /** Whether the app is already running in an installed (standalone) shell. */
  isStandalone: boolean;
  /** Whether the user previously dismissed the banner (persisted). */
  dismissed: boolean;
}

/**
 * True when the custom install banner should be shown.
 * - Never show inside an already-installed standalone shell, even if a
 *   stray `beforeinstallprompt` event somehow fired.
 * - Never show once the user has dismissed it (permanent dismissal — see
 *   the plan's Risks section for why no time-boxed re-prompt exists).
 * - Otherwise, only show once we actually have a captured deferred prompt
 *   to act on (the common case: the browser never fired the event at all).
 */
export function shouldShowInstallBanner(opts: ShouldShowInstallBannerOptions): boolean {
  return opts.hasDeferredPrompt && !opts.isStandalone && !opts.dismissed;
}
