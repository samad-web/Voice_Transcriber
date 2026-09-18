"use client";

import {
  REPLY_LANGUAGE_LABELS,
  REPLY_LENGTH_LABELS,
  REPLY_TONE_LABELS,
  type ReplyDrafterConfig,
  type ReplyLanguage,
  type ReplyLength,
  type ReplyTone,
} from "@aura/shared";
import { Input, Label, Select } from "@aura/ui";

export function ReplySettings({
  config,
  onChange,
}: {
  config: ReplyDrafterConfig;
  onChange: (config: ReplyDrafterConfig) => void;
}) {
  const set = (patch: Partial<ReplyDrafterConfig>) => onChange({ ...config, ...patch });
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <Label htmlFor="reply-tone">Tone</Label>
        <Select
          id="reply-tone"
          value={config.tone}
          onChange={(e) => set({ tone: e.target.value as ReplyTone })}
        >
          {(Object.keys(REPLY_TONE_LABELS) as ReplyTone[]).map((t) => (
            <option key={t} value={t}>
              {REPLY_TONE_LABELS[t]}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="reply-length">Length</Label>
        <Select
          id="reply-length"
          value={config.length}
          onChange={(e) => set({ length: e.target.value as ReplyLength })}
        >
          {(Object.keys(REPLY_LENGTH_LABELS) as ReplyLength[]).map((l) => (
            <option key={l} value={l}>
              {REPLY_LENGTH_LABELS[l]}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="reply-language">Language</Label>
        <Select
          id="reply-language"
          value={config.language}
          onChange={(e) => set({ language: e.target.value as ReplyLanguage })}
        >
          {(Object.keys(REPLY_LANGUAGE_LABELS) as ReplyLanguage[]).map((l) => (
            <option key={l} value={l}>
              {REPLY_LANGUAGE_LABELS[l]}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="reply-signoff">Sign-off</Label>
        <Input
          id="reply-signoff"
          maxLength={120}
          value={config.signOff}
          onChange={(e) => set({ signOff: e.target.value })}
          placeholder="e.g. - Priya, Sirah Digital"
        />
      </div>
    </div>
  );
}
