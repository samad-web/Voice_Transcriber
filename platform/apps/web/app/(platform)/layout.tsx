import { Sidebar } from "@/components/sidebar";

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col md:flex-row">
      <Sidebar />
      <main className="flex-1 flex flex-col min-h-0 overflow-y-auto p-5 md:p-8 space-y-6">
        {children}
      </main>
    </div>
  );
}
