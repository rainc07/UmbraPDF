// Personal-data detection presets (Malaysia-focused). Pure logic: regex + validators, no DOM.
import type { SearchPattern } from './search';

export interface Preset {
  id: string;
  label: string;
  description: string;
  defaultOn: boolean;
  patterns: Omit<SearchPattern, 'id' | 'label'>[];
}

export interface CustomPattern { label: string; source: string; ignoreCase: boolean }

const digits = (s: string) => s.replace(/\D/g, '');

export function luhn(num: string): boolean {
  let sum = 0, dbl = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = num.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return num.length > 0 && sum % 10 === 0;
}

/**
 * Accept only if `kw` labels this value: it must appear earlier on the same line, within `n` chars.
 * If the value starts its own line (label above it, e.g. table/form layouts), the previous line is used instead.
 * This stops a label on one row ("Date of birth: …") from flagging the next row ("Report date: …").
 */
const near = (kw: RegExp, n = 40) => (m: RegExpExecArray, text: string) => {
  const before = text.slice(Math.max(0, m.index - n - 1), m.index);
  const nl = before.lastIndexOf('\n');
  if (nl === -1) return kw.test(before.slice(-n));
  const sameLine = before.slice(nl + 1);
  if (sameLine.trim()) return kw.test(sameLine);
  const prev = before.slice(0, nl);
  return kw.test(prev.slice(prev.lastIndexOf('\n') + 1));
};

/** The whole line containing the match (for context words before or after it). */
const lineOf = (m: RegExpExecArray, text: string) => {
  const a = text.lastIndexOf('\n', m.index - 1) + 1;
  const b = text.indexOf('\n', m.index + m[0].length);
  return text.slice(a, b === -1 ? text.length : b);
};
const COMPANY_CTX = /\b(?:sdn\.?\s*bhd|berhad|bhd|plt|llp|ssm|syarikat|company|co\.?\s*reg|registration|pendaftaran\s+syarikat|roc|rob)\b/i;
const IC_CTX = /\b(?:nric|n\.?r\.?i\.?c|i\/?c|mykad|my\s*kad|k\/p|kp|kad\s+pengenalan|identity\s+card|id\s*no)\b/i;
const NEW_SSM = /^(?:19|20)\d{2}0[1-6]\d{6}$/;

/** Case-insensitive literal inside a case-sensitive regex (names must stay case-sensitive). */
const ci = (w: string) => w.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
const NAME_WORD = `(?:[A-Z][a-z'’.-]+|[A-Z][A-Z'’.-]+|[A-Z]\.)`;
const NAME_LINK = `(?:${['bin', 'binti', 'bte', 'bt', 'a/l', 'a/p', 'al', 'ap', 'van', 'de', 'dan'].map((w) => ci(w).replace('/', '\\/')).join('|')}|@)`;
/** 2–6 name words on one line, optionally joined by bin/binti/a/l/a/p/@. */
const NAME = `${NAME_WORD}(?:[ ]+(?:${NAME_LINK}[ ]+)?${NAME_WORD}){1,5}`;
const NAME_LABELS = ['name', 'nama', 'full name', 'nama penuh', 'holder', 'account holder', 'tenant', 'landlord', 'lessor', 'lessee',
  'penyewa', 'pemilik', 'tuan rumah', 'owner', 'employee', 'pekerja', 'patient', 'pesakit', 'applicant', 'pemohon', 'guarantor',
  'penjamin', 'witness', 'saksi', 'signed by', 'attention', 'attn', 'beneficiary', 'penerima', 'customer', 'pelanggan', 'insured', 'claimant'];
const HONORIFICS = ['mr', 'mrs', 'ms', 'mdm', 'miss', 'dr', 'encik', 'en', 'puan', 'pn', 'cik', 'tuan', 'tn', "dato'", 'dato’', 'dato',
  'datuk', 'datin', 'tan sri', 'puan sri', 'haji', 'hajah', 'hj', 'hjh', 'tengku', 'ustaz', 'ustazah'];
