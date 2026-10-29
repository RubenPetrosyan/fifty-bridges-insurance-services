// Vercel Serverless Function: FMCSA carrier lookup proxy (SAFER + FMCSA open data).
// Why a proxy? A browser page on vercel.app cannot reliably fetch safer.fmcsa.dot.gov
// directly (no CORS headers, and SAFER sometimes blocks browser fetches). A server-side
// function can fetch the public SAFER Company Snapshot, parse the public fields, and
// return only clean JSON to the page. No API key is needed for SAFER or for FMCSA's
// public Socrata open data.
// Sources used, in order:
//  1. SAFER Company Snapshot (primary for name, address, phone, MC, status, MCS-150,
//     power units, drivers, cargo, operation classification, carrier operation).
//  2. FMCSA Company Census open data (data.transportation.gov, dataset az4n-8mr2) —
//     used ONLY to fill cargo / operation / carrier-operation fields that the SAFER
//     parser left empty. Its cargo flags are crgo_* = "X", and its operation fields
//     are interstate/intrastate flags. SAFER remains primary; census never overwrites
//     a SAFER value that is already present.
//  3. FMCSA Insurance History open data (dataset 6sqe-dvqs, InsHist) — cancelled /
//     replaced filings only, verified live for DOT 3475651 (it returned MCP76813A and
//     CCA-0013421-00, both Cancelled, and did NOT return the active GRT12604A filing).
//     The active filing is therefore NOT claimed from this dataset. The response
//     always includes a motusUrl so the visitor (and Ruben) can check the Motus
//     public snapshot (authority detail -> Insurance Details, Include History on)
//     for the current active filing.
// What it does NOT do: MOTUS public pages are a client-side app that loads data by
// JavaScript after load (up to ~60s), so a server-side HTML fetch returns only an
// empty shell — Motus itself is therefore linked, not scraped. It also never invents
// FEIN or garaging data. Physical address is the principal place of business from
// FMCSA, never garaging.
function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}
function normParen(s) {
  return clean(s).replace(/\s*\(\s*/g, ' (').replace(/\s+\)/g, ')');
}
function between(text, start, ends) {
  const i = text.indexOf(start);
  if (i < 0) return '';
  const from = i + start.length;
  let end = text.length;
  for (const e of ends) {
    const j = text.indexOf(e, from);
    if (j >= 0 && j < end) end = j;
  }
  return clean(text.slice(from, end));
}
function stripHtml(html) {
  return clean(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&#0*39;/g, "'")
      .replace(/\s+:/g, ':')
  );
}
// Section slice: find the first start label (with or without colon), slice until the
// earliest end label after it. Falls back to '' when the start label is absent.
function sectionSlice(text, starts, ends) {
  let from = -1;
  for (const s of starts) {
    const i = text.indexOf(s);
    if (i >= 0) { from = i + s.length; break; }
  }
  if (from < 0) return '';
  let end = text.length;
  for (const e of ends) {
    const j = text.indexOf(e, from);
    if (j >= 0 && j < end) end = j;
  }
  return text.slice(from, end);
}
// Known-item X matching: in SAFER's stripped text, selected items appear as
// "X <item>" whether the X was a table cell, a dash-list item, or inline text.
// Unselected items appear with no X, so searching for "X <item>" (normalised) is
// robust to both layouts and never merges the whole section into one item.
function xKnown(section, known) {
  const sec = normParen(section);
  const out = [];
  for (const item of known) {
    const needle = 'X ' + normParen(item);
    if (sec.indexOf(needle) >= 0) out.push(item);
  }
  return out;
}
const OPERATION_ITEMS = [
  'Auth. For Hire', 'Exempt For Hire', 'Private(Property)',
  'Priv. Pass. (Business)', 'Priv. Pass. (Non-business)', 'Migrant',
  'U.S. Mail', "Fed. Gov't", "State Gov't", 'Local Gov\'t', 'Indian Nation',
];
const CARRIER_OPERATION_ITEMS = [
  'Interstate', 'Intrastate Only (HM)', 'Intrastate Only (Non-HM)',
];
const CARGO_ITEMS = [
  'General Freight', 'Household Goods', 'Metal: sheets, coils, rolls',
  'Motor Vehicles', 'Drive/Tow away', 'Logs, Poles, Beams, Lumber',
  'Building Materials', 'Mobile Homes', 'Machinery, Large Objects',
  'Fresh Produce', 'Liquids/Gases', 'Intermodal Cont.', 'Passengers',
  'Oilfield Equipment', 'Livestock', 'Grain, Feed, Hay', 'Coal/Coke',
  'Meat', 'Garbage/Refuse', 'US Mail', 'Chemicals', 'Commodities Dry Bulk',
  'Refrigerated Food', 'Beverages', 'Paper Products', 'Utilities',
  'Agricultural/Farm Supplies', 'Construction', 'Water Well',
];
function parseSafer(html) {
  const text = stripHtml(html);
  if (/RECORD INACTIVE/i.test(text) && !/Legal Name:/i.test(text)) {
    return { error: 'inactive', message: 'FMCSA SAFER shows this record as inactive, or no active snapshot was returned.' };
  }
  const legalName = between(text, 'Legal Name:', ['DBA Name:', 'Physical Address:']);
  if (!legalName) {
    return { error: 'not_found', message: 'No carrier snapshot was found for this DOT number on FMCSA SAFER.' };
  }
  const dba = between(text, 'DBA Name:', ['Physical Address:']);
  const physicalAddress = between(text, 'Physical Address:', ['Phone:', 'Mailing Address:']);
  const mailingAddress = between(text, 'Mailing Address:', ['DUNS Number:', 'Power Units:']);
  const phoneMatch = text.match(/Phone:\s*(\(\d{3}\)\s*\d{3}-\d{4})/);
  const mcMatches = [...new Set([...text.matchAll(/MC-(\d+)/g)].map((m) => 'MC-' + m[1]))];
  const usdotStatus = between(text, 'USDOT Status:', ['Out of Service Date:', 'USDOT Number:']);
  let authorityStatus = between(text, 'Operating Authority Status:', ['For Licensing', 'MC/MX/FF Number(s):']);
  authorityStatus = authorityStatus.replace(/Please Note:.*$/i, '').trim();
  const mcsMatch = text.match(/MCS-150 Form Date:\s*(\d{2}\/\d{2}\/\d{4})/);
  const powerMatch = text.match(/Power Units:\s*(\d+)/);
  const driversMatch = text.match(/Drivers:\s*\*?\s*(\d+)/);
  const asOfMatch = text.match(/management information systems as of\s+(\d{2}\/\d{2}\/\d{4})/);
  const operationClassification = xKnown(
    sectionSlice(text, ['Operation Classification:'], ['Carrier Operation:', 'Cargo Carried:']),
    OPERATION_ITEMS
  );
  const carrierOperation = xKnown(
    sectionSlice(text, ['Carrier Operation:'], ['Cargo Carried:', 'Inspections/Crashes']),
    CARRIER_OPERATION_ITEMS
  );
  const cargo = xKnown(
    sectionSlice(text, ['Cargo Carried:'], ['Inspections/Crashes', 'Safety Rating']),
    CARGO_ITEMS
  );
  const powerUnits = powerMatch ? parseInt(powerMatch[1], 10) : null;
  return {
    legalName,
    dba: dba || null,
    physicalAddress: physicalAddress || null,
    mailingAddress: mailingAddress || null,
    phone: phoneMatch ? phoneMatch[1] : null,
    mcNumbers: mcMatches,
    usdotStatus: usdotStatus || null,
    authorityStatus: authorityStatus || null,
    mcs150Date: mcsMatch ? mcsMatch[1] : null,
    powerUnits,
    drivers: driversMatch ? parseInt(driversMatch[1], 10) : null,
    cargo,
    operationClassification,
    carrierOperation,
    dataAsOf: asOfMatch ? asOfMatch[1] : null,
  };
}
const CENSUS_CARGO_MAP = {
  crgo_genfreight: 'General Freight',
  crgo_household: 'Household Goods',
  crgo_metal: 'Metal: sheets, coils, rolls',
  crgo_motorveh: 'Motor Vehicles',
  crgo_drive: 'Drive/Tow away',
  crgo_log: 'Logs, Poles, Beams, Lumber',
  crgo_bldg: 'Building Materials',
  crgo_mobile: 'Mobile Homes',
  crgo_mach: 'Machinery, Large Objects',
  crgo_produce: 'Fresh Produce',
  crgo_liquid: 'Liquids/Gases',
  crgo_inter: 'Intermodal Cont.',
  crgo_pass: 'Passengers',
  crgo_oil: 'Oilfield Equipment',
  crgo_livestock: 'Livestock',
  crgo_grain: 'Grain, Feed, Hay',
  crgo_coal: 'Coal/Coke',
  crgo_meat: 'Meat',
  crgo_garbage: 'Garbage/Refuse',
  crgo_usmail: 'US Mail',
  crgo_chem: 'Chemicals',
  crgo_drybulk: 'Commodities Dry Bulk',
  crgo_refriger: 'Refrigerated Food',
  crgo_beverage: 'Beverages',
  crgo_paper: 'Paper Products',
  crgo_utility: 'Utilities',
  crgo_farmsupp: 'Agricultural/Farm Supplies',
  crgo_construct: 'Construction',
  crgo_waterwell: 'Water Well',
};
function parseCensus(row) {
  if (!row) return {};
  const cargo = [];
  for (const [field, label] of Object.entries(CENSUS_CARGO_MAP)) {
    if (String(row[field] || '').toUpperCase() === 'X') cargo.push(label);
  }
  const carrierOperation = [];
  if (row.interstate_beyond_100_miles === '1' || row.interstate_within_100_miles === '1') {
    carrierOperation.push('Interstate');
  }
  if (row.intrastate_beyond_100_miles === '1' || row.intrastate_within_100_miles === '1') {
    carrierOperation.push(row.hm_ind === 'Y' ? 'Intrastate Only (HM)' : 'Intrastate Only (Non-HM)');
  }
  const operationClassification = [];
  const classdef = String(row.classdef || '').toUpperCase();
  if (classdef.includes('AUTHORIZED FOR HIRE')) operationClassification.push('Auth. For Hire');
  else if (classdef.includes('EXEMPT FOR HIRE')) operationClassification.push('Exempt For Hire');
  else if (classdef.includes('PRIVATE')) operationClassification.push('Private(Property)');
  let mcs150Date = null;
  if (/^\d{8}$/.test(String(row.mcs150_date || ''))) {
    const d = String(row.mcs150_date);
    mcs150Date = d.slice(4, 6) + '/' + d.slice(6, 8) + '/' + d.slice(0, 4);
  }
  return {
    cargo,
    carrierOperation,
    operationClassification,
    powerUnits: row.power_units != null ? parseInt(row.power_units, 10) : null,
    drivers: row.total_drivers != null ? parseInt(row.total_drivers, 10) : null,
    mcs150Date,
    legalName: row.legal_name || null,
  };
}
function parseInsuranceRow(r) {
  const amountField = r.mod_col_5 != null && r.mod_col_5 !== '' ? r.mod_col_5 : r.min_cov_amount;
  const amount = amountField != null && !isNaN(parseInt(amountField, 10)) ? parseInt(amountField, 10) * 1000 : null;
  return {
    insurer: clean(r.name_company),
    policyNumber: r.policy_no || null,
    form: r.ins_form_code ? 'BMC-' + r.ins_form_code : null,
    coverageType: r.mod_col_3 || null,
    amount: amount,
    status: r.mod_col_1 || null,
    effectiveDate: r.effective_date || null,
    cancellationDate: r.cancl_effective_date || null,
    cancellationMethod: r.cancl_method || null,
    docketNumber: r.docket_number || null,
  };
}
async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    clearTimeout(timer);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const dot = String((req.query && req.query.dot) || '').replace(/[^0-9]/g, '').slice(0, 10);
  if (!dot) return res.status(400).json({ error: 'bad_dot', message: 'Enter a numeric US DOT number.' });
  const saferUrl =
    'https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=' +
    encodeURIComponent(dot);
  const motusUrl = 'https://motus.dot.gov/customer/' + encodeURIComponent(dot) + '/account';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const r = await fetch(saferUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Fifty Bridges Fleet Vault; FMCSA SAFER lookup)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    clearTimeout(timer);
    if (!r.ok) {
      return res.status(502).json({ error: 'fmcsa_error', message: 'FMCSA SAFER returned status ' + r.status + '. Try again, or open the SAFER snapshot directly.' });
    }
    const html = await r.text();
    const parsed = parseSafer(html);
    if (parsed.error) {
      return res.status(parsed.error === 'inactive' ? 200 : 404).json({ dot, saferUrl, motusUrl, source: 'FMCSA SAFER', ...parsed });
    }
    // Fill gaps from FMCSA census open data (never overwrites a SAFER value).
    const censusRows = await fetchJson(
      'https://data.transportation.gov/resource/az4n-8mr2.json?dot_number=' + encodeURIComponent(dot) + '&$limit=5',
      10000
    );
    let census = {};
    if (Array.isArray(censusRows) && censusRows.length) census = parseCensus(censusRows[0]);
    const union = (a, b) => [...new Set([...(a || []), ...(b || [])])];
    if (!parsed.cargo.length && census.cargo && census.cargo.length) parsed.cargo = census.cargo;
    else if (census.cargo && census.cargo.length) parsed.cargo = union(parsed.cargo, census.cargo);
    if (!parsed.carrierOperation.length && census.carrierOperation && census.carrierOperation.length) parsed.carrierOperation = census.carrierOperation;
    if (!parsed.operationClassification.length && census.operationClassification && census.operationClassification.length) parsed.operationClassification = census.operationClassification;
    if (parsed.powerUnits == null && census.powerUnits != null && !isNaN(census.powerUnits)) parsed.powerUnits = census.powerUnits;
    if (parsed.drivers == null && census.drivers != null && !isNaN(census.drivers)) parsed.drivers = census.drivers;
    if (!parsed.mcs150Date && census.mcs150Date) parsed.mcs150Date = census.mcs150Date;
    if (!parsed.legalName && census.legalName) parsed.legalName = census.legalName;
    // Insurance history: FMCSA open data (InsHist) — cancelled/replaced filings only.
    const paddedDot = dot.padStart(8, '0');
    const insRows = await fetchJson(
      'https://data.transportation.gov/resource/6sqe-dvqs.json?dot_number=' + encodeURIComponent(paddedDot) + '&$limit=500',
      10000
    );
    let insuranceHistory = [];
    if (Array.isArray(insRows)) {
      insuranceHistory = insRows.map(parseInsuranceRow).sort((a, b) => {
        const da = a.effectiveDate || '', db = b.effectiveDate || '';
        return db.localeCompare(da);
      });
    }
    return res.status(200).json({
      dot,
      saferUrl,
      motusUrl,
      source: 'FMCSA SAFER + FMCSA open data',
      ...parsed,
      insuranceHistory,
      insuranceHistorySource: 'FMCSA open data (InsHist) — cancelled/replaced filings only. Active filings are NOT in this dataset.',
      insuranceNote:
        'Insurance history below is cancelled/replaced filings from FMCSA open data only. It does NOT include the current active filing. Check the Motus public snapshot (link above, authority detail -> Insurance Details, Include History on) for the full record including the active filing. FEIN and garaging are never copied from any record.',
    });
  } catch (e) {
    return res.status(502).json({ error: 'fmcsa_error', message: 'Could not reach FMCSA SAFER right now. Check the DOT number and try again, or open the SAFER snapshot directly.' });
  }
};
