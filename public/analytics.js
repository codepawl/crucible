(() => {
  const currentScript = document.currentScript;
  const siteId = currentScript ? currentScript.getAttribute('data-cf-site') : '';
  const hostname = window.location.hostname;
  const isProductionHost = hostname === 'codepawl.com' || hostname.endsWith('.codepawl.com');
  if (!isProductionHost || !siteId || !/^[0-9a-f]{32}$/.test(siteId)) {
    return;
  }
  const beaconScript = document.createElement('script');
  beaconScript.defer = true;
  beaconScript.src = 'https://static.cloudflareinsights.com/beacon.min.js';
  beaconScript.setAttribute('data-cf-beacon', JSON.stringify({ token: siteId }));
  (document.body || document.head).appendChild(beaconScript);
})();
