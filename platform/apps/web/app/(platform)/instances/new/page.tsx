import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { InstanceForm } from "./instance-form";

export default function NewInstancePage() {
  return (
    <>
      <PageHeader title="New Instance" context="Platform" />
      <Link
        href="/instances"
        className="inline-flex items-center gap-1.5 text-[10px] font-mono font-bold uppercase tracking-wider text-neutral-500 hover:text-black"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        All instances
      </Link>
      <InstanceForm />
    </>
  );
}
