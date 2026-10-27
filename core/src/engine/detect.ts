// Personal-data detection presets (Malaysia-focused). Pure logic: regex + validators, no DOM.
import { literalPattern, type PageText, type SearchPattern } from './search';

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
type Accept = (m: RegExpExecArray, text: string, pt?: PageText) => boolean;

/**
 * Table layout: the label is a column header somewhere above the value (data rows in between).
 * Only for a bare cell: if the value's own line has a "Something:" label before it, that label wins.
 * Header lines have no digits; lines with digits are data rows and are climbed over.
 */
const columnHeader = (kw: RegExp, maxLines = 8): Accept => (m, text, pt) => {
  if (!pt) return false;
  const ls = text.lastIndexOf('\n', m.index - 1) + 1;
  if (/[:：]/.test(text.slice(Math.max(ls, m.index - 40), m.index))) return false;
  let vx0 = Infinity, vx1 = -Infinity, vy = Infinity;
  for (let i = m.index; i < m.index + m[0].length; i++) {
    const b = pt.boxes[i];
    if (b) { vx0 = Math.min(vx0, b.x); vx1 = Math.max(vx1, b.x + b.w); vy = Math.min(vy, b.y); }
  }
  if (!Number.isFinite(vx0)) return false;
  const re = new RegExp(kw.source, kw.flags.includes('g') ? kw.flags : kw.flags + 'g');
  let start = ls;
  for (let n = 0; n < maxLines && start > 0; n++) {
    const end = start - 1;
    start = text.lastIndexOf('\n', end - 1) + 1;
    const line = text.slice(start, end);
    if (/[:：]/.test(line)) return false; // "Label: value" lines make a form, not a table
    if (/\d/.test(line)) continue;
    re.lastIndex = 0;
    let k: RegExpExecArray | null;
    while ((k = re.exec(line))) {
      let lx0 = Infinity, lx1 = -Infinity, ly = Infinity;
      for (let i = start + k.index; i < start + k.index + k[0].length; i++) {
        const b = pt.boxes[i];
        if (b) { lx0 = Math.min(lx0, b.x); lx1 = Math.max(lx1, b.x + b.w); ly = Math.min(ly, b.y); }
      }
      // Aligned like a table column: left edges line up, right edges line up (numbers), or the value sits under the label.
      const lw = lx1 - lx0, vc = (vx0 + vx1) / 2;
      const aligned = (vx0 >= lx0 - 0.5 * lw && vx0 <= lx1) || Math.abs(vx1 - lx1) <= 0.5 * lw || (vc >= lx0 && vc <= lx1);
      if (ly < vy && aligned) return true;
      if (!k[0].length) re.lastIndex++;
    }
  }
  return false;
};

/** Label on the same line (within n chars), on the line above, or as a column header (tables). */
const labelled = (kw: RegExp, n = 60): Accept => {
  const a = near(kw, n), b = columnHeader(kw);
  return (m, text, pt) => a(m, text) || b(m, text, pt);
};

