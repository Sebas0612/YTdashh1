function parseRequests(symbolsParam) {
  if (!symbolsParam) return [];
  return String(symbolsParam).split(',').map(part => {
    const decoded = decodeURIComponent(part.trim());
    if (!decoded) return null;
    const sep = decoded.indexOf('~');
    if (sep === -1) return {
      requested: decoded,
      candidates: [decoded]
    };
    return {
      requested: decoded.slice(0, sep),
      candidates: decoded.slice(sep + 1).split('|').map(s => s.trim()).filter(Boolean)
    };
  }).filter(Boolean);
}

async function fetchFinnhubQuote(symbol, token) {
  const url = 'https://finnhub.io/api/v1/quote?symbol=' + encodeURIComponent(symbol) + '&token=' + encodeURIComponent(token);
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const price = Number(data && data.c);
  if (!price || price <= 0) return null;
  return {
    price,
    timestamp: data.t ? new Date(Number(data.t) * 1000).toISOString() : new Date().toISOString()
  };
}

module.exports = async function handler(req, res) {
  const token = process.env.FINNHUB_API_KEY;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (!token) {
    res.status(200).json({ configured: false, error: 'Live prices not configured yet' });
    return;
  }

  const requests = parseRequests(req.query && req.query.symbols);
  if (!requests.length) {
    res.status(400).json({ configured: true, error: 'No symbols provided', quotes: [] });
    return;
  }

  const quotes = [];
  for (const request of requests.slice(0, 30)) {
    let found = null;
    let symbolUsed = '';
    const candidates = Array.from(new Set(request.candidates));
    for (const symbol of candidates) {
      try {
        found = await fetchFinnhubQuote(symbol, token);
      } catch (_) {
        found = null;
      }
      if (found) {
        symbolUsed = symbol;
        break;
      }
    }
    if (found) {
      quotes.push({
        requested: request.requested,
        symbolUsed,
        price: found.price,
        currency: 'EUR',
        timestamp: found.timestamp,
        provider: 'finnhub'
      });
    } else {
      quotes.push({
        requested: request.requested,
        symbolUsed: '',
        price: null,
        currency: 'EUR',
        timestamp: new Date().toISOString(),
        provider: 'finnhub',
        error: 'No price found, edit symbol.'
      });
    }
  }

  res.status(200).json({ configured: true, quotes });
};
