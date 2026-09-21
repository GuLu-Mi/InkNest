import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

import { PRODUCTION_CSP, STYLE_NONCE_PLACEHOLDER } from './src/shared/csp'

const DEVELOPMENT_CSP =
  "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' inknest-resource:; connect-src 'self' ws:; font-src 'none'; media-src 'none'"

function contentSecurityPolicy(isDevelopment: boolean): Plugin {
  return {
    name: 'inknest-content-security-policy',
    transformIndexHtml() {
      return [
        { tag: 'meta', attrs: { name: 'inknest-style-nonce', content: isDevelopment ? '' : STYLE_NONCE_PLACEHOLDER }, injectTo: 'head-prepend' },
        {
          tag: 'meta',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content: isDevelopment ? DEVELOPMENT_CSP.replace("; frame-ancestors 'none'", '') : PRODUCTION_CSP.replace("; frame-ancestors 'none'", '')
          },
          injectTo: 'head-prepend'
        }
      ]
    }
  }
}

export default defineConfig(({ command }) => {
  const isDevelopment = command === 'serve'

  return {
    main: {
      define: {
        __INKNEST_DEVELOPMENT__: JSON.stringify(isDevelopment)
      }
    },
    preload: {},
    renderer: {
      root: 'src/renderer',
      plugins: [vue(), contentSecurityPolicy(isDevelopment)]
    }
  }
})
