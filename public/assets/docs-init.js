// Boots Swagger UI on /docs. Kept as a file (not inline) so the page CSP can forbid inline scripts.
window.addEventListener('load', () => {
  window.ui = window.SwaggerUIBundle({
    url: '/openapi.json',
    dom_id: '#swagger-ui',
    deepLinking: true,
    docExpansion: 'list',
    defaultModelsExpandDepth: 0,
    persistAuthorization: false, // never store API keys in the browser
    tryItOutEnabled: false,
  });
});
