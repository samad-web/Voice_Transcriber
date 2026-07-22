export function PageHeader({ title, context }: { title: string; context?: string }) {
  return (
    <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 border-b-2 border-neutral-200 pb-5">
      <div>
        <div className="text-[10px] font-mono text-neutral-400 uppercase tracking-[0.25em] font-bold flex items-center gap-1.5">
          <span>{context ?? "Workspace"}</span>
          <span className="w-1.5 h-1.5 bg-black rounded-full animate-ping" />
        </div>
        <h2 className="text-3xl sm:text-5xl font-display font-black text-black mt-2 leading-none uppercase tracking-tighter">
          {title}
        </h2>
      </div>
    </div>
  );
}
