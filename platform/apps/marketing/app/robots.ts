import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/**
 * Doc 10 §9.
 *
 * `/start` is the funnel entry - a conversion route, not content, with nothing
 * for a crawler to index. `/admin` is a 307 to the console login; indexing it
 * would put a sign-in door in the search results for a product whose organic
 * traffic is people who do not have an account yet.
 *
 * Neither line is a security measure. robots.txt is a request, and it is a
 * public file - anything listed here is listed for everyone to read.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/start", "/admin", "/capture"] }],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
