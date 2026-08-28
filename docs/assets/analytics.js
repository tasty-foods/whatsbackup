/* Visit counting — off until a token is filled in below.
 *
 * Cloudflare Web Analytics: a page count and a referrer. No cookies, no
 * fingerprinting, nothing that identifies a reader or follows them anywhere
 * else — which is why it needs no consent banner under the GDPR, and why it is
 * the only thing on this site allowed to phone home besides the download
 * button asking GitHub for the newest release.
 *
 * TO SWITCH IT ON: put the site token from
 *   Cloudflare dashboard → Analytics & Logs → Web Analytics → Add a site
 * between the quotes. Nothing loads while it is empty, so the privacy page
 * stays true either way.
 */
(function () {
  var TOKEN = '';
  if (!TOKEN) return;
  var s = document.createElement('script');
  s.defer = true;
  s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
  s.setAttribute('data-cf-beacon', JSON.stringify({ token: TOKEN }));
  document.head.appendChild(s);
})();