const BANK_KW = /bank|acc(?:oun)?t|acc?\.? ?no|a\/c|akaun/i;
/** "Account No", "Acct No.", "A/C No", "No. Akaun", "Nombor Akaun", "Account Number". */
const BANK_LABEL = /(?:acc(?:oun)?t\.?|a\/c)\s*(?:no\.?|number|num\.?|#)?|(?:no\.?|nombor|nombor)\s*akaun(?:\s*bank)?/;
const TIN_KW = /\bTIN\b|tax\s*(?:identification|id|ref(?:erence)?|file|no)|income\s*tax|cukai|LHDN|IRBM|hasil|e-?invoice/i;
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
/** Words that show a "name" is really a form caption or sentence ("Name of applicant", "Nama penuh seperti dalam IC"). */
const NAME_STOP = /^(?:of|the|and|for|to|in|on|at|by|as|per|shall|will|must|is|are|details?|information|info|address|alamat|number|nombor|no|date|tarikh|signature|tandatangan|butiran|maklumat|card|kad|ic|nric|passport|pasport|account|akaun|phone|telefon|email|e-mail|list|senarai|form|borang|section|bahagian|field|here|below|above|page|title|position|jawatan|company|syarikat|bank|seperti|dalam|yang|dan|atau|please|sila|refer|see|n\/a|nil|tiada|not|none)$/i;
/** Form/field words: a "name" containing one is a field label ("Account No.", "IC Number", "Date Of Birth"), never a person. */
const FIELD_WORD = /^(?:account|acct|a\/c|akaun|no|nos|number|num|nombor|ic|nric|mykad|passport|pasport|date|tarikh|dob|tel|telephone|phone|mobile|fax|email|e-mail|address|alamat|bank|branch|cawangan|code|kod|ref|reference|rujukan|amount|jumlah|total|balance|baki|id|tin|tax|cukai|swift|iban|postcode|poskod|gender|jantina|race|bangsa|religion|agama|nationality|status|occupation|pekerjaan|signature|tandatangan|holder|pemegang|type|jenis|salary|gaji|income|pendapatan|sdn|bhd|berhad)$/i;
const nameWordsOk = (v: string) => {
  const ws = v.split(/[\s]+/).filter(Boolean);
  if (ws.some((w) => FIELD_WORD.test(w.replace(/[.:,;()]+$/g, '')))) return false;
  return ws.length > 0 && !NAME_STOP.test(ws[0]) && ws.filter((w) => NAME_STOP.test(w)).length <= (ws.length > 3 ? 1 : 0);
};
const nameOk = (m: RegExpExecArray, text: string) => {
  if (NOT_PERSON_WORD.test(m[0]) || !nameWordsOk(m[0])) return false;
  const before = text.slice(text.lastIndexOf('\n', m.index - 1) + 1, m.index);
  // "Bank name:", "Company name:" label something that isn't a person.
  return !NOT_PERSON_LABEL.test(before.replace(/\b(?:name|nama)\b\.?\s*[:：-]?\s*$/i, '').trimEnd());
};

/** Malaysian Chinese surnames (romanised) and common given-name syllables: "TAN WEI MING", "Lim Siew Ling". */
const CN_SURNAMES = ['Tan', 'Lim', 'Lee', 'Ng', 'Wong', 'Ong', 'Chan', 'Chong', 'Goh', 'Teh', 'Yap', 'Low', 'Ho', 'Ooi', 'Khoo', 'Leong',
  'Cheah', 'Chin', 'Choo', 'Chua', 'Foo', 'Koh', 'Kok', 'Lai', 'Lau', 'Liew', 'Loh', 'Mak', 'Pang', 'Phang', 'Poh', 'Quek', 'Seah', 'See',
  'Sim', 'Siow', 'Soh', 'Tay', 'Tee', 'Toh', 'Wee', 'Woo', 'Yeo', 'Yeoh', 'Yong', 'Chew', 'Heng', 'Hew', 'Kang', 'Khor', 'Kwan', 'Lam',
  'Liang', 'Liow', 'Loke', 'Ling', 'Thong', 'Ting', 'Yee', 'Yip', 'Cheng', 'Chai', 'Choong', 'Chuah', 'Gan', 'Hii', 'Kan', 'Kuan', 'Lew',
  'Loo', 'Lum', 'Sia', 'Siew', 'Tang', 'Tiong', 'Voon', 'Wu', 'Yeap', 'Yew', 'Ang', 'Au', 'Beh', 'Chee', 'Chiew', 'Chow', 'Fong', 'Hoo',
  'Hor', 'Kee', 'Koay', 'Kong', 'Ku', 'Kwok', 'Leow', 'Lian', 'Liu', 'Lo', 'Mok', 'Neoh', 'Oon', 'Pua', 'Saw', 'Sin', 'Soo', 'Soon', 'Tai',
  'Tham', 'Thor', 'Tiew', 'Ung', 'Wan', 'Wang', 'Yam', 'Yau', 'Yu', 'Zhang', 'Chen', 'Huang', 'Lin', 'Zhou', 'Xu', 'Sun', 'Ma', 'Hu', 'Guo', 'He'];
const CN_GIVEN = ['Wei', 'Ming', 'Kok', 'Keong', 'Siew', 'Mei', 'Ling', 'Hui', 'Yee', 'Kah', 'Chee', 'Boon', 'Hock', 'Seng', 'Choon', 'Wai',
  'Kit', 'Yong', 'Jun', 'Jia', 'Xin', 'Yi', 'Hao', 'Zhi', 'Kai', 'Hong', 'Kian', 'Soon', 'Huat', 'Leng', 'Lian', 'Peng', 'Ping', 'Fong',
  'Kheng', 'Teck', 'Beng', 'Eng', 'Guan', 'Heng', 'Hin', 'Hoe', 'Hoong', 'Hwa', 'Jin', 'Kean', 'Keat', 'Khai', 'Kim', 'Kin', 'Kuan', 'Lai',
  'Lee', 'Lip', 'Loong', 'Meng', 'Min', 'Nam', 'Ngee', 'Pei', 'Pui', 'Qi', 'Sheng', 'Shi', 'Sin', 'Siang', 'Siong', 'Soo', 'Tat', 'Tian',
  'Ting', 'Tong', 'Wah', 'Weng', 'Wen', 'Yan', 'Yang', 'Yau', 'Yen', 'Yew', 'Yik', 'Yin', 'Yit', 'Yoke', 'Yu', 'Yuan', 'Yun', 'Zi', 'Chun',
  'Chong', 'Fatt', 'Foo', 'Fook', 'Hean', 'Hooi', 'Kee', 'Keng', 'Kong', 'Lan', 'Leong', 'Li', 'Lin', 'Liang', 'Mun', 'Ning', 'San', 'Shan',
  'Sze', 'Tze', 'Wan', 'Wing', 'Xiang', 'Ying', 'Ah', 'Kow', 'Seong', 'Sen', 'Kon', 'Swee', 'Chin', 'Choy', 'Fei', 'Hoi', 'Kwong', 'Mooi',
  'Poh', 'Sai', 'Shin', 'Tuck', 'Voon', 'Wing', 'Yeong', 'Yoong', 'Zhen', 'Jie', 'Jing', 'Qian', 'Rui', 'Xuan', 'Yao', 'En', 'Er', 'Huey'];
/** Malay/Muslim name anchors: a name usually starts with one of these. */
const MY_ANCHORS = ['Muhammad', 'Muhamad', 'Mohammad', 'Mohamad', 'Mohamed', 'Mohd', 'Muhd', 'Md', 'Ahmad', 'Abdul', 'Abd', 'Nur', 'Nurul',
  'Nor', 'Noor', 'Siti', 'Nik', 'Megat', 'Syed', 'Sharifah', 'Syarifah', 'Puteri', 'Wan', 'Fatimah', 'Aminah', 'Aishah', 'Aisyah', 'Zainab',
  'Nurin', 'Nurhayati', 'Norazlina', 'Norhayati', 'Mohd.', 'Ahmad'];
const alt = (ws: string[], caps: boolean) => [...new Set(ws)].map((w) => esc(caps ? w.toUpperCase() : w)).join('|');
/**
 * Any romanised Chinese syllable (Hanyu Pinyin, Hokkien/Cantonese spellings): "Kiat", "Zheng", "Xuan", "Siew".
 * Used only after a surname and a known given syllable, for names whose last part isn't in CN_GIVEN.
 */
const CN_SYL = '(?:[bcdfghjklmnpqrstwxyz]|ch|sh|zh|ng|kh|th|ts|ph)?h?[aeiouy]{1,3}(?:ng|n|m|k|t|p|h|w)?';
const CN_SYL_STOP = /^(?:the|to|in|on|at|is|as|of|by|me|he|we|be|so|no|do|go|my|hi|oh|ok|she|see|pay|may|say|way|day|key|men|ten|net|set|let|get|bet|pet|hot|not|but|cut|put|run|sun|fun|man|can|pan|van|fan|ran|him|his|her|its|out|had|has|was|new|any|few|saw|two|who|why|how|now|yes|you|yet|job|ya|ta|tak|dan|ke|di|ini|itu|yang|pada|bin|binti|bt|a|an|i|o|u)$/i;
const cnName = (caps: boolean) => {
  const cap = caps ? `[A-Z]${CN_SYL.replace(/[a-z]/g, (c) => c.toUpperCase())}` : `[A-Z]${CN_SYL}`;
  return `(?:${alt(CN_SURNAMES, caps)})(?:[ -](?:${alt(CN_GIVEN, caps)})(?![\\p{L}])){1,2}(?:[ -](?:${cap})(?![\\p{L}])){0,2}`;
};
/** Words before a Malay anchor that make it a place or institution, not a person ("Jalan Raja Muda", "Masjid Abdul..."). */
const NOT_PERSON_BEFORE = /\b(?:jalan|jln|lorong|lrg|taman|tmn|masjid|sekolah|sk|smk|kolej|universiti|university|hospital|klinik|bangunan|wisma|menara|kampung|kg|persiaran|lebuh|surau|dewan|institut|pusat|stadium|bandar|pekan)\b(?:[ ]+[A-Z][\w'’.]*){0,3}[ ]*$/i;
const personOk = (m: RegExpExecArray, text: string) => nameOk(m, text) && !NOT_PERSON_BEFORE.test(text.slice(Math.max(0, m.index - 30), m.index));

/** ID cards (MyKad and family): card words anywhere on the page. */
const CARD_CTX = /kad\s*pengenalan|my\s?kad|identity\s*card|warganegara|\bmy(?:pr|kas|kid|tentera)\b/i;
const CARD_NAME_LINE = `[A-Z][A-Z'’.@/-]*(?:[ ]+[A-Z][A-Z'’.@/-]*){1,6}`;
/** A wrapped name's second line can be a single word ("NUR AISYAH BINTI" / "ABDULLAH"). */
const CARD_NAME_LINE2 = `[A-Z][A-Z'’.@/-]{2,}(?:[ ]+[A-Z][A-Z'’.@/-]*){0,5}`;

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
    },
    {
      // OCR slips: O/o→0, I/l/|→1, S→5, B→8, Z→2, and dashes read as en/em dashes, "~" or with spaces.
      // Only on ID-card pages or next to an IC label, and at most 3 slipped characters.
      regex: /(?<![\dA-Za-z])[\dOoIl|SBZ]{6}\s?[-–—~]?\s?[\dOoIl|SBZ]{2}\s?[-–—~]?\s?[\dOoIl|SBZ]{4}(?![\dA-Za-z])/g,
      accept: (m, t) => {
        const raw = m[0].replace(/[\s\-–—~]/g, '');
        if (/^\d+$/.test(raw) && /^\d{6}-?\d{2}-?\d{4}$/.test(m[0])) return false; // the exact pattern above handles it
        if (raw.replace(/\d/g, '').length > 3 || !(CARD_CTX.test(t) || IC_CTX.test(lineOf(m, t)))) return false;
        const d = raw.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/S/g, '5').replace(/B/g, '8').replace(/Z/g, '2');
        const mm = +d.slice(2, 4), dd = +d.slice(4, 6);
        return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
      },
    },
    {
      // ID-card pages: where the OCR saw the card's front but could not read its number (see markUnreadIc).
      regex: /‹IC number›/g,
      accept: (_m, t) => CARD_CTX.test(t),
    },
    {
      // ID-card pages: the start of an IC number whose end was lost to glare ("780912-14-55"), at the start of a line.
      regex: /(?<=(?:^|\n)[ \t]*)\d{6}(?:[-–]\d{0,2}[-–]?\d{0,3})?(?=[ \t]|\n|$)/g,
      accept: (m, t) => {
        if (m[0].length >= 14 || !CARD_CTX.test(t)) return false;
        const mm = +m[0].slice(2, 4), dd = +m[0].slice(4, 6);
        return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
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
    id: 'bank', label: 'Bank account', description: '8–17 digits after or under “Account No. / No. Akaun / A/C / bank”', defaultOn: true,
    patterns: [
      {
        // Groups joined by one consistent separator, so a table row "880808-08-8888 7612345678" splits into two values.
        regex: /(?<![\d-])\d{1,6}(?:([ -]?)\d{1,8}(?:\1\d{1,8}){0,4})?(?![\d-])/g,
        accept: (m, t, pt) => { const n = digits(m[0]).length; return n >= 8 && n <= 17 && labelled(BANK_KW)(m, t, pt); },
      },
      // "Account No.: <value>": whatever account-like value follows the label (letters + digits too, e.g. "ACC-00012345678").
      { regex: new RegExp(`(?<=(?:${BANK_LABEL.source})[ \\t]*[:：#][ \\t]*)[A-Z]{0,4}[ -]?\\d[\\d -]{4,28}\\d`, 'gi'),
        accept: (m) => digits(m[0]).length >= 6 },
    ],
  },
  {
    id: 'passport', label: 'Passport', description: 'A12345678 / H… / K…, or ID after “passport”', defaultOn: true,
    patterns: [
      { regex: /(?<![A-Za-z0-9])[AHK]\d{8}(?![A-Za-z0-9])/g },
      { regex: /(?<![A-Za-z0-9])[A-Z]{1,2}\d{6,8}(?![A-Za-z0-9])/g, accept: labelled(/pass?port|pasport/i) },
    ],
  },
  {
    id: 'dob', label: 'Date of birth', description: 'Dates after “birth / DOB / lahir”', defaultOn: true,
    patterns: [{ regex: new RegExp(`(?<!\\d)${DATE}(?!\\d)`, 'gi'), accept: labelled(/birth|\bD\.?O\.?B\b|lahir/i) }],
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
    id: 'tin', label: 'Tax no. (TIN)', description: 'LHDN TIN: IG/SG/OG + 9–11 digits; C, D, E, F, PT, TA… numbers next to “TIN / No. Cukai / Income tax”', defaultOn: true,
    patterns: [
      { regex: /(?<![A-Za-z0-9])(?:IG|SG|OG)[ -]?\d{9,11}(?![A-Za-z0-9])/g },
      { regex: /(?<![A-Za-z0-9])(?:CS|FA|PT|TA|TC|TN|TR|TP|LE|C|D|E|F|J)[ -]?\d{8,11}(?![A-Za-z0-9])/g, accept: labelled(TIN_KW, 60) },
      // "TIN: …" / "No. Cukai Pendapatan: …": any number in TIN shape after the label (incl. an IC number used as TIN).
      { regex: new RegExp(`(?<=(?:${TIN_KW.source})[^\\n:：]{0,25}[:：][ \\t]*)(?:[A-Z]{1,2}[ -]?)?\\d[\\d -]{7,14}\\d`, 'gi') },
    ],
  },
  {
    id: 'name', label: 'Name', description: 'After “Name:”, “Nama”, “Holder:”…, in a Name column, titles (Encik, Puan, Mr…), bin/binti, common Malaysian names, and on ID cards', defaultOn: true,
    patterns: [
      { regex: new RegExp(`(?<=(?:^|[^\\p{L}])(?:${labelRe})\\s*[:：-]\\s*)${NAME}`, 'gu'), accept: nameOk },
      // Labelled with a colon: the whole value up to the next label or line end, in any letter case ("Name: tan wei ming").
      { regex: new RegExp(`(?<=(?:^|[^\\p{L}])(?:${labelRe})[ \\t]*[:：][ \\t]*)\\p{L}[\\p{L}'’.@/ -]{1,58}?(?=[ \\t]*(?:\\n|$|[,;(]|\\s{2,}|[ \\t]+\\p{L}[\\p{L} .\\/]{0,24}[:：]|[ \\t]+\\d))`, 'gu'),
        accept: (m, t) => /\p{L}{2}/u.test(m[0]) && nameOk(m, t) },
      // Label at the start of a line without a colon: "NAME   YAP KON SEN", "Nama Siti Aminah".
      { regex: new RegExp(`(?<=(?:^|\\n)[ \\t]*(?:${labelRe})[ \\t]+)${NAME}`, 'gu'), accept: nameOk },
      // Table: a name cell under a "Name"/"Nama" column header.
      { regex: new RegExp(`(?<![\\p{L}])${NAME}(?![\\p{L}])`, 'gu'),
        accept: (m, t, pt) => nameOk(m, t) && columnHeader(/\b(?:name|nama|full\s+name|nama\s+penuh|holder|pemegang)\b/i)(m, t, pt) },
      // Common Malaysian names, no label needed: Chinese surname + given names, Malay anchor names.
      { regex: new RegExp(`(?<![\\p{L}])(?:${cnName(true)}|${cnName(false)})(?![\\p{L}])`, 'gu'),
        accept: (m, t) => nameOk(m, t) && !/^(?:tan|puan)\s+sri\b/i.test(m[0]) && !/\b(?:tan|puan)\s*$/i.test(t.slice(Math.max(0, m.index - 6), m.index)),
        // Extra syllables after the known part ("Tan Chee Kiat") stop at ordinary words ("Tan Chee Kin to sign").
        refine: (m) => {
          const ws = m[0].split(/([ -])/);
          while (ws.length > 3 && CN_SYL_STOP.test(ws[ws.length - 1])) ws.splice(-2, 2);
          return { start: m.index, end: m.index + ws.join('').length };
        } },
      { regex: new RegExp(`(?<![\\p{L}])(?:${alt(MY_ANCHORS, true)}|${alt(MY_ANCHORS, false)})(?:[ ]+${NAME_WORD}){1,4}(?![\\p{L}])`, 'gu'), accept: personOk },
      // ID card: the name lines right under the IC number.
      { regex: new RegExp(`(?<=(?:^|\\n)[^\\n]*\\d{6}[ ]?[-–]?[ ]?\\d{2}[ ]?[-–]?[ ]?\\d{4}[^\\n]*\\n(?:[^\\n]{0,8}\\n){0,2})${CARD_NAME_LINE}(?:\\n${CARD_NAME_LINE2}(?=[ \\t]*(?:\\n|$)))?`, 'gu'),
        accept: (m, t) => CARD_CTX.test(t) && nameWordsOk(m[0]) && !NOT_PERSON_WORD.test(m[0]),
        refine: (m) => {
          // A second line belongs to the name only if it doesn't look like the address starting.
          const [l1, l2] = m[0].split('\n');
          const keep2 = l2 && !/\d/.test(l2) && !STRICT_KW_RE.test(l2) && !stateRe.test(l2) && !CARD_CTX.test(l2);
          return { start: m.index, end: m.index + (keep2 ? m[0].length : l1.length) };
        } },
      { regex: new RegExp(`(?<=(?:^|[^\\p{L}])(?:${honorRe})\\.?\\s+)${NAME}`, 'gu'), accept: nameOk },
      { regex: new RegExp(`(?<![\\p{L}])${NAME_WORD}(?:[ ]+${NAME_WORD}){0,3}[ ]+(?:${ci('binti')}|${ci('bin')}|${ci('bte')}|${ci('a')}\\/${ci('l')}|${ci('a')}\\/${ci('p')}|${ci('s')}\\/${ci('o')}|${ci('d')}\\/${ci('o')})[ ]+${NAME_WORD}(?:[ ]+${NAME_WORD}){0,3}`, 'gu'), accept: nameOk },
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
export interface DetectOptions {
  /** Vehicle plates only next to a label (vehicle, kenderaan, plate…). */ platesNeedLabel?: boolean;
  /** Settings → "Always redact": words/phrases found whole-word, any case, across spaces and line breaks. */ always?: readonly string[];
}

export const ALWAYS_LABEL = 'Always redact';
export const ALWAYS_MAX = 500; // words in the list
export const ALWAYS_MAX_LEN = 200; // characters per word/phrase

/** Tidy a list entry (collapse spacing); '' if it can't be used. */
export const normAlways = (w: string) => w.replace(/\s+/g, ' ').trim().slice(0, ALWAYS_MAX_LEN);


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
  (opts.always ?? []).forEach((w, i) => {
    const re = literalPattern(normAlways(w), false, true);
    if (re) out.push({ id: `always.${i}`, label: ALWAYS_LABEL, regex: re });
  });
  return out;
}
