// Dedicated DeepGPU Zoomer GA4 web stream; enhanced measurement is disabled.
(() => {
  const measurementId = 'G-YMJM4ZKLMS';
  const sitePath = '/DeepGPU-Zoomer/';
  if (!/^G-[A-Z0-9]+$/.test(measurementId)
      || location.origin !== 'https://byronbuzz.github.io'
      || !location.pathname.startsWith(sitePath)
      || document.getElementById('deepgpu-google-tag')) return;

  // Shared-view fragments and query parameters are not needed for visit counts.
  const pageLocation = location.origin + location.pathname;
  let pageReferrer = '';
  try {
    const referrer = new URL(document.referrer);
    pageReferrer = referrer.origin + referrer.pathname;
  } catch {}

  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', measurementId, {
    page_location: pageLocation,
    page_referrer: pageReferrer,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    cookie_path: sitePath
  });

  const tag = document.createElement('script');
  tag.id = 'deepgpu-google-tag';
  tag.async = true;
  tag.src = 'https://www.googletagmanager.com/gtag/js?id=' + measurementId;
  document.head.appendChild(tag);
})();
