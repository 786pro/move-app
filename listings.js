const https = require('https');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { lat, lng, status = 'sale', radius = '1' } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'Missing lat/lng' });

  const PD_KEY = process.env.PROPERTYDATA_KEY || 'FML2RPCTZV';
  const listingStatus = status === 'rent' ? 'rent' : 'sale';
  const path = `/prices?key=${PD_KEY}&location=${lat},${lng}&listing_status=${listingStatus}&radius=${radius}`;

  try {
    const raw = await httpsGet('api.propertydata.co.uk', path);
    const data = JSON.parse(raw);
    if (data.status === 'error') return res.status(502).json({ error: data.message });

    const props = data.data?.raw_data || [];

    // Validate rent — monthly rent should never be over £10k
    if (listingStatus === 'rent') {
      const avg = props.reduce((a,p) => a + parseInt(p.price||0), 0) / (props.length||1);
      if (avg > 10000) return res.status(200).json({ listings:[], count:0, warning:'Rent data unavailable' });
    }

    // Get postcode for this location — used to build working Rightmove URL
    let outcode = null;
    try {
      const pcRaw = await httpsGet('api.postcodes.io', `/postcodes?lon=${lng}&lat=${lat}&limit=1`);
      const pcData = JSON.parse(pcRaw);
      const postcode = pcData.result?.[0]?.postcode;
      if (postcode) outcode = postcode.split(' ')[0]; // e.g. "SW1A"
    } catch(e) {}

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

      let url;

      if (portal.includes('rightmove')) {
        // Rightmove works with outcode search — this reliably opens listings near the property
        if (outcode) {
          if (listingStatus === 'rent') {
            url = `https://www.rightmove.co.uk/property-to-rent/find.html?searchType=RENT&searchLocation=${outcode}&useLocationIdentifier=false&radius=0.25&maxPrice=${price+500}&minPrice=${Math.max(0,price-500)}&sortType=6`;
          } else {
            url = `https://www.rightmove.co.uk/property-for-sale/find.html?searchType=SALE&searchLocation=${outcode}&useLocationIdentifier=false&radius=0.25&maxPrice=${price+50000}&minPrice=${Math.max(0,price-50000)}&sortType=6`;
          }
        } else {
          // No outcode — use Rightmove map search centred on coordinates
          if (listingStatus === 'rent') {
            url = `https://www.rightmove.co.uk/property-to-rent/map.html#mapMode=S&latitude=${pLat}&longitude=${pLng}&zoom=15&maxPrice=${price+500}&minPrice=${Math.max(0,price-500)}`;
          } else {
            url = `https://www.rightmove.co.uk/property-for-sale/map.html#mapMode=S&latitude=${pLat}&longitude=${pLng}&zoom=15&maxPrice=${price+50000}&minPrice=${Math.max(0,price-50000)}`;
          }
        }
      } else if (portal.includes('zoopla')) {
        // Zoopla lat/lng URL format works well
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

    res.status(200).json({ listings, count: listings.length, outcode });
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
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method:'GET', headers:{'User-Agent':'MOVE-App/1.0'}, timeout:15000 },
      (res) => { let b=''; res.on('data',c=>b+=c); res.on('end',()=>resolve(b)); }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timed out')); });
    req.end();
  });
}
