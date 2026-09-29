import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { getCoverage } from "@/server/catalog.functions";
import type { MarketCoverage } from "@/lib/coverage";

/**
 * What a visitor sees before they sign in.
 *
 * Carries the Institute of Innovation and Advanced Learning's identity — their
 * name, their line, their navy — because this is IIAL's grant desk rather than
 * a product with their logo pasted on. Everything said about IIAL here comes
 * from iial.ca; everything said about the desk is something the system can be
 * held to.
 *
 * The tone is the product's own. This is a tool whose entire argument is that
 * it tells you what it does not know, so a page full of superlatives would
 * contradict the thing it is selling on the first screen. The coverage figures
 * are read live from the catalog rather than written into the copy, because a
 * number typed into marketing is a number nobody updates.
 */
export function Landing() {
  const fetchCoverage = useServerFn(getCoverage);
  const [data, setData] = useState<{ coverage: MarketCoverage[]; totalGrants: number } | null>(
    null,
  );

  useEffect(() => {
    void (async () => {
      try {
        setData(await fetchCoverage({ data: {} }));
      } catch {
        // The page stands without it. A landing that fails to render because a
        // count could not be fetched is a worse first impression than one that
        // simply does not show the count.
        setData(null);
      }
    })();
  }, [fetchCoverage]);

  const automatic = (data?.coverage ?? []).filter((m) => m.level === "automatic");

  return (
    <main>
      {/* ── The one dark panel, where the identity lives ─────────────────── */}
      <section className="bg-[var(--color-deep)] text-[var(--color-deep-ink)]">
        <div className="mx-auto max-w-3xl px-6 pb-16 pt-14">
          {/* The inverse mark, which is the version drawn for a dark field. */}
          <img
            src="/brand/iial-logo-inverse.png"
            alt="Institute of Innovation and Advanced Learning"
            width={162}
            height={51}
            className="h-11 w-auto"
          />
          <p className="mt-4 text-sm opacity-70">Empowering Innovation, Elevating Expertise</p>

          <h1 className="mt-8 text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl">
            The grant desk for
            <br />
            IIAL and its partners.
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed opacity-80">
            Applied research and professional education are funded one call at a time, and every
            funding database answers with the same forty results and a match score somebody has to
            re-check by hand. This answers two separate questions instead, and shows its work on
            both.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-5">
            <Link
              to="/auth"
              data-testid="landing-cta"
              className="rounded-md bg-[var(--color-deep-ink)] px-5 py-2.5 text-sm font-medium text-[var(--color-deep)]"
            >
              Sign in
            </Link>
            <Link
              to="/catalog"
              className="text-sm font-medium underline underline-offset-4 opacity-85"
            >
              See exactly what we cover
            </Link>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-3xl px-6 pb-24">
        {/* ── The two questions ─────────────────────────────────────────── */}
        <section className="mt-16">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
            Two questions, never merged into one number
          </h2>
          <div className="mt-4 grid gap-px overflow-hidden rounded-md border border-[var(--color-rule)] bg-[var(--color-rule)] sm:grid-cols-2">
            <div className="bg-[var(--color-surface)] p-5">
              <h3 className="font-medium">May this organisation apply?</h3>
              <p className="mt-2 text-sm leading-relaxed text-[var(--color-ink-soft)]">
                Decided by rules, not by a model, so the answer is the same every time the page
                loads. Every rule that ran is stored with its result — including the ones that could
                not be decided, which is a third answer most tools do not have.
              </p>
              <p className="mt-3 text-sm">
                <span className="text-[var(--color-ineligible)]">✗</span> Restricted to US; this
                client operates in Ontario, Canada.
              </p>
            </div>
            <div className="bg-[var(--color-surface)] p-5">
              <h3 className="font-medium">Is it worth an hour?</h3>
              <p className="mt-2 text-sm leading-relaxed text-[var(--color-ink-soft)]">
                Answered in the organisation&rsquo;s own words found in the funder&rsquo;s own text
                — a claim you can check against the call in seconds. When a match came from meaning
                rather than wording, it says so instead of dressing it up as a percentage.
              </p>
              <p className="mt-3 text-sm text-[var(--color-ink-soft)]">
                This funder&rsquo;s own text mentions &ldquo;applied research&rdquo; and
                &ldquo;professional education&rdquo;.
              </p>
            </div>
          </div>
        </section>

        {/* ── Drafting ───────────────────────────────────────────────────── */}
        <section className="mt-16">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
            Drafting that answers the funder, not a template
          </h2>
          <p className="mt-4 max-w-xl leading-relaxed text-[var(--color-ink-soft)]">
            A call is read into its own requirements — their headings, their word limits, the
            criteria they published — and each section is drafted against those. What has already
            been written for that organisation is reused by meaning, so an answer filed as
            &ldquo;track record&rdquo; answers a call asking for &ldquo;organizational
            capacity&rdquo;.
          </p>
          <p className="mt-4 max-w-xl leading-relaxed">
            Where a fact is missing, the draft says so:{" "}
            <code className="rounded bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-sm">
              [NEED: number of participants]
            </code>{" "}
            <span className="text-[var(--color-ink-soft)]">
              — a marked gap takes seconds to fill and an invented figure can never be found.
            </span>
          </p>
        </section>

        {/* ── The honest part, which is the actual differentiator ─────────── */}
        <section className="mt-16 rounded-md border border-[var(--color-rule)] bg-[var(--color-surface)] p-6">
          <h2 className="text-sm font-semibold">What it will not do</h2>
          <ul className="mt-4 flex flex-col gap-3 text-sm leading-relaxed text-[var(--color-ink-soft)]">
            <li>
              <span className="text-[var(--color-ink)]">Give you a match score.</span> A number
              cannot be wrong in a way you can see, so it gets re-verified in full or trusted
              blindly.
            </li>
            <li>
              <span className="text-[var(--color-ink)]">Hide what it ruled out.</span> Ineligible
              results are collapsed, never dropped — a result that silently disappears is
              indistinguishable from one that was never found.
            </li>
            <li>
              <span className="text-[var(--color-ink)]">Claim coverage it does not have.</span> A
              market we do not refresh is listed as a directory, not padded out to look like the
              rest.
            </li>
            <li>
              <span className="text-[var(--color-ink)]">Send anything on its own.</span> The last
              check before a submission is a person confirming they read it, and that check is never
              satisfied automatically.
            </li>
          </ul>
        </section>

        {/* ── Live coverage, read rather than typed ───────────────────────── */}
        {data && data.totalGrants > 0 && (
          <section className="mt-16" data-testid="landing-coverage">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
              In the catalog right now
            </h2>
            <div className="mt-4 flex flex-wrap items-baseline gap-x-10 gap-y-4">
              <div>
                <div className="font-mono text-3xl tabular-nums">
                  {data.totalGrants.toLocaleString()}
                </div>
                <div className="mt-1 text-sm text-[var(--color-ink-soft)]">open calls</div>
              </div>
              <div>
                <div className="font-mono text-3xl tabular-nums">{automatic.length}</div>
                <div className="mt-1 text-sm text-[var(--color-ink-soft)]">
                  {automatic.length === 1 ? "market refreshed" : "markets refreshed"} automatically
                </div>
              </div>
            </div>
            <p className="mt-4 max-w-xl text-sm text-[var(--color-ink-soft)]">
              Read from the catalog as this page loaded, not written into the copy.{" "}
              <Link to="/catalog" className="text-[var(--color-accent)]">
                Every market, with what it really is
              </Link>
              .
            </p>
          </section>
        )}

        <section className="mt-16 border-t border-[var(--color-rule)] pt-8">
          <p className="max-w-xl text-sm leading-relaxed text-[var(--color-ink-soft)]">
            Built for consultants and institutes running work for several organisations at once,
            where one client&rsquo;s material must never appear in another&rsquo;s. That isolation
            is enforced by the database, not by a screen.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-5">
            <Link
              to="/auth"
              className="rounded-md bg-[var(--color-accent-strong)] px-5 py-2.5 text-sm font-medium text-white"
            >
              Sign in
            </Link>
            <span className="text-sm text-[var(--color-ink-soft)]">
              Institute of Innovation and Advanced Learning · Aurora, Ontario
            </span>
          </div>
        </section>
      </div>
    </main>
  );
}
