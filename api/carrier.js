// Vercel Serverless Function: FMCSA SAFER carrier lookup proxy.
// Why a proxy? A browser page on vercel.app cannot reliably fetch safer.fmcsa.dot.gov
// directly (no CORS headers, and SAFER sometimes blocks browser fetches). A server-side
// function can fetch the public SAFER Company Snapshot, parse the public fields, and
// return only clean JSON to the page. No API key is needed for SAFER.
// What it does NOT do (yet): MOTUS does have a public snapshot
// (motus.dot.gov/public/search, motus.dot.gov/customer/<DOT>/account) with an
// Insurance Details tab and an Include History toggle — verified live 2026-10-27
// with no login — but that page is a client-side app that loads its data by
// JavaScript after load (up to ~60s), so a server-side HTML fetch returns only
// an empty shell. Insurance filing history is therefore not returned here until
// a verified server-side source for it (the app's own API, or FMCSA's public
// open-data insurance history dataset, field-checked against known rows) is
// confirmed. It also never invents FEIN or garaging data.
function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
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
  );
}
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
  const usdotStatus = between(text, 'USDOT Status:', ['Out of Service Date:']);
  let authorityStatus = between(text, 'Operating Authority Status:', ['For Licensing', 'MC/MX/FF Number(s):']);
  authorityStatus = authorityStatus.replace(/Please Note:.*$/i, '').trim();
  const mcsMatch = text.match(/MCS-150 Form Date:\s*(\d{2}\/\d{2}\/\d{4})/);
  const powerMatch = text.match(/Power Units:\s*(\d+)/);
  const driversMatch = text.match(/Drivers:\s*\*?\s*(\d+)/);
  const asOfMatch = text.match(/management information systems as of\s+(\d{2}\/\d{2}\/\d{4})/);
  // Cargo / operation: in the snapshot, selected items are marked with a leading "X ".
  function xItems(sectionStart, sectionEnd) {
    const sec = between(text, sectionStart, [sectionEnd]);
    if (!sec) return [];
    const parts = sec.split(/\s*-\s*/).map((s) => s.trim()).filter(Boolean);
    const out = [];
    parts.forEach((p) => {
      const m = p.match(/^X\s+(.+)$/);
      if (m) out.push(clean(m[1]).replace(/^SAFER Layout\s*/i, ''));
    });
    return out.filter((x) => x && !/^SAFER/i.test(x));
  }
  const cargo = xItems('Cargo Carried:', ['Inspections/Crashes']);
  const operationClassification = xItems('Operation Classification:', ['Carrier Operation:']);
  const carrierOperation = xItems('Carrier Operation:', ['Cargo Carried:']);
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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const dot = String((req.query && req.query.dot) || '').replace(/[^0-9]/g, '').slice(0, 10);
  if (!dot) return res.status(400).json({ error: 'bad_dot', message: 'Enter a numeric US DOT number.' });
  const saferUrl =
    'https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=' +
    encodeURIComponent(dot);
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
      return res.status(parsed.error === 'inactive' ? 200 : 404).json({ dot, saferUrl, source: 'FMCSA SAFER', ...parsed });
    }
    return res.status(200).json({
      dot,
      saferUrl,
      source: 'FMCSA SAFER',
      ...parsed,
      insuranceNote:
        'Insurance filing history is NOT included yet: the MOTUS public snapshot has it (Insurance Details tab, Include History on), but it is a JavaScript app whose data is not in the initial HTML, so it cannot be auto-fetched by this server function until a verified server-side source is confirmed.',
    });
  } catch (e) {
    return res.status(502).json({ error: 'fmcsa_error', message: 'Could not reach FMCSA SAFER right now. Check the DOT number and try again, or open the SAFER snapshot directly.' });
  }
};
