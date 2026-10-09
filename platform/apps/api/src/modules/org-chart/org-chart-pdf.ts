import PDFDocument from "pdfkit";
import {
  type LineLike,
  type PositionStatus,
  childMapOf,
  initialsOf,
  layoutTree,
  parentMapAsOf,
  subtreeOf,
} from "@aura/shared";

/**
 * §5.2's PDF export of the chart, or of one branch.
 *
 * ── WHY THIS CALLS THE SAME LAYOUT FUNCTION THE BROWSER DOES ───────────────
 *
 * §5.2 asks for an export "of the current view". Two layout implementations
 * would produce two charts from one dataset and no way to say which was
 * wrong - so `layoutTree` lives in `@aura/shared`, has no DOM dependency, and
 * both callers hand it the same node size. That is the single reason the
 * layout maths is not inside a React component.
 *
 * ── TOKENS DO NOT REACH HERE, AND THAT IS THE ONE DEVIATION ────────────────
 *
 * §3's rule is that nothing is a colour literal. A PDF has no stylesheet and
 * no `prefers-color-scheme`, so the greys below ARE literals - there is no
 * mechanism for them to be anything else.
 *
 * They are deliberately a monochrome print palette rather than a copy of the
 * console's accent colours: a chart printed on an office laser printer in
 * black and white is the actual use (§5.2 also asks for "print-friendly"), and
 * a token-faithful blue becomes an indistinct grey on exactly that printer.
 * Status is carried by a WORD ("Vacant", "Frozen") and not by colour, which
 * §3.4's "colour is never the only signal" asks for anyway. Recorded in
 * ORG_CHART_DECISIONS.md §3.
 */

/** Print geometry, in PDF points. Chosen so a four-level chart fits A3 landscape. */
const NODE_WIDTH = 150;
const NODE_HEIGHT = 58;
const GAP_X = 18;
const GAP_Y = 34;
const MARGIN = 36;
const HEADER = 54;

const INK = "#171717";
const MUTED = "#6b6b6b";
const HAIRLINE = "#b4b4b4";
const PANEL = "#f4f4f4";

export interface PdfPosition {
  id: string;
  title: string;
  sortOrder: number;
  subtitle: string | null;
  holderName: string | null;
  status: PositionStatus;
}

export interface RenderOrgChartPdfInput {
  orgName: string;
  asOf: string;
  isHistorical: boolean;
  orientation: "vertical" | "horizontal";
  rootPositionId: string | null;
  positions: PdfPosition[];
  lines: readonly LineLike[];
}

