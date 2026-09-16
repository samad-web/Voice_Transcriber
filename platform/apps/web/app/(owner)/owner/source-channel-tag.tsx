import {
  CircleHelp,
  FileSpreadsheet,
  FileText,
  Mail,
  MessageCircle,
  Phone,
  PenLine,
  Plug,
  Webhook,
} from "lucide-react";
import { sourceChannelInfo, type SourceFamily } from "@/lib/source-channel";

const FAMILY_ICON: Record<SourceFamily, typeof Phone> = {
  phone: Phone,
  whatsapp: MessageCircle,
  form: FileText,
  email: Mail,
  api: Plug,
  webhook: Webhook,
  import: FileSpreadsheet,
  manual: PenLine,
};

/**
 * "Came in via WhatsApp" - the channel a person or lead first arrived on, with
 * the configured source and campaign when the record names them.
 *
 * Neutral on purpose: a source is a category, not a state, and the console's
 * colour rule leaves categories grey (@aura/ui's state.tsx). The icon and the
 * words carry it.
 */
export function SourceChannelTag({
  channel,
  sourceName,
  campaignName,
}: {
  channel: string | null | undefined;
  sourceName?: string | null;
  campaignName?: string | null;
}) {
  const info = sourceChannelInfo(channel);
  const Icon = info ? FAMILY_ICON[info.family] : CircleHelp;
  const detail = [sourceName, campaignName].filter(Boolean).join(" · ");

  return (
    <span
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border-strong bg-surface px-2.5 py-1 text-xs text-text"
      title={info ? info.description : "This record does not say how it first arrived"}
    >
      <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-text-muted" />
      <span className="text-text-muted">Came in via</span>
      <span className="truncate font-medium">{info ? info.label : "unknown source"}</span>
      {detail ? <span className="truncate text-text-muted">· {detail}</span> : null}
    </span>
  );
}
