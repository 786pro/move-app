// MOVE! – Property Detail API (Vercel)
const https = require('https');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'Missing lat/lng' });

  const PD_KEY = process.env.PROPERTYDATA_KEY;

  try {
    const [valRaw, soldRaw] = await Promise.all([
      httpsGet('api.propertydata.co.uk', `/valuation-sale?key=${PD_KEY}&location=${lat},${lng}`),
      httpsGet('api.propertydata.co.uk', `/sold-prices?key=${PD_KEY}&location=${lat},${lng}&radius=0.1`),
    ]);
    const val = JSON.parse(valRaw);
    const sold = JSON.parse(soldRaw);
    res.status(200).json({
      valuation: val.status === 'success' ? val.data : null,
      recentSales: sold.status === 'success' ? (sold.data?.raw_data || []).slice(0,3) : [],
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
};

function httpsGet(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method:'GET', headers:{'User-Agent':'MOVE-App/1.0'}, timeout:15000 },
      (res) => { let b=''; res.on('data',c=>b+=c); res.on('end',()=>resolve(b)); }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}