export async function renderOrgChartPdf(
  input: RenderOrgChartPdfInput,
): Promise<{ buffer: Buffer; filename: string }> {
  const parents = parentMapAsOf(input.lines, input.asOf);
  const allChildren = childMapOf(input.positions, parents);

  /**
   * §5.2's "selected branch". Narrowing the NODE LIST and letting `rootsOf`
   * re-derive the root is what makes this work without a special case: a
   * position whose manager is not in the set becomes a root (see `rootsOf`),
   * so the branch draws as its own chart.
   */
  const keep = input.rootPositionId
    ? new Set(subtreeOf(allChildren, input.rootPositionId))
    : null;
  const positions = keep ? input.positions.filter((p) => keep.has(p.id)) : input.positions;
  const children = keep ? childMapOf(positions, parents) : allChildren;

  const layout = layoutTree(positions, parents, children, new Map(), {
    nodeWidth: NODE_WIDTH,
    nodeHeight: NODE_HEIGHT,
    gapX: GAP_X,
    gapY: GAP_Y,
    orientation: input.orientation,
  });

  const byId = new Map(positions.map((p) => [p.id, p]));
  const placed = new Map(layout.nodes.map((n) => [n.id, n]));

  /**
   * ONE page, sized to the chart, rather than a fixed page the chart is
   * scaled onto.
   *
   * An org chart is not page-shaped: a wide flat company and a deep narrow one
   * want completely different paper. Scaling either onto A4 makes the text too
   * small to read, which for a chart whose whole content is names and titles
   * means the export is useless. A custom page size prints to whatever paper
   * is loaded via the print dialog's own fit-to-page, which is the one place
   * that decision belongs.
   *
   * `Math.max` with a minimum so an EMPTY chart still produces a valid page
   * rather than a zero-width one, which some readers refuse to open.
   */
  const width = Math.max(layout.width, 320) + MARGIN * 2;
  const height = Math.max(layout.height, 120) + MARGIN * 2 + HEADER;

  const doc = new PDFDocument({
    size: [width, height],
    margin: 0,
    info: {
      Title: `${input.orgName} - organization chart`,
      Subject: `As of ${input.asOf}`,
      Creator: "Aura",
    },
  });

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve) => doc.on("end", () => resolve()));

  // ── Header ───────────────────────────────────────────────────────────────
  doc.fillColor(INK).fontSize(16).text(input.orgName, MARGIN, MARGIN - 10, { width: width - MARGIN * 2 });
  doc
    .fillColor(MUTED)
    .fontSize(9)
    .text(
      input.isHistorical
        ? `Organization chart as it stood on ${input.asOf}`
        : `Organization chart - ${input.asOf}`,
      MARGIN,
      MARGIN + 12,
    );

  const originY = MARGIN + HEADER;

  // ── Connectors, under the nodes ──────────────────────────────────────────
  //
  // Drawn first so a node's filled box covers the line arriving at it, which
  // is what makes the right-angle joins look clean rather than crossed.
  for (const edge of layout.edges) {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (!from || !to) continue;

    doc.save().lineWidth(edge.type === "dotted" ? 0.75 : 1).strokeColor(HAIRLINE);
    if (edge.type === "dotted") doc.dash(3, { space: 3 });

    if (input.orientation === "vertical") {
      // §3's bus line: down out of the parent, across, down into the child.
      const startX = from.x + NODE_WIDTH / 2;
      const startY = from.y + NODE_HEIGHT + originY;
      const endX = to.x + NODE_WIDTH / 2;
      const endY = to.y + originY;
      const busY = startY + GAP_Y / 2;
      doc.moveTo(startX, startY).lineTo(startX, busY).lineTo(endX, busY).lineTo(endX, endY).stroke();
    } else {
      const startX = from.x + NODE_WIDTH;
      const startY = from.y + NODE_HEIGHT / 2 + originY;
      const endX = to.x;
      const endY = to.y + NODE_HEIGHT / 2 + originY;
      const busX = startX + GAP_X / 2;
      doc.moveTo(startX, startY).lineTo(busX, startY).lineTo(busX, endY).lineTo(endX, endY).stroke();
    }
    doc.undash().restore();
  }

  // ── Nodes ────────────────────────────────────────────────────────────────
  for (const node of layout.nodes) {
    const position = byId.get(node.id);
    if (!position) continue;
    const x = node.x;
    const y = node.y + originY;
    const vacant = position.status === "vacant";

    doc.save();
    doc.roundedRect(x, y, NODE_WIDTH, NODE_HEIGHT, 5);
    // A vacant seat is a DASHED outline with no fill (§3), which survives a
    // black-and-white print where a tint would not.
    if (vacant) doc.dash(2, { space: 2 }).lineWidth(1).strokeColor(HAIRLINE).stroke().undash();
    else doc.fillAndStroke(PANEL, HAIRLINE);
    doc.restore();

    // The initials disc - §3's avatar, with §14's initials fallback. No photo:
    // fetching and embedding 500 avatars would dominate both the response time
    // and the file size, and a printed chart identifies people by name.
    const discX = x + 10;
    const discY = y + 10;
    doc.save().circle(discX + 10, discY + 10, 10).fillAndStroke("#ffffff", HAIRLINE).restore();
    doc
      .fillColor(MUTED)
      .fontSize(7)
      .text(position.holderName ? initialsOf(position.holderName) : "--", discX, discY + 6.5, {
        width: 20,
        align: "center",
      });

    const textX = x + 36;
    const textWidth = NODE_WIDTH - 44;
    doc
      .fillColor(INK)
      .fontSize(8.5)
      .text(position.holderName ?? "Vacant", textX, y + 9, {
        width: textWidth,
        height: 11,
        ellipsis: true,
        lineBreak: false,
      });
    doc
      .fillColor(INK)
      .fontSize(7.5)
      .text(position.title, textX, y + 21, {
        width: textWidth,
        height: 10,
        ellipsis: true,
        lineBreak: false,
      });

    // Status as a WORD, never colour alone (§3.4, and the laser-printer note
    // in this file's header).
    const note = [
      position.subtitle,
      position.status === "frozen" ? "Frozen" : null,
      node.childCount > 0 ? `${node.childCount} report${node.childCount === 1 ? "" : "s"}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    if (note) {
      doc
        .fillColor(MUTED)
        .fontSize(6.5)
        .text(note, textX, y + 33, { width: textWidth, height: 9, ellipsis: true, lineBreak: false });
    }
  }

  doc.end();
  await done;

  const filename = `org-chart-${input.asOf}${input.rootPositionId ? "-branch" : ""}.pdf`;
  return { buffer: Buffer.concat(chunks), filename };
}
