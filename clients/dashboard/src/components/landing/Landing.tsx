/** The public front page — what a visitor without a session sees at `/`.
 *
 *  A server component with no client JavaScript: the header's links are anchors into this page plus
 *  the two doors into the app, both of which are `/login` (signing in for the first time is how an
 *  account is made, on the Free plan). Every plan figure comes from the `sheet` the page fetched
 *  from the core; with no sheet, the pricing section says it couldn't load instead of guessing.
 */
import Link from "next/link";
import {
  AudioLines,
  CalendarDays,
  Check,
  Download,
  FileText,
  MessageSquare,
  PlayCircle,
  Radio,
  Search,
  Video,
  type LucideIcon,
} from "lucide-react";
import { PLAN_LABELS, planFeatures, priceLine, type PlanSheet } from "@/lib/plans";

const PLAN_BLURBS: Record<string, string> = {
  free: "Try it on a real meeting.",
  pro: "For people who live in meetings.",
  team: "For teams running several meetings at once.",
};

const FEATURES: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: Video,
    title: "A notetaker in every call",
    body: "Paste a Google Meet, Microsoft Teams or Zoom link and a bot joins the meeting, records it and transcribes it.",
  },
  {
    icon: Radio,
    title: "Live transcript",
    body: "Follow the conversation as it happens, with every line attributed to the person who said it.",
  },
  {
    icon: FileText,
    title: "Summaries and action items",
    body: "When the meeting ends you get a summary, the decisions made and who owes what, with a title and tags.",
  },
  {
    icon: MessageSquare,
    title: "Ask your meetings",
    body: "Chat with one meeting or across all of them: what was decided, who raised it, what's still open.",
  },
  {
    icon: CalendarDays,
    title: "Joins from your calendar",
    body: "Connect Google Calendar, Microsoft 365 or any calendar feed and the bot joins scheduled meetings on its own.",
  },
  {
    icon: PlayCircle,
    title: "Recordings you can replay",
    body: "Listen back to any meeting and click a line of the transcript to jump to that moment.",
  },
  {
    icon: Search,
    title: "Search everything",
    body: "Find any word ever said in any of your meetings, and rename speakers or tag meetings to keep them in order.",
  },
  {
    icon: Download,
    title: "Take it with you",
    body: "Export a transcript as text, Markdown, Word, PDF or subtitles (SRT and VTT).",
  },
];

const STEPS: { title: string; body: string }[] = [
  { title: "Sign in", body: "Use your Google or Microsoft account. No card needed for the Free plan." },
  { title: "Send the bot", body: "Paste a meeting link, or connect your calendar so it joins on its own." },
  { title: "Read and ask", body: "Get the transcript live, then the summary — and ask it anything later." },
];

const BUTTON = "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors";
const PRIMARY = `${BUTTON} bg-accent text-accent-ink hover:opacity-90`;
const SECONDARY = `${BUTTON} border border-line-strong bg-card text-ink hover:bg-raised`;

export interface LandingProps {
  productName: string;
  sheet: PlanSheet | null;
}