const NOT_PERSON_LABEL = /\b(?:bank|company|syarikat|business|perniagaan|product|trade|brand|file|user|account|branch|cawangan|building|bangunan|project|projek|vessel|road|jalan|street|taman|plan)\s*$/i;
const NOT_PERSON_WORD = /\b(?:SDN|BHD|BERHAD|ENTERPRISE|TRADING|BANK|LTD|PLT|LLP|CORPORATION|CORP|HOLDINGS|GROUP|RESOURCES|SERVICES|INDUSTRIES|MAYBANK|CIMB|HSBC|AGREEMENT|PREMISES|TENANCY|RENTAL|DEPOSIT|MALAYSIA)\b/i;
const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const labelRe = NAME_LABELS.map((l) => ci(esc(l)).replace(/ /g, '\\s+')).join('|');
const honorRe = HONORIFICS.map((h) => ci(esc(h)).replace(/ /g, '\\s+')).join('|');
const nameOk = (m: RegExpExecArray, text: string) => {
  if (NOT_PERSON_WORD.test(m[0])) return false;
  const before = text.slice(text.lastIndexOf('\n', m.index - 1) + 1, m.index);
  // "Bank name:", "Company name:" label something that isn't a person.
  return !NOT_PERSON_LABEL.test(before.replace(/\b(?:name|nama)\b\.?\s*[:：-]?\s*$/i, '').trimEnd());
};

// ---- Addresses (Malaysia) ----
const ADDR_KW = ['jalan', 'jln', 'lorong', 'lrg', 'taman', 'tmn', 'persiaran', 'lebuh', 'lebuhraya', 'lingkaran', 'kampung', 'kg', 'batu',
  'bandar', 'seksyen', 'section', 'blok', 'block', 'unit', 'lot', 'no', 'pusat perniagaan', 'kompleks', 'menara', 'wisma', 'plaza',
  'apartment', 'apartmen', 'kondominium', 'condominium', 'residensi', 'flat', 'pangsapuri', 'desa', 'bukit', 'street', 'road', 'avenue',
  'off', 'mukim', 'daerah', 'p.o. box', 'peti surat'];
const STATES = ['johor', 'kedah', 'kelantan', 'melaka', 'malacca', 'negeri sembilan', 'n. sembilan', 'pahang', 'perak', 'perlis',
  'pulau pinang', 'penang', 'p. pinang', 'sabah', 'sarawak', 'selangor', 'terengganu', 'kuala lumpur', 'k. lumpur', 'kl', 'w.p.',
  'wilayah persekutuan', 'putrajaya', 'labuan'];
const kwRe = `\\b(?:${ADDR_KW.map((w) => ci(esc(w)).replace(/ /g, '\\s+')).join('|')})\\b`;
const stateRe = new RegExp(`\\b(?:${STATES.map((w) => esc(w).replace(/ /g, '\\s*')).join('|')})(?![a-z])`, 'i');
const ADDR_KW_RE = new RegExp(kwRe);
const POSTCODE = '\\b(?:0[1-9]|[1-9]\\d)\\d{3}\\b';
const STRICT_KW = ADDR_KW.filter((w) => !['no', 'off', 'unit', 'lot', 'block', 'blok', 'section', 'flat', 'desa', 'bukit', 'batu', 'road', 'street'].includes(w));
const STRICT_KW_RE = new RegExp(`\\b(?:${STRICT_KW.map((w) => ci(esc(w)).replace(/ /g, '\\s+')).join('|')})\\b`);
const POSTCODE_CITY_RE = new RegExp(`${POSTCODE}[ ,]+[A-Za-z]`);
const ADDR_LABELS = ['address', 'alamat', 'premises', 'premis', 'alamat premis', 'residential address', 'mailing address',
  'correspondence address', 'beralamat di', 'residing at', 'lokasi', 'location'];
