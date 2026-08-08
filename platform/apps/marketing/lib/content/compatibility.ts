/**
 * The OEM capture matrix.
 *
 * SOURCE OF TRUTH: `Build docs/05_FLEET_ONBOARDING.md` §1 and the scan paths in
 * `CallRecorderApp/.../capture/CaptureSettings.kt`. Every row here is a
 * hardware-verified fact from that table, not a guess and not a hedge.
 *
 * Doc 10 §1 objection #2 and §9 both turn on this page: naming the limit
 * precisely is what buys credibility on everything else, and "which phones
 * record calls automatically" is the highest-intent organic query this product
 * can rank for. So the ❌ row is stated as plainly as the ✅ ones.
 */

export type CaptureStatus = "verified" | "supported" | "untested" | "unsupported";

export interface OemRow {
  brand: string;
  status: CaptureStatus;
  /** The folder the OEM dialer writes into, where one is public. */
  path: string;
  note?: string;
}

export const OEM_MATRIX: OemRow[] = [
  {
    brand: "Samsung (One UI)",
    status: "verified",
    path: "Recordings/Call/",
    note: "Verified on hardware.",
  },
  {
    brand: "Xiaomi / Redmi (HyperOS)",
    status: "verified",
    path: "Recordings/sound_recorder/call_rec/",
    note: "Verified on hardware. Earlier HyperOS builds use Recordings/CallRecord/.",
  },
  {
    brand: "Xiaomi / Redmi / POCO (MIUI)",
    status: "supported",
    path: "MIUI/sound_recorder/call_rec/",
  },
  {
    brand: "Realme / Oppo (ColorOS)",
    status: "supported",
    path: "Recordings/Call Recordings/",
    note: "Older ColorOS builds use Music/Recordings/Call Recordings/.",
  },
  {
    brand: "Vivo / OnePlus",
    status: "supported",
    path: "In the default scan list",
  },
  {
    brand: "Infinix / Tecno / itel",
    status: "untested",
    path: "Music/PhoneRecord/<number>/",
    note: "The path is shipped in the scanner, but we have not confirmed it on a device. Tell us your model and we will test before you buy.",
  },
  {
    brand: "Pixel / Motorola / Nokia (Google Dialer)",
    status: "unsupported",
    path: "Private app storage, unreadable",
    note: "Confirmed on hardware. The Google Dialer keeps its recordings in internal app storage that Android blocks every other app from reading. There is no setting, no permission and no version of Aura that changes this.",
  },
];

export const STATUS_LABEL: Record<CaptureStatus, string> = {
  verified: "Verified on hardware",
  supported: "Supported",
  untested: "Shipped, untested",
  unsupported: "Not supported",
};
