/**
 * Facts about the site that appear in more than one place. Edit the placeholders in square brackets before you
 * publish the privacy and terms pages.
 */
export const SITE = {
  name: "Ority",
  tagline: "Get a group to agree on what matters most.",
  /** Where the site lives today. Set SITE_URL when you build to use your own address (see the README, Hosting). */
  defaultUrl: "https://ority.onrender.com",
  /** Shown on the privacy and terms pages. Replace these. */
  organization: "[Your organization]",
  contactEmail: "[contact email]",
  legalUpdated: "[date]",
} as const;

/** The site address with no trailing slash. `fromEnv` is the SITE_URL given at build time, if any. */
export const siteUrl = (fromEnv?: string): string => (fromEnv && /^https?:\/\//.test(fromEnv) ? fromEnv : SITE.defaultUrl).replace(/\/+$/, "");
