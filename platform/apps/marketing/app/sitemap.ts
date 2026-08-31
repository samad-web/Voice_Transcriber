import type { MetadataRoute } from "next";
import { LEGAL_PAGES } from "@/lib/legal";
import { SITE_URL } from "@/lib/site";

/**
 * Doc 10 §9. Listed by hand rather than generated from the filesystem: a
 * sitemap that silently grows an entry when someone adds a route is a sitemap
 * nobody reviews, and the priority ordering below is a judgement - doc 10 §9
 * says /compatibility carries the highest-intent organic traffic on the site,
 * ahead of the homepage.
 */
const ROUTES: Array<{ path: string; priority: number; changeFrequency: "monthly" | "yearly" }> = [
  { path: "/", priority: 1.0, changeFrequency: "monthly" },
  { path: "/compatibility", priority: 0.9, changeFrequency: "monthly" },
  { path: "/security", priority: 0.8, changeFrequency: "monthly" },
  { path: "/consent", priority: 0.7, changeFrequency: "yearly" },
];

/**
 * The legal pages are appended only once they can actually be served.
 *
 * They 404 until the company facts in lib/legal.ts are filled in, and a sitemap
 * that advertises a 404 is worse than one that omits the page: Search Console
 * reports it as an error against the whole site, and the first thing a
 * compliance-minded visitor does with a "Privacy policy" result is click it.
 */
const legalRoutes = LEGAL_PAGES.filter((p) => p.ready).map((p) => ({
  path: p.href,
  priority: 0.5,
  changeFrequency: "yearly" as const,
}));

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return [...ROUTES, ...legalRoutes].map((r) => ({
    url: `${SITE_URL}${r.path}`,
    lastModified,
    changeFrequency: r.changeFrequency,
    priority: r.priority,
  }));
}
