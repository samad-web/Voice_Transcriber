export function ProgressBar({
  percent,
  tone = "solid",
  className = "",
}: {
  percent: number;
  tone?: "solid" | "danger";
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div
      className={`w-full bg-neutral-200 h-2.5 rounded-none border border-black overflow-hidden ${className}`}
    >
      <div
        className={`h-full rounded-none transition-all duration-300 ${
          tone === "danger" ? "bg-red-600" : "bg-black"
        }`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
