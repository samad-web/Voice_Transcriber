import { Activity, DollarSign, HardDrive, Phone } from "lucide-react";
import { Card, MonoLabel, StatCard } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { apiGet } from "@/lib/server-api";

interface Overview {
  calls: { total: number; complete: number; failed: number; total_seconds: number };
  devices: { total: number; active: number };
  usage: Record<string, number>;
  byDay: Array<{ day: string; volume: number; complete: number }>;
}

export default async function DashboardPage() {
  const data = await apiGet<Overview>("/v1/analytics/overview");

  if (!data) {
    return (
      <>
        <PageHeader title="Platform Hub" />
        <Card>
          <MonoLabel>API offline</MonoLabel>
          <p className="text-sm text-neutral-600 mt-2 font-sans">
            Start the API with <code>pnpm --filter @aura/api dev</code>.
          </p>
        </Card>
      </>
    );
  }

  const successRate =
    data.calls.total > 0 ? ((data.calls.complete / data.calls.total) * 100).toFixed(1) : "—";
  const minutes = Math.round(data.calls.total_seconds / 60);
  const tokens = (data.usage.llm_tokens_in ?? 0) + (data.usage.llm_tokens_out ?? 0);

  return (
    <>
      <PageHeader title="Platform Hub" />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
        <StatCard
          label="Capture Success"
          value={`${successRate}%`}
          icon={<Activity className="h-5 w-5" />}
          footer={<span>{data.calls.complete}/{data.calls.total} complete</span>}
        />
        <StatCard
          label="Recorded Time"
          value={`${minutes} min`}
          icon={<Phone className="h-5 w-5" />}
          footer={<span>{data.calls.failed} failed</span>}
        />
        <StatCard
          label="Fleet Health"
          value={`${data.devices.active}/${data.devices.total}`}
          icon={<HardDrive className="h-5 w-5" />}
          footer={<span>active devices</span>}
        />
        <StatCard
          label="LLM Tokens"
          value={tokens.toLocaleString()}
          icon={<DollarSign className="h-5 w-5" />}
          footer={<span>metered from day one</span>}
        />
      </div>

      <Card>
        <MonoLabel>Call ingest — last 7 days</MonoLabel>
        {data.byDay.length === 0 ? (
          <p className="text-sm text-neutral-500 mt-3 font-sans">No calls in the window yet.</p>
        ) : (
          <div className="mt-4 flex items-end gap-2 h-40">
            {data.byDay.map((d) => {
              const max = Math.max(...data.byDay.map((x) => x.volume), 1);
              return (
                <div key={d.day} className="flex-1 flex flex-col items-center gap-1.5">
                  <div className="w-full flex flex-col justify-end h-32">
                    <div
                      className="w-full bg-black border-2 border-black"
                      style={{ height: `${(d.volume / max) * 100}%` }}
                    />
                  </div>
                  <span className="text-[9px] font-mono text-neutral-400 font-bold">
                    {new Date(d.day).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </>
  );
}
