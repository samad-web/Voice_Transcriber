"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Maximize, Minimize, RefreshCw } from "lucide-react";
import { Button, Select } from "@aura/ui";
import { paletteById, type Palette, type ReportDoc } from "@aura/shared";
import { CanvasGrid, type GridItem } from "@/app/(owner)/owner/reports/builder/canvas-grid";
import { ChartSurface, type WidgetResult } from "@/app/(owner)/owner/reports/builder/chart-surface";
import { renderReportAction } from "@/app/(owner)/owner/reports/builder/actions";
import { LocalTime } from "@/components/local-time";
import { useFullscreen } from "@/lib/use-fullscreen";

const REFRESH_CHOICES = [
  { label: "Every 30s", ms: 30_000 },
  { label: "Every 1m", ms: 60_000 },
  { label: "Every 5m", ms: 300_000 },
];

/** How long the pointer can sit idle in fullscreen before the top bar hides. */
const IDLE_HIDE_MS = 4000;

interface LiveDashboardProps {
  reportId: string;
  token?: string;
  name: string;
  initialDoc: ReportDoc;
  customPalettes: Palette[];
}

/**
 * The live, chrome-free canvas.
 *
 * Reuses `CanvasGrid`/`ChartSurface` in `frozen` mode - the same components
 * the editor and print already use - so a widget looks identical here to how
 * it was authored, at whatever width the actual screen happens to be:
 * `CanvasGrid` already sizes its 12 columns from its measured container
 * width, so it fills a large display without any extra scale hack.
 */
export function LiveDashboard({
  reportId,
  token,
  name,
  initialDoc,
  customPalettes,
}: LiveDashboardProps) {
  const [doc, setDoc] = useState(initialDoc);
  const [widgets, setWidgets] = useState<Record<string, WidgetResult>>({});
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [intervalMs, setIntervalMs] = useState(REFRESH_CHOICES[1].ms);
  const [barVisible, setBarVisible] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { isFullscreen, supported: fullscreenSupported, toggle: toggleFullscreen } =
    useFullscreen(containerRef);

  const refresh = useCallback(async () => {
    const result = await renderReportAction(reportId, token);
    if (result.data) {
      setDoc(result.data.snapshot.doc);
      setWidgets(result.data.snapshot.widgets as Record<string, WidgetResult>);
      setGeneratedAt(result.data.snapshot.generatedAt);
      setError(null);
    } else if (result.error) {
      setError(result.error);
    }
  }, [reportId, token]);

  // Fires immediately (so the first paint doesn't sit on "Loading" for a
  // whole interval) and then on the chosen cadence.
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), intervalMs);
    return () => clearInterval(id);
  }, [refresh, intervalMs]);

  // Auto-hides the top bar once fullscreen and the pointer has gone idle -
  // the usual kiosk-display convention, so nothing but the report is on
  // screen for the office TV this is meant for.
  useEffect(() => {
    if (!isFullscreen) {
      setBarVisible(true);
      return;
    }
    const show = () => {
      setBarVisible(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setBarVisible(false), IDLE_HIDE_MS);
    };
    show();
    window.addEventListener("pointermove", show);
    return () => {
      window.removeEventListener("pointermove", show);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [isFullscreen]);

  const page = doc.pages[Math.min(pageIndex, doc.pages.length - 1)];
  const palette = paletteById(doc.theme.paletteId, customPalettes);
  const gridItems: GridItem[] = page.widgets.map((w) => ({ id: w.id, layout: w.layout }));

  return (
    <div ref={containerRef} className="flex min-h-dvh flex-col bg-bg">
      <div
        className={`flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface px-4 py-2.5 transition-opacity duration-300 ${
          isFullscreen && !barVisible ? "pointer-events-none opacity-0" : "opacity-100"
        }`}
      >
        <div className="flex flex-wrap items-baseline gap-3">
          <span className="text-sm font-semibold text-text">{name}</span>
          {generatedAt ? (
            <span className="text-xs text-text-muted">
              updated <LocalTime iso={generatedAt} mode="time" />
            </span>
          ) : (
            <span className="text-xs text-text-muted">loading…</span>
          )}
          {error ? <span className="text-xs text-danger-text">{error}</span> : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {doc.pages.length > 1 ? (
            <div className="flex gap-1">
              {doc.pages.map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPageIndex(i)}
                  aria-current={i === pageIndex ? "true" : undefined}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                    i === pageIndex
                      ? "bg-accent text-white"
                      : "text-text-muted hover:bg-surface-hover hover:text-text"
                  }`}
                >
                  {p.name}
                </button>
              ))}
            </div>
          ) : null}

          <Select
            aria-label="Refresh interval"
            value={intervalMs}
            onChange={(e) => setIntervalMs(Number(e.target.value))}
            className="h-8 text-xs"
          >
            {REFRESH_CHOICES.map((choice) => (
              <option key={choice.ms} value={choice.ms}>
                {choice.label}
              </option>
            ))}
          </Select>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void refresh()}
            aria-label="Refresh now"
          >
            <RefreshCw className="size-4" />
          </Button>

          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={toggleFullscreen}
            disabled={!fullscreenSupported}
            title={fullscreenSupported ? undefined : "Fullscreen isn't available in this browser"}
          >
            {isFullscreen ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
            {isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          </Button>

          <Link
            href={`/owner/reports/builder/${reportId}`}
            className="text-xs text-text-muted hover:text-text hover:underline"
          >
            Edit report
          </Link>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {gridItems.length === 0 ? (
          <p className="py-16 text-center text-sm text-text-muted">This page has no widgets yet.</p>
        ) : (
          <CanvasGrid items={gridItems} frozen onChange={() => {}}>
            {(item) => {
              const widget = page.widgets.find((w) => w.id === item.id);
              if (!widget) return null;
              return (
                <div className="flex h-full flex-col p-3">
                  {widget.title ? (
                    <p className="mb-1 text-xs font-semibold text-text">{widget.title}</p>
                  ) : null}
                  {widget.subtitle ? (
                    <p className="mb-1 text-[11px] text-text-muted">{widget.subtitle}</p>
                  ) : null}
                  <div className="min-h-0 flex-1">
                    <ChartSurface
                      widget={widget}
                      result={widgets[widget.id]}
                      palette={palette}
                      preset={doc.theme.preset}
                      frozen
                    />
                  </div>
                </div>
              );
            }}
          </CanvasGrid>
        )}
      </div>
    </div>
  );
}
