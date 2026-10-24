import { SITE } from "../../../shared/site";
import { PageShell } from "../Site";

/**
 * Privacy, terms and the 404 page. The legal pages are plain-language drafts with placeholders in square brackets.
 * Edit the placeholders in shared/site.ts, review the wording, and have it checked before you rely on it.
 */

function Draft() {
  return (
    <p class="notice warn" role="note">
      This is a plain-language draft. Replace the parts in square brackets and have the page reviewed before you rely on it. Last updated: {SITE.legalUpdated}.
    </p>
  );
}

export function PrivacyPage() {
  return (
    <PageShell current="/privacy">
      <h1>Privacy</h1>
      <Draft />

      <h2>The short version</h2>
      <ul>
        <li>There are no accounts, no ads and no tracking across other sites.</li>
        <li>Votes are private. Participants only see their own choices.</li>
        <li>A poll is deleted 90 days after it was last used. Organizers can delete one sooner.</li>
      </ul>

      <h2>What Ority stores</h2>
      <p>
        For each poll: its title, description, options, settings and results. For each participant: the name they typed and their votes. For the
        organizer: a one-way scrambled copy of the organizer link's secret key, so Ority can check it without being able to read it back.
      </p>
      <p>Ority does not ask for or store email addresses, passwords or payment details.</p>

      <h2>What stays in your browser</h2>
      <p>
        Ority saves a few things in your browser, on your device only: the organizer links for polls you created, the polls you joined, a private
        token that lets you vote again from the same browser, and a note that you have seen a tour. This is browser storage, not tracking cookies.
      </p>

      <h2>Who can see what</h2>
      <ul>
        <li>Participants see the options and their own votes. After an open poll closes they see anonymous totals only if the organizer chose to share them.</li>
        <li>The organizer sees only headcounts while voting is open, and the results once the poll closes. They see who voted for what only if they chose named results.</li>
        <li>The people who run Ority can technically reach stored data to keep the service working. [Describe your own access policy here.]</li>
      </ul>

      <h2>Network addresses</h2>
      <p>
        To stop one person creating a flood of polls, Ority briefly uses your network (IP) address to count how many polls come from it each hour.
        It is held in memory and is not saved with your poll. [The company that hosts Ority may keep ordinary server logs. Describe them here.]
      </p>

      <h2>How long things are kept</h2>
      <p>
        A poll and everything in it is deleted automatically 90 days after it was last used. Organizers can delete a poll sooner from the Run the poll
        screen. While Ority is in early use, a poll can also be lost if the service restarts, so download your results when a poll closes.
      </p>

      <h2>Where Ority is hosted</h2>
      <p>[Name of the hosting provider and the region where data is stored.]</p>

      <h2>Your choices</h2>
      <p>You can delete your poll from its organizer page. To ask for something to be removed, contact {SITE.contactEmail}.</p>

      <h2>Changes to this page</h2>
      <p>If this page changes, the date at the top will change too.</p>

      <h2>Contact</h2>
      <p>{SITE.organization}, {SITE.contactEmail}</p>
    </PageShell>
  );
}

export function TermsPage() {
  return (
    <PageShell current="/terms">
      <h1>Terms of use</h1>
      <Draft />

      <h2>Using Ority</h2>
      <p>Ority lets you create polls and collect votes. You may use it for lawful purposes. By using Ority you agree to these terms.</p>

      <h2>Your polls and content</h2>
      <p>
        You are responsible for what you put in a poll, such as titles, descriptions and options, and for having the right to share it. Do not include
        anything unlawful or harmful, or private details about other people. Do not use Ority to collect sensitive personal information.
      </p>

      <h2>Fair use</h2>
      <p>
        Do not try to break, overload or get around the limits on Ority, including the limit on how many polls you can create in an hour. Do not use it
        to send spam.
      </p>

      <h2>Names and votes</h2>
      <p>Participants choose their own names. Organizers should tell their group how the results will be used.</p>

      <h2>Availability and lost data</h2>
      <p>
        We aim to keep Ority running, but we cannot promise it will always be available or that a poll will never be lost. Download your results if
        they matter.
      </p>

      <h2>No warranty</h2>
      <p>
        Ority is provided as it is, with no promises about the results it produces or that it suits a particular purpose. As far as the law allows,
        {" "}{SITE.organization} is not responsible for losses from using it. [Have this section reviewed for your situation.]
      </p>

      <h2>Changes to these terms</h2>
      <p>If these terms change, the date at the top will change too. Using Ority after a change means you accept it.</p>

      <h2>Contact</h2>
      <p>{SITE.organization}, {SITE.contactEmail}</p>
    </PageShell>
  );
}

export function NotFoundPage() {
  return (
    <PageShell>
      <section class="not-found" aria-labelledby="h-404">
        <p class="not-found-code" aria-hidden="true">404</p>
        <h1 id="h-404">We could not find that page</h1>
        <p class="lead">The link may be old or mistyped. If you were sent a poll link, ask the person who sent it to share it again.</p>
        <p class="hero-actions">
          <a class="button-link primary big" href="/create">Create a poll</a>
          <a class="button-link secondary big" href="/">Back to the start</a>
        </p>
        <p><a href="/templates">Browse templates</a> or <a href="/faq">read the FAQ</a>.</p>
      </section>
    </PageShell>
  );
}
