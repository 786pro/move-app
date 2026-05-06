const https = require('https');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { lat, lng, status = 'sale', radius = '1' } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'Missing lat/lng' });

  const PD_KEY = process.env.PROPERTYDATA_KEY || 'FML2RPCTZV';
  const listingStatus = status === 'rent' ? 'rent' : 'sale';

  try {
    // Step 1: Get property data from PropertyData
    const pdRaw = await httpsGet('api.propertydata.co.uk',
      `/prices?key=${PD_KEY}&location=${lat},${lng}&listing_status=${listingStatus}&radius=${radius}`
    );
    const pdData = JSON.parse(pdRaw);
    if (pdData.status === 'error') return res.status(502).json({ error: pdData.message });

    const props = pdData.data?.raw_data || [];

    // Validate rent prices — monthly rent should be under £10k
    if (listingStatus === 'rent') {
      const avg = props.reduce((a,p) => a + parseInt(p.price||0), 0) / (props.length||1);
      if (avg > 10000) return res.status(200).json({ listings:[], count:0, warning:'Rent data unavailable' });
    }

    // Step 2: Get postcode from coordinates
    let postcode = null;
    let outcode = null;
    let rmLocationId = null;

    try {
      const pcRaw = await httpsGet('api.postcodes.io', `/postcodes?lon=${lng}&lat=${lat}&limit=1`);
      const pcData = JSON.parse(pcRaw);
      postcode = pcData.result?.[0]?.postcode;
      if (postcode) outcode = postcode.split(' ')[0];
    } catch(e) {}

    // Step 3: Get Rightmove location identifier using their typeahead API
    if (outcode) {
      try {
        const rmRaw = await httpsGetWithHeaders('los.rightmove.co.uk',
          `/typeahead?query=${encodeURIComponent(outcode)}&limit=5&exclude=`,
          {
            'Referer': 'https://www.rightmove.co.uk/',
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          }
        );
        const rmData = JSON.parse(rmRaw);
        // Find postcode or outcode match
        const match = rmData.matches?.find(m =>
          m.type === 'OUTCODE' || m.type === 'POSTCODE'
        );
        if (match) rmLocationId = `${match.type}^${match.id}`;
      } catch(e) {}
    }

    // Deduplicate by lat/lng/price
    const seen = new Set();
    const listings = props.filter(p => {
      const key = `${p.lat},${p.lng},${p.price}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map(p => {
      const pLat = parseFloat(p.lat);
      const pLng = parseFloat(p.lng);
      const price = parseInt(p.price || 0);
      const portal = p.portal || 'rightmove.co.uk';

      let url;

      if (portal.includes('rightmove')) {
        if (rmLocationId) {
          // Use proper Rightmove location identifier — this WORKS
          const locEnc = encodeURIComponent(rmLocationId);
          if (listingStatus === 'rent') {
            url = `https://www.rightmove.co.uk/property-to-rent/find.html?locationIdentifier=${locEnc}&radius=0.25&maxPrice=${price+500}&minPrice=${Math.max(0,price-500)}&sortType=6&includeLetAgreed=false`;
          } else {
            url = `https://www.rightmove.co.uk/property-for-sale/find.html?locationIdentifier=${locEnc}&radius=0.25&maxPrice=${price+50000}&minPrice=${Math.max(0,price-50000)}&sortType=6&includeSSTC=false`;
          }
        } else if (outcode) {
          // Fallback — Rightmove outcode search without ID still works for browsing
          if (listingStatus === 'rent') {
            url = `https://www.rightmove.co.uk/property-to-rent/find.html?searchType=RENT&locationIdentifier=OUTCODE%5E${outcode}&radius=0.25&maxPrice=${price+500}&minPrice=${Math.max(0,price-500)}&sortType=6`;
          } else {
            url = `https://www.rightmove.co.uk/property-for-sale/find.html?searchType=SALE&locationIdentifier=OUTCODE%5E${outcode}&radius=0.25&maxPrice=${price+50000}&minPrice=${Math.max(0,price-50000)}&sortType=6`;
          }
        } else {
          url = `https://www.rightmove.co.uk/property-for-sale/find.html?searchType=SALE&searchLocation=${pLat},${pLng}&radius=0.25`;
        }
      } else if (portal.includes('zoopla')) {
        if (listingStatus === 'rent') {
          url = `https://www.zoopla.co.uk/to-rent/property/lat/${pLat}/lng/${pLng}/?radius=0.25&price_frequency=per_month&price_max=${price+500}&price_min=${Math.max(0,price-500)}&results_sort=newest_listings`;
        } else {
          url = `https://www.zoopla.co.uk/for-sale/property/lat/${pLat}/lng/${pLng}/?radius=0.25&price_max=${price+50000}&price_min=${Math.max(0,price-50000)}&results_sort=newest_listings`;
        }
      } else {
        url = `https://www.onthemarket.com/${listingStatus==='rent'?'to-rent':'for-sale'}/?lat=${pLat}&lng=${pLng}&radius=0.25`;
      }

      return {
        id: `${pLat}_${pLng}_${price}_${listingStatus}`,
        lat: pLat, lng: pLng, price,
        priceLabel: formatPrice(price),
        propertyType: (p.type||'property').replace(/_/g,'-'),
        bedrooms: p.bedrooms ? parseInt(p.bedrooms) : null,
        status: listingStatus,
        sstc: p.sstc === 1,
        portal, url,
        distance: p.distance ? parseFloat(p.distance).toFixed(2) : null,
      };
    }).filter(p => p.lat && p.lng);

    res.status(200).json({ listings, count: listings.length, debug: { outcode, rmLocationId } });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
};

function formatPrice(n) {
  if (!n) return 'POA';
  if (n >= 1000000) return '£' + (n/1000000).toFixed(2).replace(/\.?0+$/,'') + 'm';
  if (n >= 1000) return '£' + Math.round(n/1000) + 'k';
  return '£' + n.toLocaleString();
}

function httpsGet(hostname, path) {
  return httpsGetWithHeaders(hostname, path, { 'User-Agent': 'MOVE-App/1.0' });
}

function httpsGetWithHeaders(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method:'GET', headers, timeout:15000 },
      (res) => { let b=''; res.on('data',c=>b+=c); res.on('end',()=>resolve(b)); }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timed out')); });
    req.end();
  });
}
