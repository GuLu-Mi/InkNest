import { createApp } from 'vue'

import { initializeTheme } from './theme'
import App from './App.vue'
import './styles.css'

void initializeTheme().then(() => {
  createApp(App).mount('#app')
  void window.inknest.rendererReady()
})
