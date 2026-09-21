export const STYLE_NONCE_PLACEHOLDER = '__INKNEST_STYLE_NONCE__'
export const PRODUCTION_CSP = `default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'nonce-${STYLE_NONCE_PLACEHOLDER}'; img-src 'self' inknest-resource:; connect-src 'none'; font-src 'none'; media-src 'none'`
