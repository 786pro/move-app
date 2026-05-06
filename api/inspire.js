// MOVE! – Boundaries API (Vercel)
const https = require('https');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { bbox } = req.query;
  if (!bbox) return res.status(400).json({ error: 'Missing bbox' });

  const [west, south, east, north] = bbox.split(',').map(Number);
  if ([west,south,east,north].some(isNaN)) return res.status(400).json({ error: 'Invalid bbox' });

  const lrBbox = `${south},${west},${north},${east}`;
  const attempts = [
    `/inspire/ows?SERVICE=WFS&VERSION=1.1.0&REQUEST=GetFeature&TYPENAME=inspire:INSPIRE_Index_Polygon&BBOX=${lrBbox},urn:ogc:def:crs:EPSG::4326&maxFeatures=200`,
    `/inspire/ows?SERVICE=WFS&VERSION=1.1.0&REQUEST=GetFeature&TYPENAME=inspire:INSPIRE_Index_Polygon&BBOX=${bbox},EPSG:4326&maxFeatures=200`,
  ];

  for (const path of attempts) {
    try {
      const raw = await httpsGet('inspire.landregistry.gov.uk', path);
      if (!raw || raw.includes('WFS is disabled')) break;
      const geojson = gmlToGeoJSON(raw);
      if (geojson.features.length > 0) return res.status(200).json(geojson);
    } catch(e) {}
  }

  // Fallback to Overpass buildings
  const overpassBbox = `${south},${west},${north},${east}`;
  const query = `[out:json][timeout:20];(way["building"](${overpassBbox}););out body;>;out skel qt;`;
  try {
    const raw = await httpsGet('overpass-api.de', '/api/interpreter?data=' + encodeURIComponent(query));
    const data = JSON.parse(raw);
    const nodes = {};
    data.elements.filter(e => e.type==='node').forEach(e => { nodes[e.id] = [e.lon, e.lat]; });
    const features = data.elements.filter(e => e.type==='way' && e.nodes?.length > 2).map(e => {
      const coords = e.nodes.map(id => nodes[id]).filter(Boolean);
      if (coords.length < 3) return null;
      const f = coords[0], l = coords[coords.length-1];
      if (f[0]!==l[0]||f[1]!==l[1]) coords.push([f[0],f[1]]);
      return { type:'Feature', properties:{ id:e.id, building:e.tags?.building }, geometry:{ type:'Polygon', coordinates:[coords] }};
    }).filter(Boolean);
    res.status(200).json({ type:'FeatureCollection', features });
  } catch(e) {
    res.status(200).json({ type:'FeatureCollection', features:[] });
  }
};

function gmlToGeoJSON(gml) {
  const features = [];
  const memberRx = /<(?:\w+:)?featureMember[^>]*>([\s\S]*?)<\/(?:\w+:)?featureMember>/g;
  let m;
  while ((m = memberRx.exec(gml)) !== null) {
    const block = m[1];
    const idM = block.match(/<(?:\w+:)?INSPIREID[^>]*>([^<]+)<\/(?:\w+:)?INSPIREID>/i);
    const posM = block.match(/<(?:\w+:)?posList[^>]*>([\s\S]*?)<\/(?:\w+:)?posList>/);
    if (!posM) continue;
    const nums = posM[1].trim().split(/\s+/).map(Number);
    if (nums.length < 6) continue;
    const coords = [];
    for (let i = 0; i+1 < nums.length; i+=2) coords.push([nums[i+1], nums[i]]);
    if (coords.length < 4) continue;
    const f=coords[0], l=coords[coords.length-1];
    if (f[0]!==l[0]||f[1]!==l[1]) coords.push([f[0],f[1]]);
    features.push({ type:'Feature', properties:{ INSPIREID: idM?idM[1].trim():null }, geometry:{ type:'Polygon', coordinates:[coords] }});
  }
  return { type:'FeatureCollection', features };
}

function httpsGet(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method:'GET', headers:{'User-Agent':'MOVE-App/1.0'}, timeout:20000 },
      (res) => { let b=''; res.on('data',c=>b+=c); res.on('end',()=>resolve(b)); }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}