export function Landing({ productName, sheet }: LandingProps) {
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="sticky top-0 z-20 border-b border-line bg-canvas/90 backdrop-blur">
        <nav aria-label="Main" className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-accent-ink">
              <AudioLines size={17} aria-hidden />
            </span>
            {productName}
          </Link>
          <ul className="order-3 flex w-full gap-5 text-sm text-ink-2 sm:order-none sm:w-auto">
            <li><a href="#features" className="hover:text-ink">Features</a></li>
            <li><a href="#pricing" className="hover:text-ink">Pricing</a></li>
            <li><a href="#about" className="hover:text-ink">About</a></li>
          </ul>
          <div className="ml-auto flex items-center gap-2">
            <Link href="/login" className={`${BUTTON} text-ink-2 hover:text-ink`}>Log in</Link>
            <Link href="/login" className={PRIMARY}>Try for free</Link>
          </div>
        </nav>
      </header>

      <main>
        <section className="mx-auto max-w-6xl px-4 pb-16 pt-16 text-center sm:px-6 sm:pt-24">
          <p className="mx-auto mb-5 inline-flex rounded-full bg-accent-soft px-3 py-1 text-xs font-medium text-accent">
            Google Meet · Microsoft Teams · Zoom
          </p>
          <h1 className="mx-auto max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">
            Every meeting, written down and ready to act on
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base text-ink-2 sm:text-lg">
            {productName} sends a notetaker into your calls, gives you the transcript live and a summary
            when the meeting ends — so you can listen instead of typing.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link href="/login" className={PRIMARY}>Try for free</Link>
            <a href="#pricing" className={SECONDARY}>See pricing</a>
          </div>
          <p className="mt-3 text-xs text-ink-3">Free plan · no card required</p>
        </section>

        <section id="features" aria-labelledby="features-heading" className="scroll-mt-20 border-t border-line bg-rail">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
            <h2 id="features-heading" className="text-2xl font-semibold tracking-tight sm:text-3xl">What it does</h2>
            <p className="mt-2 max-w-2xl text-ink-2">From the moment the meeting starts to long after it ends.</p>
            <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {FEATURES.map(({ icon: Icon, title, body }) => (
                <li key={title} className="rounded-card border border-line bg-card p-5">
                  <Icon size={20} className="text-accent" aria-hidden />
                  <h3 className="mt-3 text-sm font-semibold">{title}</h3>
                  <p className="mt-1.5 text-sm text-ink-2">{body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section aria-labelledby="how-heading" className="border-t border-line">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
            <h2 id="how-heading" className="text-2xl font-semibold tracking-tight sm:text-3xl">How it works</h2>
            <ol className="mt-10 grid gap-6 sm:grid-cols-3">
              {STEPS.map((step, i) => (
                <li key={step.title} className="flex gap-4">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent">
                    {i + 1}
                  </span>
                  <div>
                    <h3 className="font-semibold">{step.title}</h3>
                    <p className="mt-1 text-sm text-ink-2">{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <Pricing sheet={sheet} />

        <section id="about" aria-labelledby="about-heading" className="scroll-mt-20 border-t border-line">
          <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
            <h2 id="about-heading" className="text-2xl font-semibold tracking-tight sm:text-3xl">About {productName}</h2>
            <div className="mt-4 space-y-4 text-ink-2">
              <p>
                {productName} is a meeting assistant: it joins your calls, writes down what was said and turns it
                into notes you can search, export and ask questions of.
              </p>
              <p>
                {productName === "Vexa" ? "It is" : "It is built on"}{" "}
                <a href="https://github.com/Vexa-ai/vexa" className="text-accent hover:underline" rel="noopener noreferrer">
                  Vexa
                </a>
                , the open-source meeting bot and transcription platform (Apache-2.0). Your meetings stay in this
                service: transcripts, recordings and summaries are yours to export or delete at any time, and
                deleting your account erases all of them.
              </p>
            </div>
          </div>
        </section>

        <section className="border-t border-line bg-rail">
          <div className="mx-auto max-w-6xl px-4 py-16 text-center sm:px-6">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Bring a notetaker to your next meeting</h2>
            <p className="mt-2 text-ink-2">It takes a minute to set up.</p>
            <Link href="/login" className={`${PRIMARY} mt-6`}>Try for free</Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-6 text-sm text-ink-3 sm:px-6">
          <span>© {new Date().getFullYear()} {productName}</span>
          <a href="#features" className="hover:text-ink">Features</a>
          <a href="#pricing" className="hover:text-ink">Pricing</a>
          <a href="#about" className="hover:text-ink">About</a>
          <Link href="/login" className="ml-auto hover:text-ink">Log in</Link>
        </div>
      </footer>
    </div>
  );
}

function Pricing({ sheet }: { sheet: PlanSheet | null }) {
  return (
    <section id="pricing" aria-labelledby="pricing-heading" className="scroll-mt-20 border-t border-line bg-rail">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <h2 id="pricing-heading" className="text-2xl font-semibold tracking-tight sm:text-3xl">Pricing</h2>
        <p className="mt-2 text-ink-2">Start free. Upgrade when your meetings outgrow it.</p>
        {sheet ? (
          <ul className="mt-10 grid gap-4 md:grid-cols-3">
            {sheet.plans.map((plan) => (
              <PlanCard key={plan.plan_id} sheet={sheet} planId={plan.plan_id} features={planFeatures(plan)} />
            ))}
          </ul>
        ) : (
          <div role="status" className="mt-10 rounded-card border border-line bg-card p-6 text-sm text-ink-2">
            The plans couldn&apos;t be loaded just now. Every account starts on the Free plan —{" "}
            <Link href="/login" className="text-accent hover:underline">sign up</Link> to see the paid plans.
          </div>
        )}
      </div>
    </section>
  );
}

function PlanCard({ sheet, planId, features }: { sheet: PlanSheet; planId: string; features: string[] }) {
  const label = PLAN_LABELS[planId] ?? planId;
  const price = priceLine(sheet, planId);
  const highlighted = planId === "pro";
  return (
    <li
      aria-labelledby={`plan-${planId}`}
      className={`flex flex-col rounded-card border bg-card p-6 ${highlighted ? "border-accent" : "border-line"}`}
    >
      <h3 id={`plan-${planId}`} className="text-lg font-semibold">{label}</h3>
      <p className="mt-1 text-sm text-ink-2">{PLAN_BLURBS[planId] ?? ""}</p>
      <div className="mt-5 min-h-14" data-testid={`price-${planId}`}>
        {price.kind === "free" && <p className="text-3xl font-semibold tracking-tight">Free</p>}
        {price.kind === "priced" && (
          <>
            <p className="text-3xl font-semibold tracking-tight">{price.monthly ?? price.yearly}</p>
            {price.monthly && price.yearly && (
              <p className="mt-1 text-xs text-ink-3">
                or {price.yearly}
                {price.yearlySaving ? ` — save ${price.yearlySaving}%` : ""}
              </p>
            )}
          </>
        )}
        {price.kind === "unpriced" && <p className="text-sm text-ink-2">See pricing after sign-up</p>}
      </div>
      <ul className="mt-5 flex-1 space-y-2.5 text-sm">
        {features.map((line) => (
          <li key={line} className="flex gap-2">
            <Check size={16} className="mt-0.5 shrink-0 text-ok" aria-hidden />
            {line}
          </li>
        ))}
      </ul>
      <Link href={planId === "free" ? "/login" : "/login?next=%2Fbilling"} className={`${highlighted ? PRIMARY : SECONDARY} mt-6`}>
        {planId === "free" ? "Try for free" : `Get ${label}`}
      </Link>
    </li>
  );
}
