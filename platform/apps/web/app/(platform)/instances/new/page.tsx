import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { InstanceForm } from "./instance-form";

export default function NewInstancePage() {
  return (
    <>
      <PageHeader title="New Instance" context="Platform" />
      {/* Kept until the operator console has breadcrumbs (doc 28 §4.1), in the
          [id] page's token classes rather than the pre-v2 stock palette. */}
      <Link
        href="/instances"
        className="inline-flex items-center gap-1.5 self-start rounded-sm text-sm font-medium text-text-muted transition-colors duration-150 ease-out hover:text-text"
      >
        <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
        All instances
      </Link>
      <InstanceForm />
    </>
  );
}
