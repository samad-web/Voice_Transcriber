/** Emits a structured-data block (doc 10 §9).
 *
 *  `dangerouslySetInnerHTML` is the documented way to render JSON-LD in Next.
 *  Every payload passed here is authored in this repository - never user input,
 *  never fetched - so there is no injection surface. */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
