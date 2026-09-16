/*
 * @aura/ui - design system v2.
 *
 * Tokens live in ./theme.css and are imported by the consuming app's
 * globals.css (`@import "@aura/ui/theme.css";`). Nothing here defines a colour.
 *
 * Every export that existed in v1 is still exported, with the same name and the
 * same props - the console runs on these in production and slice 2 has not
 * migrated it yet.
 */

// ── Brand ──────────────────────────────────────────────────────────────────
export { Logo, Wordmark } from "./logo";

// ── v1 surface, restyled onto v2 tokens (props unchanged) ────────────────────
export { Card } from "./card";
export type { CardProps } from "./card";
export { BrutalButton } from "./brutal-button";
export { StatusChip } from "./status-chip";
export { MonoLabel } from "./mono-label";
export { StatCard } from "./stat-card";
export type { StatCardProps, StatFormat } from "./stat-card";
export { ConsolePanel } from "./console-panel";
export { ProgressBar } from "./progress-bar";

// ── v2 primitives ────────────────────────────────────────────────────────────
export { Button } from "./button";
export type { ButtonProps, ButtonSize, ButtonVariant } from "./button";
export { Input } from "./input";
export type { InputProps } from "./input";
export { Select } from "./select";
export type { SelectProps } from "./select";
export { Checkbox } from "./checkbox";
export type { CheckboxProps } from "./checkbox";
export { Radio, RadioGroup } from "./radio";
export type { RadioProps } from "./radio";
export { Label } from "./label";
export type { LabelProps } from "./label";
export { FormField } from "./form-field";
export type { FormFieldProps } from "./form-field";
export { Skeleton, SkeletonText } from "./skeleton";
export { EmptyState } from "./empty-state";
export {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "./table";
export { Dialog } from "./dialog";
export type { DialogProps } from "./dialog";
export { ConfirmProvider, useConfirm, CONFIRM_WORD, typedWordFor } from "./confirm";
export type { ConfirmOptions } from "./confirm";
export { DropZone } from "./drop-zone";
export type { DropZoneProps } from "./drop-zone";

// ── the functional colour system (state.tsx is the contract) ────────────────
export {
  CONSOLE_STATES,
  STATE_TONE,
  callState,
  callStateLabel,
  pipelineStage,
} from "./state";
export type { CallLike, ConsoleState, PipelinePhase, PipelineStage, StateTone } from "./state";
export { StateChip, StateRule } from "./state-chip";
export type { StateChipProps } from "./state-chip";
export { RowHint, SyncingHint } from "./row-hint";
export { ErrorBanner } from "./error-banner";
export type { RowHintKind, RowHintProps } from "./row-hint";
export { FeedbackProvider, useAlert, useToast } from "./feedback";
export type { AlertOptions, ToastOptions } from "./feedback";
export { Tooltip } from "./tooltip";
export type { TooltipProps } from "./tooltip";

// ── marketing primitives (apps/marketing, slice 3) ───────────────────────────
export { SectionHeading } from "./section-heading";
export type { SectionHeadingProps } from "./section-heading";
export { FeatureCard } from "./feature-card";
export type { FeatureCardProps } from "./feature-card";
export { PricingCard } from "./pricing-card";
export type { PricingCardProps } from "./pricing-card";
export { FAQAccordion } from "./faq-accordion";
export type { FaqItem } from "./faq-accordion";
export { CTABanner } from "./cta-banner";
export type { CTABannerProps } from "./cta-banner";
export { LogoGrid } from "./logo-grid";
export type { LogoGridItem } from "./logo-grid";
export { StepFlow } from "./step-flow";
export type { Step } from "./step-flow";

// ── helpers ──────────────────────────────────────────────────────────────────
export { cx } from "./cx";