const addrLabelRe = ADDR_LABELS.map((l) => ci(esc(l)).replace(/ /g, '\\s+')).join('|');
const addrOk = (t: string) => {
  const pc = new RegExp(POSTCODE).test(t);
  return (pc && (ADDR_KW_RE.test(t) || stateRe.test(t))) || (t.match(new RegExp(kwRe, 'g'))?.length ?? 0) >= 2;
};

/**
 * Cut a raw multi-line grab down to the address: keep street lines until the postcode line,
 * then at most one short city/state line. Drops a leading "Label:" and trailing punctuation.
 */
function addressRange(m: RegExpExecArray, labelled: boolean): { start: number; end: number } | null {
  let start = m.index;
  const lines = m[0].split('\n');
  if (!labelled) {
    // Unlabelled: begin at the first street-looking line; drop a "Something:" label in front of it.
    let k = 0;
    const pcIdx = Math.max(0, lines.findIndex((L) => POSTCODE_CITY_RE.test(L)));
    while (k < pcIdx && !STRICT_KW_RE.test(lines[k])) { start += lines[k].length + 1; k++; }
    lines.splice(0, k);
    const lab = lines[0].match(/^[^:\d\n]{1,40}:\s*/);
    if (lab && !ADDR_KW_RE.test(lab[0])) { start += lab[0].length; lines[0] = lines[0].slice(lab[0].length); }
  }
  const lead = lines[0].match(/^\s*/)![0].length;
  start += lead; lines[0] = lines[0].slice(lead);
  const kept = [lines[0]];
  let hasPc = POSTCODE_CITY_RE.test(lines[0]);
  for (let i = 1; i < lines.length && kept.length < 4; i++) {
    const L = lines[i];
    if (hasPc) {
      // After the postcode: only a short place/state line ("Kuala Lumpur", "PERAK.").
      if (!/\d/.test(L) && !L.includes(':') && L.trim().split(/\s+/).length <= 4 && (stateRe.test(L) || /^[A-Z][A-Za-z .'-]*[.,]?\s*$/.test(L.trim()))) kept.push(L);
      break;
    }
    if (STRICT_KW_RE.test(L) || POSTCODE_CITY_RE.test(L)) { kept.push(L); hasPc = POSTCODE_CITY_RE.test(L); } else break;
  }
  let text = kept.join('\n');
  text = text.replace(/[\s,.;]+$/, '');
  if (!addrOk(text)) return null;
  // Unlabelled needs a real street word (Jalan, Taman, Lorong…) or a state, not just "No" + a 5-digit number.
  if (!labelled && !(hasPc && (STRICT_KW_RE.test(text) || stateRe.test(text)))) return null;
  return { start, end: start + text.length };
}

/** Words that look like plates but aren't: currencies, units, address/ref abbreviations. */
const PLATE_STOP = '(?:RM|MYR|USD|SGD|EUR|GBP|AUD|JPY|CNY|IDR|THB|HKD|NO|PG|PT|LOT|JLN|JL|TEL|FAX|ID|REF|ACC|AC|KM|KG|MM|CM|SEN|PH|BLK|BLOK|NOS|PP|CL|SEC|PCS|QTY|UNIT|TOT|VOL|ART|SEK|S|RS)';
const PLATE_LABEL = /vehicle|kenderaan|\bcar\b|kereta|plate|no\.?\s*pendaftaran|registration\s*(?:no|number)|\breg\.?\s*no|motor|lori|lorry|\bvan\b|plat/i;

const MONTHS = 'Jan(?:uary|uari)?|Feb(?:ruary|ruari)?|Mar(?:ch)?|Mac|Apr(?:il)?|Ma[yi]|Mei|Jun(?:e)?|Jul(?:y|ai)?|Aug(?:ust)?|Ogos|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Okt(?:ober)?|Nov(?:ember)?|Dec(?:ember)?|Dis(?:ember)?';
const DATE = `(?:\\d{1,2}[/.-]\\d{1,2}[/.-](?:19|20)\\d{2}|(?:19|20)\\d{2}[/.-]\\d{1,2}[/.-]\\d{1,2}|\\d{1,2}(?:st|nd|rd|th)?[ -](?:${MONTHS})[ ,-]+(?:19|20)\\d{2}|(?:${MONTHS}) \\d{1,2},? (?:19|20)\\d{2})`;

export const PRESETS: Preset[] = [
  {
    id: 'nric', label: 'NRIC (MyKad)', description: '900101-14-5678 or 900101145678', defaultOn: true,
    patterns: [{
      regex: /(?<![\dA-Za-z])\d{6}-?\d{2}-?\d{4}(?![\dA-Za-z])/g,
      accept: (m, t) => {
        const d = digits(m[0]); const mm = +d.slice(2, 4), dd = +d.slice(4, 6);
        if (!(mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return false;
        // 12 plain digits shaped like a new SSM number next to company words is a company number, not an IC.
        if (!m[0].includes('-') && NEW_SSM.test(d) && COMPANY_CTX.test(lineOf(m, t)) && !IC_CTX.test(lineOf(m, t))) return false;
        return true;
      },
    }],
  },
  {
    id: 'phone', label: 'Phone', description: '+60 12-345 6789, 012-3456789, 03-2161 2345', defaultOn: true,
    patterns: [{ regex: /(?<![\d+])(?:\+?60[ -]?|0)(?:1\d|[3-9])[ -]?\d{3,4}[ -]?\d{4}(?!\d)/g }],
  },
  {
    id: 'email', label: 'Email', description: 'name@example.com', defaultOn: true,
    patterns: [{ regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g }],
  },
  {
    id: 'card', label: 'Card number', description: '13–19 digits, Luhn-validated', defaultOn: true,
    patterns: [{
      regex: /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g,
      accept: (m) => { const d = digits(m[0]); return d.length >= 13 && d.length <= 19 && luhn(d); },
    }],
  },
  {
    id: 'bank', label: 'Bank account', description: '10–16 digits after “account / akaun / a/c / bank”', defaultOn: true,
    patterns: [{
      regex: /(?<![\d-])\d{2,6}(?:[ -]?\d{2,8}){0,4}(?![\d-])/g,
      accept: (m, t) => { const n = digits(m[0]).length; return n >= 10 && n <= 16 && near(/bank|acc(?:oun)?t|acc?\.? ?no|a\/c|akaun/i)(m, t); },
    }],
  },
  {
    id: 'passport', label: 'Passport', description: 'A12345678 / H… / K…, or ID after “passport”', defaultOn: true,
    patterns: [
      { regex: /(?<![A-Za-z0-9])[AHK]\d{8}(?![A-Za-z0-9])/g },
      { regex: /(?<![A-Za-z0-9])[A-Z]{1,2}\d{6,8}(?![A-Za-z0-9])/g, accept: near(/pass?port/i) },
    ],
  },
  {
    id: 'dob', label: 'Date of birth', description: 'Dates after “birth / DOB / lahir”', defaultOn: true,
    patterns: [{ regex: new RegExp(`(?<!\\d)${DATE}(?!\\d)`, 'gi'), accept: near(/birth|\bD\.?O\.?B\b|lahir/i) }],
  },
  {
    id: 'company', label: 'Company reg. no.', description: 'SSM 202001012345, 1234567-K, LLP0012345-LGN', defaultOn: true,
    patterns: [
      { regex: /(?<!\d)(?:19|20)\d{2}0[1-6]\d{6}(?!\d)/g, accept: (m, t) => !IC_CTX.test(lineOf(m, t)) || COMPANY_CTX.test(lineOf(m, t)) },
      { regex: /(?<![\dA-Za-z-])\d{4,7}-[A-Z](?![A-Za-z0-9])/g },
      { regex: /(?<![A-Za-z0-9])LLP\d{7}-LG[NR](?![A-Za-z0-9])/g },
    ],
  },
  {
    id: 'name', label: 'Name', description: 'Only after “Name:”, “Holder:”, “Tenant:”…, titles (Encik, Puan, Mr…) or bin/binti', defaultOn: true,
    patterns: [
      { regex: new RegExp(`(?<=(?:^|[^\\p{L}])(?:${labelRe})\\s*[:：-]\\s*)${NAME}`, 'gu'), accept: nameOk },
      { regex: new RegExp(`(?<=(?:^|[^\\p{L}])(?:${honorRe})\\.?\\s+)${NAME}`, 'gu'), accept: nameOk },
      { regex: new RegExp(`(?<![\\p{L}])${NAME_WORD}(?:[ ]+${NAME_WORD}){0,3}[ ]+(?:${ci('binti')}|${ci('bin')}|${ci('bte')}|${ci('a')}\\/${ci('l')}|${ci('a')}\\/${ci('p')})[ ]+${NAME_WORD}(?:[ ]+${NAME_WORD}){0,3}`, 'gu'), accept: nameOk },
    ],
  },
  {
    id: 'address', label: 'Address', description: 'After “Address/Alamat:”, or street lines ending in a postcode (e.g. 52100 Kepong)', defaultOn: true,
    patterns: [
      // Labelled: grab the rest of the line and the next few lines; addressRange trims it.
      { regex: new RegExp(`(?<=(?:^|[^\\p{L}])(?:${addrLabelRe})\\s*[:：-]\\s*)\\S[^\\n]{4,}(?:\\n[^\\n]+){0,4}`, 'gu'),
        refine: (m) => addressRange(m, true) },
      // Unlabelled: up to 2 lines before a line with "postcode City".
      { regex: new RegExp(`(?<![^\\n])(?:[^\\n]*\\n){0,2}[^\\n]*${POSTCODE}[ ,]+[A-Za-z][^\\n]*(?:\\n[^\\n]+)?`, 'g'),
        refine: (m) => addressRange(m, false) },
    ],
  },
  {
    id: 'plate', label: 'Vehicle plate', description: 'WXY 1234, VAB 123 C. Not amounts like RM 2700', defaultOn: false,
    patterns: [{
      regex: new RegExp(`(?<![A-Za-z0-9])(?!${PLATE_STOP}\\b)(?:[A-HJ-NP-Z]{2,3} ?[1-9]\\d{0,3}|[A-HJ-NP-Z] ?[1-9]\\d{2,3})(?: ?[A-HJ-NP-Z](?![A-Za-z]))?(?![A-Za-z0-9]|[.,]\\d)`, 'g'),
    }],
  },
];

export const DEFAULT_PRESET_IDS = PRESETS.filter((p) => p.defaultOn).map((p) => p.id);

/** Throws with a readable message if the custom regex is invalid or matches empty strings. */
export function compileCustom(c: CustomPattern): RegExp {
  if (!c.source.trim()) throw new Error('Pattern is empty');
  const re = new RegExp(c.source, c.ignoreCase ? 'gi' : 'g');
  if (re.test('')) throw new Error('Pattern matches empty text');
  re.lastIndex = 0;
  return re;
}

/** Expand enabled presets + custom patterns into search patterns. Invalid custom patterns are skipped. */
export interface DetectOptions { /** Vehicle plates only next to a label (vehicle, kenderaan, plate…). */ platesNeedLabel?: boolean }

export function buildPatterns(enabled: readonly string[], custom: readonly CustomPattern[] = [], opts: DetectOptions = {}): SearchPattern[] {
  const out: SearchPattern[] = [];
  for (const p of PRESETS) {
    if (!enabled.includes(p.id)) continue;
    p.patterns.forEach((q, i) => {
      const accept = p.id === 'plate' && opts.platesNeedLabel ? near(PLATE_LABEL, 50) : q.accept;
      out.push({ id: `${p.id}.${i}`, label: p.label, ...q, accept });
    });
  }
  custom.forEach((c, i) => {
    try { out.push({ id: `custom.${i}`, label: c.label.trim() || 'Custom', regex: compileCustom(c) }); } catch { /* skipped */ }
  });
  return out;
}
