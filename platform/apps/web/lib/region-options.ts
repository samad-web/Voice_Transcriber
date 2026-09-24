import "server-only";
import { phoneCountries, type PhoneCountry } from "@aura/shared/dist/phone";

/**
 * The Time & location page's two catalogues, built on the SERVER and handed
 * down as props: the names come from ICU, and the server's and the browser's
 * can spell a country differently ("Turkey" / "Türkiye"). One source means
 * the list the page hydrates is the list it rendered.
 */

export interface CurrencyOption {
  /** ISO 4217, "INR". */
  code: string;
  /** "Indian Rupee". */
  name: string;
}

/** Codes ICU lists but no business prices in today - historic and fund codes. */
const RETIRED = /^(?:X[A-Z]{2}|ADP|AFA|ALK|AOK|AON|AOR|ARA|ARL|ARM|ARP|ATS|AZM|BAD|BAN|BEC|BEF|BEL|BGL|BGM|BGO|BOL|BOP|BOV|BRB|BRC|BRE|BRN|BRR|BRZ|BUK|BYB|BYR|CHE|CHW|CLE|CLF|CNH|CNX|COU|CSD|CSK|CUC|CYP|DDM|DEM|ECS|ECV|EEK|ESA|ESB|ESP|FIM|FRF|GEK|GHC|GNS|GQE|GRD|GWE|GWP|HRD|HRK|IEP|ILP|ILR|ISJ|ITL|KRH|KRO|LTL|LTT|LUC|LUF|LUL|LVL|LVR|MAF|MCF|MDC|MGF|MKN|MLF|MRO|MTL|MTP|MVP|MXP|MXV|MZE|MZM|NIC|NLG|PEI|PES|PLZ|PTE|RHD|ROL|RUR|SDD|SDP|SIT|SKK|SLL|SRG|STD|SUR|SVC|TJR|TMM|TPE|TRL|UAK|UGS|USN|USS|UYI|UYP|UYW|VEB|VED|VEF|VNN|YDD|YUD|YUM|YUN|YUR|ZAL|ZMK|ZRN|ZRZ|ZWD|ZWL|ZWR)$/;

export function currencyOptions(): CurrencyOption[] {
  const codes = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("currency") : ["INR", "USD", "EUR", "GBP", "AED"];
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(["en"], { type: "currency" });
  } catch {
    names = null;
  }
  return codes
    .filter((code) => !RETIRED.test(code))
    .map((code) => ({ code, name: names?.of(code) ?? code }))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
}

export function countryOptions(): PhoneCountry[] {
  return [...phoneCountries()];
}
