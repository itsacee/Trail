/**
 * Vercel Web Analytics initialization
 * This script loads and initializes Vercel Analytics for the site.
 */
(function() {
  // Initialize the analytics queue
  window.va = window.va || function () {
    (window.vaq = window.vaq || []).push(arguments);
  };
  
  // Load the analytics script
  var script = document.createElement('script');
  script.defer = true;
  script.src = '/_vercel/insights/script.js';
  document.head.appendChild(script);
})();
