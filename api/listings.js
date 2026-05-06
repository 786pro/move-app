// MOVE! – Listings API (Vercel)
// PropertyData /prices for map pins
// Rightmove location ID lookup for working portal links

const https = require('https');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { lat, lng, status = 'sale', radius = '1' } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'Missing lat/lng' });

  const PD_KEY = process.env.PROPERTYDATA_KEY;
  const listingStatus = status === 'rent' ? 'rent' : 'sale';

  try {
    // Step 1: Get property price data from PropertyData
    const pdPath = `/prices?key=${PD_KEY}&location=${lat},${lng}&listing_status=${listingStatus}&radius=${radius}`;
    const pdRaw = await httpsGet('api.propertydata.co.uk', pdPath);
    const pdData = JSON.parse(pdRaw);
    if (pdData.status === 'error') return res.status(502).json({ error: pdData.message });

    const props = pdData.data?.raw_data || [];

    // Validate rent prices — monthly rent should be under £10k
    if (listingStatus === 'rent') {
      const avg = props.reduce((a,p) => a + parseInt(p.price||0), 0) / (props.length||1);
      if (avg > 10000) return res.status(200).json({ listings:[], count:0, warning:'Rent data unavailable' });
    }

    // Step 2: Get Rightmove location ID for this area
    // This gives us a working Rightmove search URL
    const rmLocation = await getRightmoveLocationId(lat, lng);

    // Deduplicate
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

      // Build working portal URL using Rightmove location identifier
      let url;
      if (rmLocation && portal.includes('rightmove')) {
        const locId = encodeURIComponent(rmLocation);
        if (listingStatus === 'rent') {
          url = `https://www.rightmove.co.uk/property-to-rent/find.html?locationIdentifier=${locId}&maxBedrooms=&minBedrooms=&maxPrice=${price+500}&minPrice=${Math.max(0,price-500)}&radius=0.25&sortType=6&includeLetAgreed=false`;
        } else {
          url = `https://www.rightmove.co.uk/property-for-sale/find.html?locationIdentifier=${locId}&maxBedrooms=&minBedrooms=&maxPrice=${price+50000}&minPrice=${Math.max(0,price-50000)}&radius=0.25&sortType=6&includeSSTC=false`;
        }
      } else if (portal.includes('zoopla')) {
        url = listingStatus === 'rent'
          ? `https://www.zoopla.co.uk/to-rent/property/lat/${pLat}/lng/${pLng}/?radius=0.25&price_max=${price+500}&price_min=${Math.max(0,price-500)}`
          : `https://www.zoopla.co.uk/for-sale/property/lat/${pLat}/lng/${pLng}/?radius=0.25&price_max=${price+50000}&price_min=${Math.max(0,price-50000)}`;
      } else {
        url = listingStatus === 'rent'
          ? `https://www.rightmove.co.uk/property-to-rent/find.html?searchLocation=${pLat},${pLng}&radius=0.25`
          : `https://www.rightmove.co.uk/property-for-sale/find.html?searchLocation=${pLat},${pLng}&radius=0.25`;
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

    res.status(200).json({ listings, count: listings.length, rmLocation });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
};

// Get Rightmove location identifier from coordinates
// Uses Rightmove's typeahead API to find the nearest location
async function getRightmoveLocationId(lat, lng) {
  try {
    // First get a postcode from coordinates using postcodes.io (free, no key needed)
    const pcRaw = await httpsGet('api.postcodes.io', `/postcodes?lon=${lng}&lat=${lat}&limit=1`);
    const pcData = JSON.parse(pcRaw);
    const postcode = pcData.result?.[0]?.postcode;
    if (!postcode) return null;

    // Then look up Rightmove location ID for that postcode
    const outcode = postcode.split(' ')[0];
    const rmPath = `/api/typeahead/v1/units?t=POSTCODE&s=${encodeURIComponent(outcode)}`;
    const rmRaw = await httpsGet('www.rightmove.co.uk', rmPath, {
      'User-Agent': 'Mozilla/5.0 (compatible; MOVE-App/1.0)',
      'Accept': 'application/json',
      'Referer': 'https://www.rightmove.co.uk/',
    });

    const rmData = JSON.parse(rmRaw);
    const loc = rmData?.typeAheadLocations?.[0];
    return loc ? loc.locationIdentifier : `POSTCODE^${outcode}`;
  } catch(e) {
    return null;
  }
}

function formatPrice(n) {
  if (!n) return 'POA';
  if (n >= 1000000) return '£' + (n/1000000).toFixed(2).replace(/\.?0+$/,'') + 'm';
  if (n >= 1000) return '£' + Math.round(n/1000) + 'k';
  return '£' + n.toLocaleString();
}

function httpsGet(hostname, path, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method:'GET', headers:{'User-Agent':'MOVE-App/1.0', ...extraHeaders}, timeout:15000 },
      (res) => { let b=''; res.on('data',c=>b+=c); res.on('end',()=>resolve(b)); }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timed out')); });
    req.end();
  });
}
