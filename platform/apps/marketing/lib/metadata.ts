import type { Metadata } from "next";
import { BRAND, SITE_URL } from "./site";

/**
 * Per-page metadata. Doc 10 §9 requires a unique title and description plus
 * OpenGraph and Twitter cards on every page, and a canonical.
 *
 * There is no OG image yet - one has to be designed, and a broken `og:image`
 * URL renders worse in a share preview than none at all. Tracked in the run
 * report's followUps.
 */
export function pageMetadata(opts: {
  title: string;
  description: string;
  path: string;
  /**
   * Keep this page out of search results.
   *
   * For the token-gated surfaces - a page that only means anything to somebody
   * holding a private link has nothing to offer a search engine, and indexing
   * one invites strangers onto a screen whose only honest answer to them is
   * "this link has expired".
   */
  noIndex?: boolean;
}): Metadata {
  const url = `${SITE_URL}${opts.path}`;
  const fullTitle = opts.path === "/" ? opts.title : `${opts.title}, ${BRAND}`;

  return {
    title: opts.title,
    description: opts.description,
    alternates: { canonical: url },
    ...(opts.noIndex ? { robots: { index: false, follow: false } } : {}),
    openGraph: {
      type: "website",
      url,
      siteName: BRAND,
      title: fullTitle,
      description: opts.description,
      locale: "en_IN",
    },
    twitter: {
      card: "summary_large_image",
      title: fullTitle,
      description: opts.description,
    },
  };
}
